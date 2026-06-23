-- 0069: 특정 배치를 원가 계산에서 제외하는 플래그.
--   exclude_from_cost = true 인 배치의 수입 라인은 평균원가 가중평균·정정 템플릿·제품 원가근거에서 제외된다.
--   (재고 수량 자체는 건드리지 않음 — 원가 계산 반영만 차단.)
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS exclude_from_cost BOOLEAN NOT NULL DEFAULT false;

-- 지정된 테스트/무효 배치 두 건을 원가 계산에서 제외
UPDATE import_batches
   SET exclude_from_cost = true
 WHERE batch_no IN ('TEST-1781790351851', 'TEST-1781907417958');
