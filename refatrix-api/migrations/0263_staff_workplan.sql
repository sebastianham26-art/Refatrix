-- =====================================================================
-- 0263 · 직원 업무일지 — 아침 「오늘 할 일」 · 마감 전 「오늘 한 일」 (2026-10-08)
--   디렉터 결정: 체크리스트 + 계획 외 한 일(자유서술) · 전 직원 공유 ·
--   디렉터 WhatsApp 아침(계획)/저녁(실적) 별도 발송 · 마감시각 + 미작성 직원 WhatsApp 알림
--   재실행 안전(IF NOT EXISTS / ON CONFLICT).
-- =====================================================================

-- 대상 직원 여부(디렉터 역할은 코드에서 항상 제외)
ALTER TABLE users ADD COLUMN IF NOT EXISTS workplan_enabled BOOLEAN NOT NULL DEFAULT true;

-- 하루 머리 정보: 작성 시각·지연 여부·계획 외 한 일
CREATE TABLE IF NOT EXISTS workplan_days (
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date      DATE   NOT NULL,
  plan_saved_at  TIMESTAMPTZ,                       -- 「오늘 할 일」 최초 저장 시각
  plan_late      BOOLEAN NOT NULL DEFAULT false,    -- 할 일 마감 이후 최초 저장
  done_saved_at  TIMESTAMPTZ,                       -- 「오늘 한 일」 최초 저장 시각
  done_late      BOOLEAN NOT NULL DEFAULT false,    -- 한 일 마감 이후 최초 저장
  extra_done     TEXT NOT NULL DEFAULT '',          -- 계획에 없던 한 일
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, work_date)
);

-- 항목: 할 일 한 줄 = 1행. 실적은 status/note 로 같은 행에 기록.
CREATE TABLE IF NOT EXISTS workplan_items (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date     DATE   NOT NULL,
  title         TEXT   NOT NULL,
  sort          INT    NOT NULL DEFAULT 0,
  carried_from  BIGINT REFERENCES workplan_items(id) ON DELETE SET NULL,  -- 이월 원본
  carry_count   INT    NOT NULL DEFAULT 0,          -- 연속 이월 횟수(원본 0 → 1, 2, …)
  added_late    BOOLEAN NOT NULL DEFAULT false,     -- 할 일 마감 이후 추가
  status        TEXT   NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','partial','missed')),
  note          TEXT   NOT NULL DEFAULT '',
  deleted_at    TIMESTAMPTZ,                        -- 소프트 삭제(이월 항목을 지워도 다시 생기지 않게)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_workplan_items_day ON workplan_items (work_date, user_id);
-- 같은 항목은 한 번만 이월(지운 이월 항목도 남아 있어 재생성 방지)
CREATE UNIQUE INDEX IF NOT EXISTS uq_workplan_items_carry ON workplan_items (carried_from) WHERE carried_from IS NOT NULL;

-- 설정(1행) — 시각은 'HH:MM'(멕시코 시각), 근무일은 0=일 … 6=토
CREATE TABLE IF NOT EXISTS workplan_settings (
  id                 INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  plan_deadline      TEXT NOT NULL DEFAULT '10:00',
  done_deadline      TEXT NOT NULL DEFAULT '18:00',
  workdays           TEXT NOT NULL DEFAULT '1,2,3,4,5,6',
  remind_enabled     BOOLEAN NOT NULL DEFAULT true,
  remind_plan_at     TEXT NOT NULL DEFAULT '09:30',
  remind_done_at     TEXT NOT NULL DEFAULT '17:30',
  remind_template    TEXT,                          -- Meta 승인 템플릿 이름(본문 {{1}} 이름 {{2}} 무엇 {{3}} 날짜 {{4}} 마감시각)
  remind_template_lang TEXT NOT NULL DEFAULT 'es_MX',
  summary_enabled    BOOLEAN NOT NULL DEFAULT true,
  summary_plan_at    TEXT NOT NULL DEFAULT '10:15',
  summary_done_at    TEXT NOT NULL DEFAULT '18:15',
  summary_user_ids   BIGINT[] NOT NULL DEFAULT '{}',  -- 비어 있으면 DAILY_SUMMARY_WA_TO(디렉터 번호)
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         BIGINT REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO workplan_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 발송 원장 — (종류, 날짜, 받는 사람) 1회. user_id 0 = 환경변수 번호(DAILY_SUMMARY_WA_TO)
CREATE TABLE IF NOT EXISTS workplan_wa_sends (
  kind        TEXT   NOT NULL CHECK (kind IN ('remind_plan','remind_done','sum_plan','sum_done')),
  work_date   DATE   NOT NULL,
  user_id     BIGINT NOT NULL,
  to_masked   TEXT,
  status      TEXT   NOT NULL,
  message_id  TEXT,
  error       TEXT,
  attempts    INT    NOT NULL DEFAULT 0,
  sent_at     TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, work_date, user_id)
);
