-- 0270 · Meta 광고 문의(Messenger · Instagram) 가져오기 — 2026-10-12 디렉터 지시
--   「Meta 광고 문의 500건 이상을 지역 · 연락처 · 이름 · 수요품목으로 엑셀 목록화 → refaccionaria 고객의 판매기회로」
--   Meta Graph API(/{page}/conversations)로 대화를 받아 한 대화 = 한 행으로 저장하고,
--   고객이 쓴 말에서 업종 · 지역 · 전화 · 차종 · 부품을 규칙으로 뽑는다(자동값). 사람이 고친 값(_m)이 항상 이긴다.
-- 재실행 안전.
CREATE TABLE IF NOT EXISTS meta_threads (
  id             BIGSERIAL PRIMARY KEY,
  platform       TEXT NOT NULL CHECK (platform IN ('messenger','instagram')),
  thread_id      TEXT NOT NULL UNIQUE,            -- Graph conversation id
  user_id        TEXT,                            -- PSID / IGSID
  name           TEXT,
  username       TEXT,                            -- Instagram @
  first_at       TIMESTAMPTZ,                     -- 받은 메시지 중 가장 이른 것(가져온 범위 안)
  last_at        TIMESTAMPTZ,                     -- 대화 갱신 시각
  last_in_at     TIMESTAMPTZ,                     -- 고객이 마지막으로 쓴 시각
  msg_count      INT,
  in_count       INT,
  messages       JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{at, me:bool, text}] 최근 순서대로 최대 80
  customer_text  TEXT,                            -- 고객이 쓴 말만 이어 붙임(봇 버튼 문구 포함)
  -- 자동 추출
  a_tipo         TEXT,
  a_tipo_btn     TEXT,                            -- 광고 버튼 「Soy X de MTY」로만 고른 업종(참고)
  a_state        TEXT,
  a_city         TEXT,
  a_phone        TEXT,
  a_email        TEXT,
  a_vehicles     TEXT,
  a_parts        TEXT,
  a_intent       TEXT,                            -- precio / catálogo / envío / asesor …
  -- 사람이 고친 값(있으면 우선)
  m_name         TEXT,
  m_tipo         TEXT,
  m_state        TEXT,
  m_city         TEXT,
  m_phone        TEXT,
  m_vehicles     TEXT,
  m_parts        TEXT,
  status         TEXT NOT NULL DEFAULT 'nuevo' CHECK (status IN ('nuevo','contactado','derivado','venta','descartado')),
  derived_to     TEXT,                            -- 넘겨 준 refaccionaria(자유 입력)
  derived_customer_id BIGINT REFERENCES customers(id),
  note           TEXT,
  updated_by     BIGINT REFERENCES users(id),
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meta_threads_last_idx ON meta_threads (last_at DESC);
CREATE INDEX IF NOT EXISTS meta_threads_state_idx ON meta_threads (COALESCE(m_state, a_state));

CREATE TABLE IF NOT EXISTS meta_sync_runs (
  id          BIGSERIAL PRIMARY KEY,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  trigger     TEXT NOT NULL DEFAULT 'manual',     -- manual / auto
  full_scan   BOOLEAN NOT NULL DEFAULT false,
  ok          BOOLEAN,
  threads     INT NOT NULL DEFAULT 0,
  inserted    INT NOT NULL DEFAULT 0,
  by_platform JSONB,
  error       TEXT,
  started_by  BIGINT REFERENCES users(id)
);
