-- 0324 · SYD 리스트 품명(DESCRIPCIÓN) — SYD 가 정해서 쓰는 제품 명칭 (2026-11-08)
--   SYD 가격 리스트(Plantilla Articulo: ARTÍCULO · FAMILIA · DESCRIPCIÓN · PRECIO LISTA)를 올릴 때 품명도 남긴다.
--   보는 곳: VIO 제품찾기 · 프로모션 만들기(CTR 코드 옆 SYD 코드 · SYD 품명). 예) TERMINAL EXTERIOR "L" · HORQUILLA INFERIOR "R"
--   예전 리스트 줄은 NULL — 품명이 든 리스트를 한 번 다시 올리면 채워진다.
ALTER TABLE syd_price_items ADD COLUMN IF NOT EXISTS descripcion TEXT;
