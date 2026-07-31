-- =====================================================================
-- Refatrix ERP · 0156_shortage_resolutions
-- 부족분 해소 추적 — 부족분 발생 이후 "같은 고객 + 같은 제품" 판매가 일어나면
-- 판매 수량만큼 부족분을 해소(FIFO)하고, 해소 내역을 원장으로 남긴다.
--   · 원 부족 기록(stock_shortages.shortage_qty)은 절대 수정하지 않는다(기록 유지).
--   · 누적 해소량은 stock_shortages.resolved_qty 에 캐시, 잔여 = shortage_qty - resolved_qty.
--   · 잔여가 0이 되면 status='resolved' (resolved_at/by 기록). 일부 해소는 open 유지.
--   · 해소 원장(stock_shortage_resolutions): 언제·어느 인보이스로·몇 개 해소됐는지.
--     source: sale=매출 등록 시 자동 / scan=소급 스캔 / manual=디렉터 수동 해소.
--   · 인보이스 삭제·수정 시 그 인보이스가 만든 해소는 되돌린다(원장 행 삭제 + resolved_qty 복원).
-- =====================================================================

ALTER TABLE stock_shortages
  ADD COLUMN IF NOT EXISTS resolved_qty NUMERIC(15,3) NOT NULL DEFAULT 0;
COMMENT ON COLUMN stock_shortages.resolved_qty IS '누적 해소 수량(해소 원장 합계 캐시). 잔여 = shortage_qty - resolved_qty';

-- 기존 데이터 정합: 이미 resolved 인 기록은 전량 해소된 것으로 간주(원장 없이 캐시만).
UPDATE stock_shortages SET resolved_qty = shortage_qty
 WHERE status = 'resolved' AND resolved_qty = 0;

CREATE TABLE IF NOT EXISTS stock_shortage_resolutions (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shortage_id       BIGINT NOT NULL REFERENCES stock_shortages(id) ON DELETE CASCADE,
  qty               NUMERIC(15,3) NOT NULL,               -- 이번에 해소된 수량(>0)
  source            TEXT NOT NULL DEFAULT 'sale'
                    CHECK (source IN ('sale','scan','manual')),
  sales_invoice_id  BIGINT REFERENCES sales_invoices(id), -- 어느 판매가 해소했나(manual 이면 NULL 가능)
  resolved_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by       BIGINT REFERENCES users(id),          -- NULL = 시스템(자동)
  note              TEXT
);
CREATE INDEX IF NOT EXISTS idx_ssr_shortage ON stock_shortage_resolutions (shortage_id);
CREATE INDEX IF NOT EXISTS idx_ssr_invoice  ON stock_shortage_resolutions (sales_invoice_id);
