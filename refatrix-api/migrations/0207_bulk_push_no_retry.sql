-- 0207_bulk_push_no_retry.sql
-- ① 재시도해도 소용없는 응답코드를 연동별로 지정한다.
--    예: ERR_CUSTOMER_NOT_FOUND — 그 고객이 CRM 에 없다는 뜻이라 6번을 더 보내도 결과가 같다.
--    전체 동기화(강제 일괄 전송)를 하면 이런 건이 대량으로 생기므로, 실패가 아니라
--    「건너뜀」 으로 닫아 재시도 큐를 더럽히지 않는다.
-- ② 일괄 전송 이력을 구분하려고 origin 은 코드에서 'bulk_push' 로 넣는다(스키마 변경 불필요).
ALTER TABLE integration_endpoints
  ADD COLUMN IF NOT EXISTS no_retry_codes TEXT NOT NULL DEFAULT 'ERR_CUSTOMER_NOT_FOUND';

-- 일괄 전송에서 같은 고객이 중복 적재되지 않게(대기 중인 건이 있으면 건너뛴다) 조회를 빠르게.
CREATE INDEX IF NOT EXISTS idx_crm_outbox_pending_customer
  ON crm_customer_outbox (customer_id, op) WHERE status = 'pending';
