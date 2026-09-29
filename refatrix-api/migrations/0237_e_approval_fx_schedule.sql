-- =====================================================================
-- Refatrix ERP · 0237_e_approval_fx_schedule
--   전자결재(0234) 확장 — 디렉터 요청 2026-09-29
--   ① 통화: USD 로 기입하면 ERP 재무 환율(fx_rates, 0019)로 MXN 자동 환산.
--      · 상신 시점에 환율을 문서에 고정(fx_rate · fx_date · fx_locked_at). 한 번 고정되면 바뀌지 않는다
--        (회수 후 재상신해도 유지 · 재기안 새 문서만 새로 고정).
--      · 결재·기준액·리포트는 전부 MXN(planned_*) 기준 — 원통화 금액은 orig_* 에 보존.
--   ② 결제 방식: 일시불(once) · 분할(installment) · 정기 반복(recurring, 매주·격주·매월·분기).
--      · 회차는 approval_payments — 회차별로 재무가 집행(실적·지급일·증빙). USD 회차는 그 지급일 환율로 고정.
--      · 모든 회차가 집행/중단되면 문서 집행완료 → 대표이사 사후승인(기존 흐름 그대로).
--   ③ 본문 그림: body_rich(JSON: 문단 텍스트 · data:image 그림). body 는 검색·엑셀용 평문으로 유지.
--   · 재무상태·cashflow 에는 여전히 쓰지 않는다.
--   · 기존 문서는 회차 1개(일시불)로 백필 — 이미 집행된 문서는 그 회차를 집행완료로.
--   · 전 구문 IF NOT EXISTS / NOT EXISTS — 재실행 안전.
-- =====================================================================

ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS currency      TEXT NOT NULL DEFAULT 'MXN';
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS fx_rate       NUMERIC(15,6) NOT NULL DEFAULT 1;
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS fx_date       DATE;
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS fx_source     TEXT;
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS fx_locked_at  TIMESTAMPTZ;
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS orig_sub      NUMERIC(14,2);
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS orig_iva      NUMERIC(14,2);
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS orig_total    NUMERIC(14,2);
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS payment_type  TEXT NOT NULL DEFAULT 'once';
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS payment_plan  TEXT;      -- JSON: {freq,count,start,per_sub} 편집 복원용
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS body_rich     TEXT;      -- JSON: [{t:'p',v},{t:'img',src,w,h}]

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approval_documents_currency_chk') THEN
    ALTER TABLE approval_documents ADD CONSTRAINT approval_documents_currency_chk CHECK (currency IN ('MXN','USD'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approval_documents_payment_type_chk') THEN
    ALTER TABLE approval_documents ADD CONSTRAINT approval_documents_payment_type_chk CHECK (payment_type IN ('once','installment','recurring'));
  END IF;
END $$;

-- 기존 문서: 원통화 금액 = MXN 금액
UPDATE approval_documents SET orig_sub = planned_sub, orig_iva = planned_iva, orig_total = planned_total
 WHERE orig_sub IS NULL;

-- 지급 회차 -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_payments (
  id              BIGSERIAL PRIMARY KEY,
  document_id     BIGINT NOT NULL REFERENCES approval_documents(id) ON DELETE CASCADE,
  seq             INT NOT NULL,
  due_date        DATE,
  planned_amount  NUMERIC(14,2) NOT NULL,          -- 문서 통화 · IVA 포함
  planned_mxn     NUMERIC(14,2) NOT NULL,          -- 상신 시 고정 환율로 환산
  status          TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','done','skipped')),
  actual_amount   NUMERIC(14,2),                   -- 문서 통화
  actual_mxn      NUMERIC(14,2),                   -- 지급일 환율로 환산(집행 시 고정)
  fx_rate         NUMERIC(15,6),
  fx_date         DATE,
  exec_date       DATE,
  pay_method      TEXT,
  memo            TEXT,
  exec_at         TIMESTAMPTZ,
  exec_by         BIGINT REFERENCES users(id),
  skip_reason     TEXT,
  UNIQUE (document_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_approval_payments_doc ON approval_payments(document_id);

-- 기존 문서 백필: 회차 1개(일시불)
INSERT INTO approval_payments (document_id, seq, due_date, planned_amount, planned_mxn, status,
  actual_amount, actual_mxn, fx_rate, exec_date, pay_method, memo, exec_at, exec_by)
SELECT d.id, 1, d.pay_due, d.planned_total, d.planned_total,
       CASE WHEN d.exec_status = 'done' THEN 'done' ELSE 'planned' END,
       CASE WHEN d.exec_status = 'done' THEN d.actual_total END,
       CASE WHEN d.exec_status = 'done' THEN d.actual_total END,
       CASE WHEN d.exec_status = 'done' THEN 1 END,
       d.exec_date, d.exec_pay_method, d.exec_memo, d.exec_at, d.exec_by
  FROM approval_documents d
 WHERE NOT EXISTS (SELECT 1 FROM approval_payments p WHERE p.document_id = d.id);

-- 증빙 ↔ 회차(집행 증빙이 어느 회차 것인지)
ALTER TABLE approval_files ADD COLUMN IF NOT EXISTS payment_id BIGINT REFERENCES approval_payments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_approval_files_payment ON approval_files(payment_id);
