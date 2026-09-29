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
