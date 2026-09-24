-- 审核修复 #4：数据库层保证每个家庭最多一名 owner。
-- 部分唯一索引只约束 role='owner' 的行；普通成员数量不受限。
-- 转让所有权按"先降级、后升级"顺序在同一事务内执行（见 routes/invitations.ts），
-- 配合 families 行级 FOR UPDATE 锁，瞬态不会出现双 owner。
CREATE UNIQUE INDEX IF NOT EXISTS family_members_single_owner_per_family
  ON family_members (family_id)
  WHERE role = 'owner';
