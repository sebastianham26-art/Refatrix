-- =====================================================================
-- Refatrix ERP · 0040_calendar_notices_todos
-- 포털 "일정 · 공지 · Todo" 모듈.
--   ① calendar_events : 일정(날짜 + 시간 칸 + 내용 칸, 대상 전사/팀/개인)
--   ② notices         : 공지(디렉터 작성, 대상 전체/역할/팀)
--   ③ notice_reads    : 공지 읽음 확인(최초 확인 날짜+시간)
--   ④ todos           : 할 일(디렉터가 담당자에게 배정)
-- =====================================================================

-- ① 일정 -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_date   DATE NOT NULL,                        -- 일정 날짜
  event_time   TEXT,                                 -- 시간 칸(예: '14:30', 자유 입력, 없으면 종일)
  content      TEXT NOT NULL,                         -- 내용 칸
  scope        TEXT NOT NULL DEFAULT 'personal'
               CHECK (scope IN ('company','team','personal')),
  team_id      BIGINT REFERENCES sales_teams(id),     -- scope='team'일 때
  owner_id     BIGINT REFERENCES users(id),           -- scope='personal'일 때 대상자
  created_by   BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_calevt_date ON calendar_events (event_date);
CREATE INDEX IF NOT EXISTS idx_calevt_owner ON calendar_events (owner_id);
CREATE INDEX IF NOT EXISTS idx_calevt_team ON calendar_events (team_id);

-- ② 공지 -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notices (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title        TEXT NOT NULL,
  body         TEXT,
  audience     TEXT NOT NULL DEFAULT 'all'
               CHECK (audience IN ('all','role','team')),
  audience_role TEXT,                                 -- audience='role'일 때
  team_id      BIGINT REFERENCES sales_teams(id),     -- audience='team'일 때
  pinned       BOOLEAN NOT NULL DEFAULT false,
  created_by   BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_notice_created ON notices (created_at);

-- ③ 공지 읽음 확인(최초 확인 1회) -----------------------------------
CREATE TABLE IF NOT EXISTS notice_reads (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notice_id   BIGINT NOT NULL REFERENCES notices(id),
  user_id     BIGINT NOT NULL REFERENCES users(id),
  read_at     TIMESTAMPTZ NOT NULL DEFAULT now(),     -- 최초 확인한 날짜+시간
  UNIQUE (notice_id, user_id)                          -- 사용자별 1회만(최초값 보존)
);
CREATE INDEX IF NOT EXISTS idx_nread_notice ON notice_reads (notice_id);

-- ④ 할 일(디렉터가 배정) --------------------------------------------
CREATE TABLE IF NOT EXISTS todos (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title        TEXT NOT NULL,
  detail       TEXT,
  assignee_id  BIGINT NOT NULL REFERENCES users(id),   -- 담당자(배정 대상)
  due_date     DATE,
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','done')),
  done_at      TIMESTAMPTZ,
  done_note    TEXT,
  created_by   BIGINT REFERENCES users(id),            -- 배정한 디렉터
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_todo_assignee ON todos (assignee_id, status);
