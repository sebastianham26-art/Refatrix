-- 0294 · VIO 프로모션 키트 제품 등록 권한(kit_create) — 디렉터가 사용자별로 켠다(관리 › 사용자·권한 「🧰 키트 등록」)
--   켜진 사람: 📋 프로모션 목록에서 「🧰 키트 제품 만들기」(제품 마스터에 K0001 등록) · 「🖼 사진 만들기」(R2 키트 사진)
--   디렉터는 항상 가능. user_field_access 의 허용 키 목록(0039)에 kit_create 를 더한다.
ALTER TABLE user_field_access DROP CONSTRAINT IF EXISTS user_field_access_field_key_check;
ALTER TABLE user_field_access
  ADD CONSTRAINT user_field_access_field_key_check
  CHECK (field_key IN (
    'buy_price','import_overhead','unit_cost','sale_price','unit_margin','margin_rate','pnl',
    'fin_amount','ar_amount','mkt_amount','sales_amount',
    'kit_create'
  ));
