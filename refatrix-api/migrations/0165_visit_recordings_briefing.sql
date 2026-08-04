-- 방문 상담 녹음·AI 요약 + 영업사원 아침 브리핑 (2026-08-03)
-- ① sales_visit_recordings : 방문(sales_visits)에 붙는 상담 녹음 1건.
--    업로드(queued) → 전사(transcribing, Whisper) → 요약(summarizing, Claude) → done.
--    처리 성공 시 audio_b64 는 기본 폐기(NULL) — VISIT_KEEP_AUDIO=1 이면 보존.
-- ② users.wa_phone : 영업사원별 WhatsApp 수신번호(아침 브리핑용, 디렉터가 사용자 화면에서 설정).
-- ③ sales_briefing_sends : 사원별·일자별 아침 브리핑 발송 추적(하루 1회 가드 + 재시도 상한).

CREATE TABLE IF NOT EXISTS sales_visit_recordings (
  id            BIGSERIAL PRIMARY KEY,
  visit_id      BIGINT NOT NULL REFERENCES sales_visits(id) ON DELETE CASCADE,
  mode          TEXT NOT NULL DEFAULT 'memo' CHECK (mode IN ('full','memo')),  -- full=상담 전체 / memo=음성 메모
  mime          TEXT,
  duration_sec  INT,
  size_bytes    BIGINT,
  audio_b64     TEXT,                    -- data URL 의 base64 본문(처리 성공 후 NULL)
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','transcribing','summarizing','done','failed')),
  error         TEXT,
  attempts      INT NOT NULL DEFAULT 0,
  transcript    TEXT,                    -- STT 전사 원문
  summary_json  JSONB,                   -- {resumen, insights, action_items:[{content,due_date}], products, next_step}
  created_by    BIGINT NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_visit_rec_visit ON sales_visit_recordings(visit_id);
CREATE INDEX IF NOT EXISTS ix_visit_rec_queue ON sales_visit_recordings(status) WHERE status IN ('queued','transcribing','summarizing');

ALTER TABLE users ADD COLUMN IF NOT EXISTS wa_phone TEXT;

CREATE TABLE IF NOT EXISTS sales_briefing_sends (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  brief_date  DATE NOT NULL,
  status      TEXT,                      -- sent_text / sent_template / failed
  error       TEXT,
  attempts    INT NOT NULL DEFAULT 0,
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, brief_date)
);
CREATE INDEX IF NOT EXISTS ix_briefing_sends_date ON sales_briefing_sends(brief_date);
