// 假微信网关注册辅助：基于 dist 中的 FakeWechatGateway，供各测试统一构造。
import { FakeWechatGateway } from "../../dist/auth/wechat.js";

export function createTestGateway(codeMapping = {}) {
  const gateway = new FakeWechatGateway();
  for (const [code, openid] of Object.entries(codeMapping)) {
    gateway.registerCode(code, openid);
  }
  return gateway;
}
