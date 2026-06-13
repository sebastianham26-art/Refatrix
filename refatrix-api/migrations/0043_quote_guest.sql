-- =====================================================================
-- Refatrix ERP · 0043_quote_guest
--   불특정(미등록) 고객 견적 지원
--   · customer_id 를 NULL 허용 (불특정 고객은 customer_id 없음)
--   · guest_name : 불특정 고객명(자유 입력) — 견적서에 표시
-- =====================================================================
ALTER TABLE quotes ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS guest_name TEXT;
