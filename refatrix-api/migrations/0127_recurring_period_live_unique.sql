-- 0127: 고정비 예정 재생성 영구 차단 버그 수정 — 유니크 인덱스를 live 행 전용으로 재생성
--   문제: uq_txn_recurring(0023)이 deleted_at 조건 없이 (rule_id, period)에 걸려 있어,
--         예정 거래가 소프트삭제되면 그 period가 유니크를 계속 점유 →
--         [생성] 재클릭 시 ON CONFLICT DO NOTHING으로 조용히 스킵(created:0),
--         generated_through만 갱신돼 규칙은 정상처럼 보이나 예정·현금흐름 AP가 빈다.
--   수정: 삭제행은 유니크에서 제외 — 같은 period의 live 행은 여전히 1건만 허용.
--   (financeRoutes.js generate의 중복 셋·ON CONFLICT 조건도 함께 live 기준으로 변경)
-- 안전성: 기존 인덱스가 live 중복을 이미 막고 있었으므로 재생성 시 중복 충돌 불가.
-- 멱등: DROP IF EXISTS + CREATE IF NOT EXISTS — 재실행 안전.
DROP INDEX IF EXISTS uq_txn_recurring;
CREATE UNIQUE INDEX IF NOT EXISTS uq_txn_recurring
  ON transactions (recurring_rule_id, recurring_period)
  WHERE recurring_rule_id IS NOT NULL AND deleted_at IS NULL;
