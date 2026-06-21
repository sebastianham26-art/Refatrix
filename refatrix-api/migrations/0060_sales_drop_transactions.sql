-- =====================================================================
-- Refatrix ERP · 0060_sales_drop_transactions
-- 영업(sales) 역할에서 재무탭(transactions) 권한 제거.
--   · 배경: 기존 sales 사용자(Oscar, Armando 등)는 user_page_access에 transactions가
--           남아 있어 재무 그룹 메뉴가 보였음. 수금 현황은 영업 대시보드의
--           "담당고객 오픈 인보이스" 패널로 대체.
--   · 영업 대시보드의 수금 카드 숫자는 transactions 권한과 무관(authGuard + ar_amount)하므로
--     이 권한을 제거해도 수금 카드는 그대로 표시됨.
--   · 되돌리려면 사용자관리에서 해당 직원에 재무(거래) 권한을 다시 부여하거나
--     역할 기본권한을 재적용하면 됨(단, 새 roleDefaults에는 transactions 미포함).
-- =====================================================================

DELETE FROM user_page_access
 WHERE page_key = 'transactions'
   AND user_id IN (
     SELECT id FROM users WHERE role = 'sales' AND deleted_at IS NULL
   );
