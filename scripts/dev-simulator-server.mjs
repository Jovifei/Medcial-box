// 本机模拟器联调服务器：真实 API 代码 + 真实 PostgreSQL + 开发用微信网关。
// 用途：在微信开发者工具模拟器里完整跑通登录与全部业务页面，无需 AppSecret。
// 运行：
//   DATABASE_URL=postgres://postgres:medboxtest@127.0.0.1:55432/medbox_dev \
//   node scripts/dev-simulator-server.mjs [port]
// 说明：
// - DevAnyCodeGateway 把任意 wx.login code 映射为固定 openid（dev-openid-local），
//   仅供本机开发联调；多端各登各的会共享同一账号。真实换码仍需 AppSecret。
// - 数据库需先执行迁移：DATABASE_URL=... node apps/api/dist/migrate.js
// - 小程序端把 services/api.ts 的 API_BASE 指向 http://127.0.0.1:<port>，
//   并在 project.private.config.json 关闭 urlCheck（两者均为本机覆盖，不入库）。
import { buildServer } from "../apps/api/dist/app.js";
import { FakeWechatGateway } from "../apps/api/dist/auth/wechat.js";
import { createDatabasePool, createDatabaseAdapter } from "../apps/api/dist/db.js";

const PORT = Number(process.argv[2] ?? 13300);
const DEV_OPENID = process.env.DEV_OPENID ?? "dev-openid-local";

class DevAnyCodeGateway extends FakeWechatGateway {
  async code2Session(code) {
    if (!code || typeof code !== "string") {
      return super.code2Session(code);
    }
    return { openid: DEV_OPENID, sessionKey: null, unionid: null };
  }
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("缺少 DATABASE_URL（指向已迁移的开发库，如 postgres://...127.0.0.1:55432/medbox_dev）");
  process.exit(1);
}

const pool = createDatabasePool(databaseUrl);
const database = createDatabaseAdapter(pool);
const app = await buildServer({
  database,
  wechatGateway: new DevAnyCodeGateway(),
  logger: true,
});

await app.listen({ host: "127.0.0.1", port: PORT });
console.info(`dev-simulator-server listening on http://127.0.0.1:${PORT}（openid=${DEV_OPENID}）`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
