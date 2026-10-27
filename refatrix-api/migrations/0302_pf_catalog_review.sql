-- =====================================================================
-- Refatrix ERP · 0302_pf_catalog_review — REFATRIX Platform 「제품 카탈로그 점검」 (2026-10-27 디렉터 지시)
--
--   무엇을
--     · CTR 개발담당자가 REFATRIX Platform(Netlify) 화면에서 ERP 제품 카탈로그를 부품별로 점검한다.
--       고칠 것은 고치고 [확인완료] 를 누르면 그 순간 ERP 제품 마스터에 반영된다(디렉터 승인 없음).
--     · 화면은 ERP 의 **지금 값**을 직접 읽는다 — 플랫폼에 사본을 두지 않는다.
--       그래서 ERP 에서 현장 수정을 하거나 신규 품목을 만들면 플랫폼에도 그 즉시 보인다(전송할 것이 없다).
--     · 재고수량·가격은 이 화면으로 나가지 않는다(라우트가 열 자체를 읽지 않는다).
--
--   점검 상태는 저장하지 않고 **계산**한다 — 어긋날 수가 없게.
--     미검토   = 확인 기록이 없다
--     작성중   = 저장해 둔 수정안(draft)이 있다
--     확인완료 = 마지막 확인 때의 지문(confirmed_hash) = 지금 ERP 값의 지문
--     재확인   = 확인한 뒤에 ERP 에서 값이 바뀌었다(현장 수정) — 막지 않고 알려만 준다
--
--   멱등(IF NOT EXISTS) — 재실행 안전.
-- =====================================================================

-- ① 부품별 점검 상태 1행 -----------------------------------------------
--   draft = { 필드: { base: 수정 시작 때 ERP 값, value: 제안 값 } }
--     base 를 남겨 두는 이유: 수정안을 쓰는 동안 ERP 에서 같은 칸을 고치면(현장 수정)
--     확인완료 때 그 사실을 알아채고 어느 값을 쓸지 묻는다. 현장 수정이 조용히 덮이지 않는다.
CREATE TABLE IF NOT EXISTS pf_catalog_review (
  product_id         BIGINT PRIMARY KEY REFERENCES products(id),
  draft              JSONB  NOT NULL DEFAULT '{}'::jsonb,
  draft_note         TEXT,
  draft_by           TEXT,                 -- 플랫폼 사용자 구분값
  draft_by_name      TEXT,
  draft_at           TIMESTAMPTZ,
  confirmed_hash     TEXT,                 -- 마지막 확인완료 직후 카탈로그 칸의 지문
  confirmed_at       TIMESTAMPTZ,
  confirmed_by       TEXT,
  confirmed_by_name  TEXT,
  confirm_count      INT    NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pfcr_confirmed ON pf_catalog_review (confirmed_at DESC);

-- ② 확인완료 이력 (append-only) ------------------------------------------
--   applied   = 실제로 ERP 에 들어간 변경 { 필드: {from, to} } (비어 있으면 「그대로 맞음」 확인)
--   conflicts = 확인 때 현장 수정과 겹쳐서 사람이 고른 칸 { 필드: {base, erp, mine, chose} }
CREATE TABLE IF NOT EXISTS pf_catalog_confirms (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id    BIGINT REFERENCES products(id),
  code          TEXT,
  pf_user       TEXT,
  pf_user_name  TEXT,
  applied       JSONB NOT NULL DEFAULT '{}'::jsonb,
  conflicts     JSONB,
  note          TEXT,
  crm_queued    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pfcc_product ON pf_catalog_confirms (product_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_pfcc_created ON pf_catalog_confirms (created_at DESC);

-- ③ 플랫폼 카탈로그 엑셀 다운로드 기록 (append-only) — 2026-10-27 디렉터 지시
--   「다운로드 기록을 위치와 일자 · 시간으로 남겨서 내가 볼 수 있게」 → ERP 제품 › 📜 제품 이력 탭(디렉터)
--   위치는 두 가지를 함께 남긴다:
--     gps_*  = 다운로드 순간 브라우저가 준 좌표(정확) — 위치 권한을 거부하면 다운로드 자체를 막는다
--     geo_*  = 접속 IP 로 추정한 도시(대략) — GPS 를 못 받은 경우(시간 초과 · 미지원)에도 남는다
CREATE TABLE IF NOT EXISTS pf_catalog_exports (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pf_user       TEXT,
  pf_user_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_count     INT  NOT NULL DEFAULT 0,
  filters       JSONB,
  gps_status    TEXT,                -- ok | unavailable
  gps_lat       DOUBLE PRECISION,
  gps_lng       DOUBLE PRECISION,
  gps_acc       DOUBLE PRECISION,    -- 오차(m)
  ip            TEXT,
  geo_city      TEXT,
  geo_region    TEXT,
  geo_country   TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_pfce_created ON pf_catalog_exports (created_at DESC);
