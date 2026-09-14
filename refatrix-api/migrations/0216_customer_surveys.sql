-- 0216 · 제품·마케팅 › 고객 설문 분석 (2026-09-11)
--   설문지 사진/스캔 PDF → AI 판독(붉은 번호 + 문항별 답) → 엑셀·세그먼트 리포트.
--   ① surveys       : 설문 1건 = 양식(문항 정의 JSON) + 파일명 접두어 + AI 요약 캐시
--   ② survey_pages  : 설문지 1장 = 응답 1건. 원본(사진 또는 1페이지 PDF) + 화면용 JPEG + 썸네일 + 판독 결과
--   파일명은 저장하지 않고 (접두어, 붉은 번호, 중복 순번, 확장자)로 계산한다 → 접두어를 바꿔도 이름이 따라온다.
--   멱등: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS surveys (
  id            BIGSERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  code_prefix   TEXT NOT NULL,
  survey_date   DATE,
  questions     JSONB NOT NULL DEFAULT '[]'::jsonb,
  number_hint   TEXT,
  template_mime TEXT,
  template_data BYTEA,
  ai_cache      JSONB,
  created_by    BIGINT REFERENCES users(id),
  updated_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS survey_pages (
  id            BIGSERIAL PRIMARY KEY,
  survey_id     BIGINT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  seq           INT NOT NULL,
  orig_name     TEXT,
  mime          TEXT NOT NULL,
  file_data     BYTEA NOT NULL,
  file_bytes    INT,
  file_sha      TEXT,
  view_data     BYTEA,
  thumb_data    BYTEA,
  red_number    TEXT,
  red_raw       TEXT,
  dup_idx       INT NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'queued',
  error         TEXT,
  attempts      INT NOT NULL DEFAULT 0,
  answers       JSONB,
  others        JSONB,
  low_conf      TEXT[] NOT NULL DEFAULT '{}',
  edited        JSONB,
  ai_notes      TEXT,
  ai_model      TEXT,
  uploaded_by   BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  CONSTRAINT survey_pages_status_chk CHECK (status IN ('queued','processing','done','error'))
);

CREATE INDEX IF NOT EXISTS idx_survey_pages_survey ON survey_pages (survey_id, seq);
CREATE INDEX IF NOT EXISTS idx_survey_pages_queue  ON survey_pages (status, id) WHERE status IN ('queued','processing');
-- 같은 설문에 같은 번호는 한 번만 (두 번째부터 dup_idx 2, 3 …)
CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_pages_number ON survey_pages (survey_id, red_number, dup_idx) WHERE red_number IS NOT NULL;
-- 같은 파일을 두 번 올리면 거부 (sha256)
CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_pages_sha ON survey_pages (survey_id, file_sha) WHERE file_sha IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_pages_seq ON survey_pages (survey_id, seq);
