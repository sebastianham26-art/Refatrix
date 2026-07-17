-- =====================================================================
-- Refatrix ERP · 0140_field_survey_sold_history
--   현장재고조사 「기존 판매품목 점검」 — 누적판매 대조(소진) 지원.
--
--   기존고객을 선택하면 그동안 판매한 품목(누적판매 상위 30)이 체크리스트로
--   깔리고, 영업사원이 고객창고 실물을 확인해 현장재고를 입력(또는 「없음(0)」)한다.
--     소진량 = 누적판매(sold_qty_snap) − 현장재고(observed_qty)
--            = 고객창고에서 출고되어 엔드커스터머에게 팔린 수량 → 보충 제안.
--
--   설계: 체크리스트 30줄을 미리 INSERT 하지 않는다(행 부풀림 방지).
--         "점검한 것만 줄이 생긴다" → 줄이 없으면 곧 미점검.
--   기존 코드입력(origin='code') 줄의 동작·분류는 100% 그대로.
-- =====================================================================

-- origin: 'code'    = 현장에서 코드를 직접 입력한 줄(기존 동작 — 즉시/부족/개발 3분류)
--         'history' = 누적판매 체크리스트에서 점검한 줄(→ 보충 제안 계산 대상)
ALTER TABLE field_survey_lines
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'code';

-- 기존 줄은 전부 코드입력분 — 명시적으로 보정(신규 설치에서는 no-op).
UPDATE field_survey_lines SET origin = 'code' WHERE origin IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'field_survey_lines_origin_chk'
  ) THEN
    ALTER TABLE field_survey_lines
      ADD CONSTRAINT field_survey_lines_origin_chk CHECK (origin IN ('code','history'));
  END IF;
END $$;

-- 누적판매 스냅샷(점검·완료 시점 동결) — 나중에 매출이 더 쌓여도 그날의 소진량이 변하지 않게.
ALTER TABLE field_survey_lines
  ADD COLUMN IF NOT EXISTS sold_qty_snap NUMERIC(15,3);

-- 이 고객이 이 SKU 를 마지막으로 산 날 (체크리스트·보충제안 표시용)
ALTER TABLE field_survey_lines
  ADD COLUMN IF NOT EXISTS last_sold_at DATE;

-- 체크리스트 병합(조사 × 제품) 조회 · 중복 줄 방지 가드에 사용
CREATE INDEX IF NOT EXISTS idx_fsline_survey_product
  ON field_survey_lines (survey_id, product_id);
CREATE INDEX IF NOT EXISTS idx_fsline_origin
  ON field_survey_lines (origin);

-- 고객별 누적판매 집계(체크리스트·견적 사이드패널 공용) 가속
CREATE INDEX IF NOT EXISTS idx_sil_product_invoice
  ON sales_invoice_lines (product_id, invoice_id);
