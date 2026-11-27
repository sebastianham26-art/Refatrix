-- 0345: 상담 감추기(private_by) 중단 — 디렉터 결정(2026-11-27). 남아 있는 숨김을 모두 풀어 원래 보는 사람에게 다시 보이게.
--   (새로 숨기기는 API 가 막음 · 다시 공개는 그대로 가능)
UPDATE sales_consults SET private_by = NULL, private_at = NULL WHERE private_by IS NOT NULL;
