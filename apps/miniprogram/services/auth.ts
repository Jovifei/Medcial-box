// 登录服务：wx.login 取临时 code → 服务端换会话令牌（令牌仅本地保存）。
// 服务端没有任何公开测试登录接口；AppID/AppSecret 只存在于服务端环境变量。
import { api, clearToken, readToken, storeToken } from "./api";
import { ApiError } from "./api";
import { clearSessionScope, writeSessionScope } from "./session-scope";

export interface LoginResult {
  token: string;
  expiresAt: string;
  hasFamily: boolean;
}

export function loginWithWechat(): Promise<LoginResult> {
  return new Promise<LoginResult>((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (!res.code) {
          reject(new ApiError("WX_LOGIN_FAILED", "微信登录未返回临时凭据，请重试", 0));
          return;
        }
        api
          .login(res.code)
          .then((session) => {
            storeToken(session.token);
            resolve({
              token: session.token,
              expiresAt: session.expiresAt,
              hasFamily: session.user.hasFamily,
            });
          })
          .catch(reject);
      },
      fail: () => {
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
  const existing = readToken();
  if (existing !== "") {
    try {
      // auth/me 同时用于固化本机身份命名空间（草稿按 userId+familyId 隔离）。
      const me = await api.getAuthMe();
      writeSessionScope({ userId: me.user.id, familyId: me.family?.id ?? "" });
      return existing;
    } catch (error) {
      if (!(error instanceof ApiError) || (error.statusCode !== 401 && error.code !== "UNAUTHORIZED" && error.code !== "SESSION_EXPIRED")) {
        throw error;
      }
      clearToken();
      // 会话失效即作废本机身份，草稿键不得继续指向上一个账号。
      clearSessionScope();
    }
  }
  if (options.allowInteractive === false) {
    throw new ApiError("UNAUTHENTICATED", "请先登录", 401);
  }
  const result = await loginWithWechat();
  return result.token;
}

/** 退出当前设备会话；服务端撤销失败时也清理本地令牌，避免卡在旧状态。 */
export async function logout(): Promise<void> {
  try {
    if (readToken() !== "") await api.logout();
  } catch (error) {
    // 令牌已经失效时，退出登录的本地结果仍然是成功；其它网络错误继续提示用户。
    if (!(error instanceof ApiError) || error.statusCode !== 401) throw error;
  } finally {
    clearToken();
    clearSessionScope();
  }
}
