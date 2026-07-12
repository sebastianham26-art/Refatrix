-- 0133: 경쟁사 교차참조 스냅샷(백업·복원)
--   · 목적: 교차참조 업로드 한 번으로 코드 카탈로그가 오염될 위험 대비.
--   · 범위: product_xref_codes 전체 상태 (교차참조 업로드가 변경하는 유일한 테이블 —
--          products·재고·CTR 가격 원본은 교차참조 업로드로 바뀌지 않음).
--   · 동작: 업로드/전체삭제/복원 직전에 자동 스냅샷 → 목록에서 선택해 그 시점으로 회귀.

CREATE TABLE IF NOT EXISTS xref_snapshots (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label      TEXT,                                        -- 예: '업로드 전 자동백업 · LISTA_PRECIOS_....xlsx'
  kind       TEXT NOT NULL DEFAULT 'auto'
             CHECK (kind IN ('auto','manual','pre_restore')),
  row_count  INT NOT NULL DEFAULT 0,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS xref_snapshot_rows (
  snapshot_id BIGINT NOT NULL REFERENCES xref_snapshots(id) ON DELETE CASCADE,
  product_id  BIGINT NOT NULL,
  xref_code   TEXT NOT NULL,
  norm_code   TEXT NOT NULL,
  brand       TEXT,
  list_price  NUMERIC(15,2)
);
CREATE INDEX IF NOT EXISTS idx_xsr_snapshot ON xref_snapshot_rows (snapshot_id);
