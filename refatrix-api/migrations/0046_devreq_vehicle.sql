-- =====================================================================
-- Refatrix ERP · 0046_devreq_vehicle
--   제품개발요청 검토 단계에 차량정보(메이커·차종·연식) 구조화 입력
-- =====================================================================
ALTER TABLE product_dev_requests ADD COLUMN IF NOT EXISTS review_maker TEXT;  -- 메이커(Nissan 등)
ALTER TABLE product_dev_requests ADD COLUMN IF NOT EXISTS review_model TEXT;  -- 차종(Tsuru 등)
ALTER TABLE product_dev_requests ADD COLUMN IF NOT EXISTS review_year  TEXT;  -- 연식(2010-2015 등)
