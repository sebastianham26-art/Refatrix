-- 0205_outbox_reject_op.sql
-- 반려(rechazo)를 CRM 에 알리는 전송 종류를 추가한다.
--   지금까지 아웃박스는 upsert(등록·수정) 와 delete(삭제) 두 가지였다.
--   디렉터가 **반려**하면 CRM 쪽 고객은 "승인 대기"인 채로 남아, 왜 막혔는지 알 길이 없었다.
--   → op='reject' 로 `estatus: "rechazado"` + `motivoRechazo` 를 보낸다.
ALTER TABLE crm_customer_outbox DROP CONSTRAINT IF EXISTS crm_outbox_op_ck;
ALTER TABLE crm_customer_outbox ADD  CONSTRAINT crm_outbox_op_ck CHECK (op IN ('upsert','delete','reject'));

-- 반려 사유를 전송 본문과 별개로 이력에도 남긴다(사유는 사람이 읽는 정보라 payload 안에만 두지 않는다).
ALTER TABLE crm_customer_outbox ADD COLUMN IF NOT EXISTS reason TEXT;
