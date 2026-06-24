-- =====================================================================
-- Refatrix ERP · 0077_wbr_issue_photos
-- WBR 팀별 주요이슈 사진 첨부. 이미지는 별도 테이블에 저장(클라 압축된 JPEG data URL).
--  - wbr_board.data(JSON, 200KB 상한)에는 사진 id만 참조 → 보드 JSON은 작게 유지.
--  - thumb_data: 그리드용 썸네일(작게), file_data: 라이트박스용 압축 원본.
-- =====================================================================
CREATE TABLE IF NOT EXISTS wbr_issue_photos (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thumb_data  TEXT NOT NULL,                         -- data:image/jpeg;base64,... (썸네일)
  file_data   TEXT NOT NULL,                         -- data:image/jpeg;base64,... (압축 원본)
  mime        TEXT,
  caption     TEXT,
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wbr_photo_created ON wbr_issue_photos (created_at);
