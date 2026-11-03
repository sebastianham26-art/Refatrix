-- =====================================================================
-- 0314 · 전자결재 「고정비 선택」 (2026-11-03 디렉터)
--   SAT·SUA 처럼 고정비로 등록된 세금을 전자결재로 지급하면 고정비 예정과 결재 예정이 둘 다 잡혔다.
--   결재 작성 때 세금과공과 → 어느 고정비(SAT/SUA/…)인지 고르면, 지급월의 그 고정비 회차를 서버가 찾아(없으면 만들어)
--   대체 목록(0313 replaces_txn_ids)에 넣는다 → 자금계획엔 고정비 금액 대신 결재 금액만 남는다.
--   replace_choice  : 'rule'(고정비 지정) · 'none'(고정비 아님) · 'manual'(회차 직접 선택) · NULL(미선택/구 문서)
--   replace_rule_id : 'rule' 일 때 고른 고정비(recurring_rules.id)
--   전자결재 카테고리 「세금과공과」(재무 과목 = 세금과공과)가 없으면 추가한다. 기존 문서·동작 변화 없음.
-- =====================================================================
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS replace_choice TEXT;
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS replace_rule_id BIGINT;

INSERT INTO approval_categories (name, fin_category_code, active, sort_order)
SELECT '세금과공과', c.code, true, COALESCE((SELECT MAX(sort_order) FROM approval_categories), 0) + 1
  FROM (SELECT code FROM categories WHERE name = '세금과공과' ORDER BY code LIMIT 1) c
 WHERE NOT EXISTS (SELECT 1 FROM approval_categories WHERE name = '세금과공과');
