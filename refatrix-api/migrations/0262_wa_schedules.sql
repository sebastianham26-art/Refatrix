-- 0262 · WhatsApp 자동 발송 시각 설정 (디렉터 요청 2026-10-08)
--   관리 › WhatsApp 발송 시각 화면에서 작업별 시각(멕시코 시각 HH:MM)·대상일을 고친다.
--   · treasury_daily   : 일일 자금 요약     — 기본 18:00 · 당일 마감분(today)
--   · treasury_monthly : 월간 자금실적      — 기본 18:00 · today = 말일에 그달 / yesterday = 1일에 지난달
--   · daily_summary    : 오늘 요약(AI)      — 기본 05:00 · 전날분(yesterday) — 기존 동작 유지
--   행이 없거나 테이블이 없으면 코드의 같은 기본값으로 동작한다(무해).
CREATE TABLE IF NOT EXISTS wa_schedules (
  job                TEXT PRIMARY KEY CHECK (job IN ('treasury_daily','treasury_monthly','daily_summary')),
  send_time          TEXT NOT NULL CHECK (send_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  target_day         TEXT NOT NULL DEFAULT 'yesterday' CHECK (target_day IN ('today','yesterday')),
  enabled            BOOLEAN NOT NULL DEFAULT true,
  skip_empty_sunday  BOOLEAN NOT NULL DEFAULT true,
  updated_by         BIGINT REFERENCES users(id),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO wa_schedules (job, send_time, target_day) VALUES
  ('treasury_daily',   '18:00', 'today'),
  ('treasury_monthly', '18:00', 'today'),
  ('daily_summary',    '05:00', 'yesterday')
ON CONFLICT (job) DO NOTHING;
