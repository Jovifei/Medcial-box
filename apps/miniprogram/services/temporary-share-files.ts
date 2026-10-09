import { scopedStorageKey } from "./session-scope";

/** Only paths we created and durably registered may be removed after sharing. */
function key(): string | null {
  return scopedStorageKey("temporary-shared-files");
}
function owned(path: string): boolean {
  const root = wx.env?.USER_DATA_PATH;
  if (!root || !path.startsWith(`${root}/home-medicine-share-`)) return false;
  const basename = path.slice(root.length + 1);
  return /^home-medicine-share-[A-Za-z0-9_-]{12,120}\.(?:json|md|csv|pdf)$/.test(basename);
}
function readList(storageKey: string): string[] {
  const value = wx.getStorageSync(storageKey) as unknown;
  if (value === undefined || value === "") return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !owned(item))) {
    throw new Error("临时分享文件记录无效，未操作本机文件");
  }
  return [...new Set(value as string[])];
}
export function registerTemporaryShareFile(path: string): boolean {
  const storageKey = key();
  if (!storageKey || !owned(path)) return false;
  try {
    const files = readList(storageKey);
    if (!files.includes(path)) files.push(path);
    wx.setStorageSync(storageKey, files);
    const verified = readList(storageKey);
    return verified.includes(path);
  } catch { return false; }
}
export async function cleanupTemporaryShareFile(path: string): Promise<boolean> {
  const storageKey = key();
  if (!storageKey || !owned(path)) return false;
  let files: string[];
  try { files = readList(storageKey); } catch { return false; }
  if (!files.includes(path)) return false; // never unlink paths not durably registered
  const removed = await new Promise<boolean>(resolve => {
    try {
      wx.getFileSystemManager().unlink({
        filePath: path, success: () => resolve(true),
        fail: result => resolve(/no such file|not found|ENOENT/i.test(result.errMsg ?? "")),
      });
    } catch { resolve(false); }
  });
  if (!removed) return false;
  try {
    wx.setStorageSync(storageKey, files.filter(file => file !== path));
    return !readList(storageKey).includes(path);
  } catch { return false; }
}
export async function recoverTemporaryShareFiles(): Promise<boolean> {
  const storageKey = key();
  if (!storageKey) return false;
  let files: string[];
  try { files = readList(storageKey); } catch { return false; }
  const results = await Promise.all(files.map(cleanupTemporaryShareFile));
  return results.every(Boolean);
}
