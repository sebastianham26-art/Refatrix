-- 0147: 매출원가(COGS) 세분화 — 물품구매비용 / 수입부대비용 / 수입운송비
-- 기존 5010 '매출원가(COGS)' 단일 계정을 COGS 그룹 안에서 3개 항목으로 나눈다:
--   · 5010 → 이름 변경 '물품구매비용' (물품 자체 구매대금)
--   · 5030 → 신규 '수입부대비용' (통관·관세·수수료 등 수입 부대비)
--   · 5040 → 신규 '수입운송비' (국제운송 등 수입 운임)
--   ※ 5020 '수입원가 정산차액'(0013)은 그대로 유지 — 같은 매출원가 그룹에 함께 표시됨.
--   ※ 5010은 코드 유지·이름만 변경 → 기존 5010으로 등록된 과거 거래는 그대로 연결되며
--     화면에는 '물품구매비용'으로 표시된다(과거 거래 재분류 없음).
--   ※ 정책 변경 기록: 0071에서는 "수입 물류비는 계정과목 없이 '이체'로만 기록"이었으나,
--     디렉터 요청(2026-07-25)으로 COGS 세분 계정과목 신설. 재고 원가 반영은
--     기존대로 수입등록 화면에서 처리 — 이 계정들은 거래등록/월 리포트 분류용.
-- 그룹 상속(0071 패턴): group_name은 기존 5010에서 상속 — 운영 DB 문자열이 시드와 달라도
--   기존 매출원가 계정과 100% 동일하게 표시/필터된다.
-- 프런트 필터: 지출 = 수익·비손익 제외 전부 → 매출원가 그룹은 지출 드롭다운에 자동 노출(수입에는 안 뜸).
-- 코드: 5020은 0013이 사용 중 → 신규는 5030·5040. sort_order 30(5010)·31(5020) 다음 32·33.
-- 멱등: UPDATE는 재실행 무해, INSERT는 ON CONFLICT (code) DO NOTHING — 재실행 안전.

UPDATE categories
   SET name = '물품구매비용 (Compra de mercancía)'
 WHERE code = '5010';

INSERT INTO categories (code, name, group_name, sort_order)
SELECT v.code, v.name,
       COALESCE((SELECT group_name FROM categories WHERE code = '5010'), '매출원가'),
       v.sort_order
FROM (VALUES
  ('5030', '수입부대비용 (Gastos aduanales y de importación)', 32),
  ('5040', '수입운송비 (Flete de importación)',                33)
) AS v(code, name, sort_order)
ON CONFLICT (code) DO NOTHING;
