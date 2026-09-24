-- 0229 · 가격 마스터 v2 — FOB 구매가 · List 정가 · 날짜별 이력 · 일괄/단일 변경 · 경쟁사 SYD 리스트
--   설계: claude/REFATRIX_설계_2026-09-24_price_master_v2.md
--   현재값은 제품 행에(products.list_price · products.fob_usd · products.list_price_syd),
--   이력은 장부에(product_price_history, price_type = list | fob), SYD 는 리스트 단위로 보관.
--   전부 IF NOT EXISTS — 재실행 안전.

-- ① 현재 FOB 구매가(USD)
ALTER TABLE products ADD COLUMN IF NOT EXISTS fob_usd NUMERIC;

-- ② 경쟁사 SYD 가격 리스트 — 올릴 때마다 통째로 보관
CREATE TABLE IF NOT EXISTS syd_price_lists (
  id            BIGSERIAL PRIMARY KEY,
  list_date     DATE        NOT NULL,                 -- 리스트 기준일
  file_name     TEXT,
  code_count    INT         NOT NULL DEFAULT 0,
  prev_list_id  BIGINT,                               -- 비교한 바로 앞 리스트
  up_count      INT, down_count INT, same_count INT, new_count INT, gone_count INT,
  dup_count     INT,                                  -- 파일 안 중복 코드(첫 값 사용)
  note          TEXT,
  created_by    BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_syd_price_lists_date ON syd_price_lists (list_date DESC, id DESC);

CREATE TABLE IF NOT EXISTS syd_price_items (
  list_id   BIGINT  NOT NULL REFERENCES syd_price_lists(id) ON DELETE CASCADE,
  syd_norm  TEXT    NOT NULL,                         -- 매칭 키(대문자+영숫자만) — 대응품번 표와 같은 규칙
  syd_code  TEXT    NOT NULL,                         -- 파일 원문 표기
  price     NUMERIC NOT NULL,
  familia   TEXT,
  PRIMARY KEY (list_id, syd_norm)
);
CREATE INDEX IF NOT EXISTS ix_syd_price_items_norm ON syd_price_items (syd_norm);

-- ③ 변경 묶음: 한 번의 변경 = 1행 (일괄 % · SYD 비율 맞추기 · 단일 수정 · 엑셀 · SYD 제안)
CREATE TABLE IF NOT EXISTS price_change_batches (
  id              BIGSERIAL PRIMARY KEY,
  price_type      TEXT        NOT NULL DEFAULT 'list',  -- list = 판매 정가(MXN) · fob = 구매가(USD)
  mode            TEXT        NOT NULL DEFAULT 'pct',   -- pct = % · ratio = SYD × 비율 · set = 제품별 목표가
  origin          TEXT        NOT NULL DEFAULT 'bulk',  -- bulk · single · import · syd
  effective_date  DATE        NOT NULL,
  direction       SMALLINT,
  pct             NUMERIC(6,3),
  ratio           NUMERIC(8,4),
  rounding        NUMERIC(8,3) NOT NULL DEFAULT 0.01,
  scope           TEXT        NOT NULL,                 -- filter · selected · items
  filter          JSONB,
  syd_list_id     BIGINT REFERENCES syd_price_lists(id) ON DELETE SET NULL,
  status          TEXT        NOT NULL DEFAULT 'scheduled',
  product_count   INT         NOT NULL DEFAULT 0,
  applied_count   INT, skipped_count INT, reverted_count INT, revert_skipped_count INT,
  note            TEXT,
  created_by      BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at      TIMESTAMPTZ, applied_by BIGINT,
  cancelled_at    TIMESTAMPTZ, cancelled_by BIGINT,
  reverted_at     TIMESTAMPTZ, reverted_by BIGINT,
  CONSTRAINT price_change_batches_type_chk   CHECK (price_type IN ('list','fob')),
  CONSTRAINT price_change_batches_mode_chk   CHECK (mode IN ('pct','ratio','set')),
  CONSTRAINT price_change_batches_origin_chk CHECK (origin IN ('bulk','single','import','syd')),
  CONSTRAINT price_change_batches_pct_chk    CHECK (mode <> 'pct' OR (direction IN (1,-1) AND pct > 0 AND pct <= 100)),
  CONSTRAINT price_change_batches_ratio_chk  CHECK (mode <> 'ratio' OR (ratio > 0 AND price_type = 'list')),
  CONSTRAINT price_change_batches_rnd_chk    CHECK (rounding IN (0.001, 0.01, 1, 10)),
  CONSTRAINT price_change_batches_scope_chk  CHECK (scope IN ('filter','selected','items')),
  CONSTRAINT price_change_batches_status_chk CHECK (status IN ('scheduled','applied','cancelled','reverted'))
);
CREATE INDEX IF NOT EXISTS ix_price_change_batches_due ON price_change_batches (status, effective_date, id);

-- ④ 묶음 대상(저장 순간 확정한 스냅샷) + 목표가(set) + 적용 결과
CREATE TABLE IF NOT EXISTS price_change_items (
  batch_id     BIGINT NOT NULL REFERENCES price_change_batches(id) ON DELETE CASCADE,
  product_id   BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  target_price NUMERIC,
  old_price    NUMERIC,
  new_price    NUMERIC,
  result       TEXT,    -- applied · no_price · no_syd · deleted · no_change · to_zero · reverted · revert_skipped
  PRIMARY KEY (batch_id, product_id)
);
CREATE INDEX IF NOT EXISTS ix_price_change_items_product ON price_change_items (product_id);

-- ⑤ 제품별 가격 장부 — 일괄 · 단일 · 화면 수정 · 엑셀 · 되돌리기 전부
CREATE TABLE IF NOT EXISTS product_price_history (
  id              BIGSERIAL PRIMARY KEY,
  product_id      BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price_type      TEXT   NOT NULL DEFAULT 'list',
  effective_date  DATE   NOT NULL,
  old_price       NUMERIC,
  new_price       NUMERIC,
  source          TEXT   NOT NULL,
  batch_id        BIGINT REFERENCES price_change_batches(id) ON DELETE SET NULL,
  created_by      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT product_price_history_type_chk   CHECK (price_type IN ('list','fob')),
  CONSTRAINT product_price_history_source_chk CHECK (source IN ('batch','manual','import','revert','initial'))
);
CREATE INDEX IF NOT EXISTS ix_product_price_history_product ON product_price_history (product_id, price_type, effective_date, id);
CREATE INDEX IF NOT EXISTS ix_product_price_history_batch   ON product_price_history (batch_id);

-- ⑥ 이력의 출발점: 지금 정가(List)를 'initial' 1행씩 (이미 List 이력이 있는 제품은 건너뜀 → 재실행 안전)
--    FOB 는 아직 값이 없으므로 처음 올릴 때 'batch'(엑셀) 로 시작한다.
INSERT INTO product_price_history (product_id, price_type, effective_date, old_price, new_price, source)
SELECT p.id, 'list', (now() AT TIME ZONE 'America/Mexico_City')::date, NULL, p.list_price, 'initial'
  FROM products p
 WHERE p.deleted_at IS NULL
   AND p.list_price IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM product_price_history h WHERE h.product_id = p.id AND h.price_type = 'list');
