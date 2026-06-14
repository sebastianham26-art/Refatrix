-- =====================================================================
-- Refatrix ERP · 0049_split_sales_screen_keys
--   기존 'sales' 페이지 권한을 화면 단위 키로 분리(quote/stock/shortage/devrequest)
--   - 'sales' 키는 매출등록 화면용으로 유지
--   - 기존에 'sales' 를 가진 사용자에게 같은 레벨로 quote/stock/shortage/devrequest 부여
--   - 레거시 호환: 라우트는 ['fine','sales'] OR 가드라 기존 권한도 계속 동작
-- =====================================================================
INSERT INTO user_page_access (user_id, page_key, device_req, access)
SELECT u.user_id, k.page_key, u.device_req, u.access
  FROM user_page_access u
  CROSS JOIN (VALUES ('quote'),('stock'),('shortage'),('devrequest')) AS k(page_key)
 WHERE u.page_key = 'sales'
ON CONFLICT (user_id, page_key) DO NOTHING;
