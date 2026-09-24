-- P2 一次性邀请凭据（D2：文本邀请码）。明文只出现一次，库存 sha256；72 小时失效、一次性消费。
-- 原子消费语义：UPDATE ... SET used_at = now() WHERE token_hash = ? AND used_at IS NULL AND expires_at > now()
-- 的 rowCount 判定防复用；已消费以 used_at 非空 + used_by 记录，不引入独立 status 列（从设计文档 §2.2 安排）。
-- 剂量备注的"全家可见"自 002 起即由 dosage_notes.visibility（'private' | 'family'）承载，无需在本迁移 ALTER。

CREATE TABLE family_invites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id  uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES users(id),     -- 仅 owner 可创建
  expires_at timestamptz NOT NULL,                   -- created_at + 72h
  used_at    timestamptz,                            -- 非空即已消费，不可复用
  used_by    uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_invites_family ON family_invites(family_id);
