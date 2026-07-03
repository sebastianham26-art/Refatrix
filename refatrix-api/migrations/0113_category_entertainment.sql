-- 0113: 재무>거래등록 지출항목에 '접대비' 계정과목 추가
-- 판관비 그룹 — 기존 6010(급여)에서 group_name을 그대로 상속(0071 패턴).
--   운영 DB의 그룹 문자열이 시드와 다를 수 있으므로 상속시켜야
--   화면 표시/필터에서 기존 판관비 계정과 100% 동일하게 동작한다.
-- 코드: 6xxx=판관비, 마지막 사용 6130(기타경비) 다음 빈 번호 6140.
-- 멱등: ON CONFLICT (code) DO NOTHING — 재실행 안전.
INSERT INTO categories (code, name, group_name, sort_order)
SELECT '6140', '접대비',
       COALESCE((SELECT group_name FROM categories WHERE code = '6010'), '판관비'),
       67
ON CONFLICT (code) DO NOTHING;
