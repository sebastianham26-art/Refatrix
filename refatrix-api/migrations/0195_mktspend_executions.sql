-- 0195_mktspend_executions.sql
-- 마케팅 지출계획 「집행 처리」 — 재무등록과 독립적으로 계획을 소진한다.
--
-- 배경: 지급라인 1건 = 예정거래 1건 = 실적 1건 구조라, 한 번의 송금으로 여러 줄을
--       커버하면 나머지 줄이 영원히 예정으로 남아 현금예측이 과대계상됐다.
--       (설계: claude/REFATRIX_설계_2026-09-03_mktspend_execution_diff.md)
--
-- 이 마이그레이션은 "집행 기록"만 추가한다. 실제 송금 거래와의 링크는 두지 않는다
-- (디렉터 결정 — 재무등록과 별도로 움직여야 함). 대신 월 단위 금액 대사로 오차를 잡는다.
--
-- 멱등: 전부 IF NOT EXISTS. 여러 번 적용해도 안전.

CREATE TABLE IF NOT EXISTS marketing_spend_executions (
  id            BIGSERIAL PRIMARY KEY,
  line_id       BIGINT NOT NULL REFERENCES marketing_spend_lines(id) ON DELETE CASCADE,
  plan_id       BIGINT,                       -- 조회 편의(대사 패널). 라인의 plan_id 사본
  exec_date     DATE NOT NULL,                -- 실제 송금일(사용자 입력)
  amount        NUMERIC(15,2) NOT NULL,       -- 실지급액
  note          TEXT,                         -- 비고(송금 참조번호 등 자유입력)
  created_by    BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reverted_at   TIMESTAMPTZ,                  -- 되돌리기(소프트 취소) — 이력 보존
  reverted_by   BIGINT,
  revert_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_mse_line ON marketing_spend_executions(line_id);
CREATE INDEX IF NOT EXISTS idx_mse_plan ON marketing_spend_executions(plan_id);
CREATE INDEX IF NOT EXISTS idx_mse_date ON marketing_spend_executions(exec_date);

ALTER TABLE marketing_spend_lines
  ADD COLUMN IF NOT EXISTS exec_closed       BOOLEAN NOT NULL DEFAULT false, -- 완결(더 나갈 돈 없음)
  ADD COLUMN IF NOT EXISTS exec_closed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS exec_closed_by    BIGINT,
  -- 예정 거래를 "집행 처리 때문에" 우리가 소프트삭제했는지 표시.
  -- 되돌리기에서 이 표시가 있을 때만 거래를 복원한다.
  -- (재무 > 예정 삭제 등 다른 경로로 지워진 거래를 되살리지 않기 위한 가드)
  ADD COLUMN IF NOT EXISTS exec_txn_settled  BOOLEAN NOT NULL DEFAULT false;
