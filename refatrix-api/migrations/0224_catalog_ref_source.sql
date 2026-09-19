-- 0224 · 카탈로그 조회 API — 대응품번을 어디서 가져올지 (디렉터 결정 2026-09-19)
--
--   0221~0223 은 product_xref_codes 에서 뽑았다. 그 표는 「아무 경쟁사 코드나 입력해도
--   CTR 제품을 역매칭」하려고 쌓은 것이라(0130) BAW·GROB·VASLO·KYB·MOOG 등이 섞여 있고,
--   **제품/마케팅 화면의 「경쟁사 코드」(products.scode)와 목록이 다르다.**
--   고객에게는 화면과 같은 것만 보낸다.
--
--     scode (기본) = products.scode  — 화면과 같은 값, 전부 marca 'SYD'
--     xref         = product_xref_codes (종전 동작)
--     both         = 둘을 합치고 중복 제거
ALTER TABLE catalog_api_clients
  ADD COLUMN IF NOT EXISTS ref_source TEXT DEFAULT 'scode';

DO $$ BEGIN
  ALTER TABLE catalog_api_clients
    ADD CONSTRAINT catalog_api_clients_refsrc_chk CHECK (ref_source IN ('scode','xref','both'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 이미 만들어 둔 고객사도 화면과 같은 출처로 돌린다.
UPDATE catalog_api_clients SET ref_source = 'scode' WHERE ref_source IS NULL OR ref_source = 'xref';
