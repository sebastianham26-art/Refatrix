-- 0295 · Meta 광고 문의 — 광고별로 문의 나눠 보기 (2026-10-23 디렉터 지시)
--   「광고별 고유번호(광고 ID)를 ERP 에 입력하면 그 번호에 광고 이름을 내가 붙이고, 광고별로 고객 문의를 골라 보고 싶다」
--
--   · meta_ads         : 디렉터가 등록한 광고 — 광고 ID(Meta 광고 관리자 › 광고 탭 › 「광고 ID」 열) + 이름 + 메모
--                        match_text(선택) = 그 광고의 첫 메시지 · 버튼 문구. 웹훅 기록이 없는 예전 문의도 이 문구로 광고를 찾는다.
--   · meta_ad_touches  : 고객이 광고를 눌러 메시지를 보낼 때 Meta 웹훅이 주는 광고 출처(referral) 기록.
--                        WhatsApp = messages[].referral.source_id · Messenger/Instagram = messaging[].referral.ad_id.
--                        한 사람이 광고를 여러 번 눌러도 모두 쌓는다(문의의 광고 = 가장 먼저 누른 광고).
--   · meta_threads.m_ad_id : 사람이 직접 고른 광고(전화 문의 · 웹훅이 빠진 경우). 우선순위: 사람 > 웹훅 > 구분 문구.
-- 재실행 안전.
CREATE TABLE IF NOT EXISTS meta_ads (
  ad_id       TEXT PRIMARY KEY CHECK (ad_id ~ '^[0-9]{5,25}$'),
  name        TEXT NOT NULL,
  memo        TEXT,
  match_text  TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_by  BIGINT REFERENCES users(id),
  updated_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meta_ad_touches (
  id          BIGSERIAL PRIMARY KEY,
  platform    TEXT NOT NULL CHECK (platform IN ('messenger','instagram','whatsapp')),
  user_id     TEXT NOT NULL,                 -- PSID / IGSID / WhatsApp 번호(52…) — meta_threads.user_id 와 같은 값
  ad_id       TEXT NOT NULL,
  at          TIMESTAMPTZ NOT NULL,
  headline    TEXT,                          -- 광고 제목(WhatsApp headline · Messenger ads_context_data.ad_title)
  source_url  TEXT,
  ref         TEXT,                          -- Messenger ref 파라미터
  ctwa_clid   TEXT,                          -- WhatsApp 클릭 ID
  event_key   TEXT NOT NULL UNIQUE,          -- 같은 웹훅 재전송 중복 방지
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meta_ad_touches_user_idx ON meta_ad_touches (platform, user_id, at);
CREATE INDEX IF NOT EXISTS meta_ad_touches_ad_idx ON meta_ad_touches (ad_id);

ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS m_ad_id TEXT;
CREATE INDEX IF NOT EXISTS meta_threads_user_idx ON meta_threads (platform, user_id);
