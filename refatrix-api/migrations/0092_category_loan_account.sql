-- 0092: 재무>거래등록 수입항목에 '대여금(차입금)' 계정과목 추가
-- 차입금(borrowing) 유입·대여금은 매출(수익)이 아니라 재무활동 항목이므로 group_name='비손익'.
-- (수익 그룹에 넣으면 향후 손익/매출 집계가 차입금을 매출로 오인할 수 있어 분리)
-- 멱등: 코드 PK라 ON CONFLICT DO NOTHING — 재실행 안전.
INSERT INTO categories (code, name, group_name, sort_order) VALUES
  ('2010','대여금(차입금)','비손익',100)
ON CONFLICT (code) DO NOTHING;
