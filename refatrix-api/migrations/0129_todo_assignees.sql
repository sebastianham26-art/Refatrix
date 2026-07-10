-- 할 일 다중 담당자(개인별 중복 지정) 지원
-- 기존 todos.assignee_id(단일=대표 담당자)는 유지하고, 추가 담당자를 이 테이블로 관리한다.
CREATE TABLE IF NOT EXISTS todo_assignees (
  id         SERIAL PRIMARY KEY,
  todo_id    INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (todo_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_todo_assignees_todo ON todo_assignees(todo_id);
CREATE INDEX IF NOT EXISTS idx_todo_assignees_user ON todo_assignees(user_id);

-- 기존 단일 담당자를 다중 담당자 테이블로 백필(멱등)
INSERT INTO todo_assignees (todo_id, user_id)
SELECT id, assignee_id
  FROM todos
 WHERE assignee_id IS NOT NULL
   AND deleted_at IS NULL
ON CONFLICT (todo_id, user_id) DO NOTHING;
