-- P1 核心库存：用户、家庭、成员、会话、药品、批次、个人剂量备注。
-- 约定：数量 quantity NULL=未知，0=确定耗尽；有效期存原文 expiry_value + 精度 expiry_precision 两列。

CREATE TABLE users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  openid     text NOT NULL UNIQUE,               -- 微信 openid，登录幂等键
  nickname   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE families (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 每账号仅一个家庭：user_id 唯一约束即实现该不变量。
CREATE TABLE family_members (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  role      text NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_family_members_family ON family_members(family_id);

-- 数据库只存令牌 sha256 哈希与过期时间；明文令牌仅在登录响应返回一次。
CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,          -- sha256 hex
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE medicines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id        uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name             text NOT NULL,
  specification    text,
  manufacturer     text,
  approval_number  text,
  active_ingredients jsonb NOT NULL DEFAULT '[]'::jsonb,   -- string[]
  purpose_category text,
  -- 说明书摘要（手填）：来源 + 核验状态，未核验不进默认导出
  leaflet_purpose_summary       text,
  leaflet_package_usage_summary text,
  leaflet_contraindications_summary text,
  leaflet_precautions_summary   text,
  leaflet_source     text,
  leaflet_review_status text NOT NULL DEFAULT 'unverified'
      CHECK (leaflet_review_status IN ('unverified', 'matched', 'user_confirmed')),
  is_archived   boolean NOT NULL DEFAULT false,       -- 归档 = 软删除
  created_by    uuid NOT NULL REFERENCES users(id),
  updated_by    uuid NOT NULL REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 1            -- 并发控制，PUT 不匹配返回 409
);
CREATE INDEX idx_medicines_family ON medicines(family_id) WHERE NOT is_archived;

-- 批次冗余 family_id：批次级端点可直接校验归属，避免逐级 join 判断。
CREATE TABLE medicine_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  medicine_id   uuid NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  family_id     uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  lot_number    text,
  expiry_value  text,                                  -- 原文：'2026-10-31' / '2026-10' / NULL
  expiry_precision text NOT NULL DEFAULT 'unknown'
      CHECK (expiry_precision IN ('day', 'month', 'unknown')),
  quantity      integer CHECK (quantity IS NULL OR quantity >= 0),  -- NULL=未知，0=耗尽
  unit          text NOT NULL DEFAULT 'other'
      CHECK (unit IN ('tablet', 'capsule', 'sachet', 'bottle', 'box', 'other')),
  -- 盒→片/袋换算数：仅经用户确认后填写，未经确认不用于任何换算展示
  confirmed_units_per_package integer
      CHECK (confirmed_units_per_package IS NULL OR confirmed_units_per_package > 0),
  storage_location text,
  created_by    uuid NOT NULL REFERENCES users(id),
  updated_by    uuid NOT NULL REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 1
);
CREATE INDEX idx_batches_medicine ON medicine_batches(medicine_id);
CREATE INDEX idx_batches_family   ON medicine_batches(family_id);

-- 个人剂量备注：独立于药品通用说明；默认仅所属成员可见（visibility='private'）。
CREATE TABLE dosage_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  medicine_id uuid NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 备注所属成员
  content     text NOT NULL,                          -- 实际每日剂量等，纯手填
  visibility  text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'family')),
  created_by  uuid NOT NULL REFERENCES users(id),
  updated_by  uuid NOT NULL REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1
);
CREATE INDEX idx_notes_medicine_user ON dosage_notes(medicine_id, user_id);
