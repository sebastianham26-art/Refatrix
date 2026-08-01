-- =====================================================================
-- Refatrix ERP · 0159_devreq_no_todo_fanout
--   개발검토 요청(dev_review) 자동 할일 정리 — 디렉터 확정(2026-08-01):
--   ① 그동안 제품/마케팅 권한자 전원(현재 10명)에게 복제 배정되던
--      kind='dev_review' 자동 할일을 전부 소프트삭제(노이즈 제거).
--      (개발요청 대장 product_dev_requests 기록은 그대로 유지 — 데이터 손실 없음)
--   ② 앞으로는 코드에서 dev_review 할일을 아예 생성하지 않음
--      (개발필요내용 수요 집계 화면이 대체). dev_complete(완료 알림)는 유지.
--   멱등: 재실행 안전.
-- =====================================================================

UPDATE todos
   SET deleted_at = now()
 WHERE kind = 'dev_review'
   AND deleted_at IS NULL;
