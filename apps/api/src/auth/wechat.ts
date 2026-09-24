// WeChat login gateway. The production implementation calls the official
// code2session endpoint; credentials come from server-side environment
// variables only. Tests inject FakeWechatGateway — there is no public
// "test login" backdoor.
import { URLSearchParams } from "node:url";

export interface WechatCodeSession {
  openid: string;
  sessionKey: string | null;
  unionid: string | null;
}

export interface WechatGateway {
  code2Session(code: string): Promise<WechatCodeSession>;
}

/** Invalid js code → maps to 401 WECHAT_EXCHANGE_FAILED. */
export class WechatCodeError extends Error {}

/** Gateway/config/network failure → maps to 502 WECHAT_GATEWAY_ERROR. */
export class WechatGatewayError extends Error {}

interface WechatExchangePayload {
  openid?: unknown;
  session_key?: unknown;
  unionid?: unknown;
  errcode?: unknown;
  errmsg?: unknown;
}

export class HttpWechatGateway implements WechatGateway {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly endpoint = "https://api.weixin.qq.com/sns/jscode2session",
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async code2Session(code: string): Promise<WechatCodeSession> {
    if (this.appId === "" || this.appSecret === "") {
      throw new WechatGatewayError("wechat app credentials are not configured");
    }
    const query = new URLSearchParams({
      appid: this.appId,
      secret: this.appSecret,
      js_code: code,
      grant_type: "authorization_code",
    });
    let payload: WechatExchangePayload;
    try {
      const response = await this.fetchFn(`${this.endpoint}?${query.toString()}`);
      if (!response.ok) {
        throw new WechatGatewayError(`wechat gateway responded ${response.status}`);
      }
      payload = (await response.json()) as WechatExchangePayload;
    } catch (error) {
      if (error instanceof WechatGatewayError) throw error;
      throw new WechatGatewayError("wechat gateway request failed");
    }
    if (typeof payload.errcode === "number" && payload.errcode !== 0) {
      // Non-zero errcode means the exchange itself was rejected (bad code,
      // wrong appid, ...). Treat the credential as invalid, not a gateway
      // outage — the client should ask the user to retry login.
      throw new WechatCodeError(`wechat exchange rejected: ${payload.errcode}`);
    }
    if (typeof payload.openid !== "string" || payload.openid === "") {
      throw new WechatCodeError("wechat exchange returned no openid");
    }
    return {
      openid: payload.openid,
      sessionKey: typeof payload.session_key === "string" ? payload.session_key : null,
      unionid: typeof payload.unionid === "string" ? payload.unionid : null,
    };
  }
}

/** Scriptable gateway for synthetic tests: code → openid mapping. */
export class FakeWechatGateway implements WechatGateway {
  private readonly codes = new Map<string, string>();
  private failure: Error | null = null;

  registerCode(code: string, openid: string): this {
    this.codes.set(code, openid);
    return this;
  }

  setFailure(error: Error): this {
    this.failure = error;
    return this;
  }

  resetFailure(): this {
    this.failure = null;
    return this;
  }

  async code2Session(code: string): Promise<WechatCodeSession> {
    if (this.failure !== null) throw this.failure;
    const openid = this.codes.get(code);
    if (openid === undefined) {
      throw new WechatCodeError("invalid wechat js code");
    }
    return { openid, sessionKey: null, unionid: null };
  }
}

/** Default gateway for real startup; missing credentials fail at login time (502). */
export function createDefaultWechatGateway(): WechatGateway {
  return new HttpWechatGateway(
    process.env.WECHAT_APP_ID ?? "",
    process.env.WECHAT_APP_SECRET ?? "",
  );
}
