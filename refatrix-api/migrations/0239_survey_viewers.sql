-- 0239 · 고객 설문 분석 — 외부 열람 계정 (2026-09-30)
--   ERP 계정과 **완전히 분리된** 열람 전용 계정. 아이디+비밀번호로 mx_survey_analysis.html 에 로그인해
--   허락된 설문의 **익명 집계**만 본다(ERP 화면·API 는 이 토큰으로 열리지 않는다).
--   token_version 을 올리면(비밀번호 변경·정지) 이미 발급된 토큰이 즉시 무효가 된다.
CREATE TABLE IF NOT EXISTS survey_viewers (
  id              BIGSERIAL PRIMARY KEY,
  login           TEXT NOT NULL,
  name            TEXT,
  pass_hash       TEXT NOT NULL,
  survey_ids      BIGINT[] NOT NULL DEFAULT '{}',
  active          BOOLEAN NOT NULL DEFAULT true,
  failed_count    INT NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  last_login_at   TIMESTAMPTZ,
  token_version   INT NOT NULL DEFAULT 1,
  created_by      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS survey_viewers_login_uq ON survey_viewers (lower(login));
