-- 0292 · 제품 장착 위치(앞/뒤 · 상/하 · 좌/우) — 원본(Platform Export: Block · Position · CTR) 업로드
--   코드 × 차종(브랜드·모델·세대·연식)마다 한 줄. 같은 코드가 차마다 위치가 다를 수 있다(엔진 마운트 등).
--   제품 마스터와는 코드(대문자)로 이어 붙인다 — 마스터에 아직 없는 코드도 받아 둔다.
--   업로드는 「전체 교체」: 새 배치를 넣고 예전 줄은 지운다(배치 기록은 남김).

CREATE TABLE IF NOT EXISTS product_position_batches (
  id          BIGSERIAL PRIMARY KEY,
  file_name   TEXT,
  rows_in     INT NOT NULL DEFAULT 0,      -- 파일에서 읽은 줄
  rows_saved  INT NOT NULL DEFAULT 0,      -- 저장한 (코드 × 차종 × 위치) 줄
  codes       INT NOT NULL DEFAULT 0,      -- 서로 다른 코드 수
  codes_known INT NOT NULL DEFAULT 0,      -- 그중 제품 마스터에 있는 코드
  side_fixed  INT NOT NULL DEFAULT 0,      -- L/R 접미사로 좌우를 바로잡은 줄
  uploaded_by BIGINT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_positions (
  id          BIGSERIAL PRIMARY KEY,
  batch_id    BIGINT REFERENCES product_position_batches(id) ON DELETE CASCADE,
  ctr_code    TEXT NOT NULL,                                  -- 대문자
  block       TEXT NOT NULL CHECK (block IN ('front','rear')),
  level       TEXT CHECK (level IN ('upper','lower')),
  side        TEXT CHECK (side IN ('lh','rh')),
  side_fixed  BOOLEAN NOT NULL DEFAULT false,                 -- 원본 좌우와 코드 접미사(L/R)가 달라 접미사로 고침 · 또는 원본에 좌우가 없어 접미사로 채움
  pos_raw     TEXT,                                           -- 원본 Position 글자(예: Front Lower LH)
  part        TEXT,                                           -- 원본 Part(예: CONTROL ARM)
  brand       TEXT,
  model       TEXT,
  generation  TEXT,
  years       TEXT,
  y_from      INT,
  y_to        INT,
  status      TEXT,                                           -- Confirmed · Candidate · …
  src_col     TEXT,                                           -- CTR · 4th CTR
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_positions_code_idx ON product_positions (ctr_code);
CREATE INDEX IF NOT EXISTS product_positions_batch_idx ON product_positions (batch_id);
