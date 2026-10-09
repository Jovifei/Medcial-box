import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { installGracefulShutdown } from "../dist/lifecycle.js";

test("AUD-12 actual Fastify listen + SIGTERM triggers exactly one onClose/resource cleanup",async()=>{
  const signals=new EventEmitter();
  const app=Fastify({logger:false});
  let closed=0;
  let release;
  const finished=new Promise(resolve=>{release=resolve;});
  app.get("/health",async()=>({status:"ok"}));
  app.addHook("onClose",async()=>{closed++;release();});
  const detach=installGracefulShutdown(app,signals,()=>{throw new Error("close failed");});
  const address=await app.listen({host:"127.0.0.1",port:0});
  const live=await fetch(address+"/health");
  assert.equal(live.status,200);
  signals.emit("SIGTERM");
  signals.emit("SIGINT");
  await finished;
  await app.close();
  assert.equal(closed,1);
  detach();
  assert.equal(signals.listenerCount("SIGINT"),0);
  assert.equal(signals.listenerCount("SIGTERM"),0);
  await assert.rejects(fetch(address+"/health"));
});
