-- =====================================================================
-- 0313 · 전자결재 ↔ 고정비 회차 대체 (2026-11-03)
--   증상: SUA·임차료를 전자결재로 지급하면 전자결재 예정/실적과 고정비 회차 예정이 따로 남아
--         같은 고정비가 한 달에 2~3건 자금계획에 잡혔다(지난 예정은 오늘로 이월되며 겹침).
--   approval_documents.replaces_txn_ids : 이 결재가 대신하는 고정비 회차(예정 거래 id 목록)
--   transactions.replaced_by_doc       : 전자결재가 대체해 숨긴 고정비 회차 — 문서가 반려·삭제되면
--                                         이 표시가 있는 회차만 되살린다(사용자가 직접 지운 회차는 건드리지 않음).
--   기존 데이터·동작 변화 없음(두 컬럼 모두 NULL).
-- =====================================================================
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS replaces_txn_ids BIGINT[];
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS replaced_by_doc BIGINT;
CREATE INDEX IF NOT EXISTS idx_transactions_replaced_by_doc ON transactions(replaced_by_doc) WHERE replaced_by_doc IS NOT NULL;
