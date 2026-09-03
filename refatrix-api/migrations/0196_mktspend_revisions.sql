-- 0196_mktspend_revisions.sql
-- 마케팅 지출계획 「개정 스냅샷」 — 수정분 변경표시(diff)의 기준선.
--
-- 배경: 계획을 수정하면 기존 내용과 새 내용이 같은 레벨로 보여 디렉터가 검토할 수 없었다.
--       상태 전이(제출·승인·반려·디렉터 수정)마다 계획 전문을 스냅샷으로 남기고,
--       화면은 "직전 스냅샷 대비 지금"을 색으로 구분해 보여준다.
--
-- diff 계산은 화면(프런트)에서 한다. 이 테이블은 기준선만 제공한다.
--
-- 멱등: IF NOT EXISTS + backfill 은 NOT EXISTS 가드. 여러 번 적용해도 안전.

CREATE TABLE IF NOT EXISTS marketing_spend_revisions (
  id         BIGSERIAL PRIMARY KEY,
  plan_id    BIGINT NOT NULL REFERENCES marketing_spend_plans(id) ON DELETE CASCADE,
  rev_no     INT NOT NULL,
  event      TEXT NOT NULL,   -- submitted | approved | rejected | director_edit | backfill
  snapshot   JSONB NOT NULL,  -- {title,category,event_date,purpose,items:[{id,name,memo,lines:[…]}],targets:[…]}
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_msr_plan_rev ON marketing_spend_revisions(plan_id, rev_no);
CREATE INDEX IF NOT EXISTS idx_msr_plan ON marketing_spend_revisions(plan_id, rev_no DESC);

-- ---------------------------------------------------------------------------
-- backfill: 이미 승인된 계획의 "현재 상태"를 rev 1 로 남긴다.
--   → 이 마이그레이션 이후의 첫 수정부터 diff 가 정상 동작한다.
--   (backfill 이 없으면 기존 계획은 기준선이 없어 전부 "신규"로 보인다)
-- ---------------------------------------------------------------------------
WITH item_lines AS (
  SELECT i.plan_id, i.id AS item_id, i.name, i.memo, i.sort_order,
         COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'id',         l.id,
               'kind',       l.kind,
               'due_date',   to_char(l.due_date, 'YYYY-MM-DD'),
               'amount',     round(l.amount, 2),
               'memo',       l.memo,
               'sort_order', l.sort_order)
             ORDER BY l.sort_order, l.id
           ) FILTER (WHERE l.id IS NOT NULL),
           '[]'::jsonb) AS lines
    FROM marketing_spend_items i
    LEFT JOIN marketing_spend_lines l ON l.item_id = i.id
   GROUP BY i.plan_id, i.id, i.name, i.memo, i.sort_order
), plan_items AS (
  SELECT plan_id,
         jsonb_agg(
           jsonb_build_object(
             'id',         item_id,
             'name',       name,
             'memo',       memo,
             'sort_order', sort_order,
             'lines',      lines)
           ORDER BY sort_order, item_id) AS items
    FROM item_lines
   GROUP BY plan_id
), plan_targets AS (
  SELECT plan_id,
         jsonb_agg(
           jsonb_build_object(
             'customer_id', customer_id,
             'is_general',  is_general)
           ORDER BY id) AS targets
    FROM marketing_spend_targets
   GROUP BY plan_id
)
INSERT INTO marketing_spend_revisions (plan_id, rev_no, event, snapshot, created_by, created_at)
SELECT p.id, 1, 'backfill',
       jsonb_build_object(
         'title',      p.title,
         'category',   p.category,
         'event_date', to_char(p.event_date, 'YYYY-MM-DD'),
         'purpose',    p.purpose,
         'items',      COALESCE(pi.items, '[]'::jsonb),
         'targets',    COALESCE(pt.targets, '[]'::jsonb)),
       p.decided_by,
       COALESCE(p.decided_at, p.submitted_at, now())
  FROM marketing_spend_plans p
  LEFT JOIN plan_items   pi ON pi.plan_id = p.id
  LEFT JOIN plan_targets pt ON pt.plan_id = p.id
 WHERE p.deleted_at IS NULL
   AND p.status = 'approved'
   AND NOT EXISTS (SELECT 1 FROM marketing_spend_revisions r WHERE r.plan_id = p.id);
