-- =====================================================================
-- 0331 · 「답장 필요」 · 「새 메시지」 표시 (2026-11-19 디렉터)
--   「손님이 답을 남겼는데 우리 쪽 대답이 아직이면 목록에서부터 표시 — WhatsApp 의 안 읽은 대화처럼」
--   reply_last_in   손님의 마지막 메시지(Meta 기록 제외)
--   reply_last_out  우리 쪽 사람 답장의 마지막(광고 자동 응답 · ERP 봇 제외)
--   reply_pending_n 우리 마지막 답장 뒤 손님이 보낸 메시지 수
--   답장 필요 = reply_last_in > reply_last_out (최근 30일 · 판매/제외 아님) — 상태는 목록 SQL 이 바로 본다
--   meta_lead_seen  사람마다 그 문의를 마지막으로 연 시각 → 그 뒤 손님 메시지 = 새 메시지(파란 점)
-- =====================================================================
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS reply_last_in TIMESTAMPTZ;
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS reply_last_out TIMESTAMPTZ;
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS reply_pending_n INT NOT NULL DEFAULT 0;
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS reply_calc_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_meta_threads_reply_need ON meta_threads (reply_last_in) WHERE reply_last_in IS NOT NULL;

CREATE TABLE IF NOT EXISTS meta_lead_seen (
  thread_id  BIGINT NOT NULL REFERENCES meta_threads(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);
