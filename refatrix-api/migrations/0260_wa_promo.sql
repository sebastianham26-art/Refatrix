-- 0260 · WhatsApp 마케팅 — 잠재고객 연락처 · 수신 동의 · 발송 일정(이미지) · 받은/보낸 메시지 · 자동응답 (2026-10-07 디렉터 지시)
--   · wa_contacts         : 잠재고객(이름·번호·메모·출처) + 수신 동의 상태(unknown → asked → yes / no) + 받은 메시지함 상태
--   · wa_messages         : 받은 메시지(웹훅) · 보낸 메시지(자동응답·직접 답장·동의 요청·정기 발송) 전부 — Cloud API 는 지난 대화를
--                           돌려주지 않으므로 ERP 가 받는 순간 저장한다. 실제 도착·읽음은 wa_message_status(0253)와 wamid 로 잇는다.
--   · wa_campaigns        : 일자별 발송(이미지 + 문구, 멕시코 시각) · wa_campaign_sends : (발송 × 연락처) 1행
--   · wa_autoreplies      : 자동응답 규칙(받은 말·버튼 → 답장 + 할 일)
-- 모두 IF NOT EXISTS — 재실행 안전.

CREATE TABLE IF NOT EXISTS wa_contacts (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL,                          -- 52 + 10자리
  memo          TEXT,
  source        TEXT NOT NULL DEFAULT 'manual',          -- manual / excel / survey
  source_ref    TEXT,                                    -- 예: survey:3:EXPO26_0137
  consent       TEXT NOT NULL DEFAULT 'unknown',          -- unknown / asked / yes / no
  consent_at    TIMESTAMPTZ,
  consent_via   TEXT,                                    -- button / message / sales / import
  consent_by    BIGINT REFERENCES users(id),             -- 영업 확인 등 사람이 바꾼 경우
  ask_queued_at TIMESTAMPTZ,                             -- 동의 요청 대기열
  asked_at      TIMESTAMPTZ,                             -- 동의 요청 보낸 시각(1회)
  ask_message_id TEXT,
  ask_error     TEXT,
  inbox_state   TEXT NOT NULL DEFAULT 'none',             -- none / open(미처리) / done(처리 완료)
  lead          BOOLEAN NOT NULL DEFAULT false,          -- 🙋 상담 요청
  assigned_to   BIGINT REFERENCES users(id),
  note          TEXT,
  last_in_at    TIMESTAMPTZ,
  last_out_at   TIMESTAMPTZ,
  created_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  CONSTRAINT wa_contacts_consent_chk CHECK (consent IN ('unknown','asked','yes','no')),
  CONSTRAINT wa_contacts_inbox_chk CHECK (inbox_state IN ('none','open','done')),
  CONSTRAINT wa_contacts_source_chk CHECK (source IN ('manual','excel','survey'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_contacts_phone ON wa_contacts (phone) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wa_contacts_consent ON wa_contacts (consent) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wa_contacts_ask ON wa_contacts (ask_queued_at) WHERE ask_queued_at IS NOT NULL AND asked_at IS NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS wa_campaigns (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  send_at       TIMESTAMPTZ NOT NULL,
  caption       TEXT NOT NULL,
  image         BYTEA NOT NULL,
  image_mime    TEXT NOT NULL,
  image_name    TEXT,
  memo_filter   TEXT,                                    -- 비우면 동의 전체, 값이 있으면 메모에 그 말이 있는 동의자만
  status        TEXT NOT NULL DEFAULT 'scheduled',       -- scheduled / sending / done / cancelled
  media_id      TEXT,
  media_at      TIMESTAMPTZ,
  target_n      INT,
  created_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  CONSTRAINT wa_campaigns_status_chk CHECK (status IN ('scheduled','sending','done','cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_wa_campaigns_due ON wa_campaigns (send_at) WHERE status IN ('scheduled','sending');

CREATE TABLE IF NOT EXISTS wa_campaign_sends (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id   BIGINT NOT NULL REFERENCES wa_campaigns(id) ON DELETE CASCADE,
  contact_id    BIGINT NOT NULL REFERENCES wa_contacts(id),
  status        TEXT NOT NULL,                           -- sending / sent_image / sent_template / failed
  message_id    TEXT,
  error         TEXT,
  attempts      INT NOT NULL DEFAULT 0,
  sent_at       TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_wa_campaign_sends_msg ON wa_campaign_sends (message_id);

CREATE TABLE IF NOT EXISTS wa_messages (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  direction     TEXT NOT NULL,                           -- in / out
  phone         TEXT NOT NULL,
  contact_id    BIGINT REFERENCES wa_contacts(id),
  wamid         TEXT,
  kind          TEXT,                                    -- text / button / interactive / image / template / audio …
  body          TEXT,
  payload       TEXT,                                    -- 버튼 payload · 미디어 id
  source        TEXT NOT NULL,                           -- inbound / autoreply / manual / consent / campaign
  campaign_id   BIGINT REFERENCES wa_campaigns(id) ON DELETE SET NULL,
  rule_id       BIGINT,
  sent_by       BIGINT REFERENCES users(id),
  ok            BOOLEAN,
  error         TEXT,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wa_messages_dir_chk CHECK (direction IN ('in','out'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_messages_in_wamid ON wa_messages (wamid) WHERE direction = 'in' AND wamid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wa_messages_contact ON wa_messages (contact_id, at);
CREATE INDEX IF NOT EXISTS idx_wa_messages_phone ON wa_messages (phone, at);
CREATE INDEX IF NOT EXISTS idx_wa_messages_at ON wa_messages (at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_messages_wamid ON wa_messages (wamid);

CREATE TABLE IF NOT EXISTS wa_autoreplies (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sort          INT NOT NULL DEFAULT 100,
  keywords      TEXT[] NOT NULL DEFAULT '{}',
  is_fallback   BOOLEAN NOT NULL DEFAULT false,          -- 어떤 규칙에도 안 맞을 때
  reply         TEXT NOT NULL,
  buttons       TEXT[] NOT NULL DEFAULT '{}',            -- 답장에 붙일 선택 버튼(최대 3)
  action        TEXT NOT NULL DEFAULT 'none',            -- none / consent_yes / consent_no / lead
  active        BOOLEAN NOT NULL DEFAULT true,
  updated_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  CONSTRAINT wa_autoreplies_action_chk CHECK (action IN ('none','consent_yes','consent_no','lead'))
);

-- 기본 규칙(처음 한 번만) — 화면에서 고칠 수 있다
INSERT INTO wa_autoreplies (sort, keywords, is_fallback, reply, buttons, action)
SELECT * FROM (VALUES
  (10, ARRAY['si quiero','si','sí','acepto']::text[], false,
   '¡Listo! Recibirá nuestras promociones y novedades. Puede escribir BAJA cuando quiera dejar de recibirlas.', ARRAY[]::text[], 'consent_yes'),
  (20, ARRAY['no gracias','no','baja','stop','cancelar']::text[], false,
   'Entendido, no le enviaremos más promociones. ¡Gracias!', ARRAY[]::text[], 'consent_no'),
  (30, ARRAY['quiero cotizar','cotizar','cotizacion','precio','precios','hablar con asesor','asesor']::text[], false,
   '¡Gracias! Un asesor de Refatrix le escribirá en breve. ¿Para qué vehículo y año lo necesita?', ARRAY[]::text[], 'lead'),
  (40, ARRAY['ver catalogo','catalogo']::text[], false,
   'Aquí puede ver nuestro catálogo: https://refatrix.com', ARRAY[]::text[], 'none'),
  (900, ARRAY[]::text[], true,
   'Gracias por escribir a Refatrix. Horario de atención: lunes a viernes 8:00-18:00. ¿En qué podemos ayudarle?',
   ARRAY['Quiero cotizar','Ver catálogo','Hablar con asesor']::text[], 'none')
) AS v(sort, keywords, is_fallback, reply, buttons, action)
WHERE NOT EXISTS (SELECT 1 FROM wa_autoreplies);
