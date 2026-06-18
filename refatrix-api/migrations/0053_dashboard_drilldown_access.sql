-- 영업대시보드 드릴다운 접근 권한:
--   영업(sales)·영업지원(sales_support)·마케팅(marketing) 이
--   매출 목록(매출 화면, page 'sales') + 수금 계획(재무 화면, page 'transactions') 을 조회할 수 있도록.
--   기존 권한이 있으면 유지(ON CONFLICT DO NOTHING) — 다운그레이드하지 않음.

-- (1) 영업·영업지원 → 수금 계획(transactions) 조회
INSERT INTO user_page_access (user_id, page_key, device_req, access)
SELECT u.id, 'transactions', 'anywhere', 'view'
  FROM users u
 WHERE u.deleted_at IS NULL AND u.role IN ('sales','sales_support')
ON CONFLICT (user_id, page_key) DO NOTHING;

-- (2) 마케팅 → 매출 목록(sales) 조회
INSERT INTO user_page_access (user_id, page_key, device_req, access)
SELECT u.id, 'sales', 'anywhere', 'view'
  FROM users u
 WHERE u.deleted_at IS NULL AND u.role = 'marketing'
ON CONFLICT (user_id, page_key) DO NOTHING;

-- (3) 마케팅 → 수금 계획(transactions) 조회
INSERT INTO user_page_access (user_id, page_key, device_req, access)
SELECT u.id, 'transactions', 'anywhere', 'view'
  FROM users u
 WHERE u.deleted_at IS NULL AND u.role = 'marketing'
ON CONFLICT (user_id, page_key) DO NOTHING;
