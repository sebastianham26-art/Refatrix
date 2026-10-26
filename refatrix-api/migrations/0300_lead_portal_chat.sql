-- =====================================================================
-- 0300 · 고객 포털 — Facebook(Messenger) 문의에 refaccionaria 가 직접 답하기 (2026-10-26 디렉터 지시)
--   「WhatsApp 대화는 막고 Facebook 대화만」 · 선점 기본 3일(디렉터 조정) · 선점 뒤 메시지만 보임 ·
--   포털의 wa.me 버튼 제거 · 선점 중에도 직원(Business Suite) 답장 허용(ERP · 포털에 같이 보임)
--
--   · meta_page_messages   : Messenger 웹훅으로 받은 메시지(손님 → 페이지 · 페이지 → 손님 에코) + 포털에서 보낸 메시지.
--                            mid 로 중복 방지. source = customer | portal | staff
--   · lead_portal_claims   : 선점(문의 하나에 살아 있는 선점은 하나). 메시지를 주고받을 때마다 만료가 늘어난다.
--   · lead_portal_settings : 선점 기본 일수(디렉터가 바꿈)
-- 재실행 안전.
-- =====================================================================
CREATE TABLE IF NOT EXISTS meta_page_messages (
  id           BIGSERIAL PRIMARY KEY,
  psid         TEXT NOT NULL,                         -- 손님 PSID = meta_threads.user_id (platform='messenger')
  mid          TEXT UNIQUE,                           -- Meta 메시지 id
  direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
  source       TEXT NOT NULL CHECK (source IN ('customer','portal','staff')),
  text         TEXT,
  at           TIMESTAMPTZ NOT NULL,
  customer_id  BIGINT REFERENCES customers(id),       -- source=portal 일 때 보낸 refaccionaria
  code_id      BIGINT REFERENCES lead_portal_codes(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meta_page_messages_psid_idx ON meta_page_messages (psid, at);

CREATE TABLE IF NOT EXISTS lead_portal_claims (
  id           BIGSERIAL PRIMARY KEY,
  thread_id    BIGINT NOT NULL REFERENCES meta_threads(id) ON DELETE CASCADE,
  customer_id  BIGINT NOT NULL REFERENCES customers(id),
  code_id      BIGINT REFERENCES lead_portal_codes(id),
  claimed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  released_at  TIMESTAMPTZ,                          -- 디렉터가 해제(또는 다음 선점 때 만료분 정리)
  released_by  BIGINT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS lead_portal_claims_thread_idx ON lead_portal_claims (thread_id, claimed_at DESC);
CREATE INDEX IF NOT EXISTS lead_portal_claims_customer_idx ON lead_portal_claims (customer_id, claimed_at DESC);

CREATE TABLE IF NOT EXISTS lead_portal_settings (
  id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  claim_days  INT NOT NULL DEFAULT 3 CHECK (claim_days BETWEEN 1 AND 30),
  updated_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO lead_portal_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
