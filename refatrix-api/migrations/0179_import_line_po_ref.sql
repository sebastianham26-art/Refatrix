-- 0179: 수입 라인에 구매 참조번호(오더번호) 저장 (2026-08-19)
--   문제: 같은 SKU가 여러 발주(참조번호)에 걸쳐 있으면 수입원가 프리필·인보이스 단가 매칭이
--         참조번호를 무시하고 "아무 발주"의 단가를 붙였음 (예: CE0536L — 100RA26A1C 12개 + 100RA26B2C 25개).
--   해결: 수입 라인을 (참조번호 × SKU) 단위로 관리. po_ref = 구매 ref_no(= 패킹리스트 order_no, 인보이스 A열 ORDER NO).
ALTER TABLE import_lines ADD COLUMN IF NOT EXISTS po_ref TEXT;
COMMENT ON COLUMN import_lines.po_ref IS '구매 참조번호(발주 ref_no = 인보이스 ORDER NO). 오더번호×SKU 단위 원가 추적용(0179)';
