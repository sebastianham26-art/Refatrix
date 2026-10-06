-- wa_events.sql
-- (참고용 · whatsapp-webhook.js가 시작 시 자동 생성하므로 실행 불필요)
-- WhatsApp 웹훅으로 들어온 고객 메시지와 발송 상태를 저장하는 테이블 (PostgreSQL)

CREATE TABLE IF NOT EXISTS wa_events (
  id           BIGSERIAL PRIMARY KEY,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind         TEXT NOT NULL CHECK (kind IN ('message', 'status')),
  wamid        TEXT NOT NULL,          -- WhatsApp 메시지 ID
  phone        TEXT,                   -- 고객 번호 (52 + 10자리)
  msg_type     TEXT,                   -- text, image, button, interactive ...
  body         TEXT,                   -- 메시지 내용 (텍스트/버튼 답변/캡션)
  status       TEXT,                   -- sent, delivered, read, failed
  error        JSONB,                  -- 발송 실패 시 오류 내용
  raw          JSONB NOT NULL          -- Meta가 보낸 원본
);

-- Meta는 같은 알림을 여러 번 보낼 수 있으므로 중복 저장 방지
CREATE UNIQUE INDEX IF NOT EXISTS wa_events_dedupe
  ON wa_events (wamid, kind, (COALESCE(status, '')));

CREATE INDEX IF NOT EXISTS wa_events_phone_time
  ON wa_events (phone, received_at DESC);
