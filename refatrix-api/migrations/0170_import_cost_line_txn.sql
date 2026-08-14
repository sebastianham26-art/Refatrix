-- 0170_import_cost_line_txn.sql
-- 수입 부대비용 명세 줄 ↔ 재무 거래(실제 지불 내역) 연결
--
-- 목적: 부대비용 금액을 손으로 입력하는 대신 재무에 등록된 실제 지출을 가져올 때,
--       "어느 거래를 가져왔는지"를 기록한다.
--       → 같은 거래를 두 번 원가에 반영하는 사고 차단 + 미사용 비용 추적.
--
-- 멱등: IF NOT EXISTS 로 재실행 안전.
-- ⚠ 파일명 번호는 라이브 repo 최신 마이그레이션 +1 로 바꿔서 배포할 것.
--    (한 번이라도 배포된 번호의 내용은 절대 교체하지 말 것 — 0148/0149 사고 참조)

ALTER TABLE import_cost_lines
  ADD COLUMN IF NOT EXISTS transaction_id BIGINT NULL REFERENCES transactions(id);

CREATE INDEX IF NOT EXISTS idx_import_cost_lines_transaction
  ON import_cost_lines (transaction_id)
  WHERE transaction_id IS NOT NULL;

COMMENT ON COLUMN import_cost_lines.transaction_id IS
  '재무 거래(transactions.id)에서 가져온 부대비용인 경우 그 거래 id. 수동 입력이면 NULL.';
