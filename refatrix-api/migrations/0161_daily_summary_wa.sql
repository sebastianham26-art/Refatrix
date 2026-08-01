-- =====================================================================
-- Refatrix ERP · 0161_daily_summary_wa
--   「오늘 요약」 WhatsApp 자동 발송 상태 추적 — 디렉터 요청(2026-08-01):
--   멕시코 기준 매일 오전 5시에 전일 요약을 생성해 디렉터 WhatsApp 으로 자동 발송.
--   · wa_sent_at  : 발송 성공 시각(NULL = 미발송) — 하루 1회 발송 가드
--   · wa_status   : sent_text / sent_template / failed …
--   · wa_error    : 마지막 실패 사유(재시도 진단용)
--   · wa_attempts : 시도 횟수(스케줄러 재시도 상한 5회)
--   멱등(IF NOT EXISTS). 재실행 안전.
-- =====================================================================

ALTER TABLE daily_summaries ADD COLUMN IF NOT EXISTS wa_sent_at  TIMESTAMPTZ;
ALTER TABLE daily_summaries ADD COLUMN IF NOT EXISTS wa_status   TEXT;
ALTER TABLE daily_summaries ADD COLUMN IF NOT EXISTS wa_error    TEXT;
ALTER TABLE daily_summaries ADD COLUMN IF NOT EXISTS wa_attempts INT NOT NULL DEFAULT 0;
