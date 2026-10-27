-- =====================================================================
-- Refatrix ERP · 0304_pf_catalog_rounds — CTR 차수별 검토(1차 · 2차 · 3차 · 4차 …) (2026-10-27 디렉터 지시)
--
--   「CTR 이 1차 · 2차 · 3차 · 4차로 검토한 내역을 상태로 보여 주고 싶다. 차수별 엑셀 목록을 주면
--     그 코드는 1차(날짜)로 확인했다고 표시」
--   → ERP › 제품 › 📜 제품 이력 탭(디렉터)에서 차수 · 검토일을 고르고 CTR 코드 엑셀을 올린다.
--     품목마다 차수 1개 = 1행. 같은 차수를 다시 올리면 날짜만 새 값으로 바뀐다.
--
--   함께 바뀌는 것(코드 쪽): 확인완료 뒤 잠금을 없앤다 — 확인한 뒤에도 고칠 일이 생긴다.
--   확인완료는 날짜로 보여 주고, 여러 번이면 횟수와 날짜를 모두 보여 준다(pf_catalog_confirms 그대로 사용).
--
--   멱등(IF NOT EXISTS) — 재실행 안전.
-- =====================================================================
CREATE TABLE IF NOT EXISTS pf_catalog_rounds (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id   BIGINT REFERENCES products(id),
  code         TEXT NOT NULL,                 -- 그때의 코드(제품이 지워져도 남는다)
  round        SMALLINT NOT NULL CHECK (round BETWEEN 1 AND 9),
  reviewed_on  DATE NOT NULL,                 -- 그 차수 검토일(디렉터가 정한 날짜)
  batch_id     BIGINT,                        -- pf_catalog_bulk_batches.id
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pfrd_product_round ON pf_catalog_rounds (product_id, round) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pfrd_round ON pf_catalog_rounds (round, reviewed_on);

-- 업로드 기록에 차수 · 검토일
ALTER TABLE pf_catalog_bulk_batches ADD COLUMN IF NOT EXISTS round       SMALLINT;
ALTER TABLE pf_catalog_bulk_batches ADD COLUMN IF NOT EXISTS reviewed_on DATE;

-- 플랫폼 목록의 「견적 있음」 표시 — 품목별 견적 줄을 빨리 찾는다(기존 인덱스는 예약 수량 있는 줄만)
CREATE INDEX IF NOT EXISTS idx_qlines_product ON quote_lines (product_id) WHERE product_id IS NOT NULL;
