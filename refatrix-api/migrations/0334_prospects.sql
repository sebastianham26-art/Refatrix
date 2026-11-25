-- 🧭 영업 > 고객개발 (DENUE 잠재고객 → 담당 배정 → 방문·녹음 → Alta de clientes → 고객 전환) — 디렉터 요청 2026-11-24
--   ① prospects                : INEGI DENUE 에서 가져온 잠재고객(업체) 1곳 = 1행. 주(cve_ent)를 가리지 않는다 → 다른 주는 CSV 만 추가.
--   ② prospect_territories     : 지역(주 + municipio/CP 묶음) — 담당자 1명. 저장 시 미배정 후보 자동 배정.
--   ③ prospect_stage_history   : 단계 이동 이력(소요일·전환율 계산용)
--   ④ prospect_assign_history  : 담당 변경 이력
--   ⑤ prospect_targets         : 담당자 × 월 × 지표 목표
--   ⑥ prospect_routes / _stops : 하루 방문 계획(순서) — 실제 방문은 stop.consult_id 로 연결
--   ⑦ prospect_crm_values      : Alta de clientes 양식 값(업체 단위로 누적) — 담당자가 확인·저장한 값만
--      prospect_crm_log        : 값 변경 이력(AI 값 vs 최종 값 비교 포함)
--   ⑧ prospect_customer_links  : 기존 ERP 고객과의 연결 요청·승인 이력
--   ⑨ sales_consults.prospect_id 등 : 기존 「고객상담」 빠른 녹음을 그대로 쓰고 후보와 연결만 한다.
--      sales_consult_recordings.alta_* : 기존 요약이 끝난 뒤 같은 전사문으로 만든 Alta de clientes 초안(AI)
-- 기존 테이블의 기존 행·동작은 바꾸지 않는다(컬럼 추가만). 멱등 — 재실행 안전.

CREATE TABLE IF NOT EXISTS prospect_territories (
  id             BIGSERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  cve_ent        TEXT NOT NULL DEFAULT '19',            -- 주 코드(INEGI). 19 = Nuevo León
  municipios     TEXT[] NOT NULL DEFAULT '{}',          -- 포함 municipio 이름(대소문자·강세 무시 비교)
  cps            TEXT[] NOT NULL DEFAULT '{}',          -- (선택) 포함 우편번호 — 있으면 municipio 보다 우선
  owner_user_id  BIGINT REFERENCES users(id),
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_by     BIGINT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS prospects (
  id               BIGSERIAL PRIMARY KEY,
  denue_id         TEXT UNIQUE,                         -- DENUE id (수동 등록은 NULL)
  clee             TEXT,
  nom_estab        TEXT NOT NULL,
  raz_social       TEXT,
  scian_code       TEXT,
  segment          TEXT NOT NULL DEFAULT 'taller_general'
                   CHECK (segment IN ('mayorista','refaccionaria','refaccionaria_usada','taller_suspension','taller_general','otro')),
  priority         TEXT NOT NULL DEFAULT 'C' CHECK (priority IN ('A','B','C')),
  per_ocu          TEXT,
  address          TEXT,
  colonia          TEXT,
  cp               TEXT,
  cve_ent          TEXT,
  entidad          TEXT,
  cve_mun          TEXT,
  municipio        TEXT,
  localidad        TEXT,
  lat              DOUBLE PRECISION,
  lng              DOUBLE PRECISION,
  phone            TEXT,
  email            TEXT,
  web              TEXT,
  denue_fecha_alta TEXT,
  denue_edition    TEXT,                                -- 마지막으로 확인된 DENUE 판(예: 2026-11)
  denue_missing    BOOLEAN NOT NULL DEFAULT FALSE,      -- 새 판에 없음 → 「폐업 가능」 표시만
  source           TEXT NOT NULL DEFAULT 'denue' CHECK (source IN ('denue','manual')),
  territory_id     BIGINT REFERENCES prospect_territories(id) ON DELETE SET NULL,
  owner_user_id    BIGINT REFERENCES users(id),
  stage            TEXT NOT NULL DEFAULT 'sin_asignar'
                   CHECK (stage IN ('sin_asignar','asignado','contactado','interesado','cotizado','registro','cliente_activo','descartado')),
  stage_since      TIMESTAMPTZ NOT NULL DEFAULT now(),
  discard_reason   TEXT,
  customer_id      BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  last_activity_at TIMESTAMPTZ,
  assigned_at      TIMESTAMPTZ,
  created_by       BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ,
  deleted_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_prospects_owner_stage ON prospects(owner_user_id, stage) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_prospects_territory ON prospects(territory_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_prospects_ent_mun ON prospects(cve_ent, municipio) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_prospects_geo ON prospects(lat, lng) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_prospects_customer ON prospects(customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS prospect_stage_history (
  id           BIGSERIAL PRIMARY KEY,
  prospect_id  BIGINT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  from_stage   TEXT,
  to_stage     TEXT NOT NULL,
  user_id      BIGINT REFERENCES users(id),
  reason       TEXT,
  auto         BOOLEAN NOT NULL DEFAULT FALSE,          -- 시스템 자동 전환(배정·첫 방문·고객 승인 등)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_pstage_hist ON prospect_stage_history(prospect_id, created_at);
CREATE INDEX IF NOT EXISTS ix_pstage_hist_to ON prospect_stage_history(to_stage, created_at);

CREATE TABLE IF NOT EXISTS prospect_assign_history (
  id           BIGSERIAL PRIMARY KEY,
  prospect_id  BIGINT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  from_user    BIGINT REFERENCES users(id),
  to_user      BIGINT REFERENCES users(id),
  by_user      BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prospect_targets (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  period        TEXT NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  metric        TEXT NOT NULL CHECK (metric IN ('visitas','contactados','cotizaciones','nuevos_clientes','venta_nuevos')),
  target_value  NUMERIC(15,2) NOT NULL DEFAULT 0,
  updated_by    BIGINT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, period, metric)
);

CREATE TABLE IF NOT EXISTS prospect_routes (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  route_date  DATE NOT NULL,
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ,
  UNIQUE (user_id, route_date)
);
CREATE TABLE IF NOT EXISTS prospect_route_stops (
  id           BIGSERIAL PRIMARY KEY,
  route_id     BIGINT NOT NULL REFERENCES prospect_routes(id) ON DELETE CASCADE,
  prospect_id  BIGINT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  seq          INT NOT NULL,
  consult_id   BIGINT REFERENCES sales_consults(id) ON DELETE SET NULL,   -- 실제 방문(체크인)
  UNIQUE (route_id, prospect_id)
);

CREATE TABLE IF NOT EXISTS prospect_crm_values (
  prospect_id   BIGINT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  field_key     TEXT NOT NULL,                          -- 예: datos_generales.contacto_principal / competencia.1.marca
  value         JSONB,
  form_key      TEXT NOT NULL DEFAULT 'alta_clientes',
  form_version  INT NOT NULL DEFAULT 1,
  consult_id    BIGINT REFERENCES sales_consults(id) ON DELETE SET NULL,  -- 어느 방문에서 확정했는지
  source        TEXT,                                   -- ia | denue | manual (확정 당시 출처)
  updated_by    BIGINT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (prospect_id, field_key)
);
CREATE TABLE IF NOT EXISTS prospect_crm_log (
  id           BIGSERIAL PRIMARY KEY,
  prospect_id  BIGINT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  field_key    TEXT NOT NULL,
  old_value    JSONB,
  new_value    JSONB,
  ai_value     JSONB,                                   -- 같은 방문의 AI 초안 값(정확도 추적)
  consult_id   BIGINT,
  user_id      BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_pcrm_log ON prospect_crm_log(prospect_id, created_at);

CREATE TABLE IF NOT EXISTS prospect_customer_links (
  id            BIGSERIAL PRIMARY KEY,
  prospect_id   BIGINT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  customer_id   BIGINT NOT NULL REFERENCES customers(id),
  method        TEXT NOT NULL CHECK (method IN ('alta','vinculo','sugerencia')),
  status        TEXT NOT NULL DEFAULT 'solicitado' CHECK (status IN ('solicitado','aprobado','rechazado','anulado')),
  note          TEXT,
  requested_by  BIGINT REFERENCES users(id),
  decided_by    BIGINT REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_plink_open ON prospect_customer_links(status) WHERE status = 'solicitado';

-- 기존 「고객상담」 빠른 녹음과 연결
ALTER TABLE sales_consults ADD COLUMN IF NOT EXISTS prospect_id BIGINT REFERENCES prospects(id) ON DELETE SET NULL;
ALTER TABLE sales_consults ADD COLUMN IF NOT EXISTS checkin_dist_m INT;                    -- 체크인 위치 ↔ 후보 좌표 거리(m)
ALTER TABLE sales_consults ADD COLUMN IF NOT EXISTS review_status TEXT
  CHECK (review_status IS NULL OR review_status IN ('por_revisar','borrador','confirmado'));
ALTER TABLE sales_consults ADD COLUMN IF NOT EXISTS reviewed_by BIGINT REFERENCES users(id);
ALTER TABLE sales_consults ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS ix_consults_prospect ON sales_consults(prospect_id) WHERE prospect_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_consults_review ON sales_consults(created_by, review_status) WHERE review_status IN ('por_revisar','borrador');

ALTER TABLE sales_consult_recordings ADD COLUMN IF NOT EXISTS alta_draft JSONB;            -- AI 초안(양식 키별 값·근거·확신도)
ALTER TABLE sales_consult_recordings ADD COLUMN IF NOT EXISTS alta_status TEXT
  CHECK (alta_status IS NULL OR alta_status IN ('pending','done','failed'));
ALTER TABLE sales_consult_recordings ADD COLUMN IF NOT EXISTS alta_error TEXT;
