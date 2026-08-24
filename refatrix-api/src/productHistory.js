// =====================================================================
// Refatrix ERP · productHistory.js  (2026-08-24)
// 제품(SKU) 이력 화면용 순수 헬퍼.
//
// 이력은 두 테이블에서 나온다 — 어느 쪽도 새로 만들지 않고 **읽기만** 한다.
//   · product_change_log  (0141) : 마스터 변경(생성/수정 · 화면·엑셀·소재)
//   · product_status_log  (0179) : 판매 활성/비활성 전환
// 두 피드를 한 표로 합쳐 「변경기록 날짜 · CTR Code · 변경내역 · SYD Code ·
// Estado(Activo/Inactivo) · 변경자」 6열로 보여주고, 행을 열면 그 시점 **이후**의
// movement(재고 입출고 · 판매 · 견적)를 보여준다.
//
// 이 파일은 DB 를 모른다(순수함수) — 테스트가 쉽도록 라우트에서 분리.
// =====================================================================

// 가격류 필드 — sale_price 권한이 없는 사용자에게는 변경내역에서 가린다.
// (제품 목록/마스터 다운로드가 이미 같은 기준으로 가격을 감추므로 이력만 뚫리면 안 된다)
export const PRICE_FIELDS = new Set([
  'list_price', 'discount', 'list_price_syd', 'price_customer_syd', 'price_customer_ctr',
]);

// 표시 라벨 — 엑셀 헤더/화면과 같은 이름을 쓴다(사용자가 아는 이름).
export const FIELD_LABELS = {
  code: 'Clave CTR', scode: 'Clave SyD', app: 'Aplicacion', name: 'Nombre del producto',
  sat_code: 'Clave SAT', origin: 'Origen', list_price: 'List Price', iva_rate: 'IVA',
  ean: 'Barcode', location: 'Fast Movement Location', list_price_syd: 'List Price de SYD',
  price_customer_syd: 'Precio Cliente de SYD', price_customer_ctr: 'Precio Cliente de CTR',
  material: 'Material', rack_location: 'Rack 위치',
  _syd: 'Clave SyD(분해)', _app: '적용차종',
};

export const SOURCE_LABELS = {
  manual: '화면 입력', import: '엑셀 업로드', material: '소재 지정', material_bulk: '소재 일괄지정',
  status: '판매상태', status_check: '일괄 점검',
};

const isNil = (v) => v === null || v === undefined || v === '';

// 값 1개를 사람이 읽는 문자열로. 배열(_syd)·숫자(_app)·null 처리.
export function fmtValue(v) {
  if (isNil(v)) return '—';
  if (Array.isArray(v)) return v.length ? v.join(' // ') : '—';
  if (typeof v === 'number') return String(v);
  return String(v);
}

// changes JSONB → 표시용 항목 배열. 가격 권한 없으면 해당 항목을 빼고 개수만 남긴다.
//   반환: { parts:[{field,label,from,to}], hidden_price: n }
export function changeParts(changes, canPrice = true) {
  const parts = [];
  let hidden = 0;
  if (!changes || typeof changes !== 'object') return { parts, hidden_price: 0 };
  for (const field of Object.keys(changes)) {
    if (!canPrice && PRICE_FIELDS.has(field)) { hidden += 1; continue; }
    const c = changes[field] || {};
    parts.push({
      field,
      label: FIELD_LABELS[field] || field,
      from: c.from === undefined ? null : c.from,
      to: c.to === undefined ? null : c.to,
    });
  }
  return { parts, hidden_price: hidden };
}

// 한 줄 요약 문장(엑셀 내려받기·좁은 화면·검색 대비). 화면은 parts 로 더 예쁘게 그린다.
export function describeRow({ kind, action, source, changes, reason, canPrice = true }) {
  if (kind === 'status') {
    const head = action === 'activate' ? '판매 재개(활성화)' : '판매 중단(비활성화)';
    return reason ? `${head} — ${reason}` : head;
  }
  const { parts, hidden_price: hidden } = changeParts(changes, canPrice);
  if (action === 'create') {
    const named = parts.filter((p) => !isNil(p.to)).map((p) => p.label);
    const src = SOURCE_LABELS[source] || source || '';
    const tail = named.length ? ` (${named.slice(0, 6).join(', ')}${named.length > 6 ? ` 외 ${named.length - 6}건` : ''})` : '';
    return `제품 신규 등록${src ? ` · ${src}` : ''}${tail}`;
  }
  const seg = parts.map((p) => `${p.label}: ${fmtValue(p.from)} → ${fmtValue(p.to)}`);
  if (hidden) seg.push(`가격 항목 ${hidden}건(열람권한 없음)`);
  return seg.length ? seg.join(' · ') : '변경 내용 없음';
}

// 그 변경 시점의 SYD 코드 — 이 변경이 SyD 를 건드렸으면 「바뀐 뒤」 값을, 아니면 현재 값을.
//   product_change_log 는 scode 스냅샷을 따로 갖지 않으므로(변경된 필드만 기록)
//   건드리지 않은 행은 현재 마스터의 scode 를 보여주는 것이 가장 덜 헷갈린다.
export function sydForRow(changes, currentScode) {
  if (changes && typeof changes === 'object') {
    if (changes.scode && changes.scode.to !== undefined && !isNil(changes.scode.to)) return String(changes.scode.to);
    if (changes._syd && Array.isArray(changes._syd.to) && changes._syd.to.length) return changes._syd.to.join(' // ');
  }
  return currentScode || null;
}

// 재고 원장 부호 — 'in'=+, 'out'=−, 'adjust'=저장된 부호 그대로(stockRoutes.applyMovement 와 동일).
export function signedQty(moveType, qty) {
  const n = Number(qty) || 0;
  if (moveType === 'in') return Math.abs(n);
  if (moveType === 'out') return -Math.abs(n);
  return n;
}

// 변경 시점의 재고 = 현재 재고 − (그 이후 원장 증감 합)
//   원장이 재고의 유일한 변동원이므로(0005 주석) 역산이 성립한다.
export function stockAtChange(currentQty, movesAfter) {
  const delta = (movesAfter || []).reduce((s, m) => s + signedQty(m.move_type, m.qty), 0);
  return Math.round(((Number(currentQty) || 0) - delta) * 1000) / 1000;
}
