-- 0146: 재무>거래등록 지출항목에 '운반비(매출출고)' 계정과목 추가 (스페인어 병기)
-- 매출 출고 시 회사가 부담하는 운임(고객 배송비)을 별도 분류하기 위함.
--   성격: 판매 관련 비용 → 판관비(운반비). 수입(import) 물류비와는 별개 —
--   수입 물류비는 0071 정책대로 계정과목 없이 '이체'로만 기록(재고원가는 수입등록에서 처리).
-- 판관비 그룹 — 기존 6010(급여)에서 group_name을 그대로 상속(0071·0113·0117 패턴).
--   운영 DB의 그룹 문자열이 시드와 다를 수 있으므로 상속시켜야
--   화면 표시/필터에서 기존 판관비 계정과 100% 동일하게 동작한다.
--   프런트 필터: 지출 = 수익·비손익 제외 전부 → 판관비는 지출 드롭다운에 자동 노출(수입에는 안 뜸).
-- 코드: 6xxx=판관비, 마지막 사용 6150(연구개발비) 다음 빈 번호 6160.
-- 멱등: ON CONFLICT (code) DO NOTHING — 재실행 안전.
INSERT INTO categories (code, name, group_name, sort_order)
SELECT '6160', '운반비(매출출고) (Flete de ventas)',
       COALESCE((SELECT group_name FROM categories WHERE code = '6010'), '판관비'),
       69
ON CONFLICT (code) DO NOTHING;
