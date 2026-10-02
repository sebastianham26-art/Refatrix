-- Refatrix ERP · 0248_e_approval_pending_at
--   전자결재 게시판: 현재 처리자 이름 옆에 「대기한 시간」 표시 (디렉터 요청 2026-10-02).
--   approval_lines.pending_at = 그 단계가 차례(pending)가 된 시각. 이후 활성화될 때마다 서버가 기록한다.
--   기존에 이미 차례인 단계는 추정값으로 채운다:
--     · 사후승인: 집행완료 시각(없으면 승인·상신 시각)
--     · 그 외: 앞 단계 중 마지막 처리 시각(없으면 상신 시각)
ALTER TABLE approval_lines ADD COLUMN IF NOT EXISTS pending_at TIMESTAMPTZ;

UPDATE approval_lines l
   SET pending_at = CASE
         WHEN l.step_type = 'post_ceo' THEN COALESCE(d.exec_at, d.approved_at, d.submitted_at, d.created_at)
         ELSE COALESCE((SELECT max(x.acted_at) FROM approval_lines x
                         WHERE x.document_id = l.document_id AND x.step_order < l.step_order AND x.acted_at IS NOT NULL),
                       d.submitted_at, d.created_at)
       END
  FROM approval_documents d
 WHERE d.id = l.document_id AND l.status = 'pending' AND l.pending_at IS NULL;
