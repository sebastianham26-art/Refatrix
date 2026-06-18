-- =====================================================================
-- Refatrix ERP · 운영 데이터 초기화 (실사용 시작 전)
--   유지: 제품 마스터, 사용자/권한, 회사설정, 거래분류, 계좌(마스터),
--         영업팀, 영업단계, 활동분류, 환율
--   삭제: 고객·견적·매출·재고변동·부족·개발·재무거래·목표·마케팅·
--         수입·협업/게시/일정·로그·고정비 정기규칙
--   추가: 제품 재고/평균원가 0 리셋 · 계좌 시작잔액 0
-- 반드시 백업(스냅샷) 후 실행하세요. 트랜잭션으로 묶여 오류 시 전체 취소됩니다.
-- =====================================================================
BEGIN;

-- 1) 운영/거래 데이터 일괄 삭제 (CASCADE가 FK 순서 자동 처리, ID는 1부터 재시작)
TRUNCATE TABLE
  -- 고객
  customers, customer_change_requests, customer_directives, customer_documents,
  customer_meetings, customer_stage_history, stage_log,
  -- 견적
  quotes, quote_lines,
  -- 매출
  sales_invoices, sales_invoice_lines, sales_payments, sales_payment_allocations,
  sales_change_requests, sales_sku_pending, invoices,
  -- 재고변동·부족·원가조정
  stock_movements, stock_shortages, cogs_adjustments,
  -- 개발요청
  product_dev_requests,
  -- 재무 거래
  transactions, txn_change_requests, period_closings,
  -- 고정비 정기규칙 (삭제 요청)
  recurring_rules,
  -- 매출목표
  monthly_targets, sales_targets, target_customer_months, target_team_months, target_team_status,
  -- 마케팅
  marketing_activities, marketing_alloc, marketing_budget_items, marketing_budget_months,
  marketing_budget_periods, marketing_notes, marketing_plan_status,
  -- 수입(import)
  import_batches, import_lines, import_overheads, import_cost_adjustments,
  import_cost_allocations, import_cost_docs, import_cost_lines,
  -- 협업/게시/일정
  todos, todo_memos, tasks, task_memos, task_groups,
  calendar_events, announcements, notices, notice_reads,
  dashboard_requests, dashboard_widgets,
  -- 로그/세션
  audit_log, check_log, check_sessions, page_view_daily
RESTART IDENTITY CASCADE;

-- 2) 제품 재고수량·평균원가 0 리셋 (제품 마스터 자체는 유지)
UPDATE products SET stock_qty = 0, avg_cost = 0;

-- 3) 계좌 시작잔액을 0 으로 설정 (계좌 마스터는 유지)
UPDATE accounts SET open_balance = 0 WHERE deleted_at IS NULL;

COMMIT;

-- 확인용 (실행 후 0 또는 의도값이 나와야 함)
-- SELECT 'customers' t, count(*) FROM customers
-- UNION ALL SELECT 'quotes', count(*) FROM quotes
-- UNION ALL SELECT 'sales_invoices', count(*) FROM sales_invoices
-- UNION ALL SELECT 'transactions', count(*) FROM transactions
-- UNION ALL SELECT 'product_dev_requests', count(*) FROM product_dev_requests
-- UNION ALL SELECT 'products(유지)', count(*) FROM products
-- UNION ALL SELECT 'accounts(유지)', count(*) FROM accounts;
