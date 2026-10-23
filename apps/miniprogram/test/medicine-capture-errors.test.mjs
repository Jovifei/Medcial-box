import assert from "node:assert/strict";
import test from "node:test";
import { loadPage, makePageContext } from "./runtime.mjs";
import { ownedPhotoFixture } from "./support/owned-photo-fixture.mjs";

class ApiError extends Error {
  constructor(code, message = "Synthetic request failure") { super(message); this.code = code; }
}
function fixture({ scan, choose, read, login, recognize, lookup, compress, info, toast } = {}) {
  const native = ownedPhotoFixture();
  if (read) native.getFileSystemManager().readFile = read;
  let lookups = 0;
  let recognitions = 0;
  const { definition } = loadPage("pages/medicine-edit/medicine-edit.ts", {
    setTimeoutFn: () => 0,
    modules: {
      "../../services/auth": { ensureLoggedIn: login ?? (async () => {}) },
      "../../services/api": { ApiError, api: {
        async findMedicineCandidates() { lookups++; return lookup ? lookup() : { candidates: [], warnings: [] }; },
        async recognizeMedicine() { recognitions++; return recognize ? recognize() : { draft: {}, warnings: [] }; },
      } },
    },
    wx: { ...native, scanCode: scan, chooseMedia: choose ?? (async () => ({ tempFiles: [{ tempFilePath: "/synthetic.jpg", size: 4 }] })),
      ...(compress ? { compressImage: compress } : {}), ...(info ? { getFileInfo: info } : {}),
      ...(toast ? { showToast: toast } : {}) },
  });
  const page = makePageContext(definition);
  page.onLoad({});
  return { page, lookups: () => lookups, recognitions: () => recognitions };
}

test("large original photo is compressed before the upload limit is applied", async () => {
  let compressed = false;
  const f = fixture({
    choose: async () => ({ tempFiles: [{ tempFilePath: "/large.jpg", size: 6 * 1024 * 1024 }] }),
    compress: options => { compressed = true; options.success({ tempFilePath: "/small.jpg" }); },
  });
  await f.page.onRecognizePhoto("camera");
  assert.equal(compressed, true);
  assert.equal(f.recognitions(), 1);
});

test("photo still over 4 MB after compression never reaches recognition", async () => {
  const toasts = [];
  const f = fixture({
    choose: async () => ({ tempFiles: [{ tempFilePath: "/large.jpg", size: 6 * 1024 * 1024 }] }),
    compress: options => options.success({ tempFilePath: "/still-large.jpg" }),
    read: options => options.success({ data: "/9j/" + "A".repeat(6 * 1024 * 1024) }),
    toast: options => toasts.push(options.title),
  });
  await f.page.onRecognizePhoto("camera");
  assert.equal(f.recognitions(), 0);
  assert.match(toasts.join(" "), /超过 4MB/);
});

test("oversized compressed photo is rejected before base64 allocation when file info is available", async () => {
  let reads = 0;
  const f = fixture({
    choose: async () => ({ tempFiles: [{ tempFilePath: "/large.jpg", size: 6 * 1024 * 1024 }] }),
    compress: options => options.success({ tempFilePath: "/compressed.jpg" }),
    info: options => options.success({ size: 5 * 1024 * 1024 }),
    read: () => { reads++; },
  });
  await f.page.onRecognizePhoto("camera");
  assert.equal(reads, 0);
  assert.equal(f.recognitions(), 0);
});

test("failed compression rejects an oversized original before reading it", async () => {
  let reads = 0;
  const toasts = [];
  const f = fixture({
    choose: async () => ({ tempFiles: [{ tempFilePath: "/large.jpg", size: 6 * 1024 * 1024 }] }),
    compress: options => options.fail({ errMsg: "synthetic compression failure" }),
    read: () => { reads++; },
    toast: options => toasts.push(options.title),
  });
  await f.page.onRecognizePhoto("camera");
  assert.equal(reads, 0);
  assert.equal(f.recognitions(), 0);
  assert.match(toasts.join(" "), /超过 4MB/);
});

for (const method of ["onScanCode", "onRetryBarcodeLookup"]) {
  for (const [code, expected] of [["UNAUTHORIZED", /登录已失效/], ["NETWORK_ERROR", /网络连接失败/]]) {
    test(`${method} distinguishes ${code} only after a code is retained`, async () => {
      const f = fixture({ scan: options => options.success({ result: "6900000000012" }), lookup: async () => { throw new ApiError(code); } });
      if (method === "onRetryBarcodeLookup") f.page.data.scannedBarcode = "6900000000012";
      await f.page[method]();
      assert.equal(f.lookups(), 1);
      assert.match(f.page.data.barcodeLookupStatus, expected);
      assert.match(f.page.data.recognitionHint, /已保留/);
      assert.equal(f.page.data.scannedBarcode, "6900000000012");
    });
  }
}

for (const [kind, errMsg, expected] of [
  ["permission", "scanCode:fail auth deny PRIVATE", /权限/],
  ["cancel", "scanCode:fail cancel", /取消/],
  ["hardware", "scanCode:fail camera unavailable PRIVATE", /未读取|未读到/],
]) {
  test(`scan ${kind} before any result never claims a retained barcode`, async () => {
    const f = fixture({ scan: options => options.fail({ errMsg }) });
    await f.page.onScanCode();
    assert.equal(f.lookups(), 0);
    assert.equal(f.page.data.scannedBarcode, "");
    assert.equal(f.page.data.canRetryBarcode, false);
    assert.match(f.page.data.recognitionHint, expected);
    assert.doesNotMatch(f.page.data.barcodeLookupStatus + f.page.data.recognitionHint, /已保留|已扫到|PRIVATE/);
  });
}

test("empty scanner result clears a stale lookup status without making a request", async () => {
  const f = fixture({ scan: options => options.success({ result: " " }) });
  f.page.data.barcodeLookupStatus = "正在查询候选资料…";
  await f.page.onScanCode();
  assert.equal(f.lookups(), 0);
  assert.match(f.page.data.barcodeLookupStatus, /没有读到条码/);
  assert.equal(f.page.data.canRetryBarcode, false);
});

for (const [kind, options, expected] of [
  ["permission", { choose: async () => { throw { errMsg: "chooseMedia:fail auth deny PRIVATE" }; } }, /权限/],
  ["cancel", { choose: async () => { throw { errMsg: "chooseMedia:fail cancel" }; } }, /取消/],
  ["read", { read: options => options.fail({ errMsg: "readFile:fail PRIVATE" }) }, /照片读取失败/],
  ["network", { recognize: async () => { throw new ApiError("NETWORK_ERROR"); } }, /网络连接失败/],
  ["authentication", { recognize: async () => { throw new ApiError("UNAUTHORIZED"); } }, /登录/],
  ["model", { recognize: async () => { throw new ApiError("RECOGNITION_UNAVAILABLE", "识别模型当前资源不足，请稍后重试"); } }, /资源不足/],
]) {
  test(`photo ${kind} has an actionable category without inventing inventory`, async () => {
    const f = fixture(options);
    await f.page.onRecognizePhoto("camera");
    assert.match(f.page.data.recognitionHint, expected);
    assert.doesNotMatch(f.page.data.recognitionHint, /PRIVATE/);
    assert.equal(f.page.data.recognizing, false);
    if (["permission", "cancel", "read"].includes(kind)) {
      assert.equal(f.recognitions(), 0);
      assert.equal(f.page.data.photoDrafts.length, 0);
    }
  });
}
