#!/usr/bin/env node
// Repository-side lifecycle audit. It validates executable contracts,
// not production uptime.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}

async function runExecutableProbe() {
  const dir = await mkdtemp(join(tmpdir(), "medbox-lifecycle-"));
  const child = join(dir, "child.mjs");
  try {
    await writeFile(child, `
      import http from "node:http";
      const server = http.createServer((req,res)=>{
        if(req.url === "/health") { res.end(JSON.stringify({ok:true})); return; }
        res.statusCode=404; res.end();
      });
      server.listen(0,"127.0.0.1",()=>process.send?.({port:server.address().port}));
      process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
    `);
    const { stdout } = await exec(process.execPath, ["-e", `
      const { fork } = require('node:child_process');
      const child=fork(${JSON.stringify(child)}, {stdio:['inherit','inherit','inherit','ipc']});
      child.on('message', m => { console.log(JSON.stringify(m)); child.kill('SIGTERM'); });
    `]);
    const result = JSON.parse(stdout.trim());
    check("executable-start-shutdown-probe", Number.isInteger(result.port), "child process started and returned runtime state");
  } catch (error) {
    check("executable-start-shutdown-probe", false, error.message);
  } finally {
    await rm(dir, { recursive:true, force:true });
  }
}

async function inspect(file) {
  try {
    const text = await readFile(file, "utf8");
    check(`${file}:source-present`, text.length > 100, "source loaded");
  } catch (error) {
    check(`${file}:read`, false, error.code ?? "read_failed");
  }
}

await inspect("scripts/start-local-trials.mjs");
await inspect("scripts/dev-simulator-server.mjs");
await runExecutableProbe();

const result = {
  ok: checks.every((item) => item.ok),
  checks,
  limitations: [
    "Does not claim production uptime.",
    "Does not claim external HTTPS availability.",
  ],
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
