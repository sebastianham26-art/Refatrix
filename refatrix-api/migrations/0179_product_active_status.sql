-- =====================================================================
-- Refatrix ERP · 0179_product_active_status
-- 제품(SKU) 활성/비활성 상태 + 상태 전환 이력 + 「일괄 점검」 배치 보관
--
-- 목적
--   · 특정 목적(단종·품질이슈·전략적 판매중단 등)에 따라 SKU 를 비활성으로 바꾸고,
--     그 SKU 가 지금 어떤 업무(견적·수주확정·포장·인보이스·수금·발주·입고·부족분·
--     오퍼시트·개발요청)에 걸려 있는지 업체별로 정리해서 볼 수 있게 한다.
--   · 비활성은 「신규 사용 차단」일 뿐 과거 기록을 지우지 않는다 —
--     매출·매출총이익(P&L)·원가 내역은 그대로 조회된다. (soft delete 와 다르다)
--   · 여러 SKU 를 골라 한 번에 점검한 결과를 배치로 저장해 이력에서 다시 열람하고,
--     업체별로 처리결과 메모를 남긴다.
--
-- 멱등(IF NOT EXISTS) — 재실행 안전. 기본값 TRUE 이므로 기존 전 제품은 활성 상태.
-- =====================================================================

-- ① products 상태 컬럼 ------------------------------------------------
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_active         BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS inactive_reason   TEXT;          -- 마지막 전환 사유
ALTER TABLE products ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS status_changed_by BIGINT REFERENCES users(id);

-- 비활성은 소수라 부분 인덱스로 충분(활성 조회는 전체 스캔 그대로).
CREATE INDEX IF NOT EXISTS idx_products_inactive ON products (id) WHERE is_active = FALSE;

-- ② 상태 전환 이력 ----------------------------------------------------
CREATE TABLE IF NOT EXISTS product_status_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id  BIGINT NOT NULL REFERENCES products(id),
  code        TEXT,                                   -- 전환 시점 코드 스냅샷
  action      TEXT NOT NULL CHECK (action IN ('activate','deactivate')),
  reason      TEXT,
  check_id    BIGINT,                                 -- 일괄 점검에서 전환했으면 그 배치 id
  open_summary JSONB,                                 -- 전환 시점의 미결 항목 요약(근거 보존)
  changed_by  BIGINT REFERENCES users(id),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prodstatlog_product ON product_status_log (product_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_prodstatlog_when    ON product_status_log (changed_at DESC);

-- ③ 일괄 점검 배치 ----------------------------------------------------
CREATE TABLE IF NOT EXISTS product_status_checks (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title       TEXT,                                   -- 사용자가 붙이는 이름(미입력 시 자동)
  mode        TEXT NOT NULL DEFAULT 'mixed'
              CHECK (mode IN ('deactivate','activate','mixed')),
              -- deactivate=활성→비활성 검토 / activate=비활성→활성(판매재개) 검토 / mixed=혼합
  sku_count   INT NOT NULL DEFAULT 0,
  open_count  INT NOT NULL DEFAULT 0,                 -- 미결 항목이 1건 이상인 SKU 수
  note        TEXT,
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_prodstatchk_when ON product_status_checks (created_at DESC);

-- ④ 배치에 담긴 SKU 별 점검 결과(스냅샷) -------------------------------
--    detail 은 점검 시점의 항목 원문(업체별 그룹)을 그대로 보관 —
--    나중에 견적이 취소돼도 "그때 무엇이 걸려 있었나"를 재현할 수 있어야 하므로.
CREATE TABLE IF NOT EXISTS product_status_check_items (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  check_id      BIGINT NOT NULL REFERENCES product_status_checks(id) ON DELETE CASCADE,
  product_id    BIGINT NOT NULL REFERENCES products(id),
  code          TEXT,
  name          TEXT,
  was_active    BOOLEAN,                              -- 점검 시점 상태
  target_active BOOLEAN,                              -- 하려던 전환(TRUE=활성화, FALSE=비활성화)
  open_total    INT NOT NULL DEFAULT 0,               -- 미결 항목 건수 합
  summary       JSONB,                                -- 버킷별 건수/수량
  detail        JSONB,                                -- 업체별 상세 행
  applied_at    TIMESTAMPTZ,                          -- 이 배치에서 실제 전환한 시각
  applied_by    BIGINT REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_prodstatchkitem ON product_status_check_items (check_id, product_id);
CREATE INDEX IF NOT EXISTS idx_prodstatchkitem_prod ON product_status_check_items (product_id);

-- ⑤ 업체별 처리결과 메모 ----------------------------------------------
--    "걸려있는 항목이 있으면 각 업체별로 정리해서 보고 처리결과를 메모" 요구 반영.
--    party = 고객사/공급처 이름(내부 항목은 '(내부)' 같은 고정 라벨).
CREATE TABLE IF NOT EXISTS product_status_check_notes (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  check_id    BIGINT NOT NULL REFERENCES product_status_checks(id) ON DELETE CASCADE,
  product_id  BIGINT NOT NULL REFERENCES products(id),
  party       TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL DEFAULT 'todo' CHECK (state IN ('todo','doing','done')),
  memo        TEXT,
  updated_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_prodstatchknote ON product_status_check_notes (check_id, product_id, party);
CREATE INDEX IF NOT EXISTS idx_prodstatchknote_chk ON product_status_check_notes (check_id);
