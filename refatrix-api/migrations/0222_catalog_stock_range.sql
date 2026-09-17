-- 0222 · 카탈로그 조회 API — 재고는 **구간**으로 내보낸다 (디렉터 결정 2026-09-17)
--
--   0221 은 기본값이 'qty'(정확한 수량)였다. 멀티브랜드 비교 플랫폼에는 우리 재고 실수치가
--   그대로 올라간다 — 경쟁사와 한 화면에서 비교되는 곳이다. 구간으로 바꾼다.
--
--   구간(catalogPull.js catalogStockRange 와 같아야 한다):
--     0 · 1-5 · 6-10 · 11-20 · 21-50 · 51-100 · 101+
--
--   ⚠ 이 변경으로 existencia 의 **타입이 숫자 → 문자열**이 된다.
--     이미 연동 중인 고객사가 있으면 상대 개발자에게 알린 뒤 적용할 것(계약서 6·10항).

ALTER TABLE catalog_api_clients ALTER COLUMN stock_mode SET DEFAULT 'range';

-- 이미 만들어 둔 고객사도 구간으로 돌린다. 수량으로 되돌리려면 화면에서 바꾼다.
UPDATE catalog_api_clients SET stock_mode = 'range' WHERE stock_mode = 'qty';
