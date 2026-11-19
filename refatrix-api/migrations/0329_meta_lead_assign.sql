-- =====================================================================
-- 0329 · Meta 광고 문의 → 영업사원 배분 · 하루 목표 · 고객별 메모 · 실적 (2026-11-19)
--   디렉터: ERP 에 들어오는 문의를 영업사원에게 나눠 대화하게 한다.
--     · 대화할 사람은 디렉터가 클릭으로 고른다(meta_assign_members) · 사람마다 하루 목표(건)
--     · 지정받지 않은 문의는 하루 목표가 찰 때까지 자동으로 나눈다(meta_assignments.how='auto')
--     · 사람마다 고객별 메모(meta_lead_notes)
--     · 개인별 · 팀 전체 「할당 대비 대화함」 실적
-- =====================================================================
CREATE TABLE IF NOT EXISTS meta_assign_settings (
  id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  auto            BOOLEAN NOT NULL DEFAULT true,       -- 자동 분배 켬
  default_target  INT NOT NULL DEFAULT 20,             -- 새로 고른 사람의 기본 하루 목표
  pool_days       INT NOT NULL DEFAULT 7,              -- 최근 며칠 안의 문의만 나눈다
  work_start      INT NOT NULL DEFAULT 8,              -- 자동 분배 시간(멕시코시티 시) — 이 시간 안에서만
  work_end        INT NOT NULL DEFAULT 19,
  updated_by      BIGINT REFERENCES users(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO meta_assign_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS meta_assign_members (
  user_id       BIGINT PRIMARY KEY REFERENCES users(id),
  daily_target  INT NOT NULL DEFAULT 20 CHECK (daily_target >= 0 AND daily_target <= 500),
  active        BOOLEAN NOT NULL DEFAULT true,
  updated_by    BIGINT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 할당 1건 = 한 사람에게 한 문의를 맡긴 기록(다시 맡기면 앞 기록은 ended_at)
CREATE TABLE IF NOT EXISTS meta_assignments (
  id            BIGSERIAL PRIMARY KEY,
  thread_id     BIGINT NOT NULL REFERENCES meta_threads(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  day           DATE NOT NULL,                         -- 맡긴 날(멕시코시티) — 하루 목표에 세는 날
  how           TEXT NOT NULL CHECK (how IN ('auto','manual')),
  assigned_by   BIGINT REFERENCES users(id),           -- 사람이 맡겼으면 그 사람 · 자동이면 NULL
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  status0       TEXT,                                  -- 맡길 때 문의 상태(상태를 바꾸면 대화함)
  done_at       TIMESTAMPTZ,                           -- 대화함으로 센 시각
  done_how      TEXT CHECK (done_how IN ('reply','status','call')),
  ended_at      TIMESTAMPTZ                            -- 다른 사람에게 넘기거나 배정을 풀었음
);
CREATE INDEX IF NOT EXISTS idx_meta_assign_user_day ON meta_assignments (user_id, day);
CREATE INDEX IF NOT EXISTS idx_meta_assign_thread ON meta_assignments (thread_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS idx_meta_assign_open ON meta_assignments (assigned_at) WHERE done_at IS NULL AND ended_at IS NULL;

ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS assigned_to BIGINT REFERENCES users(id);
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_meta_threads_assigned ON meta_threads (assigned_to) WHERE assigned_to IS NOT NULL;

-- 고객별 메모(누가 · 언제) — 문의 상세의 「메모」(한 칸)와 별개로 쌓인다
CREATE TABLE IF NOT EXISTS meta_lead_notes (
  id          BIGSERIAL PRIMARY KEY,
  thread_id   BIGINT NOT NULL REFERENCES meta_threads(id) ON DELETE CASCADE,
  user_id     BIGINT REFERENCES users(id),
  text        TEXT NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meta_lead_notes_thread ON meta_lead_notes (thread_id, at);
