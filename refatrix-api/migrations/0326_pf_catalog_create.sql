-- =====================================================================
-- Refatrix ERP · 0326_pf_catalog_create — REFATRIX Platform 「샘플 검토」 신규 CTR 생성 기록 (2026-11-11)
--
--   POST /api/pf-catalog/items 로 플랫폼(sample_review.html)이 만든 신규 CTR 1건 = 1행 (append-only).
--   제품 자체는 products 에 들어가고(개발 중 · 판매 비활성), 여기에는 「누가 · 언제 · 어떤 샘플에서 ·
--   어떤 품목(category)으로」 만들었는지를 남긴다. products 에는 품목(category) 칸이 없어서 여기에 둔다.
--
--   멱등(IF NOT EXISTS) — 재실행 안전.
-- =====================================================================
CREATE TABLE IF NOT EXISTS pf_catalog_creates (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id    BIGINT REFERENCES products(id),
  code          TEXT NOT NULL,
  category      TEXT,                     -- ball · tre · ctl · stb · bush · shk · mnt · idl · other
  source        TEXT NOT NULL DEFAULT 'refatrix-sample-review',
  pf_user       TEXT,
  pf_user_name  TEXT,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,   -- 저장한 값(정규화 후) — 가격 · 재고 없음
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pfcr8_product ON pf_catalog_creates (product_id);
CREATE INDEX IF NOT EXISTS idx_pfcr8_created ON pf_catalog_creates (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pfcr8_code    ON pf_catalog_creates (upper(code));
