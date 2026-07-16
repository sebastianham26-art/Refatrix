-- 0138: 방문 체크인에 연락처(이메일·핸드폰) 필드 추가
ALTER TABLE sales_visits ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE sales_visits ADD COLUMN IF NOT EXISTS contact_phone TEXT;
