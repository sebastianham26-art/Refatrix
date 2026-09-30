-- 0240 · 일일 자금(AP/AR) 스냅샷 누적 + 월간실적 + WhatsApp 지정 수신자 발송
--   · treasury_daily_snapshots : 하루 1행. 은행잔고(기초·마감, 통화별) · 실제 수금(AR)·지급(AP) · 환율 · 항목.
--       data       = 최신 재계산 결과(원장이 사후 수정되면 다시 계산될 때 갱신)
--       first_data = 처음 확정(최초 계산) 당시 결과 — 절대 덮지 않음. 사후 수정(소급 등록) 감지용.
--   · treasury_wa_recipients   : 디렉터가 관리하는 수신자(이름·번호·언어·일일/월간 선택·사용 여부)
--   · treasury_wa_sends        : 발송 원장 (종류 · 기간 · 수신자) 1행 — 성공 1회 가드 + 재시도 횟수
-- 모두 IF NOT EXISTS — 재실행 안전.

CREATE TABLE IF NOT EXISTS treasury_daily_snapshots (
  snap_date     DATE PRIMARY KEY,
  fx_rate       NUMERIC(15,6),
  open_mxn      NUMERIC(15,2) NOT NULL DEFAULT 0,
  open_usd      NUMERIC(15,2) NOT NULL DEFAULT 0,
  in_mxn        NUMERIC(15,2) NOT NULL DEFAULT 0,
  in_usd        NUMERIC(15,2) NOT NULL DEFAULT 0,
  out_mxn       NUMERIC(15,2) NOT NULL DEFAULT 0,
  out_usd       NUMERIC(15,2) NOT NULL DEFAULT 0,
  close_mxn     NUMERIC(15,2) NOT NULL DEFAULT 0,
  close_usd     NUMERIC(15,2) NOT NULL DEFAULT 0,
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_data    JSONB,
  first_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS treasury_wa_recipients (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,                       -- 정규화된 WA 번호(521+10자리 등)
  lang        TEXT NOT NULL DEFAULT 'es' CHECK (lang IN ('ko','es')),
  get_daily   BOOLEAN NOT NULL DEFAULT true,
  get_monthly BOOLEAN NOT NULL DEFAULT true,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS treasury_wa_sends (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('daily','monthly')),
  period        TEXT NOT NULL,                     -- daily: 'YYYY-MM-DD' · monthly: 'YYYY-MM'
  recipient_id  BIGINT NOT NULL REFERENCES treasury_wa_recipients(id),
  to_masked     TEXT,
  status        TEXT,                              -- sent_text / sent_template / failed
  message_id    TEXT,
  error         TEXT,
  attempts      INT NOT NULL DEFAULT 0,
  sent_at       TIMESTAMPTZ,                       -- 마지막 성공 시각(= 1회 가드)
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, period, recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_treasury_wa_sends_upd ON treasury_wa_sends (updated_at DESC);
