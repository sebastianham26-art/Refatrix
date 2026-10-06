-- 0252 · WhatsApp 수신번호 형식 변경: 멕시코 구 형식 521+10자리 → 52+10자리 (2026-10-06 디렉터 지시)
--   대상: 일일자금 수신자(treasury_wa_recipients.phone) · 아침 브리핑 수신번호(users.wa_phone)
--   521 로 시작하는 13자리 숫자만 바꾼다. 다른 나라 번호·이미 52 형식인 번호는 건드리지 않는다.
--   재실행해도 결과가 같다(멱등).

UPDATE treasury_wa_recipients
   SET phone = '52' || substr(phone, 4), updated_at = now()
 WHERE phone ~ '^521[0-9]{10}$';

UPDATE users
   SET wa_phone = '52' || substr(wa_phone, 4)
 WHERE wa_phone ~ '^521[0-9]{10}$';
