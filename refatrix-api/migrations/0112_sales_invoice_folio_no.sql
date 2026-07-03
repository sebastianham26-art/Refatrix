-- No. de Folio(CFDI 내부 폴리오 번호)를 SAT 번호(folio fiscal UUID)와 별도로 저장.
-- 매출확정에서 입력, 수금상세·Estado de cuenta에 표시, 수금상세 검색 대상.
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS folio_no TEXT;
