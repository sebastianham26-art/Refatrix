-- =====================================================================
-- Refatrix ERP · 0234_e_approval
--   공통 › 전자결재 — 비용집행 품의 (기안 → 중간결재·합의·경유 → 디렉터 결재
--   → [기준액 이상] 대표이사 사전승인 → 집행(재무) → 대표이사 사후승인 → 완결)
--
--   · 결재선은 상신 시점에 approval_lines 로 스냅샷(설정이 바뀌어도 진행 중 문서는 그대로).
--   · 결재 상태(status) · 집행 상태(exec_status) · 사후승인 상태(post_status) 3축 분리.
--   · 예정/실적 금액은 이 모듈 안에서만 관리 — transactions·cashflow 에는 쓰지 않는다(디렉터 결정 2026-09-29).
--   · 증빙 원본은 approval_files.file_data(BYTEA) — 비공개. 조회는 API 가 권한 확인 후 내려준다.
--     목록 쿼리는 file_data 를 읽지 않는다(0091·0230 과 같은 방식). 파일당 20MB 검증은 src/approval.js.
--   · 댓글 수정·삭제는 디렉터만(approval_comment_history 에 원문 보존, 삭제는 소프트).
--   · 전 구문 IF NOT EXISTS — 재실행 안전.
-- =====================================================================

-- 설정(단일 행) ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_settings (
  id                     SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ceo_pre_threshold      NUMERIC(14,2) NOT NULL DEFAULT 100000,
  threshold_basis        TEXT NOT NULL DEFAULT 'total' CHECK (threshold_basis IN ('total','sub')),
  variance_tolerance_pct NUMERIC(6,2) NOT NULL DEFAULT 10,
  ceo_user_id            BIGINT REFERENCES users(id),
  director_user_id       BIGINT REFERENCES users(id),
  finance_user_id        BIGINT REFERENCES users(id),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             BIGINT REFERENCES users(id)
);

-- 대표이사 = 이름/아이디가 Jang 인 사용자. 디렉터 = Sebastian 우선(시드 '관리자' 계정 회피), 없으면 첫 디렉터.
-- 재무 = 첫 treasury. 못 찾으면 NULL — 설정 화면에서 지정(지정 전에는 상신이 막히고 이유가 표시된다).
INSERT INTO approval_settings (id, ceo_user_id, director_user_id, finance_user_id)
SELECT 1,
  (SELECT id FROM users WHERE deleted_at IS NULL AND (name ILIKE 'jang%' OR login_id ILIKE 'jang%') ORDER BY id LIMIT 1),
  COALESCE(
    (SELECT id FROM users WHERE deleted_at IS NULL AND role = 'director' AND (name ILIKE 'sebastian%' OR login_id ILIKE 'sebastian%') ORDER BY id LIMIT 1),
    (SELECT id FROM users WHERE deleted_at IS NULL AND role = 'director' ORDER BY id LIMIT 1)),
  (SELECT id FROM users WHERE deleted_at IS NULL AND role = 'treasury' ORDER BY id LIMIT 1)
WHERE NOT EXISTS (SELECT 1 FROM approval_settings WHERE id = 1);

CREATE TABLE IF NOT EXISTS approval_settings_log (
  id          BIGSERIAL PRIMARY KEY,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by  BIGINT REFERENCES users(id),
  detail      TEXT NOT NULL
);

-- 카테고리 · 카테고리별 결재선 템플릿 -------------------------------------
CREATE TABLE IF NOT EXISTS approval_categories (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO approval_categories (name, sort_order)
SELECT v.name, v.ord FROM (VALUES
  ('출장비',10),('소모품',20),('마케팅',30),('차량·연료',40),('수선·유지',50),
  ('비품',60),('외주용역',70),('임차료',80),('복리후생',90),('기타',100)
) AS v(name, ord)
WHERE NOT EXISTS (SELECT 1 FROM approval_categories);

CREATE TABLE IF NOT EXISTS approval_category_steps (
  id           BIGSERIAL PRIMARY KEY,
  category_id  BIGINT NOT NULL REFERENCES approval_categories(id) ON DELETE CASCADE,
  step_order   INT NOT NULL DEFAULT 0,
  step_type    TEXT NOT NULL CHECK (step_type IN ('approve','agree','pass')),
  user_id      BIGINT NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_approval_category_steps_cat ON approval_category_steps(category_id);

-- 문서번호 연도별 시퀀스 (EXP-YYYY-NNNN) ------------------------------------
CREATE TABLE IF NOT EXISTS approval_doc_seq (
  year     INT PRIMARY KEY,
  last_no  INT NOT NULL DEFAULT 0
);

-- 문서 -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_documents (
  id                  BIGSERIAL PRIMARY KEY,
  doc_no              TEXT UNIQUE,                       -- 상신 시 부여(임시저장은 NULL)
  version             INT NOT NULL DEFAULT 1,
  parent_id           BIGINT REFERENCES approval_documents(id),   -- 반려 건 재기안 원문서
  category_id         BIGINT REFERENCES approval_categories(id),
  title               TEXT NOT NULL,
  vendor              TEXT,
  body                TEXT,
  drafter_id          BIGINT NOT NULL REFERENCES users(id),
  pay_due             DATE,
  pay_method          TEXT,
  iva_applied         BOOLEAN NOT NULL DEFAULT true,
  planned_sub         NUMERIC(14,2) NOT NULL DEFAULT 0,
  planned_iva         NUMERIC(14,2) NOT NULL DEFAULT 0,
  planned_total       NUMERIC(14,2) NOT NULL DEFAULT 0,
  include_finance     BOOLEAN NOT NULL DEFAULT true,      -- 디렉터 기안 시 재무 합의 포함 여부
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','progress','approved','rejected')),
  exec_status         TEXT NOT NULL DEFAULT 'none' CHECK (exec_status IN ('none','pending','done')),
  post_status         TEXT NOT NULL DEFAULT 'none' CHECK (post_status IN ('none','pending','confirmed','flagged')),
  ceo_pre_required    BOOLEAN NOT NULL DEFAULT false,
  threshold_at_submit NUMERIC(14,2),
  basis_at_submit     TEXT,
  actual_total        NUMERIC(14,2),
  exec_date           DATE,
  exec_pay_method     TEXT,
  exec_memo           TEXT,
  exec_at             TIMESTAMPTZ,
  exec_by             BIGINT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at        TIMESTAMPTZ,
  approved_at         TIMESTAMPTZ,
  closed_at           TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_approval_documents_drafter ON approval_documents(drafter_id);
CREATE INDEX IF NOT EXISTS idx_approval_documents_status ON approval_documents(status, exec_status, post_status);

-- 결재선(상신 시점 스냅샷) ------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_lines (
  id           BIGSERIAL PRIMARY KEY,
  document_id  BIGINT NOT NULL REFERENCES approval_documents(id) ON DELETE CASCADE,
  step_order   INT NOT NULL,
  step_type    TEXT NOT NULL
               CHECK (step_type IN ('draft','approve','agree','pass','director','pre_ceo','post_ceo')),
  user_id      BIGINT NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'waiting'
               CHECK (status IN ('waiting','pending','done','rejected','flagged','skipped')),
  acted_at     TIMESTAMPTZ,
  comment      TEXT
);
CREATE INDEX IF NOT EXISTS idx_approval_lines_doc ON approval_lines(document_id);
CREATE INDEX IF NOT EXISTS idx_approval_lines_user ON approval_lines(user_id, status);

-- 참조(진행 중 열람) · 공람(승인 후 공유) -----------------------------------
CREATE TABLE IF NOT EXISTS approval_viewers (
  document_id  BIGINT NOT NULL REFERENCES approval_documents(id) ON DELETE CASCADE,
  user_id      BIGINT NOT NULL REFERENCES users(id),
  kind         TEXT NOT NULL CHECK (kind IN ('ref','share')),
  PRIMARY KEY (document_id, user_id, kind)
);

-- 댓글 · 수정 이력 ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_comments (
  id           BIGSERIAL PRIMARY KEY,
  document_id  BIGINT NOT NULL REFERENCES approval_documents(id) ON DELETE CASCADE,
  author_id    BIGINT NOT NULL REFERENCES users(id),
  body         TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at    TIMESTAMPTZ,
  edited_by    BIGINT REFERENCES users(id),
  deleted_at   TIMESTAMPTZ,
  deleted_by   BIGINT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_approval_comments_doc ON approval_comments(document_id);

CREATE TABLE IF NOT EXISTS approval_comment_history (
  id           BIGSERIAL PRIMARY KEY,
  comment_id   BIGINT NOT NULL REFERENCES approval_comments(id) ON DELETE CASCADE,
  old_body     TEXT NOT NULL,
  replaced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  replaced_by  BIGINT REFERENCES users(id)
);

-- 증빙 파일(비공개 원본) -----------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_files (
  id           BIGSERIAL PRIMARY KEY,
  document_id  BIGINT NOT NULL REFERENCES approval_documents(id) ON DELETE CASCADE,
  comment_id   BIGINT REFERENCES approval_comments(id),
  kind         TEXT NOT NULL DEFAULT '기타',
  stage        TEXT NOT NULL CHECK (stage IN ('draft','progress','exec','post')),
  file_name    TEXT,
  mime_type    TEXT NOT NULL,
  file_size    BIGINT NOT NULL,
  sha256       TEXT NOT NULL,
  file_data    BYTEA NOT NULL,
  cfdi_uuid    TEXT,
  cfdi_rfc     TEXT,
  cfdi_total   NUMERIC(14,2),
  dup_of       TEXT,                                  -- 업로드 시 같은 해시/UUID 가 쓰인 다른 문서번호
  uploaded_by  BIGINT NOT NULL REFERENCES users(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at    TIMESTAMPTZ,
  voided_by    BIGINT REFERENCES users(id),
  void_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_approval_files_doc ON approval_files(document_id);
CREATE INDEX IF NOT EXISTS idx_approval_files_sha ON approval_files(sha256);
CREATE INDEX IF NOT EXISTS idx_approval_files_uuid ON approval_files(cfdi_uuid);

-- 결재문서 연결(다른 결재 문서를 증빙으로) -------------------------------------
CREATE TABLE IF NOT EXISTS approval_links (
  document_id         BIGINT NOT NULL REFERENCES approval_documents(id) ON DELETE CASCADE,
  linked_document_id  BIGINT NOT NULL REFERENCES approval_documents(id),
  created_by          BIGINT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, linked_document_id)
);

-- 행위 이력(타임라인) — 상신·승인·반려·회수·집행·이의·파일 삭제/무효 등. 수정·삭제 API 없음.
CREATE TABLE IF NOT EXISTS approval_events (
  id           BIGSERIAL PRIMARY KEY,
  document_id  BIGINT NOT NULL REFERENCES approval_documents(id) ON DELETE CASCADE,
  actor_id     BIGINT REFERENCES users(id),
  action       TEXT NOT NULL,
  step_type    TEXT,
  detail       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_approval_events_doc ON approval_events(document_id);

-- 알림 -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_notifications (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id),
  document_id  BIGINT NOT NULL REFERENCES approval_documents(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  memo         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_approval_notifications_user ON approval_notifications(user_id, read_at);
