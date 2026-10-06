-- 0253 · WhatsApp 웹훅 — 실제 전달 상태(접수/도착/읽음/실패) + 수신자의 마지막 메시지 시각 (2026-10-06)
--   API 「성공」은 Meta 가 접수했다는 뜻일 뿐이다. 실제 도착 여부와 실패 사유는 나중에 웹훅으로 온다.
--   ① wa_message_status : 메시지 ID(wamid)별 최종 상태. 모든 발송 경로(일일자금·브리핑·오퍼시트·요약)가 공용.
--   ② wa_inbound        : 번호별 마지막 수신 메시지 시각 → 24시간 창이 열려 있는지 판단.
--   번호는 52+10자리로 정규화해 저장한다(웹훅은 멕시코 번호를 521… 로 보낸다).
--   메시지 본문은 저장하지 않는다(시각·유형만).

CREATE TABLE IF NOT EXISTS wa_message_status (
  message_id    TEXT PRIMARY KEY,                      -- wamid.…
  recipient     TEXT,                                  -- 정규화 번호(52…)
  status        TEXT NOT NULL CHECK (status IN ('sent','delivered','read','failed')),
  sent_at       TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  read_at       TIMESTAMPTZ,
  failed_at     TIMESTAMPTZ,
  error_code    INT,
  error_title   TEXT,
  error_detail  TEXT,
  pricing_category TEXT,                               -- utility / service / marketing …
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_message_status_upd ON wa_message_status (updated_at DESC);

CREATE TABLE IF NOT EXISTS wa_inbound (
  wa_from       TEXT PRIMARY KEY,                      -- 정규화 번호(52…)
  last_at       TIMESTAMPTZ NOT NULL,
  last_type     TEXT,                                  -- text / image / button …
  msg_count     INT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
