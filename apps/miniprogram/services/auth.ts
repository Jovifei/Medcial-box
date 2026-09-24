// 登录服务：wx.login 取临时 code → 服务端换会话令牌（令牌仅本地保存）。
// 服务端没有任何公开测试登录接口；AppID/AppSecret 只存在于服务端环境变量。
import { api, readToken, storeToken } from "./api";
import { ApiError } from "./api";

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

/** 已有令牌直接复用；否则静默登录一次。返回可用令牌。 */
export async function ensureLoggedIn(): Promise<string> {
  const existing = readToken();
  if (existing !== "") return existing;
  const result = await loginWithWechat();
  return result.token;
}
