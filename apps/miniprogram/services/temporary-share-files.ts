import { scopedStorageKey } from "./session-scope";

/** Only paths we created and durably registered may be removed after sharing. */
export function temporaryShareScope(): string | null {
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
export function registerTemporaryShareFile(path: string, scopeKey?: string | null): boolean {
  const storageKey = scopeKey === undefined ? temporaryShareScope() : scopeKey;
  if (!storageKey || !owned(path)) return false;
  try {
    const files = readList(storageKey);
    if (!files.includes(path)) files.push(path);
    wx.setStorageSync(storageKey, files);
    const verified = readList(storageKey);
    return verified.includes(path);
  } catch { return false; }
}
export async function cleanupTemporaryShareFile(path: string, scopeKey?: string | null): Promise<boolean> {
  const storageKey = scopeKey === undefined ? temporaryShareScope() : scopeKey;
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
/**
 * A cold-start sweep is intentionally scoped to the *currently authenticated*
 * household. It cannot inspect another household's receipts, and MUST NOT
 * report a global cleanup success just because this household has no files.
 */
export interface TemporaryShareRecovery {
  scopeStatus: "clean" | "pending" | "no_identity";
  inspectedCount: number;
  allHouseholds: "not_verified";
}
export async function recoverTemporaryShareFiles(): Promise<TemporaryShareRecovery> {
  const pending = (inspectedCount: number): TemporaryShareRecovery =>
    ({ scopeStatus: "pending", inspectedCount, allHouseholds: "not_verified" });
  const storageKey = temporaryShareScope();
  if (!storageKey) return { scopeStatus: "no_identity", inspectedCount: 0, allHouseholds: "not_verified" };
  let files: string[];
  try { files = readList(storageKey); } catch { return pending(0); }
  const results = await Promise.all(files.map(path => cleanupTemporaryShareFile(path, storageKey)));
  if (temporaryShareScope() !== storageKey || !results.every(Boolean)) return pending(files.length);
  // "clean" applies solely to this household. Other scoped receipts remain
  // untouched and unverified, even if the caller cold-starts under a new login.
  return { scopeStatus: "clean", inspectedCount: files.length, allHouseholds: "not_verified" };
}
