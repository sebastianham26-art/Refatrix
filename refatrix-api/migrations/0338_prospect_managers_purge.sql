-- 🧭 고객개발 8차 (디렉터 요청 2026-11-26)
--   ① prospect_managers : 고객개발 「관리자」 — 디렉터와 똑같이 고객개발 화면 전체를 보고 고칠 수 있는 사람(ERP 역할은 그대로)
--      디렉터 요청으로 Gabriel 계정을 처음 관리자로 넣는다(이름이 Gabriel 로 시작하는 활성 사용자가 정확히 1명일 때만).
--      이후 추가·해제는 고객개발 > 지역·담당 > 담당자 명단에서 디렉터가 한다.
--   (DENUE 데이터 삭제 기능은 코드만 — 하위 기록은 기존 FK(ON DELETE CASCADE / SET NULL)로 정리)
-- 멱등 — 재실행 안전.
CREATE TABLE IF NOT EXISTS prospect_managers (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id),
  granted_by  BIGINT REFERENCES users(id),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO prospect_managers (user_id)
SELECT u.id FROM users u
 WHERE u.deleted_at IS NULL AND (u.name ILIKE 'gabriel%' OR u.login_id ILIKE 'gabriel%')
   AND (SELECT COUNT(*) FROM users x WHERE x.deleted_at IS NULL AND (x.name ILIKE 'gabriel%' OR x.login_id ILIKE 'gabriel%')) = 1
ON CONFLICT (user_id) DO NOTHING;
