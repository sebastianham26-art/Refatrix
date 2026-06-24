-- =====================================================================
-- Refatrix ERP · 0072_notice_user_targets_popup
-- 공지(notices) 확장:
--   ① audience 에 'users'(특정 유저 다중 지정) 허용 — 기존 all/role/team 유지
--   ② is_popup : 로그인 시 팝업으로 띄울지 (기본 true)
--   ③ notice_targets : 공지 × 대상 유저 (중복선택, 1공지에 N명)
-- 멱등(IF NOT EXISTS / 제약 재생성 가드). 하위호환: 기존 공지는 audience 그대로,
-- is_popup 기본 true 라 기존 공지도 팝업 대상이 됨(원치 않으면 디렉터가 개별 해제).
-- =====================================================================

-- ① audience CHECK 에 'users' 추가 (기존 제약 이름이 다를 수 있어 동적 처리)
DO $$
DECLARE c_name TEXT;
BEGIN
  SELECT con.conname INTO c_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE rel.relname = 'notices'
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) ILIKE '%audience%';
  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE notices DROP CONSTRAINT %I', c_name);
  END IF;
  ALTER TABLE notices
    ADD CONSTRAINT notices_audience_chk
    CHECK (audience IN ('all','role','team','users'));
END $$;

-- ② is_popup 컬럼 (로그인 팝업 노출 여부)
ALTER TABLE notices ADD COLUMN IF NOT EXISTS is_popup BOOLEAN NOT NULL DEFAULT true;

-- ③ 공지 × 대상 유저 (다중 지정)
CREATE TABLE IF NOT EXISTS notice_targets (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notice_id  BIGINT NOT NULL REFERENCES notices(id),
  user_id    BIGINT NOT NULL REFERENCES users(id),
  UNIQUE (notice_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_ntarget_notice ON notice_targets (notice_id);
CREATE INDEX IF NOT EXISTS idx_ntarget_user   ON notice_targets (user_id);
