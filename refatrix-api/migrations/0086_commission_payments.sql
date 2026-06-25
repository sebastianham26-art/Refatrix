-- =====================================================================
-- 커미션 지급(반제) + 증빙 모듈
--   - 재무담당/디렉터가 영업사원 1인 단위로 "지급 전표"를 등록(송금액 + 증빙 필수)
--   - 등록 시 그 영업사원의 확정(반제완납)·미지급 커미션을 오래된 인보이스부터(FIFO)
--     송금액만큼 충당(반제) → commission_payouts.paid=true 로 확정 지급 처리
--   - 증빙(은행 송금증/시스템 캡처)은 base64 로 전표에 1건 보관(인증헤더 fetch 로 열람)
-- 권한: 등록/반제 = director + treasury(commission 'edit') / 열람 = socio·sales(view)
-- =====================================================================

-- (1) 커미션 지급 전표(헤더) — 영업사원 1인 = 1 전표, 증빙 필수
CREATE TABLE IF NOT EXISTS commission_payments (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id    BIGINT NOT NULL REFERENCES users(id),    -- 지급 대상 영업사원
  amount      NUMERIC(15,2) NOT NULL DEFAULT 0,         -- 실제 송금(지급)액 MXN
  settled     NUMERIC(15,2) NOT NULL DEFAULT 0,         -- 이 전표로 반제 충당된 합계
  paid_date   DATE NOT NULL,                            -- 지급일
  note        TEXT,
  evi_name    TEXT,                                     -- 증빙 파일명
  evi_mime    TEXT,                                     -- image/* 또는 application/pdf
  evi_data    TEXT NOT NULL,                            -- base64 증빙(필수)
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comm_pay_agent ON commission_payments (agent_id);

-- (2) 반제 충당 내역 — 전표가 어떤 인보이스 커미션을 얼마나 충당했는지
CREATE TABLE IF NOT EXISTS commission_payment_allocations (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id  BIGINT NOT NULL REFERENCES commission_payments(id) ON DELETE CASCADE,
  invoice_id  BIGINT NOT NULL REFERENCES sales_invoices(id),
  amount      NUMERIC(15,2) NOT NULL DEFAULT 0           -- 이 인보이스에 충당된 금액(=확정 커미션)
);
CREATE INDEX IF NOT EXISTS idx_comm_alloc_payment ON commission_payment_allocations (payment_id);
CREATE INDEX IF NOT EXISTS idx_comm_alloc_invoice ON commission_payment_allocations (invoice_id);

-- (3) 기존 지급상태에 전표 연결(추적용). 어떤 전표로 지급됐는지.
ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS payment_id BIGINT REFERENCES commission_payments(id);

-- (4) 권한 시드
--   - 재무담당(treasury): commission 'edit'  → 지급 전표 등록/반제 가능
--   - 소시오(socio):       commission 'view'  → 전체 영업사원 열람(지급 불가)
--   (영업사원 'view' 는 0055 에서 이미 시드됨 · 디렉터는 전체 통과)
INSERT INTO user_page_access (user_id, page_key, device_req, access)
SELECT u.id, 'commission', 'anywhere', 'edit'
  FROM users u
 WHERE u.deleted_at IS NULL AND u.role = 'treasury'
ON CONFLICT (user_id, page_key) DO UPDATE SET access = 'edit', device_req = 'anywhere';

INSERT INTO user_page_access (user_id, page_key, device_req, access)
SELECT u.id, 'commission', 'anywhere', 'view'
  FROM users u
 WHERE u.deleted_at IS NULL AND u.role = 'socio'
ON CONFLICT (user_id, page_key) DO NOTHING;
