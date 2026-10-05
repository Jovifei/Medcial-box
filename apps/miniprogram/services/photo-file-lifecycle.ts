/** WeChat callback APIs (minimum SDK 2.16.1), not Node/browser filesystem semantics. */
export interface OwnedPhotoFile {
  scopeKey: string;
  draftId: string;
  path: string;
  state?: "reserved" | "ready";
  byteLength?: number;
}

type PhotoFileSystem = Pick<WechatMiniprogram.FileSystemManager, "open" | "write" | "close" | "unlink">;
interface FileLease {
  owner: OwnedPhotoFile;
  fs: PhotoFileSystem;
  fd: string;
  canClose: boolean;
  writerActive: boolean;
  closed: boolean;
  closing: Promise<boolean> | null;
}
const leases = new Map<string, FileLease>();

export class PhotoFileWriteError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function supportsOwnedPhotoFiles(fs: PhotoFileSystem, sdkVersion: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(sdkVersion)) return false;
  const [major, minor, patch] = sdkVersion.split(".").map(Number);
  const modern = major > 2 || (major === 2 && (minor > 16 || (minor === 16 && patch >= 1)));
  return modern && [fs.open, fs.write, fs.close, fs.unlink].every((method) => typeof method === "function");
}

async function settleClose(lease: FileLease): Promise<boolean> {
  if (lease.closed) return true;
  if (lease.closing) return lease.closing;
  const closing = new Promise<boolean>((resolve) => {
    try { lease.fs.close({ fd: lease.fd, success: () => resolve(true), fail: () => resolve(false) }); }
    catch { resolve(false); }
  });
  lease.closing = closing;
  const closed = await closing;
  lease.closed = closed;
  lease.closing = null;
  if (closed && !lease.writerActive && leases.get(lease.owner.path) === lease) leases.delete(lease.owner.path);
  return closed;
}

/** Retry only an exact recorded handle. A writer retains its lease through the ready commit. */
export async function closeOwnedPhotoFile(owner: OwnedPhotoFile): Promise<boolean> {
  const lease = leases.get(owner.path);
  if (!lease) return true; // A new process has no live handle from the previous one.
  if (lease.owner.scopeKey !== owner.scopeKey || lease.owner.draftId !== owner.draftId ||
      !lease.canClose || lease.writerActive) return false;
  return settleClose(lease);
}

interface WritePhotoOptions {
  fs: PhotoFileSystem;
  sdkVersion: string;
  root: string;
  scopeKey: string;
  draftId: string;
  purpose: "box_front" | "expiry";
  mimeType: "image/jpeg" | "image/png";
  data: ArrayBuffer;
  isCurrent: () => boolean;
  /** Must synchronously acknowledge durable ownership BEFORE any private bytes are written. */
  register: (owner: OwnedPhotoFile) => boolean;
  /** Must acknowledge durable ready state; false leaves the reserved record in place. */
  markReady: (owner: OwnedPhotoFile) => boolean;
}

export async function writeOwnedPhotoFile(options: WritePhotoOptions): Promise<OwnedPhotoFile> {
  const { fs, sdkVersion, scopeKey, draftId, purpose, mimeType, data, isCurrent } = options;
  if (!supportsOwnedPhotoFiles(fs, sdkVersion)) {
    throw new PhotoFileWriteError("PHOTO_STORAGE_UNAVAILABLE", "当前微信版本不支持安全保存照片草稿，请升级微信或手动录入。");
  }
  const root = options.root.replace(/\/+$/, "");
  if (!root || root.includes("\0") || !scopeKey || !/^photo-\d+-[a-z0-9]{1,6}$/.test(draftId) ||
      !["box_front", "expiry"].includes(purpose) || !["image/jpeg", "image/png"].includes(mimeType) ||
      !Number.isSafeInteger(data.byteLength) || data.byteLength <= 0 || data.byteLength > 4 * 1024 * 1024) {
    throw new PhotoFileWriteError("PHOTO_STORAGE_INPUT", "照片草稿参数无效，请重新选择照片。");
  }
  const path = `${root}/${draftId}-${purpose}-${Date.now()}.${mimeType === "image/png" ? "png" : "jpg"}`;
  const owner: OwnedPhotoFile = { path, scopeKey, draftId, state: "reserved", byteLength: data.byteLength };
  const stale = (): PhotoFileWriteError => new PhotoFileWriteError("PHOTO_STORAGE_STALE", "登录身份已变化，照片未继续保存。");
  if (!isCurrent()) throw stale();
  if (leases.has(path)) throw new PhotoFileWriteError("PHOTO_STORAGE_COLLISION", "本机照片文件正在使用，请稍后重试。");
  let fd: string;
  try {
    fd = await new Promise<string>((resolve, reject) => fs.open({ filePath: path, flag: "wx",
      success: (result) => resolve(result.fd), fail: reject }));
  } catch {
    // No receipt, unlink, or fallback write on an unsuccessful exclusive create.
    throw new PhotoFileWriteError("PHOTO_STORAGE_OPEN", "无法安全创建照片文件，原有文件未修改，请稍后重试。");
  }
  if (typeof fd !== "string" || fd === "") {
    throw new PhotoFileWriteError("PHOTO_STORAGE_HANDLE", "照片文件句柄无效，未写入照片。");
  }
  const lease: FileLease = { owner, fs, fd, canClose: false, writerActive: true, closed: false, closing: null };
  leases.set(path, lease);
  try {
    let writeStarted = false;
    let failure: PhotoFileWriteError | undefined;
    try {
      if (!isCurrent()) throw stale();
      if (!options.register({ ...owner })) {
        throw new PhotoFileWriteError("PHOTO_STORAGE_REGISTER", "本机草稿登记失败，未写入照片，请重试或手动录入。");
      }
      if (!isCurrent()) throw stale();
      writeStarted = true;
      const bytesWritten = await new Promise<number>((resolve, reject) => fs.write({ fd, data, offset: 0,
        length: data.byteLength, position: 0, success: (result) => resolve(result.bytesWritten), fail: reject }));
      if (bytesWritten !== data.byteLength) {
        throw new PhotoFileWriteError("PHOTO_STORAGE_PARTIAL", "照片未完整写入，记录已保留，请重新选择照片。");
      }
      if (!isCurrent()) throw stale();
    } catch (error) {
      failure = error instanceof PhotoFileWriteError ? error
        : new PhotoFileWriteError("PHOTO_STORAGE_WRITE", "照片写入未完成，记录已保留，请重试。");
    } finally {
      lease.canClose = true;
      const closed = await settleClose(lease);
      if (!closed) failure ??= new PhotoFileWriteError("PHOTO_STORAGE_CLOSE", "照片文件尚未安全关闭，记录已保留。");
      if (closed && !writeStarted) {
        // This exact exclusive-create produced only an empty file; never delete a preexisting path.
        await new Promise<void>((resolve) => {
          try { fs.unlink({ filePath: path, success: () => resolve(), fail: () => resolve() }); }
          catch { resolve(); }
        });
      }
    }
    if (failure) throw failure;
    if (!isCurrent()) throw stale();
    const ready: OwnedPhotoFile = { ...owner, state: "ready" };
    try {
      if (options.markReady(ready)) return ready;
    } catch { /* The reserved ownership record remains the recovery boundary. */ }
    throw new PhotoFileWriteError("PHOTO_STORAGE_READY", "照片完成状态保存失败，记录已保留，请重试。");
  } finally {
    lease.writerActive = false;
    if (lease.closed && leases.get(path) === lease) leases.delete(path);
  }
}
