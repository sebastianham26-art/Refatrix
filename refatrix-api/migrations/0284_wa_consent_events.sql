-- =====================================================================
-- Refatrix ERP · 0284_wa_consent_events — WhatsApp 마케팅 수신 동의 기록 (2026-10-16 디렉터 지시)
--   「연락처에 수신동의를 위한 발송을 하고 회신이 오면 기록이 되도록」
--   지금까지는 연락처에 마지막 상태(consent · consent_via · consent_at)만 남았다 → 일어난 일을 모두 한 줄씩 남긴다.
--   kind : queued(요청 대기열에 넣음 · 누가) · asked(요청 나감 · 템플릿/버튼) · ask_failed(보내기 실패 · 사유)
--          · retry(전달 실패 → 다시 요청) · yes · no(본인 회신 · 버튼/글 — text 에 회신 원문)
--          · reply(동의 요청 뒤 다른 말로 답함 — 상태는 그대로) · manual_yes · manual_no · reset(사람이 바꿈 · 누가)
--   도착 · 읽음 · 전달 실패는 요청 메시지 id(wa_contacts.ask_message_id) → wa_message_status 로 본다.
--   기존 연락처는 지금 상태로 한 줄씩 옮겨 담는다(backfill · 한 번만).
--   멱등(IF NOT EXISTS · NOT EXISTS) — 재실행 안전.
-- =====================================================================
CREATE TABLE IF NOT EXISTS wa_consent_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_id  BIGINT NOT NULL REFERENCES wa_contacts(id),
  kind        TEXT NOT NULL,
  via         TEXT,                 -- template · interactive · button · message · sales
  text        TEXT,                 -- 회신 원문 · 실패 사유
  message_id  TEXT,                 -- 요청 메시지 wamid
  user_id     BIGINT REFERENCES users(id),
  backfill    BOOLEAN NOT NULL DEFAULT false,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_consent_events_contact ON wa_consent_events (contact_id, at DESC);

-- 기존 기록 옮겨 담기 — 요청 보낸 적 있으면 asked, 동의/거부가 있으면 그 결과(via 그대로)
INSERT INTO wa_consent_events (contact_id, kind, via, message_id, backfill, at)
SELECT w.id, 'asked', NULL, w.ask_message_id, true, w.asked_at
  FROM wa_contacts w
 WHERE w.asked_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM wa_consent_events e WHERE e.contact_id = w.id AND e.backfill);
INSERT INTO wa_consent_events (contact_id, kind, via, user_id, backfill, at)
SELECT w.id,
       CASE WHEN w.consent_via = 'sales' THEN 'manual_' || w.consent ELSE w.consent END,
       w.consent_via, CASE WHEN w.consent_via = 'sales' THEN w.consent_by END, true, COALESCE(w.consent_at, w.updated_at)
  FROM wa_contacts w
 WHERE w.consent IN ('yes', 'no')
   AND NOT EXISTS (SELECT 1 FROM wa_consent_events e WHERE e.contact_id = w.id AND e.backfill AND e.kind <> 'asked');
