export interface ReminderTemplateFieldMap {
  title: string;
  time: string;
  remark: string;
}

export interface ReminderTemplateConfig {
  available: boolean;
  appId: string;
  appSecret: string;
  templateId: string;
  fieldMap: ReminderTemplateFieldMap;
  miniprogramState: "developer" | "trial" | "formal";
  templates: Array<{ templateId: string; title: string; available: boolean }>;
  reason?: string;
}

export interface ReminderMessage {
  openid: string;
  page: string;
  medicineName: string;
  deadlineDate: string;
  eventLabel: string;
}

export interface SubscribeMessageSender {
  send(message: ReminderMessage): Promise<{ messageId: string }>;
}

export class SubscribeMessageUnavailableError extends Error {}

const DEFAULT_FIELDS: ReminderTemplateFieldMap = {
  title: "thing1",
  time: "time2",
  remark: "thing3",
};

function safeField(value: string | undefined): string | null {
  if (value === undefined) return null;
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(value) ? value : null;
}

export function createReminderTemplateConfig(input: {
  appId: string;
  appSecret: string;
  templateId: string;
  fieldMap?: Partial<ReminderTemplateFieldMap>;
  miniprogramState?: string;
}): ReminderTemplateConfig {
  const fields = {
    title: safeField(input.fieldMap?.title ?? DEFAULT_FIELDS.title),
    time: safeField(input.fieldMap?.time ?? DEFAULT_FIELDS.time),
    remark: safeField(input.fieldMap?.remark ?? DEFAULT_FIELDS.remark),
  };
  const fieldsValid = Object.values(fields).every((field) => field !== null) &&
    new Set(Object.values(fields)).size === 3;
  const configured = input.appId.trim() !== "" && input.appSecret.trim() !== "" &&
    input.templateId.trim() !== "" && fieldsValid;
  const miniprogramState = input.miniprogramState === "developer" || input.miniprogramState === "trial"
    ? input.miniprogramState
    : "formal";
  return {
    available: configured,
    appId: input.appId,
    appSecret: input.appSecret,
    templateId: input.templateId,
    fieldMap: fieldsValid
      ? fields as ReminderTemplateFieldMap
      : DEFAULT_FIELDS,
    miniprogramState,
    templates: configured
      ? [{ templateId: input.templateId, title: "家庭药箱待处理提醒", available: true }]
      : [],
    ...(!configured ? { reason: "尚未配置可用的微信订阅模板和字段映射" } : {}),
  };
}

export function buildReminderMessageData(
  message: Pick<ReminderMessage, "medicineName" | "deadlineDate" | "eventLabel">,
  fields: ReminderTemplateFieldMap,
): Record<string, { value: string }> {
  return {
    [fields.title]: { value: "家庭药箱有待处理事项" },
    [fields.time]: { value: `${message.deadlineDate} 09:00` },
    [fields.remark]: { value: "点击打开药箱查看" },
  };
}

interface AccessTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  errcode?: unknown;
}

interface SendResponse {
  errcode?: unknown;
  msgid?: unknown;
}

export class WechatSubscribeMessageSender implements SubscribeMessageSender {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly config: ReminderTemplateConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async send(message: ReminderMessage): Promise<{ messageId: string }> {
    if (!this.config.available) throw new SubscribeMessageUnavailableError("subscription template is not configured");
    const accessToken = await this.getAccessToken();
    const url = new URL("https://api.weixin.qq.com/cgi-bin/message/subscribe/send");
    url.searchParams.set("access_token", accessToken);
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          touser: message.openid,
          template_id: this.config.templateId,
          page: message.page,
          miniprogram_state: this.config.miniprogramState,
          data: buildReminderMessageData(message, this.config.fieldMap),
        }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new SubscribeMessageUnavailableError("wechat subscribe send request failed");
    }
    if (!response.ok) throw new SubscribeMessageUnavailableError(`wechat subscribe send returned ${response.status}`);
    const payload = await response.json() as SendResponse;
    if (typeof payload.errcode === "number" && payload.errcode !== 0) {
      throw new SubscribeMessageUnavailableError(`wechat subscribe send rejected with ${payload.errcode}`);
    }
    if (payload.msgid === undefined || payload.msgid === null) {
      throw new SubscribeMessageUnavailableError("wechat subscribe send returned no message id");
    }
    return { messageId: String(payload.msgid) };
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken !== null && this.now() < this.accessTokenExpiresAt) return this.accessToken;
    const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
    url.searchParams.set("grant_type", "client_credential");
    url.searchParams.set("appid", this.config.appId);
    url.searchParams.set("secret", this.config.appSecret);
    let response: Response;
    try {
      response = await this.fetchFn(url, { signal: AbortSignal.timeout(8_000) });
    } catch {
      throw new SubscribeMessageUnavailableError("wechat access token request failed");
    }
    if (!response.ok) throw new SubscribeMessageUnavailableError(`wechat token returned ${response.status}`);
    const payload = await response.json() as AccessTokenResponse;
    if (typeof payload.errcode === "number" && payload.errcode !== 0) {
      throw new SubscribeMessageUnavailableError(`wechat token rejected with ${payload.errcode}`);
    }
    if (typeof payload.access_token !== "string" || payload.access_token === "") {
      throw new SubscribeMessageUnavailableError("wechat token response missing access_token");
    }
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 7200;
    this.accessToken = payload.access_token;
    this.accessTokenExpiresAt = this.now() + Math.max(60, expiresIn - 300) * 1000;
    return payload.access_token;
  }
}

function readFieldMap(raw: string | undefined): Partial<ReminderTemplateFieldMap> | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...(typeof parsed.title === "string" ? { title: parsed.title } : {}),
      ...(typeof parsed.time === "string" ? { time: parsed.time } : {}),
      ...(typeof parsed.remark === "string" ? { remark: parsed.remark } : {}),
    };
  } catch {
    return undefined;
  }
}

export function createDefaultReminderTemplateConfig(): ReminderTemplateConfig {
  return createReminderTemplateConfig({
    appId: process.env.WECHAT_APP_ID ?? "",
    appSecret: process.env.WECHAT_APP_SECRET ?? "",
    templateId: process.env.WECHAT_REMINDER_TEMPLATE_ID ?? "",
    fieldMap: readFieldMap(process.env.WECHAT_REMINDER_FIELD_MAP),
    miniprogramState: process.env.WECHAT_MINIPROGRAM_STATE,
  });
}
