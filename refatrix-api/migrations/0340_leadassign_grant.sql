-- =====================================================================
-- Refatrix ERP · 0340_leadassign_grant (2026-11-26)
--   「영업 할당 · 실적」 + Meta 광고 문의 배분 설정을 디렉터처럼 쓰는 사용자별 화면 권한 page_key='leadassign'.
--   Sebastian 요청: Emmanuel · marketing 계정에 디렉터와 같은 권한(수정) — 아이디 또는 이름으로 찾아 넣는다.
--   다른 사람은 관리 › 사용자 › 화면 권한 「Meta 문의 할당 · 실적(관리)」에서 켜고 끈다. 여러 번 돌려도 같다.
-- =====================================================================
INSERT INTO user_page_access (user_id, page_key, device_req, access)
SELECT u.id, 'leadassign', 'anywhere', 'edit'
  FROM users u
 WHERE u.deleted_at IS NULL
   AND (lower(coalesce(u.login_id, '')) IN ('emmanuel', 'marketing')
        OR lower(u.name) LIKE 'emmanuel%'
        OR lower(u.name) = 'marketing')
ON CONFLICT (user_id, page_key) DO UPDATE SET access = 'edit', device_req = 'anywhere';
