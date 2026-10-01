-- 016 用药计划（R3）：照护对象、授权、计划、时间点、服药实例与确认事件。
-- 权限语义（方案三.3）：
--   - 关联了账号的照护对象（linked_user_id 非空）= 私有计划，仅本人可见可管理；
--   - 未关联账号（孩子/老人）由创建者管理，其他家人凭 care_grants 获得
--     查看（can_view）或管理（can_manage）权限，两者分开配置；
--   - 家庭管理员身份不自动获得私有计划；
--   - 移除家庭成员时，其授权行随 users 外键级联删除。
-- 服药记录不自动扣减库存；多人确认同一实例只产生一次有效状态，纠正保留事件历史。

CREATE TABLE care_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (display_name <> ''),
  linked_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE care_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  care_profile_id uuid NOT NULL REFERENCES care_profiles(id) ON DELETE CASCADE,
  member_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_view boolean NOT NULL DEFAULT true,
  can_manage boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES users(id),
  UNIQUE (care_profile_id, member_user_id)
);

CREATE TABLE medication_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  care_profile_id uuid NOT NULL REFERENCES care_profiles(id) ON DELETE CASCADE,
  medicine_id uuid REFERENCES medicines(id) ON DELETE SET NULL,
  medicine_name text NOT NULL CHECK (medicine_name <> ''),
  dosage_text text NOT NULL CHECK (dosage_text <> ''),
  weekdays text[] NOT NULL DEFAULT '{mon,tue,wed,thu,fri,sat,sun}'
    CHECK (weekdays <@ ARRAY['mon','tue','wed','thu','fri','sat','sun']::text[]
           AND array_length(weekdays, 1) >= 1),
  start_date date NOT NULL,
  end_date date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medication_plans_date_order CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE TABLE plan_time_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES medication_plans(id) ON DELETE CASCADE,
  time_of_day time NOT NULL,
  UNIQUE (plan_id, time_of_day)
);

-- 服药实例：查询"今日安排"时按需物化（plan × 日期 × 时间点）。
CREATE TABLE dose_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES medication_plans(id) ON DELETE CASCADE,
  slot_id uuid NOT NULL REFERENCES plan_time_slots(id) ON DELETE CASCADE,
  care_profile_id uuid NOT NULL REFERENCES care_profiles(id) ON DELETE CASCADE,
  dose_date date NOT NULL,
  time_of_day time NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'taken', 'skipped')),
  UNIQUE (slot_id, dose_date)
);

-- 确认事件：幂等键保证同一操作重试只生效一次；纠正以新事件追加，历史完整保留。
CREATE TABLE dose_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  occurrence_id uuid NOT NULL REFERENCES dose_occurrences(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('taken', 'skipped')),
  acted_by uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (occurrence_id, idempotency_key)
);

CREATE INDEX idx_care_profiles_family ON care_profiles(family_id);
CREATE INDEX idx_medication_plans_family ON medication_plans(family_id, status);
CREATE INDEX idx_dose_occurrences_family_date ON dose_occurrences(family_id, dose_date);
