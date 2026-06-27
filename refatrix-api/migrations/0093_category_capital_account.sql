-- 0093: 재무>거래등록 수입항목에 '자본금' 계정과목 추가
-- 초기 자본금(출자금/투자금)은 자본(equity) 유입 — 매출(수익)이 아니므로 group_name='비손익'.
-- (한국 계정체계 관례: 3xxx=자본. 차입금 2010(부채)과 구분)
-- 수입 드롭다운 노출은 0092에서 이미 적용된 '비손익' 포함 필터(refatrix-finance.html)에 의해 자동.
-- 멱등: 코드 PK라 ON CONFLICT DO NOTHING — 재실행 안전.
INSERT INTO categories (code, name, group_name, sort_order) VALUES
  ('3010','자본금','비손익',110)
ON CONFLICT (code) DO NOTHING;
