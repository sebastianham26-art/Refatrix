-- =====================================================================
-- Refatrix ERP · 0013_import_cost_redesign
-- 수입 부대비용을 입고와 분리하고, 여러 입고 건에 분배/소급정정/마감처리하기 위한 구조.
-- 설계 메모(수입 원가 모델) 1단계: 데이터 구조.
--   · import_cost_docs    : 부대비용 문서(나중에·분산 입력)
--   · import_cost_lines   : 부대비용 명세(명목·금액·통화·인보이스)
--   · import_cost_allocations : 부대비용 → 입고 건 분배(다대다, 수량비율 스냅샷)
--   · import_cost_adjustments : 승인 시 제품별 처리 결과 스냅샷
--   · cogs_adjustments     : 판매(COGS)별 정정 내역(브레이크다운)
--   · period_closings      : 월 마감(잠금 기준)
--   · stock_movements 보강 : 출처 연결(batch/invoice/cost_doc)
--   · categories 시드      : 수입원가 정산차액(비용 과목)
-- =====================================================================

-- 부대비용 문서 ------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_cost_docs (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_no        TEXT,                                  -- 부대비용 건 번호(선택)
  cost_date     DATE NOT NULL,                         -- 환율 기준일
  fx_rate       NUMERIC(15,6) NOT NULL,                -- USD -> MXN (입고일/적용일 환율)
  base_currency TEXT NOT NULL DEFAULT 'MXN',
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('draft','pending','approved','rejected')),
  note          TEXT,
  created_by    BIGINT REFERENCES users(id),
  approved_by   BIGINT REFERENCES users(id),
  approved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE TRIGGER trg_import_cost_docs_upd BEFORE UPDATE ON import_cost_docs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS idx_icd_status ON import_cost_docs (status);

-- 부대비용 명세 ------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_cost_lines (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id      BIGINT NOT NULL REFERENCES import_cost_docs(id),
  label       TEXT NOT NULL,                           -- 명목(예: 해상운임, 통관사)
  amount      NUMERIC(15,2) NOT NULL,                  -- 금액(원통화)
  currency    TEXT,                                    -- USD/MXN (없으면 USD)
  invoice_no  TEXT
);
CREATE INDEX IF NOT EXISTS idx_icl_doc ON import_cost_lines (doc_id);

-- 부대비용 → 입고 건 분배 (다대다) -----------------------------------
CREATE TABLE IF NOT EXISTS import_cost_allocations (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id           BIGINT NOT NULL REFERENCES import_cost_docs(id),
  batch_id         BIGINT NOT NULL REFERENCES import_batches(id),
  batch_qty        NUMERIC(15,3),                      -- 그 입고 건 총수량(비율 산정 기준, 스냅샷)
  ratio            NUMERIC(15,6),                      -- 수량 비율(스냅샷)
  alloc_amount_mxn NUMERIC(15,2),                      -- 그 건 배분액(MXN, 스냅샷)
  UNIQUE (doc_id, batch_id)
);
CREATE INDEX IF NOT EXISTS idx_ica_doc   ON import_cost_allocations (doc_id);
CREATE INDEX IF NOT EXISTS idx_ica_batch ON import_cost_allocations (batch_id);

-- 승인 시 제품별 처리 결과 스냅샷 ------------------------------------
CREATE TABLE IF NOT EXISTS import_cost_adjustments (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id               BIGINT NOT NULL REFERENCES import_cost_docs(id),
  batch_id             BIGINT NOT NULL REFERENCES import_batches(id),
  product_id           BIGINT NOT NULL REFERENCES products(id),
  closed_month         BOOLEAN NOT NULL DEFAULT false, -- 그 입고 건이 마감월인지
  batch_qty            NUMERIC(15,3),
  per_unit_mxn         NUMERIC(15,2),                  -- 단위당 추가 부대비용
  sold_qty             NUMERIC(15,3),                  -- 이미 팔린 수량
  remaining_qty        NUMERIC(15,3),                  -- 재고에 남은 수량
  stock_added_mxn      NUMERIC(15,2),                  -- 재고 가산액
  variance_expense_mxn NUMERIC(15,2),                  -- 정산차액(마감분, 팔린 몫)
  retro_cogs_mxn       NUMERIC(15,2),                  -- 소급 COGS 정정(미마감)
  avg_cost_before      NUMERIC(15,2),
  avg_cost_after       NUMERIC(15,2),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_icadj_doc  ON import_cost_adjustments (doc_id);
CREATE INDEX IF NOT EXISTS idx_icadj_prod ON import_cost_adjustments (product_id);

-- 판매(COGS)별 정정 내역(브레이크다운) ------------------------------
CREATE TABLE IF NOT EXISTS cogs_adjustments (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id           BIGINT NOT NULL REFERENCES import_cost_docs(id),
  invoice_id       BIGINT REFERENCES invoices(id),
  product_id       BIGINT NOT NULL REFERENCES products(id),
  sale_date        DATE,
  qty              NUMERIC(15,3),
  unit_cost_before NUMERIC(15,2),
  unit_cost_after  NUMERIC(15,2),
  diff_mxn         NUMERIC(15,2),
  kind             TEXT NOT NULL CHECK (kind IN ('retro','variance')),
                     -- retro=과거 손익 소급 정정(미마감) / variance=정산차액 비용(마감)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cogsadj_doc ON cogs_adjustments (doc_id);
CREATE INDEX IF NOT EXISTS idx_cogsadj_inv ON cogs_adjustments (invoice_id);

-- 월 마감(잠금 기준) -------------------------------------------------
CREATE TABLE IF NOT EXISTS period_closings (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  period     CHAR(7) NOT NULL UNIQUE,                  -- 'YYYY-MM'
  closed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by  BIGINT REFERENCES users(id)
);

-- 재고이동 원장 보강(출처 연결) --------------------------------------
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS batch_id    BIGINT REFERENCES import_batches(id);
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS invoice_id  BIGINT REFERENCES invoices(id);
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS cost_doc_id BIGINT REFERENCES import_cost_docs(id);

-- 수입원가 정산차액 비용 과목 시드 -----------------------------------
INSERT INTO categories (code, name, group_name, sort_order)
VALUES ('5020','수입원가 정산차액','매출원가',31)
ON CONFLICT (code) DO NOTHING;
