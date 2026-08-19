// =====================================================================
// Refatrix ERP · consultAi.js — 「영업 > 고객상담」 AI 파이프라인 순수 함수 모음
//   · 미팅 녹음 → 카테고리 분류 요약 프롬프트/파서
//   · 요약 한국어 번역 프롬프트/파서(원문 불변, 화면 토글용)
//   · 선택한 여러 상담 → 기간 인사이트 프롬프트/파서(카테고리 불릿)
//   네트워크 호출 없음 — consultRoutes.js 가 사용. 전부 단위 테스트 가능.
//
//   ※ 방문(visitAi.js) 계열은 건드리지 않는다. 상담은 별도 저장소·별도 큐.
// =====================================================================

export function clip(s, n) {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// ── 카테고리(고정) — 나중에 구분·정리가 쉽도록 키를 고정한다 ─────────
//   key 는 DB/JSON 에 저장되는 값. ko/es 는 화면·프롬프트 표기용.
export const CONSULT_CATS = [
  { key: 'precio', ko: '가격·견적', es: 'Precio / Cotización' },
  { key: 'producto', ko: '제품·재고', es: 'Producto / Inventario' },
  { key: 'competencia', ko: '경쟁사', es: 'Competencia' },
  { key: 'logistica', ko: '물류·납품', es: 'Logística / Entrega' },
  { key: 'pago', ko: '결제·여신', es: 'Pago / Crédito' },
  { key: 'calidad', ko: '품질·클레임', es: 'Calidad / Reclamo' },
  { key: 'relacion', ko: '관계·기타', es: 'Relación / Otros' },
];
export const CAT_KEYS = CONSULT_CATS.map((c) => c.key);
export const CAT_FALLBACK = 'relacion';

// 느슨한 입력(대문자·한글·스페인어 라벨·유사어)을 고정 키로 정규화. 못 찾으면 '관계·기타'.
const CAT_ALIAS = {
  precio: 'precio', price: 'precio', cotizacion: 'precio', cotización: 'precio', 가격: 'precio', 견적: 'precio',
  producto: 'producto', product: 'producto', inventario: 'producto', stock: 'producto', 제품: 'producto', 재고: 'producto',
  competencia: 'competencia', competidor: 'competencia', competitor: 'competencia', 경쟁: 'competencia', 경쟁사: 'competencia',
  logistica: 'logistica', logística: 'logistica', entrega: 'logistica', envio: 'logistica', envío: 'logistica',
  물류: 'logistica', 납품: 'logistica', 배송: 'logistica',
  pago: 'pago', payment: 'pago', credito: 'pago', crédito: 'pago', cobranza: 'pago', 결제: 'pago', 여신: 'pago', 수금: 'pago',
  calidad: 'calidad', quality: 'calidad', reclamo: 'calidad', queja: 'calidad', garantia: 'calidad', garantía: 'calidad',
  품질: 'calidad', 클레임: 'calidad',
  relacion: 'relacion', relación: 'relacion', otros: 'relacion', otro: 'relacion', other: 'relacion',
  관계: 'relacion', 기타: 'relacion',
};
export function normCat(v) {
  const raw = String(v == null ? '' : v).trim().toLowerCase();
  if (!raw) return CAT_FALLBACK;
  if (CAT_KEYS.includes(raw)) return raw;
  if (CAT_ALIAS[raw]) return CAT_ALIAS[raw];
  // 라벨 일부만 온 경우(예: "Precio / Cotización", "가격·견적")
  for (const k of Object.keys(CAT_ALIAS)) {
    if (raw.includes(k)) return CAT_ALIAS[k];
  }
  return CAT_FALLBACK;
}
export function catLabel(key) {
  const c = CONSULT_CATS.find((x) => x.key === key);
  return c ? c.ko : key;
}

// ── ① 상담 녹음 요약 프롬프트 ────────────────────────────────────────
//   전사문은 대부분 스페인어(멕시코 현장). resumen/insights/bullets 는 대화 언어
//   그대로 두고, 분류 구조(JSON 키 · category 키)는 고정한다.
export function buildConsultSummaryPrompt({ transcript, companyName, contactName, consultDate, placeLabel, mode }) {
  const ctx = [];
  ctx.push(`- 상담일: ${consultDate}`);
  ctx.push(`- 업체명: ${companyName || '미상'}`);
  if (contactName) ctx.push(`- 만난 사람: ${contactName}`);
  if (placeLabel) ctx.push(`- 장소: ${placeLabel}`);
  ctx.push(`- 녹음 종류: ${mode === 'memo' ? '미팅 직후 음성 메모' : '미팅 전체 녹음'}`);
  const cats = CONSULT_CATS.map((c) => `  · ${c.key} = ${c.ko} (${c.es})`).join('\n');
  return [
    '너는 자동차부품 유통회사(멕시코) 고객상담 기록 비서다.',
    '아래는 영업 담당자가 고객과의 상담에서 녹음한 음성의 전사문이다. 내용을 분류해 JSON 하나로만 답하라.',
    '',
    '[상담 정보]',
    ctx.join('\n'),
    '',
    '[전사문]',
    String(transcript || '').trim(),
    '',
    '[카테고리 — 반드시 아래 key 중 하나만 사용]',
    cats,
    '',
    '[출력 규칙]',
    '- 반드시 아래 형태의 JSON 객체 하나만 출력(설명·마크다운 금지):',
    '{"resumen":"무슨 이야기를 했는지 요약(대화 언어 그대로, 5문장 이내)",',
    ' "bullets":[{"category":"위 key 중 하나","text":"핵심 내용 한 줄(대화 언어 그대로)"}],',
    ' "insights":"새로 파악한 내용(고객 상황·경쟁사·재고·불만 등, 없으면 빈 문자열)",',
    ' "action_items":[{"content":"펜딩·후속 조치 한 건(대화 언어 그대로, 구체적으로)","category":"위 key 중 하나","due_date":"YYYY-MM-DD 또는 null"}],',
    ' "products":["언급된 제품 코드/품명(없으면 빈 배열)"],',
    ' "next_step":"다음 상담/연락 계획 한 줄(없으면 빈 문자열)"}',
    '- 전사문에 없는 내용을 지어내지 마라. 불확실하면 비워라.',
    `- 상대 날짜("mañana", "다음 주" 등)는 상담일 ${consultDate} 기준으로 YYYY-MM-DD 로 환산하고, 날짜 언급이 없으면 null.`,
    '- bullets 는 최대 12건, action_items 는 최대 10건. 잡담·인사말은 제외.',
    '- category 는 반드시 위 key 문자열 그대로 쓴다(한글 라벨 금지).',
  ].join('\n');
}

// ── ② Claude 응답 → 요약 객체(방어적 파싱) ───────────────────────────
export function parseConsultSummaryJson(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(raw.slice(start, end + 1)); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;

  const actionItems = [];
  for (const it of (Array.isArray(obj.action_items) ? obj.action_items : []).slice(0, 10)) {
    const content = clip(it && it.content, 300);
    if (!content) continue;
    const due = (it && typeof it.due_date === 'string' && YMD.test(it.due_date)) ? it.due_date : null;
    actionItems.push({ content, category: normCat(it && it.category), due_date: due });
  }
  const bullets = [];
  for (const b of (Array.isArray(obj.bullets) ? obj.bullets : []).slice(0, 12)) {
    const t = clip(typeof b === 'string' ? b : (b && b.text), 300);
    if (!t) continue;
    bullets.push({ category: normCat(typeof b === 'string' ? '' : (b && b.category)), text: t });
  }
  const products = (Array.isArray(obj.products) ? obj.products : [])
    .map((p) => clip(p, 80)).filter(Boolean).slice(0, 30);
  return {
    resumen: clip(obj.resumen, 4000),
    bullets,
    insights: clip(obj.insights, 2000),
    action_items: actionItems,
    products,
    next_step: clip(obj.next_step, 300),
  };
}

// ── ③ 요약 한국어 번역(화면 [🇰🇷 한국어] 토글) ───────────────────────
//   원문(스페인어)은 그대로 두고 summary_json.ko 에만 캐시한다.
export function buildConsultTranslatePrompt(summary) {
  const s = summary || {};
  const src = {
    resumen: String(s.resumen || ''),
    bullets: (s.bullets || []).map((b) => String((b && b.text) || '')),
    insights: String(s.insights || ''),
    action_items: (s.action_items || []).map((a) => String((a && a.content) || '')),
    products: (s.products || []).map((p) => String(p || '')),
    next_step: String(s.next_step || ''),
  };
  return [
    '너는 스페인어→한국어 번역가다. 아래 JSON 값들을 자연스러운 한국어로 번역해 같은 구조의 JSON 하나만 출력하라.',
    '',
    '[번역 규칙]',
    '- 내용을 추가·삭제·요약하지 마라. 문장 수와 정보량을 그대로 유지한다.',
    '- 제품 코드·품번·회사명·사람 이름·지명은 번역하지 말고 원문 그대로 둔다.',
    '- 자동차부품 유통 업무 용어로 자연스럽게(예: cotización=견적, pedido=주문, balatas=브레이크 패드, factura=송장, entrega=납품).',
    '- bullets·action_items 는 문자열 배열이며 순서와 개수를 원문과 똑같이 유지한다.',
    '- 이미 한국어인 값은 그대로 둔다. 빈 문자열은 빈 문자열로.',
    '- 설명·마크다운 없이 JSON 객체 하나만 출력.',
    '',
    '[원문 JSON]',
    JSON.stringify(src),
    '',
    '[출력 형식]',
    '{"resumen":"…","bullets":["…"],"insights":"…","action_items":["…"],"products":["…"],"next_step":"…"}',
  ].join('\n');
}

// Claude 응답 → 한국어 요약 객체. base(원문 요약)로 개수·카테고리·기한을 보정한다.
export function parseConsultTranslationJson(text, base) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(raw.slice(start, end + 1)); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const b = base || {};

  const baseItems = Array.isArray(b.action_items) ? b.action_items : [];
  const tItems = Array.isArray(obj.action_items) ? obj.action_items : [];
  const action_items = baseItems.map((it, i) => {
    const t = tItems[i];
    const content = clip(typeof t === 'string' ? t : (t && t.content), 300) || clip(it && it.content, 300);
    // 카테고리·기한은 항상 원문 값 유지(번역이 바꾸지 못하게)
    return { content, category: normCat(it && it.category), due_date: (it && it.due_date) || null };
  });

  const baseBullets = Array.isArray(b.bullets) ? b.bullets : [];
  const tBullets = Array.isArray(obj.bullets) ? obj.bullets : [];
  const bullets = baseBullets.map((bu, i) => {
    const t = tBullets[i];
    const txt = clip(typeof t === 'string' ? t : (t && t.text), 300) || clip(bu && bu.text, 300);
    return { category: normCat(bu && bu.category), text: txt };
  });

  const baseProducts = Array.isArray(b.products) ? b.products : [];
  const tProducts = (Array.isArray(obj.products) ? obj.products : []).map((p) => clip(p, 80)).filter(Boolean);
  const products = baseProducts.length
    ? baseProducts.map((p, i) => tProducts[i] || clip(p, 80))
    : tProducts.slice(0, 30);

  const ko = {
    resumen: clip(obj.resumen, 4000) || clip(b.resumen, 4000),
    bullets,
    insights: clip(obj.insights, 2000),
    action_items,
    products,
    next_step: clip(obj.next_step, 300),
  };
  if (!ko.resumen && !ko.insights && !ko.action_items.length && !ko.bullets.length && !ko.next_step) return null;
  return ko;
}

// ── ④ 기간 인사이트(선택한 여러 상담을 한 번에) ──────────────────────
//   items = [{ id, date, company, by_name, resumen, insights, bullets:[{category,text}],
//              action_items:[{content,category,due_date}] }]
export function buildInsightPrompt(items, opts = {}) {
  const list = (Array.isArray(items) ? items : []).slice(0, 60);
  const lines = list.map((it, i) => {
    const parts = [`#${i + 1} ${it.date || '?'} · ${it.company || '?'}${it.by_name ? ' · 담당 ' + it.by_name : ''}`];
    if (it.resumen) parts.push(`  요약: ${clip(it.resumen, 700)}`);
    if (it.insights) parts.push(`  파악: ${clip(it.insights, 500)}`);
    for (const b of (it.bullets || []).slice(0, 10)) parts.push(`  [${b.category}] ${clip(b.text, 200)}`);
    for (const a of (it.action_items || []).slice(0, 10)) {
      parts.push(`  (펜딩/${a.category}) ${clip(a.content, 200)}${a.due_date ? ' — ' + a.due_date : ''}`);
    }
    return parts.join('\n');
  }).join('\n\n');
  const cats = CONSULT_CATS.map((c) => `  · ${c.key} = ${c.ko} (${c.es})`).join('\n');
  return [
    '너는 자동차부품 유통회사(멕시코)의 영업 총괄 분석가다.',
    `아래는 ${opts.from || '?'} ~ ${opts.to || '?'} 기간의 고객상담 ${list.length}건 요약이다.`,
    '이 상담들을 관통하는 인사이트를 뽑아 JSON 하나로만 답하라.',
    '',
    '[카테고리 — 반드시 아래 key 중 하나만 사용]',
    cats,
    '',
    '[상담 목록]',
    lines || '(없음)',
    '',
    '[출력 규칙]',
    '- 반드시 아래 형태의 JSON 객체 하나만 출력(설명·마크다운 금지):',
    '{"headline":"기간 전체를 한 줄로",',
    ' "period_bullets":[{"category":"위 key 중 하나","text":"카테고리별 핵심 인사이트 한 줄"}],',
    ' "themes":["여러 상담에서 반복된 주제(빈도·근거 포함, 한 줄씩)"],',
    ' "risks":["놓치면 위험한 것(연체 펜딩·이탈 신호·경쟁사 침투 등, 한 줄씩)"],',
    ' "next_actions":[{"content":"기간 전체 관점의 다음 조치 한 건","category":"위 key 중 하나"}]}',
    '- 위 목록에 없는 내용을 지어내지 마라. 근거가 없으면 넣지 마라.',
    '- 개별 상담 반복 나열 금지 — 여러 건을 묶어 패턴으로 말하라.',
    '- period_bullets 최대 12건 · themes/risks 각 최대 8건 · next_actions 최대 8건.',
    '- 출력 언어는 한국어로 한다(제품 코드·회사명·사람 이름은 원문 유지).',
    '- category 는 반드시 위 key 문자열 그대로 쓴다.',
  ].join('\n');
}

export function parseInsightJson(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(raw.slice(start, end + 1)); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const bul = [];
  for (const b of (Array.isArray(obj.period_bullets) ? obj.period_bullets : []).slice(0, 12)) {
    const t = clip(typeof b === 'string' ? b : (b && b.text), 400);
    if (!t) continue;
    bul.push({ category: normCat(typeof b === 'string' ? '' : (b && b.category)), text: t });
  }
  const strList = (arr, n, len) => (Array.isArray(arr) ? arr : [])
    .map((x) => clip(typeof x === 'string' ? x : (x && x.text), len)).filter(Boolean).slice(0, n);
  const next = [];
  for (const a of (Array.isArray(obj.next_actions) ? obj.next_actions : []).slice(0, 8)) {
    const c = clip(typeof a === 'string' ? a : (a && a.content), 300);
    if (!c) continue;
    next.push({ content: c, category: normCat(typeof a === 'string' ? '' : (a && a.category)) });
  }
  const out = {
    headline: clip(obj.headline, 400),
    period_bullets: bul,
    themes: strList(obj.themes, 8, 400),
    risks: strList(obj.risks, 8, 400),
    next_actions: next,
  };
  if (!out.headline && !out.period_bullets.length && !out.themes.length && !out.risks.length && !out.next_actions.length) return null;
  return out;
}

// 선택 지문 — 같은 상담 묶음이면 같은 키(캐시 적중). 순서·중복에 영향받지 않는다.
export function scopeKeyOf(ids) {
  const uniq = Array.from(new Set((Array.isArray(ids) ? ids : []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)));
  uniq.sort((a, b) => a - b);
  return 'c:' + uniq.join(',');
}

// 여러 상담의 펜딩·불릿을 카테고리별로 묶는다(화면 표 옆 「카테고리별 정리」용).
export function groupByCategory(items) {
  const out = {};
  for (const k of CAT_KEYS) out[k] = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    const k = normCat(it && it.category);
    (out[k] ||= []).push(it);
  }
  return out;
}
