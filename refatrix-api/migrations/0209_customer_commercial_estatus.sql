-- 0209 · 고객 상거래정보 계약서에 estatus 필드를 더한다(화면 표시용).
--
--   배경: ERP 에서 승인을 끝내도 CRM 쪽 고객이 「Aprobación pendiente」 로 남았다(P-0001).
--         승인 전송 본문에 상태값이 없었기 때문이다. 반려(reject)는 이미 estatus 를
--         보내고 있었으므로, 승인·수정 쪽에도 넣어 **양방향 상태를 대칭**으로 맞춘다.
--         전송 본문 자체는 코드(src/crmSync.js buildPayload)가 만든다. 이 마이그레이션은
--         관리자 화면의 「계약서」 탭이 개발자에게 보여 줄 필드 목록을 맞추는 것뿐이다.
--
--   ⚠ 계약서는 디렉터가 화면에서 직접 고치는 문서다. 통째로 덮어쓰면 그가 적어 둔
--     내용이 사라진다. 그래서 **estatus 항목이 없을 때만 뒤에 덧붙인다**(멱등).

UPDATE integration_endpoints
   SET contract = jsonb_set(
         contract,
         '{fields}',
         (contract->'fields') || jsonb_build_array(jsonb_build_object(
           'name', 'estatus',
           'type', 'string',
           'required', true,
           'es', 'Estatus del cliente en el ERP: aprobado | pendiente | rechazado',
           'ko', 'ERP 승인 상태 — 승인 시 aprobado, 반려 시 rechazado'
         ))
       ),
       updated_at = now()
 WHERE key = 'customer_commercial'
   AND contract ? 'fields'
   AND jsonb_typeof(contract->'fields') = 'array'
   AND NOT (contract->'fields' @> '[{"name":"estatus"}]'::jsonb);
