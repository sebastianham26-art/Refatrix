-- =====================================================================
-- Refatrix ERP · 0157_inbound_packing_files
--   수입입고 선적의 패킹리스트 원본 파일 보관 — ERP에서 다시 내려받아 볼 수 있게.
--   · 선적 1건당 여러 파일 가능(재업로드 이력 보존). file_data = data URL(base64).
--   · 목록/집계 쿼리는 이 테이블을 건드리지 않음(성능 보호 — 0091 패턴과 동일).
--   · 다운로드 권한: 창고(warehouse) + 구매(purchase) 화면 사용자.
-- =====================================================================

CREATE TABLE IF NOT EXISTS inbound_packing_files (
  id           BIGSERIAL PRIMARY KEY,
  shipment_id  BIGINT NOT NULL REFERENCES inbound_shipments(id) ON DELETE CASCADE,
  file_name    TEXT,
  mime_type    TEXT,
  file_data    TEXT NOT NULL,
  file_size    BIGINT,
  uploaded_by  BIGINT REFERENCES users(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbound_packing_files_ship
  ON inbound_packing_files(shipment_id);
