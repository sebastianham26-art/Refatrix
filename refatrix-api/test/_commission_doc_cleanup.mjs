// 2026-11-02h 월 확정 시 지급승인 전자결재 문서(임시저장)가 자동 생성되므로, 커미션 테스트 정리에서 그 흔적도 지운다.
//   U = 테스트 사용자 id 서브쿼리(괄호 없이, 예: "SELECT id FROM users WHERE login_id LIKE 'x%'")
export async function cleanupCommissionDocs(query, U) {
  const D = `(SELECT id FROM approval_documents WHERE drafter_id IN (${U}))`;
  const has = async (t) => (await query(`SELECT 1 FROM information_schema.tables WHERE table_name=$1`, [t])).rows.length > 0;
  if (!(await has('approval_documents'))) return;
  if (await has('commission_approval_docs')) await query(`DELETE FROM commission_approval_docs WHERE agent_id IN (${U}) OR created_by IN (${U}) OR document_id IN ${D}`);
  await query(`UPDATE approval_payments SET txn_id=NULL WHERE document_id IN ${D}`);
  await query(`DELETE FROM transactions WHERE created_by IN (${U}) OR owner_id IN (${U})`);
  for (const t of ['approval_files', 'approval_events', 'approval_notifications', 'approval_lines', 'approval_viewers', 'approval_payments', 'approval_revisions', 'approval_addenda', 'approval_comments', 'approval_links']) {
    if (await has(t)) await query(`DELETE FROM ${t} WHERE document_id IN ${D}`);
  }
  await query(`UPDATE approval_documents SET parent_id=NULL WHERE drafter_id IN (${U})`);
  await query(`DELETE FROM approval_documents WHERE drafter_id IN (${U})`);
}
