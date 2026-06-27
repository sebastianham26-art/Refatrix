-- =====================================================================
-- Refatrix ERP · 0095_quote_stage_alerts
--   수주 단계 경고 → 담당자 직접 노티스(팝업)용 추적 테이블.
--   · (quote_id, warn_type) 당 1행. 즉시 1회 + 미해결 시 매일 1회 리마인드의
--     "정확히 1회/일" 멱등 가드를 last_notified_day(MX 날짜)로 보장.
--   · last_notice_id : 가장 최근 발송한 공지(중복 스택 방지·해소 시 회수용).
--   · resolved_at    : 경고 해소(단계 전진/수금완료 등) 시각.
-- =====================================================================

CREATE TABLE IF NOT EXISTS quote_stage_alerts (
  quote_id          BIGINT NOT NULL REFERENCES quotes(id),
  warn_type         TEXT   NOT NULL,   -- created | printing | await_sat | await_collect
  first_warned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_notified_day DATE,
  last_notice_id    BIGINT REFERENCES notices(id),
  resolved_at       TIMESTAMPTZ,
  PRIMARY KEY (quote_id, warn_type)
);

CREATE INDEX IF NOT EXISTS idx_qsa_unresolved ON quote_stage_alerts (resolved_at) WHERE resolved_at IS NULL;
