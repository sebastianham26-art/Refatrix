-- 녹음 분할 업로드 임시 보관 (영업 > 고객상담 · 전시회 미팅 녹음) — 2026-08-26
-- 큰 녹음을 한 번에 보내면 기기 메모리(FileReader)·통신 구간에서 통째로 실패한다.
-- 그래서 브라우저가 3MB 조각으로 잘라 보내고, commit 때 서버가 원래 base64 로 다시 이어붙인다.
--   · seg_no  : 녹음 구간 번호(끊겼다 이어 녹음한 경우 2개 이상). 구간끼리는 '|' 로 구분해 저장한다.
--   · part_no : 그 구간 안에서의 전송 조각 순서. 조각 경계는 3바이트 배수라 base64 를 그대로 이어붙여도 안전하다.
-- commit 이 끝나면 그 세션의 조각은 즉시 삭제한다. 중간에 버려진 세션은 스케줄러가 6시간 뒤 청소한다.

CREATE TABLE IF NOT EXISTS sales_consult_upload_parts (
  id           BIGSERIAL PRIMARY KEY,
  session_key  TEXT   NOT NULL,                    -- 브라우저가 만든 업로드 세션 키
  consult_id   BIGINT NOT NULL REFERENCES sales_consults(id) ON DELETE CASCADE,
  seg_no       INT    NOT NULL,
  part_no      INT    NOT NULL,
  b64          TEXT   NOT NULL,                    -- 그 조각의 base64 본문(data URL 접두어 없음)
  created_by   BIGINT NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_key, seg_no, part_no)
);
CREATE INDEX IF NOT EXISTS ix_consult_upl_session ON sales_consult_upload_parts(session_key);
CREATE INDEX IF NOT EXISTS ix_consult_upl_age     ON sales_consult_upload_parts(created_at);
