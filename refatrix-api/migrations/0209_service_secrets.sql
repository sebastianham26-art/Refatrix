-- 0209_service_secrets.sql
-- 외부 서비스 API 키를 **ERP 화면에서** 바꾸기 위한 보관소.
--
--   왜: Anthropic(Claude) · OpenAI(Whisper) · WhatsApp(Meta) 키는 지금 Railway 환경변수에만 있다.
--   키가 만료되거나 재발급되면 Railway 콘솔에 들어가 값을 바꾸고 **재배포**해야 했고,
--   그동안 AI 요약·녹음 전사·브리핑 발송이 조용히 죽어 있었다(503 no_api_key).
--   → 키 1개 = 이 테이블의 1행. 화면에서 바꾸면 재배포 없이 즉시 반영된다.
--
--   환경변수는 남는다 — **DB 행이 우선**이고, 행이 없거나 값이 비면 환경변수로 되돌아간다.
--   (마이그레이션 전이나 이 테이블이 비어 있어도 지금 동작이 그대로 유지된다.)
--
--   ⚠ 비밀값은 평문으로 넣지 않는다. AES-256-GCM 으로 암호화한 문자열만 들어온다
--     (열쇠는 Railway 환경변수 APP_SECRET_KEY 하나 — 이 값은 DB 에 없다).
--     그래서 DB 백업이 유출돼도 키는 읽히지 않는다. 저장 형식은 src/secrets.js 참고:
--       'v1:<base64(iv|tag|ciphertext)>'  암호화된 비밀값
--       'p1:<평문>'                        비밀이 아닌 설정값(전화번호 ID·템플릿명 등)

CREATE TABLE IF NOT EXISTS service_secrets (
  name        TEXT PRIMARY KEY,                    -- 환경변수 이름 그대로: ANTHROPIC_API_KEY 등
  value_enc   TEXT,                                -- 'v1:…'(암호화) | 'p1:…'(평문 설정값) | NULL(미설정)
  is_secret   BOOLEAN NOT NULL DEFAULT true,       -- true = 화면에 값이 절대 내려가지 않는다
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT
);

-- 변경 이력 — "언제 누가 어떤 키를 바꿨나"에 답할 수 있어야 한다.
--   ⚠ 값은 이력에도 남기지 않는다. 무엇을(name) 어떻게(set|clear) 만 남긴다.
CREATE TABLE IF NOT EXISTS service_secret_changes (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  action      TEXT NOT NULL,                       -- set | clear
  changed_by  BIGINT,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_service_secret_changes ON service_secret_changes (changed_at DESC);

DO $$ BEGIN
  ALTER TABLE service_secret_changes
    ADD CONSTRAINT service_secret_changes_action_chk CHECK (action IN ('set','clear'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
