import assert from "node:assert/strict";
import test from "node:test";

const module = await import("../dist/services/subscribe-messages.js").catch(() => null);

test("subscription delivery stays blocked until credentials, a real template and fields are configured", () => {
  assert.ok(module, "subscribe message service has not been implemented");
  const missing = module.createReminderTemplateConfig({ appId: "", appSecret: "", templateId: "" });
  assert.equal(missing.available, false);
  assert.equal(missing.templates.length, 0);
  const configured = module.createReminderTemplateConfig({
    appId: "wx-test",
    appSecret: "secret-test",
    templateId: "template-test",
    fieldMap: { title: "thing1", time: "time2", remark: "thing3" },
  });
  assert.equal(configured.available, true);
  assert.deepEqual(configured.templates.map((item) => item.templateId), ["template-test"]);
});

test("message content is minimal and uses only configured template fields", () => {
  assert.ok(module, "subscribe message service has not been implemented");
  const data = module.buildReminderMessageData(
    { medicineName: "家庭测试药", deadlineDate: "2026-10-31", eventLabel: "7 天后到期" },
    { title: "thing1", time: "time2", remark: "thing3" },
  );
  assert.deepEqual(data, {
    thing1: { value: "家庭药箱有待处理事项" },
    time2: { value: "2026-10-31 09:00" },
    thing3: { value: "点击打开药箱查看" },
  });
  assert.equal(JSON.stringify(data).includes("家庭测试药"), false);
  assert.equal(JSON.stringify(data).includes("7 天后到期"), false);
  assert.equal(JSON.stringify(data).includes("剂量"), false);
});

test("sender exchanges an access token and sends one subscribed message", async () => {
  assert.ok(module, "subscribe message service has not been implemented");
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/cgi-bin/token")) {
      return new globalThis.Response(JSON.stringify({ access_token: "temporary-token", expires_in: 7200 }), { status: 200 });
    }
    return new globalThis.Response(JSON.stringify({ errcode: 0, msgid: "msg-1" }), { status: 200 });
  };
  const config = module.createReminderTemplateConfig({
    appId: "wx-test",
    appSecret: "secret-test",
    templateId: "template-test",
    fieldMap: { title: "thing1", time: "time2", remark: "thing3" },
  });
  const sender = new module.WechatSubscribeMessageSender(config, fetchFn);
  const result = await sender.send({
    openid: "openid-test",
    page: "pages/pending/pending",
    medicineName: "家庭测试药",
    deadlineDate: "2026-10-31",
    eventLabel: "7 天后到期",
  });
  assert.deepEqual(result, { messageId: "msg-1" });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.body.includes("openid-test"), true);
  assert.equal(calls[1].init.body.includes("secret-test"), false);
  assert.equal(calls[1].init.body.includes("家庭测试药"), false);
  assert.equal(calls[1].init.body.includes("7 天后到期"), false);
});

test("default config wires dose template from dedicated environment variables", () => {
  assert.ok(module, "subscribe message service has not been implemented");
  const original = {
    appId: process.env.WECHAT_APP_ID,
    appSecret: process.env.WECHAT_APP_SECRET,
    templateId: process.env.WECHAT_REMINDER_TEMPLATE_ID,
    doseTemplateId: process.env.WECHAT_DOSE_REMINDER_TEMPLATE_ID,
    doseFieldMap: process.env.WECHAT_DOSE_REMINDER_FIELD_MAP,
    state: process.env.WECHAT_MINIPROGRAM_STATE,
  };
  try {
    process.env.WECHAT_APP_ID = "wx1f6dd99d28aab8e5";
    process.env.WECHAT_APP_SECRET = "server-side-only";
    process.env.WECHAT_REMINDER_TEMPLATE_ID = "stock-template";
    process.env.WECHAT_DOSE_REMINDER_TEMPLATE_ID = "dose-template";
    process.env.WECHAT_DOSE_REMINDER_FIELD_MAP = JSON.stringify({ title: "thing1", time: "time2", remark: "thing4" });
    process.env.WECHAT_MINIPROGRAM_STATE = "trial";
    const config = module.createDefaultReminderTemplateConfig();
    assert.equal(config.available, true, "库存提醒可用");
    assert.equal(config.doseAvailable, true, "服药提醒模板必须能从独立环境变量读入");
    assert.equal(config.doseTemplateId, "dose-template");
    assert.deepEqual(config.templates.map((item) => item.templateId), ["stock-template", "dose-template"]);
    assert.equal(config.miniprogramState, "trial");

    // 只配库存模板：服药提醒如实不可用，不互相拖累
    delete process.env.WECHAT_DOSE_REMINDER_TEMPLATE_ID;
    delete process.env.WECHAT_DOSE_REMINDER_FIELD_MAP;
    const stockOnly = module.createDefaultReminderTemplateConfig();
    assert.equal(stockOnly.available, true);
    assert.equal(stockOnly.doseAvailable, false);
    assert.deepEqual(stockOnly.templates.map((item) => item.templateId), ["stock-template"]);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("dose reminder body never carries medicine name or dosage", () => {
  assert.ok(module, "subscribe message service has not been implemented");
  const data = module.buildDoseReminderMessageData(
    { doseDate: "2026-10-02", timeText: "08:00" },
    { title: "thing1", time: "time2", remark: "thing3" },
  );
  assert.deepEqual(data, {
    thing1: { value: "有一项用药安排待确认" },
    time2: { value: "2026-10-02 08:00" },
    thing3: { value: "点击打开用药计划确认" },
  });
  assert.equal(JSON.stringify(data).includes("退烧药"), false);
  assert.equal(JSON.stringify(data).includes("5ml"), false);
  assert.equal(JSON.stringify(data).includes("剂量"), false);
});
