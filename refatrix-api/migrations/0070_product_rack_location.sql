-- 0070: 제품 마스터에 랙(보관 위치) 컬럼 추가.
--   rack_location = 창고 랙 번호/위치(예: A-12, R3-05). 기본 NULL(미지정).
--   제품 조회/검색 화면에 한 칸으로 표시되며, 추후 제품마스터 업로드/편집으로 값을 채워 운영한다.
--   (재고 수량·평균원가 등 다른 값에는 영향 없음 — 표시·운영용 텍스트 컬럼만 추가.)
ALTER TABLE products ADD COLUMN IF NOT EXISTS rack_location TEXT;
