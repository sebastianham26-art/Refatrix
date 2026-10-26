-- =====================================================================
-- 0298 · 고객 포털 — 연락처를 본 문의에 「이 손님이 찾는 부품」 기록 (2026-10-26 디렉터 지시)
--   「연락처를 보게 되면 원하는 제품을 찾을 수 있게 — SYD · CTR · OE 어느 번호로든 ERP 와 똑같이 찾고,
--     제품 정보를 보고 골라 수량을 정해 저장하면 그 손님이 찾는 제품으로 나오게」
--   refaccionaria(고객) × 문의(thread) × 제품 = 한 줄. 연락처를 본(lead_portal_reveals) 문의에만 저장할 수 있다.
--   AI 가 뽑은 부품(meta_threads.ai_items · m_items)은 건드리지 않는다 — 다른 refaccionaria 화면 · ERP 자동값과 섞지 않는다.
-- 재실행 안전.
-- =====================================================================
CREATE TABLE IF NOT EXISTS lead_portal_wants (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id),
  thread_id    BIGINT NOT NULL REFERENCES meta_threads(id) ON DELETE CASCADE,
  product_id   BIGINT NOT NULL REFERENCES products(id),
  qty          INT NOT NULL CHECK (qty > 0 AND qty <= 9999),
  input_code   TEXT,                                  -- 고객이 친 번호(SYD · OE · 경쟁사 등) — 무엇으로 찾았나
  code_id      BIGINT REFERENCES lead_portal_codes(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, thread_id, product_id)
);
CREATE INDEX IF NOT EXISTS lead_portal_wants_thread_idx ON lead_portal_wants (thread_id);
