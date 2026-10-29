-- =====================================================================
-- 0307 · 소개(Referencia) 커미션 계약 (2026-10-29 · 디렉터 결정)
--   커미시오니스타 A(소개자)가 커미셔너 B(피소개자)를 소개 → B 가 커미션을 받는 매출이
--   완납(수금)되면 그 수금액(IVA 제외)의 1%(계약율)를 A 에게 지급.
--   · 계약 조건 + B 정보(계약서 제1조 표) = commission_referrals
--   · 제출 서류(계약서 제2조: CSF · 주소증빙 · 신분증 · 법인은 정관·위임장 / A 는 + 은행계좌) = commission_referral_docs
--     → 필수 서류가 모두 올라온 날 = docs_complete_on = 소개 효력일(그 전 수금분은 대상 아님)
--   · A 의 전자서명(손서명 이미지 + 본인 PIN · 조건 스냅샷) = commission_referral_signatures (수정·삭제 불가)
--   · A 에게 지급된 인보이스별 소개 커미션(지급 시점 금액·순매출 동결) = commission_referral_payouts
--   · 지급 후 B 매출이 줄면(NC·삭제) 다음 지급에서 차감한 기록 = commission_referral_adjustments
--   지급은 기존 커미션 지급 전표(commission_payments)·전자결재 흐름에 같이 들어간다.
-- =====================================================================

CREATE TABLE IF NOT EXISTS commission_referrals (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referrer_id      BIGINT NOT NULL REFERENCES users(id),        -- A · 소개자 (커미션 받는 사람)
  referred_id      BIGINT NOT NULL REFERENCES users(id),        -- B · 피소개 커미셔너
  rate             NUMERIC(6,3) NOT NULL DEFAULT 1 CHECK (rate >= 0 AND rate <= 100),
  start_date       DATE NOT NULL,
  end_date         DATE,                                        -- 비우면 B 계약이 유지되는 동안 계속
  referred_info    JSONB NOT NULL DEFAULT '{}'::jsonb,          -- 계약서 제1조 표: name·rfc·address·phone·email·legal_rep·persona(fisica/moral)
  active           BOOLEAN NOT NULL DEFAULT true,
  docs_complete_on DATE,                                        -- 필수 서류가 모두 갖춰진 날(소개 효력일 판단)
  note             TEXT,
  created_by       BIGINT REFERENCES users(id),
  updated_by       BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT commission_referrals_self CHECK (referrer_id <> referred_id),
  CONSTRAINT commission_referrals_dates CHECK (end_date IS NULL OR end_date >= start_date)
);
-- 한 B 는 동시에 한 명의 A 에게만 소개된 것으로 본다(이중 지급 방지)
CREATE UNIQUE INDEX IF NOT EXISTS uq_comm_referral_referred_active ON commission_referrals (referred_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_comm_referral_referrer ON commission_referrals (referrer_id);

CREATE TABLE IF NOT EXISTS commission_referral_docs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referral_id  BIGINT NOT NULL REFERENCES commission_referrals(id),
  party        TEXT NOT NULL CHECK (party IN ('referred','referrer')),
  doc_type     TEXT NOT NULL CHECK (doc_type IN ('csf','domicilio','ine','acta','poder','banco')),
  issued_date  DATE,                                            -- 발급일(CSF 30일 · 주소증빙 3개월 확인용)
  file_name    TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  file_size    INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  file_data    BYTEA NOT NULL,
  uploaded_by  BIGINT REFERENCES users(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  deleted_by   BIGINT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_comm_referral_docs ON commission_referral_docs (referral_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS commission_referral_signatures (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referral_id   BIGINT NOT NULL REFERENCES commission_referrals(id),
  user_id       BIGINT NOT NULL REFERENCES users(id),
  version_hash  TEXT NOT NULL,
  terms         JSONB NOT NULL,
  doc           JSONB NOT NULL,                                 -- 서명 시점 계약서 원문(스페인어 15개 조항)
  signature_png TEXT NOT NULL,                                  -- 손서명 이미지(data:image/png;base64,…)
  signed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_comm_referral_sig ON commission_referral_signatures (referral_id, signed_at DESC);

CREATE OR REPLACE FUNCTION commission_referral_signatures_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'commission_referral_signatures 는 수정·삭제할 수 없습니다 (전자서명 증빙)';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_comm_referral_sig_immutable ON commission_referral_signatures;
CREATE TRIGGER trg_comm_referral_sig_immutable
  BEFORE UPDATE OR DELETE ON commission_referral_signatures
  FOR EACH ROW EXECUTE FUNCTION commission_referral_signatures_immutable();

CREATE TABLE IF NOT EXISTS commission_referral_payouts (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referral_id  BIGINT NOT NULL REFERENCES commission_referrals(id),
  invoice_id   BIGINT NOT NULL REFERENCES sales_invoices(id),
  referrer_id  BIGINT NOT NULL REFERENCES users(id),
  amount       NUMERIC(15,2) NOT NULL,                          -- 지급(조정 후) 금액
  base_mxn     NUMERIC(15,2),                                   -- 지급 시점 커미션 기준액(ex-IVA) — 이후 차액 계산 기준
  rate         NUMERIC(6,3) NOT NULL,
  settle_ym    TEXT,
  paid         BOOLEAN NOT NULL DEFAULT true,
  paid_date    DATE,
  payment_id   BIGINT REFERENCES commission_payments(id),
  created_by   BIGINT REFERENCES users(id),
  updated_by   BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_comm_referral_payout UNIQUE (referral_id, invoice_id)
);
CREATE INDEX IF NOT EXISTS idx_comm_referral_payouts_referrer ON commission_referral_payouts (referrer_id);
CREATE INDEX IF NOT EXISTS idx_comm_referral_payouts_payment ON commission_referral_payouts (payment_id);

CREATE TABLE IF NOT EXISTS commission_referral_adjustments (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payout_id   BIGINT NOT NULL REFERENCES commission_referral_payouts(id),
  payment_id  BIGINT NOT NULL REFERENCES commission_payments(id),
  amount      NUMERIC(15,2) NOT NULL,                           -- 차감(음수)/추가(양수)
  old_amount  NUMERIC(15,2), new_amount NUMERIC(15,2),
  old_base    NUMERIC(15,2), new_base   NUMERIC(15,2),
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comm_referral_adj_payment ON commission_referral_adjustments (payment_id);
