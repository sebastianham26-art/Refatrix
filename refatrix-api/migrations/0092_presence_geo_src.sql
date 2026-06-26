-- 0092_presence_geo_src.sql
-- 위치 출처 구분: GPS(브라우저 동의) 우선, 미동의/미지원 시 IP 추정 폴백.
-- geo_src: 'gps' | 'ip' | NULL(미상),  geo_acc: GPS 정확도(미터).
ALTER TABLE user_presence
  ADD COLUMN IF NOT EXISTS geo_src TEXT,
  ADD COLUMN IF NOT EXISTS geo_acc DOUBLE PRECISION;
