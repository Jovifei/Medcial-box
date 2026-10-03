/**
 * 未保存草稿登记（R14）：
 * 有表单的页面在草稿变脏时登记「说明 + 保存动作」，供更新重启前统一处理，
 * 避免"提示先保存"却直接 applyUpdate 把草稿丢掉。
 *
 * 只保存引用，不落盘：目的是让更新链路在重启前能真正执行一次保存，
 * 而不是把提示当成保存措施。退出页面的草稿保护由各页的原生返回确认承担。
 */

export interface DirtyDraft {
  /** 面向用户的简短说明，用于更新弹窗。 */
  label: string;
  /** 执行保存；失败时必须抛错，调用方据此延期更新，不重启。 */
  save: () => Promise<void>;
}

let current: DirtyDraft | null = null;

export function registerDirtyDraft(draft: DirtyDraft): void {
  current = draft;
}

export function clearDirtyDraft(expected?: DirtyDraft): void {
  if (expected !== undefined && current !== expected) return;
  current = null;
}

export function hasDirtyDraft(): boolean {
  return current !== null;
}

export function peekDirtyDraft(): DirtyDraft | null {
  return current;
}
