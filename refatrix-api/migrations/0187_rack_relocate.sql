-- =====================================================================
-- Refatrix ERP · 0187_rack_relocate  (창고 위치변경 / Cambio de ubicación)
--
--  왜: 수입 제품은 카톤박스 단위로 랙에 적재된다. 일부 랙은 fast moving rack
--      으로 개별포장 단위로 운영한다. 카톤 랙 → fast moving rack 으로 박스를
--      옮기는 작업을 "누가·언제·무엇을·어디서→어디로·몇 개" 로 남긴다.
--
--  ① rack_kinds : 랙 유형(카톤 적재 / fast moving = 개별포장).
--                 행이 없는 랙은 기본 'carton' 으로 본다(마이그레이션이 데이터를
--                 만들지 않는다 — 디렉터가 화면에서 지정).
--  ② rack_moves : 위치변경 1건(= 카톤 라벨 1스캔 묶음)의 기록.
--                 재고 총량(products.stock_qty)은 건드리지 않는다 — 위치만 바뀐다.
--                 products.rack_location 갱신 여부는 master_updated 로 남긴다.
--
--  격리 원칙: 이 마이그레이션은 기존 테이블을 변경하지 않는다(신규 2테이블).
-- =====================================================================

-- ① 랙 유형 -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS rack_kinds (
  rack       TEXT PRIMARY KEY,                       -- 랙 번호(표기 그대로 저장, 조회는 UPPER 로 대소문자 무시)
  kind       TEXT NOT NULL DEFAULT 'carton',         -- 'carton' = 카톤박스 단위 / 'fast' = fast moving(개별포장)
  note       TEXT,
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rack_kinds_kind_chk') THEN
    ALTER TABLE rack_kinds ADD CONSTRAINT rack_kinds_kind_chk CHECK (kind IN ('carton','fast'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_rack_kinds_upper ON rack_kinds (UPPER(rack));
CREATE INDEX IF NOT EXISTS idx_rack_kinds_kind  ON rack_kinds (kind);

-- ② 위치변경 기록 -----------------------------------------------------
CREATE TABLE IF NOT EXISTS rack_moves (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id     BIGINT NOT NULL REFERENCES products(id),
  product_code   TEXT   NOT NULL,                    -- 이동 시점의 제품번호 스냅샷(제품 코드가 바뀌어도 기록은 남는다)
  from_rack      TEXT,                               -- 스캔한 기존 위치. NULL = 이동 전 위치 미지정
  to_rack        TEXT   NOT NULL,                    -- 스캔한 새 위치
  from_kind      TEXT,                               -- 이동 시점의 랙 유형 스냅샷(나중에 유형을 바꿔도 기록은 그대로)
  to_kind        TEXT,
  cartons        INTEGER NOT NULL DEFAULT 1,         -- 옮긴 카톤 수(라벨 스캔 횟수)
  per_carton     NUMERIC(15,3) NOT NULL DEFAULT 0,   -- 라벨의 소입수량(CTR-CE0796-16 → 16)
  qty_ea         NUMERIC(15,3) NOT NULL DEFAULT 0,   -- cartons × per_carton (실제 이동 수량)
  label          TEXT,                               -- 스캔 원문(진단용)
  master_updated BOOLEAN NOT NULL DEFAULT FALSE,     -- products.rack_location 을 실제로 갱신했는지
  master_from    TEXT,                               -- 갱신 직전의 제품마스터 위치(되돌리기·감사용)
  note           TEXT,
  moved_by       BIGINT REFERENCES users(id),
  moved_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rack_moves_cartons_chk') THEN
    ALTER TABLE rack_moves ADD CONSTRAINT rack_moves_cartons_chk CHECK (cartons > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rack_moves_diff_chk') THEN
    -- 같은 자리로의 이동은 기록하지 않는다(대소문자 무시)
    ALTER TABLE rack_moves ADD CONSTRAINT rack_moves_diff_chk
      CHECK (from_rack IS NULL OR UPPER(TRIM(from_rack)) <> UPPER(TRIM(to_rack)));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_rack_moves_at      ON rack_moves (moved_at DESC);
CREATE INDEX IF NOT EXISTS idx_rack_moves_product ON rack_moves (product_id, moved_at DESC);
CREATE INDEX IF NOT EXISTS idx_rack_moves_to      ON rack_moves (UPPER(to_rack));
CREATE INDEX IF NOT EXISTS idx_rack_moves_from    ON rack_moves (UPPER(from_rack));
