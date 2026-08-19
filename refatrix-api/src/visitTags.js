// 방문·상담 카테고리 자동 태깅 (순수 함수 — DB/네트워크 무관)
//
// 방문 기록에는 「목적」 컬럼이 없다(0137). 대신 대화노트(talk_note)·파악내용(insight_note)·
// AI 요약(resumen/insights/next_step/products)의 텍스트에서 키워드를 뽑아 카테고리 단어를 만든다.
//   · 현장 전사문·요약은 스페인어, 수기 입력은 한국어/스페인어 혼용 → 두 언어 키워드를 모두 등록.
//   · 마이그레이션이 필요 없고 과거 방문 기록에도 즉시 적용된다.
//
// 새 카테고리를 추가하려면 TAG_DEFS 에 { key, label, color, words[] } 한 줄만 넣으면 된다.

// 소문자화 + 발음기호 제거(cotización → cotizacion) + 공백 정규화
export function normText(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// 카테고리 정의 — 표시 순서 = 배열 순서
export const TAG_DEFS = [
  { key: 'quote', label: '견적·가격', color: '#0f6b53', words: [
    'cotiza', 'cotizacion', 'presupuesto', 'precio', 'precios', 'lista de precios',
    'descuento', 'oferta', 'promocion de precio', 'costo',
    '견적', '가격', '단가', '할인', '가격표', '오퍼',
  ] },
  { key: 'order', label: '주문·수주', color: '#1d6fa5', words: [
    'pedido', 'pedidos', 'orden de compra', 'ordenes de compra', 'comprar', 'compra',
    'oc', 'po', 'levantar el pedido', 'surtir',
    '주문', '발주', '수주', '오더',
  ] },
  { key: 'newprod', label: '신제품·개발', color: '#7a4bbd', words: [
    'nuevo producto', 'nuevos productos', 'producto nuevo', 'desarrollo', 'desarrollar',
    'no manejamos', 'no tenemos ese', 'codigo nuevo', 'nueva aplicacion', 'lanzamiento',
    '신제품', '개발', '신규코드', '신규 코드', '개발요청', '신규품목',
  ] },
  { key: 'claim', label: '클레임·품질', color: '#c0392b', words: [
    'queja', 'quejas', 'reclamo', 'reclamacion', 'defecto', 'defectuoso', 'garantia',
    'devolucion', 'devoluciones', 'calidad', 'falla', 'fallas', 'ruido', 'desgaste prematuro',
    '클레임', '불량', '반품', '품질', '하자', '컴플레인',
  ] },
  { key: 'delivery', label: '납기·물류', color: '#b8860b', words: [
    'entrega', 'entregas', 'envio', 'envios', 'flete', 'paqueteria', 'retraso', 'retrasos',
    'tiempo de entrega', 'embarque', 'transporte', 'llego tarde',
    '납기', '배송', '물류', '출고', '지연', '운송',
  ] },
  { key: 'stock', label: '재고', color: '#2c7a7b', words: [
    'inventario', 'existencia', 'existencias', 'stock', 'faltante', 'faltantes',
    'agotado', 'sin existencia', 'back order', 'backorder',
    '재고', '결품', '부족분', '품절',
  ] },
  { key: 'payment', label: '수금·결제', color: '#a35400', words: [
    'pago', 'pagos', 'cobranza', 'cobrar', 'factura', 'facturas', 'facturacion',
    'credito', 'saldo', 'adeudo', 'vencido', 'vencida', 'transferencia', 'anticipo',
    '수금', '결제', '미수', '외상', '인보이스', '입금', '여신',
  ] },
  { key: 'competitor', label: '경쟁사', color: '#8e44ad', words: [
    'competencia', 'competidor', 'otra marca', 'otras marcas', 'la marca que maneja',
    'syd', 'trw', 'brembo', 'fritec', 'grc', 'raybestos', 'bosch',
    '경쟁사', '타사', '경쟁',
  ] },
  { key: 'newcust', label: '신규개척', color: '#16a085', words: [
    'nuevo cliente', 'primera visita', 'primer contacto', 'prospecto', 'prospeccion',
    'presentacion de la empresa', 'nos presentamos', 'abrir cuenta', 'alta de cliente',
    '신규개척', '신규 고객', '신규고객', '첫 방문', '첫방문', '신규거래',
  ] },
  { key: 'promo', label: '판촉·샘플', color: '#c2185b', words: [
    'promocion', 'publicidad', 'catalogo', 'catalogos', 'lona', 'exhibidor', 'muestra',
    'muestras', 'demostracion', 'capacitacion', 'curso', 'letrero', 'playera',
    '프로모션', '홍보', '카탈로그', '샘플', '판촉', '교육', '시연',
  ] },
  { key: 'relation', label: '관계·인사', color: '#607d8b', words: [
    'visita de cortesia', 'saludo', 'saludar', 'agradecer', 'felicitar', 'comida',
    '인사', '안부', '관계', '식사',
  ] },
];

export const TAG_LABEL = TAG_DEFS.reduce((m, t) => { m[t.key] = t.label; return m; }, {});

// 표에 한 줄로 보여줄 최대 태그 수(표시 전용 — 통계는 전체 태그를 쓴다)
export const TAG_MAX = 4;

// 스페인어 복수형 허용 최소 길이. 'oc'(orden de compra) 같은 2~3글자 약어에
// 's' 를 붙이면 'pos'(=pues) 처럼 엉뚱하게 걸리므로 4글자 이상만 확장한다.
const PLURAL_MIN = 4;

// 낱말 매칭 규칙(정규식은 모듈 로드 시 1회만 컴파일 — 방문 300건 x 키워드 140개 대비)
//   · 한글 등 비라틴 → 부분일치
//   · 라틴 낱말 → 낱말 경계 + 스페인어 복수형(-s/-es) 허용
//     예) cotizacion → cotizaciones · costo → costos · descuento → descuentos
function compileWord(word) {
  const w = normText(word).trim();
  if (!w) return null;
  if (/[^\u0020-\u024F]/.test(w)) return { plain: w };              // 한글 등
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tail = w.length >= PLURAL_MIN ? '(?:es|s)?' : '';
  return { re: new RegExp(`(^|[^a-z0-9])${esc}${tail}([^a-z0-9]|$)`) };
}

// TAG_DEFS 를 컴파일된 매처로 1회 변환(요청마다 RegExp 를 새로 만들지 않는다)
const COMPILED = TAG_DEFS.map((def) => ({
  key: def.key,
  matchers: def.words.map(compileWord).filter(Boolean),
}));

function matches(hay, m) { return m.plain ? hay.includes(m.plain) : m.re.test(hay); }

// 단일 낱말 검사(테스트·디버깅용)
export function hasWord(hay, word) {
  const m = compileWord(word);
  return m ? matches(normText(hay), m) : false;
}

// 텍스트 → 카테고리 key 배열(TAG_DEFS 순서, 매칭된 것 전부)
//   ※ 여기서 자르지 않는다 — 자르면 고객 카테고리 통계가 앞쪽 정의로 편향된다.
//     표시 개수 제한은 화면 직전(tag_chips)에서 TAG_MAX 로 건다.
export function tagsFromText(text) {
  const hay = normText(text);
  if (!hay.trim()) return [];
  const out = [];
  for (const def of COMPILED) {
    if (def.matchers.some((m) => matches(hay, m))) out.push(def.key);
  }
  return out;
}

// 방문 1건(노트 + AI 요약 + 펜딩)의 모든 텍스트를 모아 태깅
//   visit: { talk_note, insight_note, met_person? }
//   summary: parseSummaryJson 결과(스페인어 원문) 또는 null
//   pendings: [{content}]
export function visitTags(visit, summary, pendings) {
  const parts = [];
  const v = visit || {};
  if (v.talk_note) parts.push(v.talk_note);
  if (v.insight_note) parts.push(v.insight_note);
  const s = summary || null;
  if (s) {
    if (s.resumen) parts.push(s.resumen);
    if (s.insights) parts.push(s.insights);
    if (s.next_step) parts.push(s.next_step);
    if (Array.isArray(s.action_items)) for (const it of s.action_items) if (it && it.content) parts.push(it.content);
    if (Array.isArray(s.products) && s.products.length) parts.push(s.products.join(' '));
  }
  for (const p of (pendings || [])) if (p && p.content) parts.push(p.content);
  return tagsFromText(parts.join(' \n '));
}

// 화면 표시용 {key,label,color} 배열
export function tagChips(keys) {
  const byKey = TAG_DEFS.reduce((m, t) => { m[t.key] = t; return m; }, {});
  return (keys || []).map((k) => byKey[k]).filter(Boolean)
    .map((t) => ({ key: t.key, label: t.label, color: t.color }));
}
