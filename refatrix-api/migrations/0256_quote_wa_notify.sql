-- 0256 · 견적·매출 추적 — 신규 견적 WhatsApp 알림 (2026-10-07 디렉터 지시)
--   · quote_wa_recipients : 받는 사람(이름 · 번호 · 언어 · 팀 범위 · 사용 여부)
--       team_ids NULL/빈 배열 = 모든 견적, 값이 있으면 그 팀 고객의 견적만(불특정 고객 견적은 작성자 팀).
--   · quote_wa_sends      : (견적 · 수신자) 1행 — 1회 발송 가드 + 재시도 횟수 + 동시 발송 잠금(claimed_at)
--   알림 대상은 「수신자 등록 이후에 만들어진 견적」뿐이다 — 등록하는 순간 옛 견적이 몰려가지 않게.
-- 모두 IF NOT EXISTS — 재실행 안전.

CREATE TABLE IF NOT EXISTS quote_wa_recipients (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,                       -- 52 + 10자리(정규화)
  lang        TEXT NOT NULL DEFAULT 'ko' CHECK (lang IN ('ko','es')),
  team_ids    BIGINT[],                            -- NULL = 전체 팀
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS quote_wa_sends (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quote_id      BIGINT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  recipient_id  BIGINT NOT NULL REFERENCES quote_wa_recipients(id),
  to_masked     TEXT,
  status        TEXT,                              -- sending / sent_text / sent_template / failed
  message_id    TEXT,
  error         TEXT,
  attempts      INT NOT NULL DEFAULT 0,
  claimed_at    TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,                       -- 성공 시각(= 1회 가드)
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (quote_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_quote_wa_sends_upd ON quote_wa_sends (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_quote_wa_sends_msg ON quote_wa_sends (message_id);
