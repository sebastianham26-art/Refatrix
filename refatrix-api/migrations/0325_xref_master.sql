-- 0325: 멕시코 시장 주요 경쟁사 크로스레퍼런스 마스터 (2026-11-11 · 디렉터 요청)
--   · 기준 파일: mexico_cross_reference_YYMMDD.xlsx — 열 SYD · CTR · BAW · GROB · VAZLO · KYB · MOOG · DESCRIPCIÓN · PRECIO · APLICACIÓN · UBICACIÓN
--   · 연결 규칙: 경쟁사 코드 → (이 마스터) → SYD 코드 → (ERP product_syd_codes) → CTR 제품
--   · 기존 product_xref_codes(0130, 제품에 붙은 교차참조)와 별개 — 이 표는 CTR 이 없는 행(미개발 SYD)도 전부 담는다.
--     그래서 나중에 그 SYD 가 ERP 에 등록되면 견적 · 제품찾기 · 개발요청 자동 검수가 바로 그 코드를 CTR 로 잇는다.
--   · 버전: 업로드마다 1건. 원본 파일(bytea)을 보관해 「최근 업로드 버전」을 그대로 내려받는다.
--          검색에 쓰는 행 · 코드는 활성(최신) 버전 것만 남긴다.

CREATE TABLE IF NOT EXISTS xref_master_versions (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  filename     TEXT,
  file_data    BYTEA,                       -- 업로드 원본(.xlsx) — 내려받기용
  file_size    INT,
  row_count    INT NOT NULL DEFAULT 0,
  code_count   INT NOT NULL DEFAULT 0,
  brand_counts JSONB,                       -- {"SYD":6634,"BAW":9490,…}
  bridged_rows INT,                         -- 업로드 시점 ERP CTR 로 이어진 행 수
  is_active    BOOLEAN NOT NULL DEFAULT FALSE,
  uploaded_by  BIGINT,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_xmv_active ON xref_master_versions (is_active);

CREATE TABLE IF NOT EXISTS xref_master_rows (
  version_id   BIGINT NOT NULL REFERENCES xref_master_versions(id) ON DELETE CASCADE,
  row_no       INT NOT NULL,                -- 엑셀 행 번호(헤더 = 1)
  syd_text     TEXT,
  ctr_text     TEXT,
  codes        JSONB,                       -- {"BAW":["SU042"],"GROB":["G4368"],…} 원문 표기
  descripcion  TEXT,
  precio       NUMERIC(15,2),
  aplicacion   TEXT,
  ubicacion    TEXT,
  PRIMARY KEY (version_id, row_no)
);

CREATE TABLE IF NOT EXISTS xref_master_codes (
  version_id   BIGINT NOT NULL REFERENCES xref_master_versions(id) ON DELETE CASCADE,
  row_no       INT NOT NULL,
  brand        TEXT NOT NULL,               -- SYD · CTR · BAW · GROB · VAZLO · KYB · MOOG
  code         TEXT NOT NULL,               -- 원문(한 칸의 '//' · '/' 나눈 조각)
  norm_code    TEXT NOT NULL                -- 대문자 + 영숫자만
);
CREATE INDEX IF NOT EXISTS idx_xmc_norm  ON xref_master_codes (version_id, norm_code);
CREATE INDEX IF NOT EXISTS idx_xmc_row   ON xref_master_codes (version_id, row_no);
CREATE INDEX IF NOT EXISTS idx_xmc_brand ON xref_master_codes (version_id, brand, norm_code);

-- 견적 줄: 입력 브랜드(붙여넣기 때 고른 브랜드). CTR 을 못 찾은 줄도 「코드 + 브랜드」가 남는다.
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS input_brand TEXT;

-- 개발요청: 입력 브랜드 · 자동 검수 결과
ALTER TABLE product_dev_requests ADD COLUMN IF NOT EXISTS input_brand      TEXT;
ALTER TABLE product_dev_requests ADD COLUMN IF NOT EXISTS result_match_via TEXT;        -- ctr · syd · oe · xref · master · manual
ALTER TABLE product_dev_requests ADD COLUMN IF NOT EXISTS auto_matched_at  TIMESTAMPTZ; -- 자동 검수로 매칭된 시각(팝업 기준)
ALTER TABLE product_dev_requests ADD COLUMN IF NOT EXISTS match_candidates TEXT;        -- 후보 여럿(자동 완료 안 함) — 'CB0001 / CB0002'
ALTER TABLE product_dev_requests ADD COLUMN IF NOT EXISTS match_checked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_devreq_auto_matched ON product_dev_requests (auto_matched_at);

-- 자동 검수 팝업 — 사용자별 마지막 확인 시각
CREATE TABLE IF NOT EXISTS dev_match_seen (
  user_id  BIGINT PRIMARY KEY,
  seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
