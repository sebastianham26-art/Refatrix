-- =====================================================================
-- Refatrix ERP · 0289_product_factory_info  (2026-10-20 · 디렉터 요청)
-- 공장이 정한 SKU 정보 — 원산지(기존 products.origin) · MOQ · 생산 상태
--   구매검토 화면에서 엑셀 업로드/붙여넣기로 대량 갱신한다.
--   · moq            : SKU 별 최소주문수량. 비어 있으면 원산지 기본값(CN 10 · TR 40 · 그 외 없음)을 쓴다.
--   · factory_status : production(생산중) · discontinued(단산) · development(개발) · dev_hold(개발 보류)
--                      비어 있으면 미등록(생산중과 같이 취급).
--     ↳ products.is_active(우리 판매 활성/비활성)와는 다른 축이다 — 공장이 만드느냐의 문제.
--   멱등(IF NOT EXISTS) — 재실행 안전.
-- =====================================================================
ALTER TABLE products ADD COLUMN IF NOT EXISTS moq                     NUMERIC(12,3);
ALTER TABLE products ADD COLUMN IF NOT EXISTS factory_status          TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS factory_info_updated_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS factory_info_updated_by BIGINT REFERENCES users(id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_factory_status_chk') THEN
    ALTER TABLE products ADD CONSTRAINT products_factory_status_chk
      CHECK (factory_status IS NULL OR factory_status IN ('production','discontinued','development','dev_hold'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_moq_chk') THEN
    ALTER TABLE products ADD CONSTRAINT products_moq_chk CHECK (moq IS NULL OR moq >= 0);
  END IF;
END $$;

-- 변경 이력(업로드 1회 = batch 1건, 바뀐 칸만 행으로)
CREATE TABLE IF NOT EXISTS product_factory_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id    TEXT NOT NULL,
  product_id  BIGINT NOT NULL REFERENCES products(id),
  code        TEXT,
  field       TEXT NOT NULL,          -- origin | moq | factory_status
  old_value   TEXT,
  new_value   TEXT,
  source      TEXT,                   -- excel | paste
  changed_by  BIGINT REFERENCES users(id),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pfl_product ON product_factory_log (product_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pfl_batch   ON product_factory_log (batch_id);
