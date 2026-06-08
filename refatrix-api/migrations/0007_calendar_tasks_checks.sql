-- =====================================================================
-- Refatrix ERP · 0007_calendar_tasks_checks
-- 일정 · 업무(Tarea) · 공지 · 읽음확인
-- =====================================================================

-- 일정 ---------------------------------------------------------------
CREATE TABLE calendar_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_date  DATE NOT NULL,
  title       TEXT NOT NULL,
  user_id     BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX idx_calendar_date ON calendar_events (event_date);

-- 업무 그룹(팀) ------------------------------------------------------
CREATE TABLE task_groups (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  deleted_at  TIMESTAMPTZ
);

-- 업무(Tarea) --------------------------------------------------------
CREATE TABLE tasks (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id    BIGINT REFERENCES task_groups(id),
  list        TEXT NOT NULL DEFAULT 'tarea'
              CHECK (list IN ('tarea','pend','mine')),
  title       TEXT NOT NULL,
  task_date   DATE,
  owner_id    BIGINT REFERENCES users(id),
  done        BOOLEAN NOT NULL DEFAULT false,
  done_at     TIMESTAMPTZ,
  done_by     BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE TRIGGER trg_tasks_upd BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_tasks_owner ON tasks (owner_id, done);

-- 업무 메모 ----------------------------------------------------------
CREATE TABLE task_memos (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id     BIGINT NOT NULL REFERENCES tasks(id),
  text        TEXT NOT NULL,
  user_id     BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_task_memos_task ON task_memos (task_id);

-- 로그인 공지 --------------------------------------------------------
CREATE TABLE announcements (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  text        TEXT NOT NULL,
  persistent  BOOLEAN NOT NULL DEFAULT true,
  targets     TEXT[] NOT NULL DEFAULT ARRAY['all'],  -- 'all' 또는 역할 목록
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

-- 읽음확인 세션(기본 시간대) ---------------------------------------
CREATE TABLE check_sessions (
  key            TEXT PRIMARY KEY,                    -- am / pm
  name           TEXT NOT NULL,
  default_start  TIME NOT NULL,
  default_end    TIME NOT NULL,
  sort_order     INT NOT NULL DEFAULT 0
);

-- 사용자별 확인 시간대(지정) ---------------------------------------
CREATE TABLE user_check_windows (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  session_key   TEXT NOT NULL REFERENCES check_sessions(key),
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  UNIQUE (user_id, session_key)
);

-- 읽음확인 기록 ------------------------------------------------------
CREATE TABLE check_log (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  log_date      DATE NOT NULL,
  session_key   TEXT NOT NULL REFERENCES check_sessions(key),
  checked_time  TIME NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, log_date, session_key)
);
CREATE INDEX idx_check_log_user_date ON check_log (user_id, log_date);
