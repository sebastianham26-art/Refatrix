-- =====================================================================
-- Refatrix ERP · 0164_customer_buyer_contact
-- 고객마스터에 "구매결정권자" 연락처 분리 —
--   기존 contact(이메일)·phone(전화)은 인보이스 수신자 연락처로 계속 사용.
--   buyer_name / buyer_phone = 구매 관련 결정을 하는 사람(오퍼시트 WhatsApp 발송 대상).
--   오퍼시트(목록·상세·wa-send)는 buyer_phone 이 있으면 그 번호로, 없으면 기존 phone 으로 폴백.
-- =====================================================================

ALTER TABLE customers ADD COLUMN IF NOT EXISTS buyer_name  TEXT;  -- 구매결정권자 이름
ALTER TABLE customers ADD COLUMN IF NOT EXISTS buyer_phone TEXT;  -- 구매결정권자 전화(WhatsApp)

COMMENT ON COLUMN customers.buyer_name  IS '구매결정권자 이름 — 오퍼시트/재오퍼 수신인';
COMMENT ON COLUMN customers.buyer_phone IS '구매결정권자 전화(WhatsApp) — 없으면 기본 phone 으로 폴백';
