-- 0094_calendar_event_targets.sql
-- 일정(달력) "개인별 지정 공유"(scope='shared')의 공유 대상자 매핑.
-- 한 일정에 여러 명을 지정할 수 있고, 지정된 사람과 작성자에게만 보인다.
-- 멱등: IF NOT EXISTS. 일정 하드삭제 시 매핑도 함께 제거(ON DELETE CASCADE).

CREATE TABLE IF NOT EXISTS calendar_event_targets (
  event_id BIGINT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  user_id  BIGINT NOT NULL REFERENCES users(id)           ON DELETE CASCADE,
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_cet_user  ON calendar_event_targets(user_id);
CREATE INDEX IF NOT EXISTS idx_cet_event ON calendar_event_targets(event_id);
