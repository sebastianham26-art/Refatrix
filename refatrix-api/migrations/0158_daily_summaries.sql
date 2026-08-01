-- =====================================================================
-- Refatrix ERP · 0158_daily_summaries
--   디렉터 전용 「오늘 요약」 — 선택한 날짜의 ERP 전체 기록(일정·할일·견적·
--   영업활동·매출·입출금·고객·마케팅·감사로그)을 AI 로 요약해 일자별로
--   누적 보관하는 테이블. 날짜당 1건(재생성 시 갱신 = 최신본 유지).
--   digest = 원본 병기(그날 수집된 구조화 기록 JSON) — AI 요약과 함께 열람.
--   멱등(IF NOT EXISTS). 재실행 안전.
-- =====================================================================

CREATE TABLE IF NOT EXISTS daily_summaries (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  summary_date  DATE NOT NULL UNIQUE,
  content_md    TEXT NOT NULL,
  digest        JSONB,
  model         TEXT,
  memo          TEXT,
  created_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_daily_summaries_date ON daily_summaries (summary_date DESC);
