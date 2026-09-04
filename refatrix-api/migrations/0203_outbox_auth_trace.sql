-- 0203_outbox_auth_trace.sql
-- 전송 이력에 **인증을 실었는지**를 남긴다.
--   증상: CRM 이 403 을 주는데, 이력 화면에는 본문과 주소만 보여서
--   "키가 안 나간 건지, 키가 틀린 건지" 구분할 수 없었다. 헤더 이름과 전송 여부를 기록한다.
--   ⚠ 키 값 자체는 절대 저장하지 않는다(이력은 사람이 보는 화면이다).
ALTER TABLE crm_customer_outbox ADD COLUMN IF NOT EXISTS auth_header TEXT;
ALTER TABLE crm_customer_outbox ADD COLUMN IF NOT EXISTS auth_sent BOOLEAN;
