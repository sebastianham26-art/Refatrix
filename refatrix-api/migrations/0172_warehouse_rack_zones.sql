-- 0172: 창고 존(zone) 지정 — 랙 번호를 4개의 "존 이동용 임시 팔렛"에 매핑
--
-- 왜: 수입 팔렛을 검수한 뒤, 카톤을 해당 랙으로 바로 옮기지 않고
--     먼저 존별 임시 팔렛에 분리(소팅)한다. 그래서 각 랙이 어느 존에 속하는지
--     디렉터가 지정해두면, 검수 스캔 때마다 "이 박스는 존 N 으로" 를 안내할 수 있다.
--
-- 설계: 존은 4개 고정(1~4, 이름만 편집 가능). 매핑은 랙 번호 단위.
--       랙이 아직 없는 신규 SKU 는 rack_zones 의 특수키 '__NEW__' 로 기본 존을 지정한다.
BEGIN;

-- 존 4개 (고정 슬롯. 이름·설명만 바꾼다)
CREATE TABLE IF NOT EXISTS warehouse_zones (
  zone        SMALLINT PRIMARY KEY CHECK (zone BETWEEN 1 AND 4),
  name        TEXT NOT NULL,
  note        TEXT,
  updated_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO warehouse_zones (zone, name) VALUES
  (1, 'Zona 1'), (2, 'Zona 2'), (3, 'Zona 3'), (4, 'Zona 4')
ON CONFLICT (zone) DO NOTHING;

-- 랙 → 존 매핑. rack 은 products.rack_location 값 그대로(대소문자 구분 없이 비교하려면 UPPER 인덱스 사용).
-- 특수키: '__NEW__' = 랙이 지정되지 않은 신규 SKU 의 기본 존.
CREATE TABLE IF NOT EXISTS rack_zones (
  rack        TEXT PRIMARY KEY,
  zone        SMALLINT NOT NULL REFERENCES warehouse_zones(zone),
  updated_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rack_zones_zone ON rack_zones(zone);
CREATE INDEX IF NOT EXISTS idx_rack_zones_rack_upper ON rack_zones(UPPER(rack));

COMMIT;
