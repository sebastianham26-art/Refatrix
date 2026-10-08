-- =====================================================================
-- 0266 · 업무일지 코멘트 + 대상 직원 직접 선택 (2026-10-08)
--   ① 직원: 마감 때 할 일 항목마다 코멘트(기존 workplan_items.note 사용 — 스키마 변경 없음)
--   ② 디렉터: 항목별 코멘트 + 하루 전체 코멘트. 다음 근무일에 그 직원의 일정표에 표시.
--   ③ 업무일지 대상은 디렉터가 고른 직원만(기본 꺼짐).
--   재실행 안전.
-- =====================================================================

-- ② 디렉터 코멘트 — 항목별
ALTER TABLE workplan_items ADD COLUMN IF NOT EXISTS dir_comment    TEXT NOT NULL DEFAULT '';
ALTER TABLE workplan_items ADD COLUMN IF NOT EXISTS dir_comment_at TIMESTAMPTZ;
ALTER TABLE workplan_items ADD COLUMN IF NOT EXISTS dir_comment_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

-- ② 디렉터 코멘트 — 하루 전체 + 직원 일정표에 보여줄 날짜 + 직원 확인 시각
ALTER TABLE workplan_days ADD COLUMN IF NOT EXISTS dir_comment    TEXT NOT NULL DEFAULT '';
ALTER TABLE workplan_days ADD COLUMN IF NOT EXISTS dir_comment_at TIMESTAMPTZ;
ALTER TABLE workplan_days ADD COLUMN IF NOT EXISTS dir_comment_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE workplan_days ADD COLUMN IF NOT EXISTS dir_show_date  DATE;          -- 직원 일정표에 띄울 날짜(다음 근무일)
ALTER TABLE workplan_days ADD COLUMN IF NOT EXISTS dir_seen_at    TIMESTAMPTZ;   -- 직원이 「확인」 누른 시각(코멘트가 바뀌면 다시 NULL)
CREATE INDEX IF NOT EXISTS ix_workplan_days_show ON workplan_days (user_id, dir_show_date) WHERE dir_show_date IS NOT NULL;

-- ③ 대상 직원: 기본 꺼짐. 딱 한 번만(opt_in_applied 플래그) —
--    이미 업무일지를 쓴 직원은 그대로 두고, 아직 안 쓴 직원은 끈다(디렉터가 화면에서 골라 켬).
--    수동으로 다시 돌려도 디렉터가 그 뒤에 켠 직원은 건드리지 않는다.
ALTER TABLE users ALTER COLUMN workplan_enabled SET DEFAULT false;
ALTER TABLE workplan_settings ADD COLUMN IF NOT EXISTS opt_in_applied BOOLEAN NOT NULL DEFAULT false;
UPDATE users u SET workplan_enabled = false
 WHERE u.workplan_enabled = true
   AND NOT EXISTS (SELECT 1 FROM workplan_days d WHERE d.user_id = u.id)
   AND EXISTS (SELECT 1 FROM workplan_settings s WHERE s.id = 1 AND s.opt_in_applied = false);
UPDATE workplan_settings SET opt_in_applied = true WHERE id = 1;
