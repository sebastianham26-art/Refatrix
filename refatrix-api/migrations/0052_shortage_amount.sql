-- 부족분(매출 불가)의 금액을 별도 보존. 재고부족으로 매출하지 못한 금액(IVA 포함, MXN).
ALTER TABLE stock_shortages
  ADD COLUMN IF NOT EXISTS shortage_amount_mxn NUMERIC(15,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN stock_shortages.shortage_amount_mxn IS '재고부족으로 매출 불가한 금액(IVA 포함, MXN)';
