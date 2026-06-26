-- 0091_presence_geo.sql
-- 접속 위치 추정(오프라인 GeoLite2, geoip-lite). user_presence 에 마지막 IP/위치 컬럼 추가.
-- ping 시 클라이언트 IP를 잡아 도시/지역/국가/위경도를 저장한다(디렉터 전용 표시).
-- 주의: IP 위치는 도시 수준 추정이며 모바일망/VPN 등으로 부정확할 수 있음.
ALTER TABLE user_presence
  ADD COLUMN IF NOT EXISTS last_ip     TEXT,
  ADD COLUMN IF NOT EXISTS geo_city    TEXT,
  ADD COLUMN IF NOT EXISTS geo_region  TEXT,
  ADD COLUMN IF NOT EXISTS geo_country TEXT,
  ADD COLUMN IF NOT EXISTS geo_lat     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS geo_lng     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS geo_at      TIMESTAMPTZ;
