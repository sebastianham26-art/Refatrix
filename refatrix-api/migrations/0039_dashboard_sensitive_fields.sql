-- =====================================================================
-- Refatrix ERP · 0039_dashboard_sensitive_fields
-- 대시보드 위젯의 민감 집계 금액을 user_field_access로 서버측 게이트.
-- 기존 제품원가 필드키에 대시보드용 키를 추가(같은 테이블·API 재사용).
--   fin_amount   : 재무 금액(캐시플로 순현금/유입/유출, 계획대비실적 금액)
--   ar_amount    : 미수/연체 금액
--   mkt_amount   : 마케팅 배분/예산 금액
--   sales_amount : 영업 목표/실적 금액
-- 디렉터는 항상 노출(fieldVisible). 그 외 유저는 visible=true 부여 시에만.
-- =====================================================================

ALTER TABLE user_field_access DROP CONSTRAINT IF EXISTS user_field_access_field_key_check;
ALTER TABLE user_field_access
  ADD CONSTRAINT user_field_access_field_key_check
  CHECK (field_key IN (
    'buy_price','import_overhead','unit_cost','sale_price','unit_margin','margin_rate','pnl',
    'fin_amount','ar_amount','mkt_amount','sales_amount'
  ));
