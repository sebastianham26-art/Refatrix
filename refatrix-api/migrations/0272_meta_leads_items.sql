-- =====================================================================
-- Refatrix ERP · 0272_meta_leads_items — Meta 광고 문의 → CTR 부품번호 × 수량 (2026-10-13 디렉터 지시)
--   「AI 를 돌려서라도 차종별 판매기회에서 부품번호를 특정 — 최종적으로 수요품목을 수량과 함께」
--   문의의 차종 · 연식 · 부품 → 카탈로그 적용차종(product_applications) + 제품명(부품 종류 · 위치 · 좌우)으로 후보 →
--   하나로 정해지면 규칙으로, 여럿이면(연식 · 버전 · 상하 · 좌우 불명) AI 가 대화를 읽고 고른다.
--   ai_items : [{model, anio, veh, pieza, code, pid, name, side, qty, qty_src, conf, src, status}]
--              status ok(정해짐) · candidato(못 정한 후보) · sin_catalogo(카탈로그에 없음 = 개발 필요) · sin_vehiculo(차종 미상)
--   m_items  : 사람이 고친 부품번호 × 수량(있으면 우선)
--   items_hash : 수요 + 후보 코드 + 대화 지문 — 같으면 다시 계산하지 않는다.
-- =====================================================================
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS ai_items    JSONB;
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS m_items     JSONB;
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS items_hash  TEXT;
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS items_at    TIMESTAMPTZ;
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS items_error TEXT;

-- 차종 → 부품 역검색(모델명 정규식) 보조
CREATE INDEX IF NOT EXISTS idx_papp_model_lower ON product_applications (lower(model));
