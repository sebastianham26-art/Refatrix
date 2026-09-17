-- 0221 · 카탈로그 조회 API (고객이 가져가는 방향)
--
--   지금까지의 연동은 두 가지뿐이었다.
--     out : 우리가 상대 서버로 보낸다 (제품전송·고객동기화)
--     in  : 상대가 우리에게 한 건씩 보낸다 (웹카달록 신규고객 등록)
--   여기서 만드는 건 세 번째다 — **상대가 우리 카탈로그를 읽어 간다.**
--
--   왜 integration_endpoints 를 재사용하지 않았나
--     그 등록부는 「연동 1건 = 1행」이다. 여기는 「고객사 1곳 = 1행」이고 앞으로 늘어난다.
--     게다가 행마다 **어느 고객의 가격인지**(customer_id)와 **언제 열어 두는지**(접속창)가 달라야 한다.
--     연동 등록부에 고객을 섞으면 화면도 이력도 뒤엉킨다. 그래서 표를 나눈다.
--
--   가격의 핵심 — 여기에 가격을 저장하지 않는다.
--     precioCompra 는 **조회 시점에** customers.discount 로 계산한다(catalogPull.js).
--     그래서 디렉터가 고객 마스터의 할인율을 바꾸면 다음 호출부터 자동으로 바뀐 가격이 나간다.
--     가격을 이 표에 복사해 두면 마스터와 어긋나는 순간 아무도 그 사실을 모른다.

-- 1) 조회 고객사 ------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalog_api_clients (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label             TEXT NOT NULL,                        -- 화면에 보이는 이름
  customer_id       BIGINT REFERENCES customers(id),      -- 가격의 근거가 되는 고객 마스터 1행
  enabled           BOOLEAN NOT NULL DEFAULT true,

  -- 키 — 발급은 서버가 한다(rfx_prod_… / rfx_test_…). 사람이 타이핑하지 않는다.
  token_test        TEXT,
  token_prod        TEXT,
  token_prod_at     TIMESTAMPTZ,
  token_test_at     TIMESTAMPTZ,

  -- 접속창 — 기본값이 이번 계약(매주 토요일 05:00~09:00, 멕시코 중부시간)이다.
  window_enforced   BOOLEAN  NOT NULL DEFAULT true,
  window_dow        SMALLINT,                             -- 0=일 … 6=토 · NULL = 매일
  window_start_hour SMALLINT NOT NULL DEFAULT 5,
  window_end_hour   SMALLINT NOT NULL DEFAULT 9,          -- 이 시각 '미만'까지 열린다
  syncs_per_period  SMALLINT NOT NULL DEFAULT 1,          -- 한 접속창에서 허용하는 동기화 횟수
  max_calls         INT      NOT NULL DEFAULT 60,         -- 한 접속창에서 허용하는 HTTP 호출 수

  -- 응답 모양
  page_limit        INT  NOT NULL DEFAULT 500,            -- 기본 페이지 크기
  stock_mode        TEXT NOT NULL DEFAULT 'qty',          -- qty = 수량 · range = 구간
  img_base_url      TEXT,                                 -- 비면 제품전송 연동의 값을 쓴다
  brands            TEXT,                                 -- 공개할 대응품번 브랜드(콤마) · 비면 전부
  include_inactive  BOOLEAN NOT NULL DEFAULT true,        -- 단종품도 activo:false 로 함께 보낸다

  ip_allow          TEXT,                                 -- 허용 IP(콤마) · 비면 제한 없음
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        BIGINT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        BIGINT
);

DO $$ BEGIN
  ALTER TABLE catalog_api_clients
    ADD CONSTRAINT catalog_api_clients_stock_chk  CHECK (stock_mode IN ('qty','range'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE catalog_api_clients
    ADD CONSTRAINT catalog_api_clients_dow_chk    CHECK (window_dow IS NULL OR (window_dow BETWEEN 0 AND 6));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE catalog_api_clients
    ADD CONSTRAINT catalog_api_clients_hours_chk  CHECK (
      window_start_hour BETWEEN 0 AND 23 AND window_end_hour BETWEEN 1 AND 24
      AND window_end_hour > window_start_hour);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE catalog_api_clients
    ADD CONSTRAINT catalog_api_clients_limit_chk  CHECK (page_limit BETWEEN 10 AND 1000
      AND max_calls BETWEEN 1 AND 100000 AND syncs_per_period BETWEEN 1 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 같은 키가 두 고객사에 있으면 어느 가격을 줄지 알 수 없다 — DB 가 막는다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cac_token_prod ON catalog_api_clients (token_prod) WHERE token_prod IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cac_token_test ON catalog_api_clients (token_test) WHERE token_test IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cac_customer ON catalog_api_clients (customer_id);

-- 2) 동기화 회차 — 「한 접속창에 한 번」을 세는 곳 -----------------------
--   period_key = 그 접속창이 열린 날(멕시코 날짜, YYYY-MM-DD). 주 1회면 그 주 토요일이다.
--   테스트 키(env='test')는 회차를 소모하지 않는다 — 개발자가 평일에 붙어 볼 수 있어야 한다.
CREATE TABLE IF NOT EXISTS catalog_api_runs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id    BIGINT NOT NULL REFERENCES catalog_api_clients(id),
  period_key   TEXT   NOT NULL,
  env          TEXT   NOT NULL DEFAULT 'prod',
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at    TIMESTAMPTZ,                       -- cursor:null 을 받아 간 시각 = 동기화 완료
  pages        INT NOT NULL DEFAULT 0,
  productos    INT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_car_period ON catalog_api_runs (client_id, period_key, env);
CREATE INDEX IF NOT EXISTS idx_car_client ON catalog_api_runs (client_id, started_at DESC);

-- 3) 호출 이력 — 상대와 이야기할 때 근거가 되는 건 이 표뿐이다 ------------
CREATE TABLE IF NOT EXISTS catalog_api_calls (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id    BIGINT REFERENCES catalog_api_clients(id),   -- 키를 못 알아봤으면 NULL
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  remote_ip    TEXT,
  env          TEXT,                                        -- test | prod | NULL
  path         TEXT,
  query        TEXT,
  http_status  INT,
  codigo_error TEXT,
  items        INT,                                         -- 이 응답에 담아 보낸 제품 수
  ms           INT,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_cacalls_client ON catalog_api_calls (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cacalls_time   ON catalog_api_calls (created_at DESC);
