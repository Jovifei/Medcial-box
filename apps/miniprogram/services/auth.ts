// 登录服务：wx.login 取临时 code → 服务端换会话令牌（令牌仅本地保存）。
// 服务端没有任何公开测试登录接口；AppID/AppSecret 只存在于服务端环境变量。
import { api, beginSessionTransition, captureSessionIdentity, clearToken, isCurrentSession, staleSessionError, storeToken } from "./api";
import type { SessionIdentity } from "./api";
import { ApiError } from "./api";
import { writeSessionScope } from "./session-scope";

export interface LoginResult {
  token: string;
  expiresAt: string;
  hasFamily: boolean;
}

let authIntent = 0;

export function loginWithWechat(): Promise<LoginResult> {
  authIntent += 1;
  const identity = beginSessionTransition();
  return new Promise<LoginResult>((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (!isCurrentSession(identity)) { reject(staleSessionError()); return; }
        if (!res.code) {
          reject(new ApiError("WX_LOGIN_FAILED", "微信登录未返回临时凭据，请重试", 0));
          return;
        }
        api
          .login(res.code)
          .then((session) => {
            if (!isCurrentSession(identity)) throw staleSessionError();
            storeToken(session.token);
            resolve({
              token: session.token,
              expiresAt: session.expiresAt,
              hasFamily: session.user.hasFamily,
            });
          })
          .catch((error: unknown) => reject(isCurrentSession(identity) ? error : staleSessionError()));
      },
      fail: () => {
        if (!isCurrentSession(identity)) { reject(staleSessionError()); return; }
        reject(new ApiError("WX_LOGIN_FAILED", "微信登录失败，请稍后重试", 0));
      },
    });
  });
}

/**
 * 确认当前令牌仍然可用。首次欢迎页传 allowInteractive=false，避免打开应用
 * 时悄悄替用户完成微信登录；业务页保留旧的静默登录兼容行为。
 */
export async function ensureLoggedIn(options: { allowInteractive?: boolean } = {}): Promise<string> {
  const identity = captureSessionIdentity();
  const existing = identity.token;
  let ownInvalidatedSession: SessionIdentity | undefined;
  if (existing !== "") {
    try {
      // auth/me 同时用于固化本机身份命名空间（草稿按 userId+familyId 隔离）。
      const me = await api.getAuthMe();
      if (!isCurrentSession(identity)) throw staleSessionError();
      writeSessionScope({ userId: me.user.id, familyId: me.family?.id ?? "" });
      return existing;
    } catch (error) {
      if (!(error instanceof ApiError) || (error.statusCode !== 401 && error.code !== "UNAUTHORIZED" && error.code !== "SESSION_EXPIRED")) {
        throw error;
      }
      // Only this request's own 401 cleanup may fall through to a new login.
      // A newer login/logout can run between the response callback and this catch.
      if (error.invalidatedSession === undefined || !isCurrentSession(error.invalidatedSession)) {
        throw staleSessionError();
      }
      ownInvalidatedSession = error.invalidatedSession;
    }
  }
  if (options.allowInteractive === false) {
    throw new ApiError("UNAUTHENTICATED", "请先登录", 401, ownInvalidatedSession);
  }
  const result = await loginWithWechat();
  return result.token;
}

/** 退出当前设备会话；服务端撤销失败时也清理本地令牌，避免卡在旧状态。 */
export async function logout(): Promise<void> {
  const intent = ++authIntent;
  const identity = beginSessionTransition();
  let invalidatedSession: SessionIdentity | undefined;
  let failure: unknown;
  let failed = false;
  try {
    if (identity.token !== "") await api.logout();
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 401) {
      invalidatedSession = error.invalidatedSession;
    } else {
      failed = true;
      failure = error;
    }
  }
  if (isCurrentSession(identity)) {
    clearToken();
  } else if (invalidatedSession === undefined || !isCurrentSession(invalidatedSession)) {
    // Another current request may already have cleared an expired token. That
    // still completes this logout, unless a newer login/logout intent took over.
    if (intent !== authIntent || captureSessionIdentity().token !== "") throw staleSessionError();
    if (failure instanceof ApiError && failure.code === "STALE_SESSION") failed = false;
  }
  if (failed) throw failure;
}
