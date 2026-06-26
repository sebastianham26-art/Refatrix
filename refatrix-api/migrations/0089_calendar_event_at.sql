-- 일정(calendar_events)에 절대시각(timestamptz) 컬럼 추가.
-- 정책: 입력하는 사람의 위치(브라우저 시간대) 기준으로 절대 순간을 기록한다.
--      → 다른 지역 사용자에게는 같은 순간이 각자 현지시각으로 환산되어 표시된다.
-- 시각 없는(종일) 일정은 event_at = NULL 로 두고 event_date 만 사용(시간대 무관).

ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS event_at TIMESTAMPTZ;

-- 기존(피처 이전) 타임드 일정 백필:
--   이 기능 도입 전의 일정은 모두 멕시코 현지(America/Mexico_City)에서 입력되었으므로,
--   기존 (event_date + event_time) 을 멕시코시티 현지시각으로 해석해 절대시각을 채운다.
--   event_at 이 비어 있고 event_time 이 HH:MM(00:00~23:59) 형식인 행만 대상(잘못된 값은 종일로 둔다).
UPDATE calendar_events
   SET event_at = (event_date::text || ' ' || event_time)::timestamp AT TIME ZONE 'America/Mexico_City'
 WHERE event_at IS NULL
   AND event_time IS NOT NULL
   AND event_time ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]';

CREATE INDEX IF NOT EXISTS idx_calevt_at ON calendar_events (event_at);
