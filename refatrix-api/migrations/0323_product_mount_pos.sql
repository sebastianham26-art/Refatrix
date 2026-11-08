-- 0323 · 제품 장착 위치 1칸(확인값) — REFATRIX Platform 「제품 카탈로그 점검」 pos 칸 (2026-11-08)
--   지금까지 장착 위치는 product_positions(0292 · 코드 × 차종 · 원본 업로드 · 전체 교체)에만 있었다.
--   CTR 이 플랫폼에서 확인 · 수정한 값을 그 표에 넣으면 다음 업로드(전체 교체)에 지워지므로,
--   제품 마스터에 따로 둔다. 비어 있으면 화면 · API 는 업로드 요약을 보여 준다(우선순위: 이 칸 → 업로드).
--   값은 표준 표기(스페인어): 'Delantera Inferior Izquierda' · 'Delantera Izquierda/Derecha' · 'Trasera' …
--   NULL 이 기본 — 기존 확인완료 지문(md5)은 이 칸이 NULL 이면 예전과 똑같다(concat_ws 가 NULL 을 건너뜀).
ALTER TABLE products ADD COLUMN IF NOT EXISTS mount_pos TEXT;
