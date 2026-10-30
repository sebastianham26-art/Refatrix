-- =====================================================================
-- 0310 · 소개자 초대 (2026-10-30 · 디렉터 결정)
--   디렉터는 소개자(A)만 선택(초대)한다. 아직 A 와 계약 전이므로 B 는 고르지 않는다.
--   초대받은 A 가 로그인하면 안내가 뜨고, A 가 직접 B 계정 선택 · B 회사 정보 · 본인 정보 입력 →
--   서류 → 서명 → 디렉터 승인.  초대받지 않은 사람은 소개 계약을 신청할 수 없다.
-- =====================================================================
CREATE TABLE IF NOT EXISTS commission_referral_invites (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),      -- 소개자(A)
  note        TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by  BIGINT REFERENCES users(id),
  revoked_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_comm_referral_invite_active ON commission_referral_invites (user_id) WHERE active;

-- 이미 소개 계약이 있는 소개자는 초대된 것으로 둔다(추가 소개 가능)
INSERT INTO commission_referral_invites (user_id, created_by, note)
SELECT DISTINCT r.referrer_id, r.created_by, '기존 소개 계약'
  FROM commission_referrals r
 WHERE r.active
   AND NOT EXISTS (SELECT 1 FROM commission_referral_invites i WHERE i.user_id = r.referrer_id AND i.active);
