-- 0124_stock_count_force_qty : 디렉터 강제조정 수량 감사 기록
--   applied_qty = 실제로 재고에 반영한 최종 수량(실사수량과 다를 수 있음).
ALTER TABLE stock_count_adjustments ADD COLUMN IF NOT EXISTS applied_qty NUMERIC(15,3);
