-- Refatrix ERP · 0247_e_approval_exec_toggle
--   전자결재: 문서별 「집행(재무)」 단계 넣기/빼기 (디렉터).
--   exec_required = true  → 지금처럼 승인완료 후 재무가 회차별로 집행 처리(실적·증빙) → 대표이사 사후승인
--   exec_required = false → 집행 단계 없음: 승인완료 시 남은 회차를 예정 금액으로 집행완료 처리하고 바로 사후승인 대기
--   기존 문서는 모두 true(동작 변화 없음). 디렉터만 작성 화면·결재선 수정에서 바꿀 수 있다.
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS exec_required BOOLEAN NOT NULL DEFAULT true;
