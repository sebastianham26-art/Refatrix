-- 0192: 영수증 번호 「다음 번호」 제안용 부분 인덱스 (성능 전용 · 2026-08-31)
--
-- GET /api/transactions/receipt-next 는 "영수증 번호가 들어있는 최근 거래 30건"만 본다.
-- 거래가 쌓이면 매번 전체 스캔이 되므로, 영수증 번호가 있는 행만 담는 부분 인덱스를 둔다.
--
-- ⚠ 이 마이그레이션을 돌리지 않아도 기능은 정상 동작한다(속도만 차이).
-- 멱등: IF NOT EXISTS — 재실행 안전.
CREATE INDEX IF NOT EXISTS idx_txn_receipt_recent
  ON transactions (created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND receipt_no IS NOT NULL AND btrim(receipt_no) <> '';
