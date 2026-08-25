-- 일정 화면 개인 일지(오늘의 기록) — 디렉터 요청 2026-08-24
-- 날짜별로 본인만 쓰고·고치고·볼 수 있는 노트(제목 없음, 날짜 + 내용만).
-- · user_id + entry_date 유니크 → 하루 1건(같은 날 다시 저장하면 갱신).
-- · 열람/수정은 항상 작성자 본인(user_id = 나)만. 디렉터라도 남의 일지는 조회 경로가 없다.
-- · 기존 calendar_events / calendar_event_memos 계열은 일절 건드리지 않는다(무회귀).

CREATE TABLE IF NOT EXISTS calendar_journal (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 작성자(=유일한 열람자)
  entry_date  DATE   NOT NULL,                                         -- 기록 대상 날짜(작성자 로컬 날짜)
  content     TEXT   NOT NULL DEFAULT '',                              -- 본문(제목 없음)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 하루 1건 보장(UPSERT 의 충돌 대상)
CREATE UNIQUE INDEX IF NOT EXISTS calendar_journal_user_date_uidx
  ON calendar_journal (user_id, entry_date);

-- 달력 범위 조회(월/주 단위) 최적화
CREATE INDEX IF NOT EXISTS calendar_journal_user_date_idx
  ON calendar_journal (user_id, entry_date DESC);
