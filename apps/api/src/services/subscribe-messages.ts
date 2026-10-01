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
  /** 服药提醒使用独立模板（R4），缺省时服药提醒不可用但库存提醒不受影响。 */
  doseTemplateId: string;
  doseFieldMap: ReminderTemplateFieldMap;
  doseAvailable: boolean;
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

/** 服药提醒消息：不携带药名或剂量，只提示有待确认的安排。 */
export interface DoseReminderMessage {
  openid: string;
  page: string;
  doseDate: string;
  timeText: string;
}

export interface SubscribeMessageSender {
  send(message: ReminderMessage): Promise<{ messageId: string }>;
}

export interface DoseMessageSender {
  /** 与库存提醒分开命名，避免两类消息的实现互相覆盖。 */
  sendDose(message: DoseReminderMessage): Promise<{ messageId: string }>;
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
  /** 服药提醒模板（可缺省：此时服药提醒不可用，库存提醒照常工作）。 */
  doseTemplateId?: string;
  doseFieldMap?: Partial<ReminderTemplateFieldMap>;
  miniprogramState?: string;
}): ReminderTemplateConfig {
  const fields = {
    title: safeField(input.fieldMap?.title ?? DEFAULT_FIELDS.title),
    time: safeField(input.fieldMap?.time ?? DEFAULT_FIELDS.time),
    remark: safeField(input.fieldMap?.remark ?? DEFAULT_FIELDS.remark),
  };
  const fieldsValid = Object.values(fields).every((field) => field !== null) &&
    new Set(Object.values(fields)).size === 3;
  const credentialsReady = input.appId.trim() !== "" && input.appSecret.trim() !== "";
  const configured = credentialsReady && input.templateId.trim() !== "" && fieldsValid;
  const doseFields = {
    title: safeField(input.doseFieldMap?.title ?? DEFAULT_FIELDS.title),
    time: safeField(input.doseFieldMap?.time ?? DEFAULT_FIELDS.time),
    remark: safeField(input.doseFieldMap?.remark ?? DEFAULT_FIELDS.remark),
  };
  const doseFieldsValid = Object.values(doseFields).every((field) => field !== null) &&
    new Set(Object.values(doseFields)).size === 3;
  const doseTemplateId = (input.doseTemplateId ?? "").trim();
  const doseConfigured = credentialsReady && doseTemplateId !== "" && doseFieldsValid;
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
    doseTemplateId,
    doseFieldMap: doseFieldsValid
      ? doseFields as ReminderTemplateFieldMap
      : DEFAULT_FIELDS,
    doseAvailable: doseConfigured,
    miniprogramState,
    templates: [
      ...(configured ? [{ templateId: input.templateId, title: "家庭药箱待处理提醒", available: true }] : []),
      ...(doseConfigured ? [{ templateId: doseTemplateId, title: "用药安排待确认", available: true }] : []),
    ],
    ...(!configured ? { reason: "尚未配置可用的微信订阅模板和字段映射" } : {}),
  };
}

/**
 * 服药提醒正文：按方案默认只写"有一项用药安排待确认"，
 * 不写药名、剂量或任何就诊信息，避免通知内容泄露。
 */
export function buildDoseReminderMessageData(
  message: Pick<DoseReminderMessage, "doseDate" | "timeText">,
  fields: ReminderTemplateFieldMap,
): Record<string, { value: string }> {
  return {
    [fields.title]: { value: "有一项用药安排待确认" },
    [fields.time]: { value: `${message.doseDate} ${message.timeText}` },
    [fields.remark]: { value: "点击打开用药计划确认" },
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

export class WechatSubscribeMessageSender implements SubscribeMessageSender, DoseMessageSender {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly config: ReminderTemplateConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async send(message: ReminderMessage): Promise<{ messageId: string }> {
    if (!this.config.available) throw new SubscribeMessageUnavailableError("subscription template is not configured");
    return this.postSubscribe({
      touser: message.openid,
      template_id: this.config.templateId,
      page: message.page,
      miniprogram_state: this.config.miniprogramState,
      data: buildReminderMessageData(message, this.config.fieldMap),
    });
  }

  /** 服药提醒走独立模板与正文（不携带药名或剂量）。 */
  async sendDose(message: DoseReminderMessage): Promise<{ messageId: string }> {
    if (!this.config.doseAvailable) throw new SubscribeMessageUnavailableError("dose subscription template is not configured");
    return this.postSubscribe({
      touser: message.openid,
      template_id: this.config.doseTemplateId,
      page: message.page === "" ? "pages/medication-plans/medication-plans" : message.page,
      miniprogram_state: this.config.miniprogramState,
      data: buildDoseReminderMessageData(message, this.config.doseFieldMap),
    });
  }

  private async postSubscribe(body: Record<string, unknown>): Promise<{ messageId: string }> {
    const accessToken = await this.getAccessToken();
    const url = new URL("https://api.weixin.qq.com/cgi-bin/message/subscribe/send");
    url.searchParams.set("access_token", accessToken);
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
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
    doseTemplateId: process.env.WECHAT_DOSE_REMINDER_TEMPLATE_ID ?? "",
    doseFieldMap: readFieldMap(process.env.WECHAT_DOSE_REMINDER_FIELD_MAP),
    miniprogramState: process.env.WECHAT_MINIPROGRAM_STATE,
  });
}
