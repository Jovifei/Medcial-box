// 本地会话身份命名空间：本机存储的键必须绑定 userId + familyId，
// 否则换账号/换家庭后上一个家庭的草稿会被下一个账号直接看到甚至保存。
// 身份与生命周期：
//   - ensureLoggedIn 成功 resolving /api/v1/auth/me 后由 auth.ts 写入；
//   - logout（含服务端撤销失败）必须清除，避免留在无令牌的旧身份上；
//   - 读取优先命中内存，本地存储抛错时仍保证本次会话可用。
export interface SessionScope {
  userId: string;
  /** 尚未加入/创建家庭的账号为空字符串。 */
  familyId: string;
}

const SESSION_SCOPE_STORAGE_KEY = "home_medicine_session_scope";

let memoryScope: SessionScope | null = null;

export function readSessionScope(): SessionScope | null {
  if (memoryScope !== null) return memoryScope;
  try {
    const raw = wx.getStorageSync(SESSION_SCOPE_STORAGE_KEY) as SessionScope | undefined;
    if (raw === undefined || raw === null || typeof raw !== "object") return null;
    if (typeof raw.userId !== "string" || typeof raw.familyId !== "string") return null;
    memoryScope = { userId: raw.userId, familyId: raw.familyId };
    return memoryScope;
  } catch {
    return null;
  }
}

export function writeSessionScope(scope: SessionScope): void {
  memoryScope = scope;
  try {
    wx.setStorageSync(SESSION_SCOPE_STORAGE_KEY, scope);
  } catch {
    // 本地存储不可用时保留内存副本，本次会话仍然隔离。
  }
}

export function clearSessionScope(): void {
  memoryScope = null;
  try {
    wx.removeStorageSync(SESSION_SCOPE_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** 仅测试使用：回到冷启动状态（无身份）。 */
export function __resetSessionScopeForTest(): void {
  memoryScope = null;
}

/**
 * 构造身份化的本地存储键。没有可用身份时返回 null——调用方必须据此
 * 禁用草稿读写，而不是退回全局键（退回即等于跨账号共享数据）。
 */
export function scopedStorageKey(namespace: string, entityId = ""): string | null {
  const scope = readSessionScope();
  if (scope === null) return null;
  return `${namespace}:${scope.userId}:${scope.familyId === "" ? "no-family" : scope.familyId}:${entityId === "" ? "new" : entityId}`;
}
