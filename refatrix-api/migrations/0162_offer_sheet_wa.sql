-- =====================================================================
-- Refatrix ERP · 0162_offer_sheet_wa
--   Offer Sheet WhatsApp API 자동발송 추적 — 디렉터 요청(2026-08-01):
--   오퍼시트 화면에서 버튼 한 번으로 고객 WhatsApp 에 자동 발송하고,
--   발송 여부·모드·수신번호·실패 사유를 기록해 추적 관리한다.
--   (기존 sent_at/sent_by/sent_channel 은 '발송 처리' 기록으로 유지 —
--    wa_* 는 실제 API 발송 결과의 원장)
--   멱등(IF NOT EXISTS). 재실행 안전.
-- =====================================================================

ALTER TABLE offer_sheets ADD COLUMN IF NOT EXISTS wa_sent_at    TIMESTAMPTZ;  -- API 발송 성공 시각
ALTER TABLE offer_sheets ADD COLUMN IF NOT EXISTS wa_status     TEXT;         -- sent_text / sent_template / failed
ALTER TABLE offer_sheets ADD COLUMN IF NOT EXISTS wa_error      TEXT;         -- 마지막 실패 사유
ALTER TABLE offer_sheets ADD COLUMN IF NOT EXISTS wa_to         TEXT;         -- 실제 수신 번호(정규화)
ALTER TABLE offer_sheets ADD COLUMN IF NOT EXISTS wa_message_id TEXT;         -- Meta 메시지 ID(추적)
