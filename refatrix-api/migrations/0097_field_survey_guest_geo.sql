-- =====================================================================
-- Refatrix ERP · 0097_field_survey_guest_geo
--   0096을 "미등록 고객 할인율 / 위치 컬럼 추가 전" 버전으로 이미 적용한 DB 보정.
--   migrate 러너는 _migrations 로 파일명 단위 추적 → 수정된 0096은 재실행되지 않으므로
--   누락 컬럼을 ADD COLUMN IF NOT EXISTS 로 채운다.
--   신규 설치(0096이 이미 컬럼 포함)에서는 아래 모두 no-op.
-- =====================================================================

ALTER TABLE field_surveys ADD COLUMN IF NOT EXISTS discount_rate NUMERIC(6,3);   -- 미등록 고객 할인율(%)
ALTER TABLE field_surveys ADD COLUMN IF NOT EXISTS geo_lat       NUMERIC(9,6);   -- 조사 위치 위도
ALTER TABLE field_surveys ADD COLUMN IF NOT EXISTS geo_lng       NUMERIC(9,6);   -- 경도
ALTER TABLE field_surveys ADD COLUMN IF NOT EXISTS geo_at        TIMESTAMPTZ;    -- 위치 취득 시각
