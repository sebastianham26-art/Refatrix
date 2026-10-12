-- =====================================================================
-- Refatrix ERP · 0268_lead_wa_notify  (2026-10-12)
-- 웹 카달록 **가입신청** WhatsApp 자동 알림
--
--   디렉터 지시:
--     "관리>웹 카달록 가입신청이 접수되면 디렉터가 담당자를 지정하는데, whatsapp으로
--      자동전송되도록 만들어줘. 1) 디렉터에게 … 내용을 발송 2) 디렉터가 담당자를 지정하면
--      담당자에게 whatsapp을 전송"
--
--   ★ 수신자 표를 **새로 만들지 않았다.** 받는 사람은 이미 두 곳에 있다:
--       · 접수 알림  → `crm_lead_notify_targets` (팝업 알림 대상 · 0210) + 디렉터는 항상
--       · 담당자 알림 → 지정된 그 사용자
--     번호는 둘 다 `users.wa_phone`(0165) 을 쓴다. 표를 또 만들면 「팝업은 오는데 WhatsApp 은
--     안 오는 사람」이 생기고, 그 불일치는 아무도 버그로 신고하지 않은 채 신뢰만 깎는다.
--
--   그래서 여기서 만드는 것은 **원장과 스위치뿐**이다.
--   모두 IF NOT EXISTS — 재실행 안전.
-- =====================================================================

-- (1) 발송 원장 ------------------------------------------------------
--   (가입신청 · 종류 · 받는 사람) 1행. 이 유니크가 **1회 발송 가드**다.
--     kind='received' → 접수 알림(받는 사람마다 1행)
--     kind='assigned' → 담당자 지정 알림(지정된 사람마다 1행 — 담당자가 바뀌면 새 사람에게 1행)
--   claimed_at 은 동시 발송 잠금이다(워커와 즉시 발송이 같은 건을 집는 것을 막는다).
CREATE TABLE IF NOT EXISTS crm_lead_wa_sends (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id     BIGINT NOT NULL REFERENCES crm_web_leads(id) ON DELETE CASCADE,
  kind        TEXT   NOT NULL CHECK (kind IN ('received','assigned')),
  user_id     BIGINT NOT NULL REFERENCES users(id),
  to_masked   TEXT,
  status      TEXT,                                -- sending / sent_template / sent_text / failed / skipped
  message_id  TEXT,
  error       TEXT,
  attempts    INT NOT NULL DEFAULT 0,
  claimed_at  TIMESTAMPTZ,
  sent_at     TIMESTAMPTZ,                          -- 성공 시각(= 1회 가드)
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lead_id, kind, user_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_wa_sends_upd ON crm_lead_wa_sends (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_wa_sends_msg ON crm_lead_wa_sends (message_id);
-- 워커가 줍는 조건 그대로 — 아직 못 보낸 건만.
CREATE INDEX IF NOT EXISTS idx_lead_wa_sends_open
  ON crm_lead_wa_sends (lead_id) WHERE sent_at IS NULL;

COMMENT ON TABLE crm_lead_wa_sends IS
  '가입신청 WhatsApp 발송 원장. (lead_id,kind,user_id) 유니크 = 1회 발송 가드. 0268';

-- (2) 스위치 ---------------------------------------------------------
--   두 알림을 **따로** 끌 수 있어야 한다. 접수 알림은 디렉터 한 사람의 일이고
--   담당자 알림은 영업사원 여러 명의 일이라, 하나가 시끄러워도 다른 쪽을 같이 끄게 되면
--   결국 둘 다 꺼 놓고 쓰지 않게 된다.
--   ⚠ 끄는 수단을 화면에 둔 이유: Railway 변수로만 두면 밤에 시끄러울 때 아무도 못 끈다.
CREATE TABLE IF NOT EXISTS crm_lead_wa_settings (
  id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  notify_received BOOLEAN NOT NULL DEFAULT true,   -- ① 접수 → 알림 대상자 + 디렉터
  notify_assigned BOOLEAN NOT NULL DEFAULT true,   -- ② 담당자 지정 → 그 담당자
  updated_by      BIGINT REFERENCES users(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO crm_lead_wa_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE crm_lead_wa_settings IS
  '가입신청 WhatsApp 알림 켜기/끄기(접수·담당자 지정 각각). 1행만 존재. 0268';
