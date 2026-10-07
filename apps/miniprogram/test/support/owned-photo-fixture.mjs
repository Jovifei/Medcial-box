/** Synthetic callback primitives for the owned-file lifecycle; never native I/O. */
export function ownedPhotoFixture(root = "/synthetic-owned-fixture") {
  const storage = new Map(), files = new Set(), handles = new Map(); let sequence = 0;
  const fs = {
    readFile: options => options.success({ data: "/9j/2Q==" }),
    open: options => { if (options.flag !== "wx" || files.has(options.filePath)) return options.fail({ errMsg: "exists" });
      files.add(options.filePath); const fd = `synthetic-${++sequence}`; handles.set(fd, options.filePath); options.success({ fd }); },
    write: options => options.success({ bytesWritten: options.data.byteLength }),
    close: options => { handles.delete(options.fd); options.success({}); },
    unlink: options => { files.delete(options.filePath); options.success({}); },
  };
  return { env: { USER_DATA_PATH: root }, getSystemInfoSync: () => ({ SDKVersion: "3.17.3" }),
    base64ToArrayBuffer: () => new Uint8Array([1, 2, 3, 4]).buffer, getFileSystemManager: () => fs,
    getStorageSync: key => storage.has(key) ? structuredClone(storage.get(key)) : undefined,
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)), removeStorageSync: key => storage.delete(key),
  };
}
