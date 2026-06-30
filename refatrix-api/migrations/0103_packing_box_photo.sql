-- =====================================================================
-- Refatrix ERP · 0103_packing_box_photo
-- 창고 출고-1b-2: 박스별 사진(여러 장). base64 data URL 저장(증빙 패턴 동일).
--   · 사진 없어도 박스 마감은 가능. 단 포장 마무리/통합 패킹리스트 출력 게이트는
--     "박스마다 ≥1장"을 요구(게이트 판정은 앱 레벨에서 photos_ok로 노출).
-- 추가형(CREATE IF NOT EXISTS)만 — 기존 영향 없음. 재실행 안전.
-- =====================================================================

CREATE TABLE IF NOT EXISTS packing_box_photo (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  box_id       BIGINT NOT NULL REFERENCES packing_box(id) ON DELETE CASCADE,
  quote_id     BIGINT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  image_data   TEXT NOT NULL,                 -- data:image/...;base64,...
  uploaded_by  BIGINT REFERENCES users(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pbphoto_box   ON packing_box_photo (box_id);
CREATE INDEX IF NOT EXISTS idx_pbphoto_quote ON packing_box_photo (quote_id);
