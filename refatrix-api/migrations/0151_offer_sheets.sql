-- =====================================================================
-- Refatrix ERP · 0151_offer_sheets
-- Offer Sheet(재입고 오퍼) — 부족분(stock_shortages)으로 남았던 제품이
-- 실제 입고(수입입고 승인 → 재고 등재)되면, 그 부족 이력을 고객별로 묶어
-- "요청하셨던 제품이 입고되었습니다. 구매하세요" 오퍼 문서를 자동 생성한다.
--   · 생성 트리거: ① 수입입고 승인 직후 자동  ② 부족분 화면의 수동 [스캔·생성]
--   · 단가 기준: 현재 정가(products.list_price) − 고객 기본할인(customers.discount)
--   · 발송: 1차는 화면에서 PDF 출력 + wa.me 링크(수동). WhatsApp API 자동발송은 추후.
--   · 부족 기록(stock_shortages) 자체는 건드리지 않는다(해소는 기존 디렉터 resolve 흐름).
-- =====================================================================

-- 오퍼 시트(고객 단위) ------------------------------------------------
CREATE TABLE IF NOT EXISTS offer_sheets (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  offer_no         TEXT UNIQUE,                          -- OS-YYYYMMDD-<id> (생성 직후 채움)
  customer_id      BIGINT NOT NULL REFERENCES customers(id),
  import_batch_id  BIGINT REFERENCES import_batches(id), -- 어느 입고 승인에서 생성됐나(수동 생성이면 NULL)
  status           TEXT NOT NULL DEFAULT 'ready'
                   CHECK (status IN ('ready','sent','cancelled')),
                   -- ready=생성됨(발송 대기) / sent=발송 완료 / cancelled=취소(시트의 부족분은 재생성 대상으로 복귀)
  origin           TEXT NOT NULL DEFAULT 'auto'
                   CHECK (origin IN ('auto','manual')),  -- auto=입고 승인 훅 / manual=화면 버튼
  subtotal_mxn     NUMERIC(15,2) NOT NULL DEFAULT 0,
  iva_mxn          NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_mxn        NUMERIC(15,2) NOT NULL DEFAULT 0,
  sent_at          TIMESTAMPTZ,
  sent_by          BIGINT REFERENCES users(id),
  sent_channel     TEXT,                                 -- 'whatsapp' 등(수동 기록)
  note             TEXT,
  created_by       BIGINT REFERENCES users(id),          -- NULL = 시스템(자동)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);
CREATE TRIGGER trg_offer_sheets_upd BEFORE UPDATE ON offer_sheets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS idx_offer_sheets_cust   ON offer_sheets (customer_id);
CREATE INDEX IF NOT EXISTS idx_offer_sheets_status ON offer_sheets (status, created_at);

-- 오퍼 라인(부족 기록 1건 = 1행, 화면·PDF에서는 제품별로 합산 표시) ----
CREATE TABLE IF NOT EXISTS offer_sheet_items (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  offer_sheet_id  BIGINT NOT NULL REFERENCES offer_sheets(id) ON DELETE CASCADE,
  shortage_id     BIGINT NOT NULL REFERENCES stock_shortages(id),
  product_id      BIGINT NOT NULL REFERENCES products(id),
  offer_qty       NUMERIC(15,3) NOT NULL,               -- 제안 수량 = 부족분 수량
  list_price      NUMERIC(15,2) NOT NULL DEFAULT 0,     -- 생성 시점 정가 스냅샷
  discount_rate   NUMERIC(5,2)  NOT NULL DEFAULT 0,     -- 생성 시점 고객 기본할인 스냅샷(%)
  unit_price      NUMERIC(15,2) NOT NULL DEFAULT 0,     -- 할인 적용 단가(IVA 제외)
  line_subtotal   NUMERIC(15,2) NOT NULL DEFAULT 0,
  line_iva        NUMERIC(15,2) NOT NULL DEFAULT 0,
  line_total      NUMERIC(15,2) NOT NULL DEFAULT 0,
  occurred_at     DATE                                  -- 부족 발생일(원 기록)
);
CREATE INDEX IF NOT EXISTS idx_osi_sheet    ON offer_sheet_items (offer_sheet_id);
CREATE INDEX IF NOT EXISTS idx_osi_shortage ON offer_sheet_items (shortage_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_osi_sheet_shortage ON offer_sheet_items (offer_sheet_id, shortage_id);
