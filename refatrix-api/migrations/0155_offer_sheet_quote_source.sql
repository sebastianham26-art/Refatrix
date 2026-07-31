-- =====================================================================
-- Refatrix ERP · 0152_offer_sheet_quote_source
-- Offer Sheet 라인의 출처 확장 — 부족 기록(stock_shortages)뿐 아니라
-- "최초 견적에 부족으로 기록된 라인"(전환·만료 전의 살아있는 견적)도
-- 입고 시 오퍼시트에 자동 반영되도록 quote_line 출처를 허용한다.
--   · shortage_id 를 NULL 허용으로 변경 + quote_id/quote_line_id 추가.
--   · 두 출처 중 하나는 반드시 있어야 함(CHECK).
--   · 중복 가드: 살아있는 시트에 담긴 quote_line 은 재스캔 제외.
--     견적이 이후 전환·만료되어 stock_shortages 로 넘어가도, 같은
--     (견적, SKU) 조합이 이미 오퍼된 경우 부족기록 스캔에서 제외(생성기 로직).
-- =====================================================================

ALTER TABLE offer_sheet_items ALTER COLUMN shortage_id DROP NOT NULL;
ALTER TABLE offer_sheet_items ADD COLUMN IF NOT EXISTS quote_id BIGINT REFERENCES quotes(id);
ALTER TABLE offer_sheet_items ADD COLUMN IF NOT EXISTS quote_line_id BIGINT REFERENCES quote_lines(id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_osi_source') THEN
    ALTER TABLE offer_sheet_items
      ADD CONSTRAINT chk_osi_source CHECK (shortage_id IS NOT NULL OR quote_line_id IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_osi_quote_line ON offer_sheet_items (quote_line_id);
CREATE INDEX IF NOT EXISTS idx_osi_quote      ON offer_sheet_items (quote_id, product_id);
