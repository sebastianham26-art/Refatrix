-- =====================================================================
-- Refatrix ERP · 0219_product_field_map
-- 제품 전송의 **필드 이름**과 **본문 형식**을 화면에서 바꾸게 한다.
--
--   왜
--     상대(CRM)는 우리 계약서를 받기 전에 이미 제품 화면을 만들어 두었다.
--     그 화면의 열은 우리 엑셀 플랜틸라 그대로다 — Clave CTR · Clave SyD · Aplicacion ·
--     Producto · SAT · Origen · Precio · IVA · EAN13 · Ubicacion · Precio lista comp. ·
--     Customer price · Sugerido refaccionarias.
--     그래서 우리가 보내는 `codigo` 를 못 읽고 `ERR_VALIDATION: Codigo CTR es requerido` 로 답했다.
--
--     열 이름은 알지만 **JSON 키 철자는 모른다**(claveCTR? clave_ctr? codigoCTR?).
--     추측을 코드에 박으면 틀릴 때마다 배포해야 한다 → **설정으로 뺀다.**
--
--   무엇을
--     field_map  : 우리 필드 → 상대 필드 이름. 값이 빈 문자열이면 그 필드는 **보내지 않는다**.
--     body_shape : lote(묶음 봉투 + productos[]) · array(루트가 제품 배열) · item(제품 1건 = 요청 1건)
--
--   멱등(IF NOT EXISTS) — 재실행 안전.
-- =====================================================================

ALTER TABLE integration_endpoints ADD COLUMN IF NOT EXISTS body_shape TEXT   NOT NULL DEFAULT 'lote';
ALTER TABLE integration_endpoints ADD COLUMN IF NOT EXISTS field_map  JSONB  NOT NULL DEFAULT '{}'::jsonb;

-- 셋 중 하나만 — 오타로 전송이 조용히 멎지 않게 DB 가 막는다.
DO $$ BEGIN
  ALTER TABLE integration_endpoints
    ADD CONSTRAINT integration_endpoints_body_shape_chk
    CHECK (body_shape IN ('lote','array','item'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'body_shape 제약 이미 있음'; END $$;

-- 제품 창구의 계약서 「비고」에 지금 상황을 적어 둔다(다음 사람이 배경을 알 수 있게).
UPDATE integration_endpoints
   SET contract = jsonb_set(
         contract, '{notes}',
         to_jsonb(
           COALESCE(contract->>'notes','') ||
           E'\n\n[2026-09-15] CRM 의 제품 업로드 화면 열: Clave CTR · Clave SyD · Aplicacion · Producto · SAT · '
           'Origen · Precio · IVA · EAN13 · Ubicacion · Precio lista comp. · Customer price · Sugerido refaccionarias. '
           '상대는 이 모델로 먼저 구현했고, 우리 계약서 이름(codigo…)을 읽지 못해 ERR_VALIDATION 을 답했다. '
           '그래서 0219 로 **필드 이름 매핑**과 **본문 형식**을 연동 관리 화면에서 바꾸게 했다. '
           '개발자에게 받아야 할 것: JSON 키 철자 · 본문 구조(묶음/배열/1건) · 필수 필드 · '
           'Sugerido refaccionarias 계산 규칙(ERP 에 없는 값).'),
         true)
 WHERE key = 'product'
   AND COALESCE(contract->>'notes','') NOT LIKE '%0219%'
   AND COALESCE(contract->>'notes','') NOT LIKE '%Sugerido refaccionarias%';
