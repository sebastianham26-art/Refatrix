-- =====================================================================
-- Refatrix ERP · 0002_users_permissions_devices
-- 사용자 · 권한(메뉴/필드/항목) · 기기 등록
-- =====================================================================

-- 사용자 -------------------------------------------------------------
CREATE TABLE users (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name             TEXT NOT NULL,
  dept             TEXT,
  role             TEXT NOT NULL
                   CHECK (role IN ('director','treasury','marketing','ops','sales','viewer')),
  pin_hash         TEXT NOT NULL,                 -- PIN 해시(평문 저장 금지)
  lang             TEXT NOT NULL DEFAULT 'ko' CHECK (lang IN ('ko','es')),
  scope            TEXT DEFAULT 'own' CHECK (scope IN ('own','all')),
  cur_scope        TEXT DEFAULT 'all' CHECK (cur_scope IN ('all','MXN','USD')),
  see_balance      BOOLEAN NOT NULL DEFAULT false,
  see_process_map  BOOLEAN NOT NULL DEFAULT false, -- 뷰어의 전체 프로세스 열람 허용
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       BIGINT REFERENCES users(id),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       BIGINT REFERENCES users(id),
  deleted_at       TIMESTAMPTZ
);
-- role 'ops' = 영업지원 (Administradora de venta) : 수입담당+영업지원 통합
CREATE TRIGGER trg_users_upd BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 콘텐츠(메뉴) 접근 + 기기 요구 ------------------------------------
CREATE TABLE user_page_access (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  page_key    TEXT NOT NULL,                       -- home/flow/record/.../settings
  device_req  TEXT NOT NULL DEFAULT 'anywhere'
              CHECK (device_req IN ('registered_only','anywhere','blocked')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, page_key)
);

-- 민감 필드 노출(필드별 잘게) --------------------------------------
CREATE TABLE user_field_access (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  field_key   TEXT NOT NULL
              CHECK (field_key IN ('buy_price','import_overhead','unit_cost',
                                   'sale_price','unit_margin','margin_rate','pnl')),
  visible     BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (user_id, field_key)
);

-- 민감 항목 열람 깊이(3단계) + 해상도 -------------------------------
CREATE TABLE user_item_depth (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  item_key    TEXT NOT NULL
              CHECK (item_key IN ('cash_position','balance','cashflow','sales')),
  depth       TEXT NOT NULL DEFAULT 'hidden'
              CHECK (depth IN ('hidden','result_only','full')),
  resolution  TEXT DEFAULT 'month'
              CHECK (resolution IN ('month','week','day')),
  UNIQUE (user_id, item_key)
);

-- 등록 기기(등록 요청은 status=pending) -----------------------------
CREATE TABLE devices (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          BIGINT NOT NULL REFERENCES users(id),
  device_key_hash  TEXT NOT NULL,                  -- 기기+브라우저 등록 키(해시)
  label            TEXT,                            -- 예: 사무실 PC / 본인 노트북
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','revoked')),
  approved_by      BIGINT REFERENCES users(id),
  approved_at      TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_key_hash)
);
CREATE INDEX idx_devices_user_status ON devices (user_id, status);
