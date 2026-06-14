-- =====================================================================
-- Refatrix ERP · 0044_stock_movement_manual
--   수동 재고이동(입고/출고/조정) 구분용 컬럼
--   · source : 'manual' | 'sale' | 'import' (자동 기록은 NULL/기존 FK로 구분)
--   · note   : 수동 이동 사유(예: 무료샘플, 재고조정 사유)
-- =====================================================================
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS note   TEXT;
CREATE INDEX IF NOT EXISTS idx_stockmov_moved_at ON stock_movements (moved_at);
CREATE INDEX IF NOT EXISTS idx_stockmov_product ON stock_movements (product_id);
