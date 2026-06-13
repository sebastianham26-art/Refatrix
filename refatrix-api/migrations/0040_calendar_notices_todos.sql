-- =====================================================================
-- Refatrix ERP · 0040_calendar_notices_todos
-- 포털 "일정 · 공지 · Todo" 모듈.
--   ① calendar_events : 일정(날짜 + 시간 칸 + 내용 칸, 대상 전사/팀/개인)
--   ② notices         : 공지(디렉터 작성, 대상 전체/역할/팀)
--   ③ notice_reads    : 공지 읽음 확인(최초 확인 날짜+시간)
--   ④ todos           : 할 일(디렉터가 담당자에게 배정)
-- 주의: calendar_events 는 0007에서 (event_date,title,user_id) 구조로 이미
--       존재할 수 있으므로, 누락 컬럼을 보강하고 레거시 컬럼을 백필한다(멱등).
-- =====================================================================

-- ① 일정 -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_date   DATE NOT NULL,
  event_time   TEXT,
  content      TEXT,
  scope        TEXT NOT NULL DEFAULT 'personal',
  team_id      BIGINT REFERENCES sales_teams(id),
  owner_id     BIGINT REFERENCES users(id),
  created_by   BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
-- 레거시(0007) 테이블 호환: 누락 컬럼 보강
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS event_time TEXT;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS content    TEXT;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS scope      TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS team_id    BIGINT REFERENCES sales_teams(id);
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS owner_id   BIGINT REFERENCES users(id);
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES users(id);
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
-- 레거시 컬럼 정리: title→content 백필 + title NOT NULL 해제, user_id→owner_id 백필
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='calendar_events' AND column_name='title') THEN
    EXECUTE 'UPDATE calendar_events SET content = COALESCE(content, title) WHERE content IS NULL';
    EXECUTE 'ALTER TABLE calendar_events ALTER COLUMN title DROP NOT NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='calendar_events' AND column_name='user_id') THEN
    EXECUTE 'UPDATE calendar_events SET owner_id = COALESCE(owner_id, user_id) WHERE owner_id IS NULL';
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_calevt_date  ON calendar_events (event_date);
CREATE INDEX IF NOT EXISTS idx_calevt_owner ON calendar_events (owner_id);
CREATE INDEX IF NOT EXISTS idx_calevt_team  ON calendar_events (team_id);

-- ② 공지 -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notices (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title        TEXT NOT NULL,
  body         TEXT,
  audience     TEXT NOT NULL DEFAULT 'all'
               CHECK (audience IN ('all','role','team')),
  audience_role TEXT,
  team_id      BIGINT REFERENCES sales_teams(id),
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
  read_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (notice_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_nread_notice ON notice_reads (notice_id);

-- ④ 할 일(디렉터가 배정) --------------------------------------------
CREATE TABLE IF NOT EXISTS todos (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title        TEXT NOT NULL,
  detail       TEXT,
  assignee_id  BIGINT NOT NULL REFERENCES users(id),
  due_date     DATE,
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','done')),
  done_at      TIMESTAMPTZ,
  done_note    TEXT,
  created_by   BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_todo_assignee ON todos (assignee_id, status);
