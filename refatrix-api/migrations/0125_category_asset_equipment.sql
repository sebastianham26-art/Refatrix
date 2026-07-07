-- 0125: 재무>거래등록 지출항목에 '비품·설비' (자산) 계정과목 추가
-- 바코드 스캐너 등 소모품이 아닌 설비/비품 구매를 분류하기 위함.
--   자산 취득은 현금 유출(지출)이지만 비용(손익)이 아니라 자산 증가 —
--   6120 비품(판관비, 비용처리)과 구분해 group_name='자산' 신설.
--   프런트 필터: 지출 = 수익·비손익 제외 전부 → '자산' 그룹은 지출 드롭다운에 자동 노출.
-- 코드: 한국 계정 관례 1xxx=자산(12xx=유형자산). 1210 미사용 확인.
-- 멱등: ON CONFLICT (code) DO NOTHING — 재실행 안전.
INSERT INTO categories (code, name, group_name, sort_order) VALUES
  ('1210','비품·설비 (Equipo y mobiliario)','자산',120)
ON CONFLICT (code) DO NOTHING;
