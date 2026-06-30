-- Refatrix ERP · 0101_device_lock_gate
-- 디렉터가 지정한 사용자만 '기기 접속 제한'을 적용한다.
--  · users.device_locked = true 인 (비디렉터) 사용자는 로그인 시 승인된 기기에서만 접속 가능
--  · 미승인 기기로 로그인하면 PIN이 맞아도 차단 + 승인요청(pending)만 생성
--  · 승인 기기는 '특정 사용자 전용'(shared=false) 또는 '공용'(shared=true: 승인된 기기면 누구나) 으로 지정
-- 멱등(IF NOT EXISTS). 재실행 안전.

ALTER TABLE users   ADD COLUMN IF NOT EXISTS device_locked boolean NOT NULL DEFAULT false;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS shared        boolean NOT NULL DEFAULT false;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_seen     timestamptz;

-- 공용(누구나) 승인 기기를 해시로 전역 조회하기 위한 부분 인덱스
CREATE INDEX IF NOT EXISTS idx_devices_shared_hash
  ON devices (device_key_hash)
  WHERE shared = true AND status = 'approved';
