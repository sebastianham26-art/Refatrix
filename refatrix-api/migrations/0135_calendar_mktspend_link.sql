-- =====================================================================
-- Refatrix ERP · 0135_calendar_mktspend_link
-- 마케팅 지출계획 → 일정 달력 자동 연동:
--   · calendar_events 에 출처 추적 컬럼(src_kind, src_id, src_plan_id) 추가.
--     - src_kind='mkt_plan' : 계획의 행사일(event_date) 일정 (내용=행사명)
--     - src_kind='mkt_line' : 집행 라인의 지급예정일(due_date) 일정
--                             (내용=행사명 · 집행항목명 · 금액)
--     - src_plan_id : 소속 계획 id(재동기화/삭제 시 이 값으로 일괄 정리)
--   · 승인(approved)된 기존 계획들을 backfill. 대상자 = 계획 작성자(마케팅 담당) + 디렉터 전원.
--   멱등: NOT EXISTS / ON CONFLICT 로 재실행 안전.
-- =====================================================================

ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS src_kind    TEXT;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS src_id      BIGINT;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS src_plan_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_calevt_srcplan ON calendar_events (src_plan_id);
CREATE INDEX IF NOT EXISTS idx_calevt_src ON calendar_events (src_kind, src_id);

-- ── backfill: 계획 행사일 일정 ──────────────────────────────────────
INSERT INTO calendar_events (event_date, content, scope, created_by, src_kind, src_id, src_plan_id)
SELECT p.event_date, left(p.title, 200), 'shared', p.created_by, 'mkt_plan', p.id, p.id
  FROM marketing_spend_plans p
 WHERE p.status = 'approved' AND p.deleted_at IS NULL AND p.event_date IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM calendar_events e
                    WHERE e.src_kind='mkt_plan' AND e.src_id=p.id AND e.deleted_at IS NULL);

-- ── backfill: 집행 라인 지급예정일 일정(내용=행사명 · 항목 · 금액) ──
INSERT INTO calendar_events (event_date, content, scope, created_by, src_kind, src_id, src_plan_id)
SELECT l.due_date,
       left(p.title || ' · ' || COALESCE(i.name, '기본 집행') || ' · '
            || to_char(l.amount, 'FM999,999,999,990.00') || ' MXN', 200),
       'shared', p.created_by, 'mkt_line', l.id, p.id
  FROM marketing_spend_lines l
  JOIN marketing_spend_plans p ON p.id = l.plan_id
  LEFT JOIN marketing_spend_items i ON i.id = l.item_id
 WHERE p.status = 'approved' AND p.deleted_at IS NULL AND l.due_date IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM calendar_events e
                    WHERE e.src_kind='mkt_line' AND e.src_id=l.id AND e.deleted_at IS NULL);

-- ── 대상자: 계획 작성자(마케팅 담당) ───────────────────────────────
INSERT INTO calendar_event_targets (event_id, user_id)
SELECT e.id, p.created_by
  FROM calendar_events e
  JOIN marketing_spend_plans p ON p.id = e.src_plan_id
 WHERE e.src_kind IN ('mkt_plan','mkt_line') AND e.deleted_at IS NULL
   AND p.created_by IS NOT NULL
ON CONFLICT DO NOTHING;

-- ── 대상자: 디렉터 전원 ────────────────────────────────────────────
INSERT INTO calendar_event_targets (event_id, user_id)
SELECT e.id, u.id
  FROM calendar_events e
  CROSS JOIN users u
 WHERE e.src_kind IN ('mkt_plan','mkt_line') AND e.deleted_at IS NULL
   AND u.role = 'director' AND u.deleted_at IS NULL
ON CONFLICT DO NOTHING;
