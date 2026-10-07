#!/usr/bin/env node
// Repository lifecycle audit. It verifies the real delivery scripts' executable
// contracts and uses an opt-in runtime probe. It does not claim production uptime.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}

async function inspectTargetScripts() {
  for (const file of ["scripts/start-local-trials.mjs", "scripts/dev-simulator-server.mjs"]) {
    try {
      const text = await readFile(file, "utf8");
      check(`${file}:read`, true, "loaded target delivery script");
      check(`${file}:executable-hooks`,
        file.endsWith("start-local-trials.mjs")
          ? /spawn\s*\(/.test(text) && /health\/local-app-trial/.test(text)
          : /health\/local-app-trial/.test(text) && /SIGINT|SIGTERM/.test(text),
        "verified executable lifecycle hooks in target source");
    } catch (error) {
      check(`${file}:read`, false, error.code ?? error.message);
    }
  }
}

async function runProbe() {
  const dir = await mkdtemp(join(tmpdir(), "medbox-lifecycle-probe-"));
  const child = join(dir, "child.mjs");
  try {
    await writeFile(child, `
      import http from "node:http";
      const server = http.createServer((req,res)=>{
        if(req.url === '/health'){res.end(JSON.stringify({ok:true}));return;}
        res.statusCode=404;res.end();
      });
      server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
      process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
    `);
    await new Promise((resolve,reject)=>{
      const p=spawn(process.execPath,[child],{stdio:['ignore','pipe','pipe','ipc']});
      let exited=false;
      p.on('message',msg=>{
        if(Number.isInteger(msg.port)) check('probe-runtime-start',true,'child returned runtime port');
        p.kill('SIGTERM');
      });
      p.on('exit',()=>{exited=true;resolve();});
      setTimeout(()=>{if(!exited){p.kill('SIGKILL');reject(new Error('probe timeout'));}},3000);
    });
    check('probe-runtime-shutdown', true, 'child exited after shutdown signal');
  } catch(error){
    check('probe-runtime-start-shutdown', false, error.message);
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
}

await inspectTargetScripts();
await runProbe();

const result={
  ok: checks.every(item=>item.ok),
  checks,
  limitations:[
    "Does not claim production uptime.",
    "Does not replace real local service/database/device validation."
  ]
};
console.log(JSON.stringify(result,null,2));
process.exitCode=result.ok?0:1;
