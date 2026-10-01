-- 0243 · 고객 설문 — 플랫폼 일괄 다운로드: 개인정보 가린 사본 + CTR 책임 확인 기록 (2026-09-30)
--   설문지 이미지를 해외(CTR)로 내려보낼 때 이름·상호·전화 등은 가린 사본만 쓴다.
--   redact_boxes : AI 가 찾은 가릴 영역 [{k,x0,y0,x1,y1}] (0~1 비율, 여백 포함)
--   redact_data  : ERP(디렉터) 화면이 원본 위에 검은 사각형을 칠해 만든 JPEG — 다운로드에는 이것만 들어간다
--   redact_used  : 실제로 칠한 사각형(AI + 놓친 칸 보충) — 감사용
ALTER TABLE survey_pages ADD COLUMN IF NOT EXISTS redact_scan TEXT;              -- NULL | queued | processing | done | error
ALTER TABLE survey_pages ADD COLUMN IF NOT EXISTS redact_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE survey_pages ADD COLUMN IF NOT EXISTS redact_error TEXT;
ALTER TABLE survey_pages ADD COLUMN IF NOT EXISTS redact_boxes JSONB;
ALTER TABLE survey_pages ADD COLUMN IF NOT EXISTS redact_data BYTEA;
ALTER TABLE survey_pages ADD COLUMN IF NOT EXISTS redact_used JSONB;
ALTER TABLE survey_pages ADD COLUMN IF NOT EXISTS redact_at TIMESTAMPTZ;
ALTER TABLE survey_pages ADD COLUMN IF NOT EXISTS redact_by BIGINT;
ALTER TABLE survey_pages ADD COLUMN IF NOT EXISTS redact_excluded BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS survey_pages_redact_scan_idx ON survey_pages (redact_scan) WHERE redact_scan IN ('queued', 'processing');

-- 플랫폼 사용자가 일괄 다운로드 전에 확인한 「개인정보 유출 책임은 CTR」 문구 — 문구 전체를 그대로 남긴다
CREATE TABLE IF NOT EXISTS survey_download_acks (
  id                   BIGSERIAL PRIMARY KEY,
  survey_id            BIGINT NOT NULL REFERENCES surveys(id),
  viewer_name          TEXT,
  platform_session_sha TEXT,                 -- 플랫폼 세션 토큰의 sha256 (토큰 원문은 저장하지 않음)
  ack_version          TEXT NOT NULL,
  ack_sha              TEXT NOT NULL,
  ack_text             TEXT NOT NULL,
  files_ready          INT NOT NULL DEFAULT 0,
  files_done           INT NOT NULL DEFAULT 0,
  ip                   TEXT,
  user_agent           TEXT,
  platform_logged      BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  downloaded_at        TIMESTAMPTZ,
  download_count       INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS survey_download_acks_survey_idx ON survey_download_acks (survey_id, created_at DESC);
