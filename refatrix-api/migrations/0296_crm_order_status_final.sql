-- 0296 · 오더상태 (전송) — 끝 상태 2개 추가 (디렉터 지시 2026-10-26)
--
--   8 expirado   ERP 의 24시간 룰로 견적이 만료됐다
--   9 eliminado  디렉터가 COT 견적 삭제를 승인했다
--
--   번호를 5·6 이 아니라 8·9 로 둔 이유
--   · CRM 은 이미 「secuencia 가 지금보다 작거나 같으면 무시」 규칙으로 동작한다(계약서 v1.0 §4).
--     끝 상태가 언제나 가장 큰 번호여야, 늦게 도착한 진행 단계(재시도)가 끝 상태를 덮지 못한다.
--   · 만료된 견적도 삭제 요청·승인될 수 있다 → eliminado(9) > expirado(8).
--   · 5~7 은 혹시 생길 진행 단계(예: 결제 완료)를 위해 비워 둔다.
--
--   멱등 — 재실행 안전(제약은 지우고 다시 만든다, 계약서는 같은 값으로 덮는다).

-- ── ① 단계 장부의 허용 번호 ──────────────────────────────────────────
ALTER TABLE crm_order_status_events DROP CONSTRAINT IF EXISTS crm_order_status_events_seq_check;
ALTER TABLE crm_order_status_events
  ADD CONSTRAINT crm_order_status_events_seq_check CHECK (seq IN (1, 2, 3, 4, 8, 9));

COMMENT ON COLUMN crm_order_status_events.status IS
  'solicitud_nueva | surtiendo | preparando_despacho | oc_enviada | expirado(8) | eliminado(9)';

-- ── ② 연동 관리 화면의 계약서 설명(estatus · estatusTexto · secuencia) ─────────
--   필드 순서와 다른 필드는 그대로 두고, 세 필드의 설명만 바꾼다.
UPDATE integration_endpoints
   SET contract = jsonb_set(contract, '{fields}', (
         SELECT jsonb_agg(
                  CASE f->>'name'
                    WHEN 'estatus' THEN f || jsonb_build_object(
                      'es', 'solicitud_nueva | surtiendo | preparando_despacho | oc_enviada | expirado | eliminado',
                      'ko', '오더 단계 코드 — 진행 4단계 + 끝 상태 2개(expirado · eliminado)')
                    WHEN 'estatusTexto' THEN f || jsonb_build_object(
                      'es', 'Texto para mostrar: Solicitud nueva | Surtiendo | Preparando despacho | OC Enviada | Expirado | Eliminado',
                      'ko', '화면 표시 문구')
                    WHEN 'secuencia' THEN f || jsonb_build_object(
                      'es', '1 a 4 = etapas; 8 = expirado (venció por la regla de 24 h); 9 = eliminado (dirección aprobó borrar la cotización). Nunca retrocede: si llega una secuencia menor o igual a la que ya tiene el pedido, ignorarla. 8 y 9 son finales',
                      'ko', '1~4 진행 단계 · 8 만료(24시간 룰) · 9 삭제(디렉터 승인). 뒤로 가지 않는다 — 작거나 같은 값은 무시. 8·9 는 끝 상태')
                    ELSE f
                  END ORDER BY ord)
           FROM jsonb_array_elements(contract->'fields') WITH ORDINALITY AS t(f, ord)))
 WHERE key = 'order_status'
   AND jsonb_typeof(contract->'fields') = 'array';

UPDATE integration_endpoints
   SET contract = jsonb_set(contract, '{notes}', to_jsonb(
         COALESCE(contract->>'notes', '') ||
         ' · 0296(2026-10-26): 끝 상태 추가 — 24시간 룰 만료 시 expirado(8), 디렉터 삭제 승인 시 eliminado(9). 계약서 v1.1.'))
 WHERE key = 'order_status'
   AND COALESCE(contract->>'notes', '') NOT LIKE '%0296%';

UPDATE integration_endpoints
   SET description = 'ERP 수주 단계가 바뀌면 CRM 오더 단계(Solicitud nueva · Surtiendo · Preparando despacho · OC Enviada)를 보낸다. 끝 상태: 24시간 룰 만료 → Expirado, 디렉터 삭제 승인 → Eliminado. 웹카달록에서 들어온 견적(COT-…)만 대상. 주소·API 키는 「고객 상거래정보」와 같은 서버·같은 키.'
 WHERE key = 'order_status'
   AND description NOT LIKE '%Expirado%';
