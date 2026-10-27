-- =====================================================================
-- Refatrix ERP · 0304_customer_notes — 고객 상세 「고객정보」 아래 메모 기록 (2026-10-27 디렉터 지시)
--
--   고객관리 › 고객 상세에서 고객정보 표 바로 아래에 메모를 쓰고 바로 저장한다.
--   · 승인 절차 없음 — 운영 메모라 즉시 남긴다(배송지 즉시저장과 같은 취급).
--   · 한 줄씩 쌓이는 기록: 언제 · 누가 · 무엇을. 덮어쓰지 않는다.
--   · 삭제 = 작성자 본인 또는 디렉터. 실제로 지우지 않고 deleted_at 만 찍는다(감사 추적).
--   · 기존 customers.memo(등록·수정 폼의 한 줄 메모)는 그대로 둔다.
--
--   멱등(IF NOT EXISTS) — 재실행 안전.
-- =====================================================================

CREATE TABLE IF NOT EXISTS customer_notes (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  body        TEXT   NOT NULL CHECK (length(btrim(body)) > 0 AND length(body) <= 2000),
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  deleted_by  BIGINT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS customer_notes_cust_idx
  ON customer_notes (customer_id, created_at DESC);
