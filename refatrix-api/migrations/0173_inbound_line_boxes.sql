-- 0173: 패킹리스트 라인별 기록 보강 — 카톤 번호 범위(FROM/TO) 저장
--
-- 왜: 패킹리스트의 각 라인이 곧 "카톤 묶음"이다(같은 SKU 라도 라인마다 소입수량이 다름).
--     2026-08-17 부터 업로드 시 라인을 합산하지 않고 그대로 저장하는데,
--     같은 SKU 라인이 여러 개면 어느 카톤 묶음인지 구분할 표식이 필요하다 → 파일의 FROM/TO 보존.
-- 기존 행은 NULL 로 남는다(합산 저장된 과거 선적 — 동작 무영향).
ALTER TABLE inbound_pallet_items ADD COLUMN IF NOT EXISTS box_from INT;
ALTER TABLE inbound_pallet_items ADD COLUMN IF NOT EXISTS box_to   INT;
