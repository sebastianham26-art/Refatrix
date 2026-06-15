-- =====================================================================
-- Refatrix ERP · 0050_todos_collab
--   할 일(Tarea) 고도화:
--   - scope        : 'user'(개인) | 'all'(전체 공통)
--   - level        : 'assigned'(디렉터 지시) | 'self'(자가 작성) | 'coop'(협조 요청)
--   - due_pending  : 마감 미정 — 담당자가 직접 마감일을 정함
--   - assignee_id  : 전체(all)면 NULL 허용
--   - todo_memos   : 릴레이 메모(커뮤니케이션 로그) — 완료 전까지 누적
-- =====================================================================

ALTER TABLE todos ADD COLUMN IF NOT EXISTS scope       TEXT NOT NULL DEFAULT 'user';
ALTER TABLE todos ADD COLUMN IF NOT EXISTS level       TEXT NOT NULL DEFAULT 'assigned';
ALTER TABLE todos ADD COLUMN IF NOT EXISTS due_pending BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now();

-- 전체(all) 배정 시 담당자 없음 허용
ALTER TABLE todos ALTER COLUMN assignee_id DROP NOT NULL;

-- 릴레이 메모(커뮤니케이션 로그)
CREATE TABLE IF NOT EXISTS todo_memos (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  todo_id     BIGINT NOT NULL REFERENCES todos(id),
  author_id   BIGINT REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_todomemo_todo ON todo_memos (todo_id) WHERE deleted_at IS NULL;
