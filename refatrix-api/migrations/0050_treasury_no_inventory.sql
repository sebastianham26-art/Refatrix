-- =====================================================================
-- Refatrix ERP · 0050_treasury_no_inventory
--   재무(treasury)는 수입원가(inventory)를 다루지 않음 → 기존 treasury 사용자의
--   inventory 페이지 권한 제거. (수입원가는 영업지원 전용)
-- =====================================================================
DELETE FROM user_page_access
 WHERE page_key = 'inventory'
   AND user_id IN (SELECT id FROM users WHERE role = 'treasury');
