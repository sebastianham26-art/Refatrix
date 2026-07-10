-- 0130: 경쟁사 교차참조 코드 (BAW / GROB / VASLO / KYB / MOOG / YOKOMITSU / SYD 추가분 등)
--   · 목적: 어떤 경쟁사 코드를 입력해도 CTR 제품으로 역매칭 (현장재고조사 등).
--   · 기존 product_syd_codes(SyD 전용)와 별도 — SyD 매칭 경로는 그대로 두고,
--     이 테이블이 브랜드 무관 통합 교차참조를 담당.
--   · norm_code = UPPER + 영숫자 외 제거 (예: 'DS-1045-S' → 'DS1045S') — 표기 흔들림 방어.

CREATE TABLE IF NOT EXISTS product_xref_codes (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id  BIGINT NOT NULL REFERENCES products(id),
  xref_code   TEXT NOT NULL,                -- 원문 코드 (표시용)
  norm_code   TEXT NOT NULL,                -- 정규화 코드 (매칭용)
  brand       TEXT,                         -- BAW / SYD1 / GROB1 / VASLO / KYB / MOOG / YOKOMITSU ...
  created_by  BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, norm_code)
);
CREATE INDEX IF NOT EXISTS idx_pxc_norm    ON product_xref_codes (norm_code);
CREATE INDEX IF NOT EXISTS idx_pxc_product ON product_xref_codes (product_id);
CREATE INDEX IF NOT EXISTS idx_pxc_brand   ON product_xref_codes (brand);

-- SyD 코드 정규화 매칭 폴백용 표현식 인덱스 (하이픈 유무 등 표기 차이 흡수)
CREATE INDEX IF NOT EXISTS idx_psc_syd_norm
  ON product_syd_codes (regexp_replace(upper(syd_code), '[^A-Z0-9]', '', 'g'));
