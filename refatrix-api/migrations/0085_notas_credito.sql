-- =====================================================================
-- Refatrix ERP · 0085_notas_credito
-- 인보이스 발행 후 조기입금(pronto pago) 할인 등 "사내 할인 승인 증빙"(nota de crédito).
-- 1단계(사내 통제 전용): 디렉터 서명 증빙을 첨부하고, 승인 금액만큼 "비현금 반제"로
--   인보이스 잔액을 0으로 마감한다.  ※ 현금/수금 총액에는 잡히지 않음(4010 거래 미생성).
-- 추후 CFDI de egreso 연동 시 cfdi_uuid 컬럼을 사용한다(지금은 NULL).
-- =====================================================================

-- NC 헤더
CREATE TABLE IF NOT EXISTS notas_credito (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id   BIGINT NOT NULL REFERENCES sales_invoices(id),
  customer_id  BIGINT NOT NULL REFERENCES customers(id),
  concepto     TEXT NOT NULL,
  rate_pct     NUMERIC(7,4),                   -- 입력 할인률(%) — 금액 직접입력 시 NULL
  total_mxn    NUMERIC(15,2) NOT NULL,         -- 할인 총액(IVA 포함) = 비현금 반제 금액
  base_mxn     NUMERIC(15,2) NOT NULL,         -- ex-IVA
  iva_mxn      NUMERIC(15,2) NOT NULL,         -- IVA(16%) 분
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft | approved | applied | void
  cfdi_uuid    TEXT,                           -- (추후 CFDI 연동용) 지금은 NULL
  created_by   BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by  BIGINT REFERENCES users(id),
  approved_at  TIMESTAMPTZ,
  applied_at   TIMESTAMPTZ,
  voided_by    BIGINT REFERENCES users(id),
  voided_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_nc_invoice  ON notas_credito (invoice_id);
CREATE INDEX IF NOT EXISTS idx_nc_customer ON notas_credito (customer_id);
CREATE INDEX IF NOT EXISTS idx_nc_status   ON notas_credito (status);

-- 서명 증빙 문서(인쇄 → 서명 → 업로드). 입금증과 동일하게 data URL(base64) 저장.
CREATE TABLE IF NOT EXISTS nota_credito_docs (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nc_id       BIGINT NOT NULL REFERENCES notas_credito(id) ON DELETE CASCADE,
  file_name   TEXT,
  mime_type   TEXT,
  file_data   TEXT NOT NULL,
  uploaded_by BIGINT REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ncdoc_nc ON nota_credito_docs (nc_id);

-- 배분(allocation) 확장: 현금/NC 구분 + NC는 payment 없이 들어갈 수 있게.
--  · 기존 현금 배분은 DEFAULT 'cash' 로 자동 분류(하위호환).
--  · 미수금 계산(Σamount)에는 NC도 포함 → 인보이스 완납 처리.
--  · 현금/현금흐름은 transactions(4010) 기준이라 NC(거래 미생성)는 자동 제외 → 이중계상 없음.
ALTER TABLE sales_payment_allocations ADD COLUMN IF NOT EXISTS kind  TEXT NOT NULL DEFAULT 'cash';  -- cash | nota_credito
ALTER TABLE sales_payment_allocations ADD COLUMN IF NOT EXISTS nc_id BIGINT REFERENCES notas_credito(id);
ALTER TABLE sales_payment_allocations ALTER COLUMN payment_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_spa_nc ON sales_payment_allocations (nc_id);
