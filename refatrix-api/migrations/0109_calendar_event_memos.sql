-- =====================================================================
-- Refatrix ERP · 0109_calendar_event_memos
--   일정(캘린더) 항목에 메모(댓글) 스레드 추가.
--   - calendar_event_memos : 일정별 메모. 작성자(author_id)·본문·작성/수정 시각.
--       * 수정(updated_at) 은 본인만, 삭제(deleted_at) 는 디렉터만 (라우트에서 강제).
--   - calendar_memo_seen   : 사용자별 메모 확인 기록 → 새 메모 팝업 재노출 방지.
--   멱등(IF NOT EXISTS). 재실행 안전.
-- =====================================================================

CREATE TABLE IF NOT EXISTS calendar_event_memos (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id    BIGINT NOT NULL REFERENCES calendar_events(id),
  author_id   BIGINT REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ,
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_calmemo_event ON calendar_event_memos (event_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS calendar_memo_seen (
  memo_id  BIGINT NOT NULL REFERENCES calendar_event_memos(id),
  user_id  BIGINT NOT NULL REFERENCES users(id),
  seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (memo_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_calmemoseen_user ON calendar_memo_seen (user_id);
