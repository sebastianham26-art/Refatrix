-- =====================================================================
-- 0318 · 고객 포털 — 문의 정보 입력(고객관리) · 개인정보 보호 확약서 전자서명 (2026-11-05 디렉터)
--   ① refaccionaria 가 포털에서 문의 손님의 정보(이름 · 업종 · 주 · 도시 · 전화 · 차종 · 부품 · 결과)를 입력
--      → ERP 「Meta 광고 문의」 같은 칸(meta_threads.m_*)에 들어가고, 누가 언제 무엇을 바꿨는지 남긴다.
--   ② 접속코드로 들어오면 먼저 「개인정보 보호 · 비밀유지 확약서」에 전자서명(이름 · 성 · 휴대폰 · 서명)
-- 재실행 안전.
-- =====================================================================
CREATE TABLE IF NOT EXISTS lead_portal_info (
  id          BIGSERIAL PRIMARY KEY,
  thread_id   BIGINT NOT NULL REFERENCES meta_threads(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  code_id     BIGINT REFERENCES lead_portal_codes(id),
  result      TEXT CHECK (result IN ('contactado','cotizado','vendido','no_interesa')),
  fields      JSONB,                                   -- 마지막으로 이 고객이 넣은 값
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (thread_id, customer_id)
);
CREATE TABLE IF NOT EXISTS lead_portal_info_log (
  id          BIGSERIAL PRIMARY KEY,
  thread_id   BIGINT NOT NULL REFERENCES meta_threads(id) ON DELETE CASCADE,
  customer_id BIGINT REFERENCES customers(id),
  code_id     BIGINT REFERENCES lead_portal_codes(id),
  changes     JSONB NOT NULL,                          -- {칸: [전, 후]}
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_portal_info_log_thread ON lead_portal_info_log (thread_id, at);

CREATE TABLE IF NOT EXISTS lead_portal_consents (
  id          BIGSERIAL PRIMARY KEY,
  code_id     BIGINT NOT NULL REFERENCES lead_portal_codes(id),
  customer_id BIGINT REFERENCES customers(id),
  version     TEXT NOT NULL,
  first_name  TEXT NOT NULL,
  last_name   TEXT NOT NULL,
  phone       TEXT NOT NULL,
  signature   TEXT NOT NULL,                           -- 손 서명 PNG(data URL)
  text        TEXT NOT NULL,                           -- 서명한 확약서 본문 그대로
  text_hash   TEXT NOT NULL,
  ip          TEXT,
  ua          TEXT,
  signed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_portal_consents_code ON lead_portal_consents (code_id, version);
