-- =====================================================================
-- 0315 · 고객 포털 — 「오늘의 주문 모음」(2026-11-04 디렉터)
--   refaccionaria 가 하루 동안 여러 문의에서 고른 부품을 모아 두고(서버에 저장 · 기기 바꿔도 유지),
--   하루에 한 번 확인한 뒤 「주문 확정」으로 Refatrix 에 보낸다(FB 견적 초안 1건).
--   한 고객 · 한 CTR 코드 = 한 줄. thread_ids = 그 부품을 고른 문의들.
-- 재실행 안전.
-- =====================================================================
CREATE TABLE IF NOT EXISTS lead_portal_basket (
  id          BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  code        TEXT   NOT NULL,
  qty         INT    NOT NULL CHECK (qty BETWEEN 1 AND 9999),
  thread_ids  BIGINT[] NOT NULL DEFAULT '{}',
  code_id     BIGINT REFERENCES lead_portal_codes(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, code)
);
CREATE INDEX IF NOT EXISTS lead_portal_basket_cust ON lead_portal_basket (customer_id);
