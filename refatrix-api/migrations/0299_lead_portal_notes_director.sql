-- =====================================================================
-- 0299 · 고객 포털 — 문의 메모 · 디렉터 전용 접속코드 (2026-10-26 디렉터 지시)
--   ① 「각 고객정보(포털 문의 카드)에 메모 — 작성한 사람만 보고, 디렉터는 언제 누가 무엇을 썼는지 전부」
--      refaccionaria 는 자기 메모만(포털), 디렉터는 ERP 「🔑 고객 접속코드 › 문의 메모」와 디렉터 코드 포털에서 전부.
--      지운 메모도 행은 남는다(deleted_at) — 디렉터 화면에는 「삭제됨」으로 보인다.
--   ② 「디렉터 전용 접속코드」 — 고객에 묶이지 않는 코드(kind='director'). 포털에서 전체 문의 · 모든 메모를 본다.
--      주문 · 매장 재고 · 찾는 부품 기록은 고객 코드 전용(디렉터 코드로는 막힘).
-- 재실행 안전.
-- =====================================================================
ALTER TABLE lead_portal_codes ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'customer';
ALTER TABLE lead_portal_codes DROP CONSTRAINT IF EXISTS lead_portal_codes_kind_chk;
ALTER TABLE lead_portal_codes ADD CONSTRAINT lead_portal_codes_kind_chk
  CHECK ((kind = 'customer' AND customer_id IS NOT NULL) OR (kind = 'director' AND customer_id IS NULL));
ALTER TABLE lead_portal_codes ALTER COLUMN customer_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS lead_portal_notes (
  id           BIGSERIAL PRIMARY KEY,
  thread_id    BIGINT NOT NULL REFERENCES meta_threads(id) ON DELETE CASCADE,
  customer_id  BIGINT REFERENCES customers(id),          -- NULL = 디렉터 코드로 쓴 메모
  code_id      BIGINT NOT NULL REFERENCES lead_portal_codes(id),
  body         TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS lead_portal_notes_thread_idx ON lead_portal_notes (thread_id);
CREATE INDEX IF NOT EXISTS lead_portal_notes_customer_idx ON lead_portal_notes (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lead_portal_notes_at_idx ON lead_portal_notes (created_at DESC);
