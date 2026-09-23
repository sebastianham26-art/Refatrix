-- 0228 · 제품 OE(순정) 부품번호 — 찾기·견적·매출 활용
--   설계: claude/REFATRIX_설계_2026-09-23_oe_codes.md
--   전부 IF NOT EXISTS — 재실행 안전.

-- ① 제품: 엑셀 원문(정규화된 표기). products.scode 와 같은 역할.
ALTER TABLE products ADD COLUMN IF NOT EXISTS oe TEXT;

-- ② 분해표: 1코드 1행. 매칭은 oe_norm(대문자+영숫자만)으로 한다.
CREATE TABLE IF NOT EXISTS product_oe_codes (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  oe_code     TEXT   NOT NULL,                  -- 원문 표기 (화면·문서 표시용)
  oe_norm     TEXT   NOT NULL,                  -- 매칭 키
  rel         TEXT   NOT NULL DEFAULT 'oe',     -- oe = 직접 OE · for = 이 부품이 들어가는 조립품의 OE
  source      TEXT   NOT NULL DEFAULT 'master', -- master = 업로드·화면 입력 · syd = Clave SyD 칸에서 복사
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT product_oe_codes_rel_chk    CHECK (rel IN ('oe','for')),
  CONSTRAINT product_oe_codes_source_chk CHECK (source IN ('master','syd')),
  CONSTRAINT product_oe_codes_uniq UNIQUE (product_id, oe_norm)
);
CREATE INDEX IF NOT EXISTS ix_product_oe_codes_norm ON product_oe_codes (oe_norm);

-- ③ 견적 줄: 「무엇으로 찾았나」 + 견적 당시 OE (syd_codes 와 같은 스냅샷 개념)
--    match_source: ctr | syd | oe | oe_for | name | other  (NULL = 0228 이전 줄)
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS match_source TEXT;
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS oe_codes     TEXT;
CREATE INDEX IF NOT EXISTS ix_quote_lines_match_source ON quote_lines (match_source);
