-- =====================================================================
-- Refatrix ERP · 0244_e_approval_edit_addenda
--   전자결재 — 디렉터 요청 2026-10-01
--   ① 결재선 수동 수정(디렉터): 진행 중 문서의 남은 단계 추가·삭제·순서·담당자 변경
--      (본인 결재 차례에도 가능). 처리 끝난 단계는 잠김. 변경은 approval_events('lines_edit') 에 전/후 기록.
--      → 스키마 변경 없음(approval_lines 를 그대로 다시 쓴다).
--   ② 내용 수정: 현재 결재 차례인 중간결재·합의·디렉터·대표이사 사전승인자 + 디렉터.
--      수정 전 문서 전체를 approval_revisions.snapshot 에 보존하고, 바뀐 항목만 changes 에 기록.
--   ③ 추가 작성: 결재자·디렉터가 원문 아래에 의견·내용(그림 포함)을 덧붙이고 파일을 올린다.
--      원문은 그대로 두고 approval_addenda 에 따로 쌓는다. 파일은 approval_files.addendum_id 로 연결.
--   · 전 구문 IF NOT EXISTS — 재실행 안전.
-- =====================================================================

CREATE TABLE IF NOT EXISTS approval_revisions (
  id           BIGSERIAL PRIMARY KEY,
  document_id  BIGINT NOT NULL REFERENCES approval_documents(id) ON DELETE CASCADE,
  editor_id    BIGINT NOT NULL REFERENCES users(id),
  step_type    TEXT,                    -- 수정 시점의 수정자 단계(디렉터가 차례 밖에서 고치면 'director_override')
  reason       TEXT,
  changes      TEXT NOT NULL,           -- JSON [{field,label,old,new}]
  snapshot     TEXT NOT NULL,           -- JSON 수정 전 문서(금액·본문·일정)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_approval_revisions_doc ON approval_revisions(document_id);

CREATE TABLE IF NOT EXISTS approval_addenda (
  id           BIGSERIAL PRIMARY KEY,
  document_id  BIGINT NOT NULL REFERENCES approval_documents(id) ON DELETE CASCADE,
  author_id    BIGINT NOT NULL REFERENCES users(id),
  step_type    TEXT,
  body         TEXT NOT NULL DEFAULT '',   -- 평문(검색·인쇄 요약용)
  body_rich    TEXT,                       -- JSON [{t:'p',v},{t:'img',src,w,h}]
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_approval_addenda_doc ON approval_addenda(document_id);

ALTER TABLE approval_files ADD COLUMN IF NOT EXISTS addendum_id BIGINT REFERENCES approval_addenda(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_approval_files_addendum ON approval_files(addendum_id);
