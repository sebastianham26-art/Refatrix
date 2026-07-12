-- 0132: 경쟁사 교차참조 코드에 리스트가격 추가
--   · BAW 가격표(LISTA GENERAL Q열 PRECIO) 업로드 시 브랜드 코드와 함께 저장.
--   · 제품찾기(경쟁사 제품검색) 화면의 CTR vs BAW vs SYD 가격비교에 사용.
--   · CTR 가격 = products.list_price · SYD 가격 = products.list_price_syd (기존 컬럼 그대로).

ALTER TABLE product_xref_codes ADD COLUMN IF NOT EXISTS list_price NUMERIC(15,2);
