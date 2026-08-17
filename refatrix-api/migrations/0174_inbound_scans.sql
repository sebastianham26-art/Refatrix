-- =====================================================================
-- Refatrix ERP · 0174_inbound_scans
-- 수입입고 검수 개편(2026-08-17): "스캔은 기록, 판정은 보고서"
--   스캔 1건 = 1행 즉시 저장(검증·차단 없음). 브라우저 캐시/기기와 무관하게
--   서버가 유일한 진실이 된다. 대조·확정은 이 기록을 집계해서 계산한다.
--   리셋 시에도 행을 지우지 않고 voided_at 만 찍는다(감사 추적).
-- =====================================================================

CREATE TABLE IF NOT EXISTS inbound_scans (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id  BIGINT NOT NULL REFERENCES inbound_shipments(id),
  pallet_id    BIGINT NOT NULL REFERENCES inbound_pallets(id),
  code         TEXT NOT NULL,              -- 라벨에서 읽은 제품번호(표준화 후)
  qty          INT,                        -- 라벨 소입수량(CTR-xxxx-16 의 16). 없으면 NULL
  matched      BOOLEAN NOT NULL DEFAULT true,  -- 팔렛 라인에 존재하는 코드였는지(스캔 시점 기준)
  scanned_by   BIGINT REFERENCES users(id),
  scanned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at    TIMESTAMPTZ                 -- 취소([-])·검수 리셋 시각. NULL = 유효
);
CREATE INDEX IF NOT EXISTS idx_inbound_scans_pallet ON inbound_scans (pallet_id) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inbound_scans_ship   ON inbound_scans (shipment_id);
