// 合成数据库池：按 SQL 片段路由、可编程结果的内存池。
// - on(pattern, ...results)：FIFO 队列，每次匹配消耗一条结果；
// - always(pattern, result)：粘性结果，适合被反复执行的认证/成员关系查询；
// - 未命中任何脚本时默认返回 { rows: [], rowCount: 0 }；
// - calls 记录全部 (sql, params) 供测试断言关键谓词（family_id、version、token_hash 等）。
// BEGIN / COMMIT / ROLLBACK 自动放行（事务无需脚本）。

function normalizeResult(result, sql, params) {
  const resolved = typeof result === "function" ? result(sql, params) : result;
  if (Array.isArray(resolved)) {
    return { rows: resolved, rowCount: resolved.length };
  }
  if (resolved === undefined || resolved === null) {
    return { rows: [], rowCount: 0 };
  }
  if (resolved.rowCount === undefined) {
    return { rows: resolved.rows ?? [], rowCount: (resolved.rows ?? []).length };
  }
  return resolved;
}

export function createFakePool() {
  const calls = [];
  const fifoScripts = [];
  const stickyScripts = [];

  const pool = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      const upper = normalized.toUpperCase();
      if (upper === "BEGIN" || upper === "COMMIT" || upper === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      const fifo = fifoScripts.find(
        (entry) => entry.pattern.test(normalized) && entry.results.length > 0,
      );
      if (fifo) return normalizeResult(fifo.results.shift(), normalized, params);
      const sticky = stickyScripts.find((entry) => entry.pattern.test(normalized));
      if (sticky) return normalizeResult(sticky.result, normalized, params);
      return { rows: [], rowCount: 0 };
    },
    on(pattern, ...results) {
      fifoScripts.push({ pattern, results });
      return pool;
    },
    always(pattern, result) {
      const key = pattern.toString();
      const existing = stickyScripts.findIndex((entry) => entry.pattern.toString() === key);
      if (existing >= 0) stickyScripts[existing].result = result;
      else stickyScripts.push({ pattern, result });
      return pool;
    },
    calls,
    callsMatching(pattern) {
      return calls.filter((entry) => pattern.test(entry.sql));
    },
  };
  return pool;
}
