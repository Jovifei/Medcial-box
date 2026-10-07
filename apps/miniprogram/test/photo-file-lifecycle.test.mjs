import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers";
import { loadService } from "./runtime.mjs";

function harness(overrides = {}) {
  const service = loadService("services/photo-file-lifecycle.ts");
  const events = [];
  let owner;
  const fs = {
    open: options => { events.push(["open", options.flag]); options.success({ fd: "owned-fd" }); },
    write: options => { events.push(["write", options.fd]); options.success({ bytesWritten: options.data.byteLength }); },
    close: options => { events.push(["close", options.fd]); options.success({}); },
    unlink: options => { events.push(["unlink", options.filePath]); options.success({}); },
    ...overrides,
  };
  const options = {
    fs, sdkVersion: "3.17.3", root: "/synthetic-owned", scopeKey: "user-a:family-a", draftId: "photo-123-abc",
    purpose: "box_front", mimeType: "image/jpeg", data: new ArrayBuffer(8), isCurrent: () => true,
    register: value => { owner = value; events.push(["register", value.state]); return true; },
    markReady: value => { owner = value; events.push(["ready", value.state]); return true; },
  };
  return { service, fs, options, events, get owner() { return owner; } };
}

test("exclusive open, durable reserve, byte-counted write, close, durable ready are ordered", async () => {
  const h = harness();
  const ready = await h.service.writeOwnedPhotoFile(h.options);
  assert.deepEqual(h.events.map(event => event[0]), ["open", "register", "write", "close", "ready"]);
  assert.equal(h.events[0][1], "wx");
  assert.equal(ready.state, "ready");
  assert.equal(ready.byteLength, 8);
  assert.equal(h.owner.state, "ready");
});

test("unsupported SDK or missing primitive never opens or falls back to writeFile", async () => {
  for (const version of ["", "2.15.9", "2.16.0", "2.16.x", "2.16.1-beta"]) {
    const h = harness();
    h.options.sdkVersion = version;
    await assert.rejects(h.service.writeOwnedPhotoFile(h.options), error => error.code === "PHOTO_STORAGE_UNAVAILABLE");
    assert.equal(h.events.length, 0);
  }
  const h = harness({ close: undefined });
  await assert.rejects(h.service.writeOwnedPhotoFile(h.options), error => error.code === "PHOTO_STORAGE_UNAVAILABLE");
  assert.equal(h.events.length, 0);
  assert.equal(h.service.supportsOwnedPhotoFiles(harness().fs, "2.16.1"), true);
});

test("existing path rejection never registers, writes, closes or unlinks someone else's file", async () => {
  const h = harness({ open: options => options.fail({ errMsg: "file already exists" }) });
  await assert.rejects(h.service.writeOwnedPhotoFile(h.options), error => error.code === "PHOTO_STORAGE_OPEN");
  assert.equal(h.events.length, 0);
  assert.equal(h.owner, undefined);
});

test("failed durable registration closes and removes only the new empty original, writes nothing", async () => {
  const h = harness();
  h.options.register = () => false;
  await assert.rejects(h.service.writeOwnedPhotoFile(h.options), error => error.code === "PHOTO_STORAGE_REGISTER");
  assert.deepEqual(h.events.map(event => event[0]), ["open", "close", "unlink"]);
});

test("throwing registration (including lost acknowledgement) still writes zero private bytes", async () => {
  const h = harness();
  h.options.register = () => { throw new Error("storage acknowledgement lost"); };
  await assert.rejects(h.service.writeOwnedPhotoFile(h.options));
  assert.deepEqual(h.events.map(event => event[0]), ["open", "close", "unlink"]);
});

test("partial writes keep durable reserved state and never become ready", async () => {
  const h = harness({ write: options => options.success({ bytesWritten: 3 }) });
  await assert.rejects(h.service.writeOwnedPhotoFile(h.options), error => error.code === "PHOTO_STORAGE_PARTIAL");
  assert.equal(h.owner.state, "reserved");
  assert.equal(h.events.some(event => ["ready", "unlink"].includes(event[0])), false);
  assert.equal(h.events.filter(event => event[0] === "close").length, 1);
});

test("write error retains ownership, closes its descriptor and never marks ready", async () => {
  const h = harness({ write: options => options.fail({ errMsg: "disk full" }) });
  await assert.rejects(h.service.writeOwnedPhotoFile(h.options), error => error.code === "PHOTO_STORAGE_WRITE");
  assert.equal(h.owner.state, "reserved");
  assert.equal(h.events.at(-1)[0], "close");
  assert.equal(h.events.some(event => event[0] === "unlink"), false);
});

test("failed close keeps an exact live lease and allows only its owner to retry", async () => {
  let closes = 0;
  const h = harness({ close: options => { closes++; if (closes === 1) options.fail({}); else options.success({}); } });
  await assert.rejects(h.service.writeOwnedPhotoFile(h.options), error => error.code === "PHOTO_STORAGE_CLOSE");
  assert.equal(h.owner.state, "reserved");
  assert.equal(await h.service.closeOwnedPhotoFile({ ...h.owner, scopeKey: "foreign" }), false);
  assert.equal(closes, 1);
  assert.equal(await h.service.closeOwnedPhotoFile(h.owner), true);
  assert.equal(closes, 2);
});

test("cleanup cannot close a descriptor while its write is still in flight", async () => {
  let finish;
  const h = harness({ write: options => { finish = () => options.success({ bytesWritten: 8 }); } });
  const writing = h.service.writeOwnedPhotoFile(h.options);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await h.service.closeOwnedPhotoFile(h.owner), false);
  assert.equal(h.events.some(event => event[0] === "close"), false);
  finish();
  await writing;
  assert.equal(h.owner.state, "ready");
});

test("identity loss after open prevents registration and private write but closes owned fd", async () => {
  let current = true;
  const h = harness({ open: options => { current = false; options.success({ fd: "owned-fd" }); } });
  h.options.isCurrent = () => current;
  await assert.rejects(h.service.writeOwnedPhotoFile(h.options), error => error.code === "PHOTO_STORAGE_STALE");
  assert.deepEqual(h.events.map(event => event[0]), ["close", "unlink"]);
});

test("identity loss after write leaves reserved data without stale ready storage writes", async () => {
  let current = true;
  const h = harness({ write: options => { current = false; options.success({ bytesWritten: 8 }); } });
  h.options.isCurrent = () => current;
  await assert.rejects(h.service.writeOwnedPhotoFile(h.options), error => error.code === "PHOTO_STORAGE_STALE");
  assert.equal(h.owner.state, "reserved");
  assert.equal(h.events.at(-1)[0], "close");
  assert.equal(h.events.some(event => event[0] === "ready"), false);
});

test("failed ready acknowledgement cannot turn a reserved record into a confirmed photo", async () => {
  const h = harness();
  h.options.markReady = () => false;
  await assert.rejects(h.service.writeOwnedPhotoFile(h.options), error => error.code === "PHOTO_STORAGE_READY");
  assert.equal(h.owner.state, "reserved");
  assert.equal(h.events.at(-1)[0], "close");
});

test("cleanup is fenced between native close and the durable ready acknowledgement", async () => {
  const h = harness();
  let cleanup;
  h.options.markReady = owner => { cleanup = h.service.closeOwnedPhotoFile(owner); return true; };
  const ready = await h.service.writeOwnedPhotoFile(h.options);
  assert.equal(await cleanup, false);
  assert.equal(await h.service.closeOwnedPhotoFile(ready), true);
});

test("invalid owner, filename parts and byte counts never invoke the native filesystem", async () => {
  for (const values of [
    { root: "" }, { scopeKey: "" }, { draftId: "../foreign" }, { purpose: "../foreign" },
    { mimeType: "text/plain" }, { data: new ArrayBuffer(0) }, { data: new ArrayBuffer(4 * 1024 * 1024 + 1) },
  ]) {
    const h = harness();
    await assert.rejects(h.service.writeOwnedPhotoFile({ ...h.options, ...values }), error => error.code === "PHOTO_STORAGE_INPUT");
    assert.equal(h.events.length, 0);
  }
});

test("concurrent exact-owned close retries share one native close call", async () => {
  let closes = 0;
  let finish;
  const h = harness({ close: options => { closes++; if (closes === 1) options.fail({}); else finish = () => options.success({}); } });
  await assert.rejects(h.service.writeOwnedPhotoFile(h.options));
  const first = h.service.closeOwnedPhotoFile(h.owner);
  const second = h.service.closeOwnedPhotoFile(h.owner);
  assert.equal(closes, 2);
  finish();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});
