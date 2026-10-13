-- 0273 · 카탈로그 조회 API — 재고 0 을 고객에게 어떻게 보일지 (디렉터 결정 2026-10-13)
--
--   real (기본) = 있는 그대로. 구간이면 '0', 수량이면 0.
--   min         = 재고가 0 인 제품을 '1-3' 으로 보낸다(수량 모드에서는 2).
--                 고객은 소량이 있다고 보고 주문을 넣고, 우리는 그 주문으로
--                 이 고객의 실제 수요(= 결품)를 알게 된다. 사내에서 '1-3' 은 「재고 없음」이다.
ALTER TABLE catalog_api_clients
  ADD COLUMN IF NOT EXISTS zero_stock_as TEXT DEFAULT 'real';

DO $$ BEGIN
  ALTER TABLE catalog_api_clients
    ADD CONSTRAINT catalog_api_clients_zerostock_chk CHECK (zero_stock_as IN ('real','min'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE catalog_api_clients SET zero_stock_as = 'real' WHERE zero_stock_as IS NULL;
