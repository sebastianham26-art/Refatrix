-- 0114: 거래(transactions)에 영수증 번호(receipt_no) 컬럼 추가
-- 재무>거래등록에서 메모 옆 영수증 번호 입력 + 거래목록 표시용.
-- 자유 텍스트(공급처 영수증/팩투라 번호 형식이 제각각이므로 형식 강제 없음).
-- 멱등: IF NOT EXISTS — 재실행 안전.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receipt_no TEXT;
