// =====================================================================
// Refatrix ERP · prospectCore.js — 「영업 > 고객개발」 순수 함수 모음 (2026-11-25)
//   · 단계 규칙 · DENUE 행 정규화(세그먼트·우선순위) · 지역 판정 · 거리 · 방문 순서
//   · 기존 고객 매칭 점수 · Alta de clientes AI 추출 프롬프트/파서 · 초안 병합 · KPI 계산
//   네트워크·DB 호출 없음 → 전부 단위 테스트 가능 (test/prospects.test.mjs)
// =====================================================================
import { ALTA_FORM, ALTA_FIELDS, ALTA_FIELD_MAP } from './altaClientesForm.js';

// ── 단계 ─────────────────────────────────────────────────────────────
export const STAGES = [
  { key: 'sin_asignar', ko: '미배정', es: 'Sin asignar' },
  { key: 'asignado', ko: '배정', es: 'Asignado' },
  { key: 'contactado', ko: '컨택', es: 'Contactado' },
  { key: 'interesado', ko: '관심', es: 'Interesado' },
  { key: 'cotizado', ko: '견적', es: 'Cotizado' },
  { key: 'registro', ko: '고객등록 중', es: 'Registro en trámite' },
  { key: 'cliente_activo', ko: '신규고객', es: 'Cliente activo' },
  { key: 'descartado', ko: '중단', es: 'Descartado' },
];
export const STAGE_KEYS = STAGES.map((s) => s.key);
const RANK = Object.fromEntries(STAGE_KEYS.map((k, i) => [k, i]));
export function stageRank(k) { return RANK[k] == null ? -1 : RANK[k]; }

export const DISCARD_REASONS = [
  'Cerrado / no localizado', 'No es del giro', 'Ya es cliente', 'Precio o condiciones', 'Sin interés', 'Otro',
];

// 단계 이동 가능 여부 — 앞으로만(담당자), 되돌리기·중단 복구는 디렉터만. 중단은 사유 필수.
export function checkStageMove(from, to, { isDirector = false, reason = '' } = {}) {
  if (!STAGE_KEYS.includes(to)) return { ok: false, error: 'bad_stage' };
  if (from === to) return { ok: false, error: 'same_stage' };
  if (to === 'descartado') {
    if (!String(reason || '').trim()) return { ok: false, error: 'reason_required' };
    return { ok: true };
  }
  if (from === 'descartado' && !isDirector) return { ok: false, error: 'director_only' };
  if (to === 'sin_asignar' && !isDirector) return { ok: false, error: 'director_only' };
  if (to === 'cliente_activo' && !isDirector) return { ok: false, error: 'auto_only' };   // 고객 승인+첫 인보이스로만
  if (stageRank(to) < stageRank(from) && from !== 'descartado' && !isDirector) return { ok: false, error: 'no_backward' };
  return { ok: true };
}

// 자동 전환: 지금보다 앞 단계일 때만 올린다(중단·신규고객은 건드리지 않음)
export function autoAdvance(current, target) {
  if (current === 'descartado' || current === 'cliente_activo') return null;
  return stageRank(target) > stageRank(current) ? target : null;
}

// ── DENUE 정규화 ───────────────────────────────────────────────────────
export const SCIAN_SEGMENT = {
  '436112': 'mayorista', '468211': 'refaccionaria', '468212': 'refaccionaria_usada',
  '811115': 'taller_suspension', '811116': 'taller_suspension',
  '811111': 'taller_general', '811112': 'taller_general', '811113': 'taller_general',
  '811114': 'taller_general', '811119': 'taller_general',
};
export const SEGMENTS = ['mayorista', 'refaccionaria', 'refaccionaria_usada', 'taller_suspension', 'taller_general', 'otro'];
export function segmentOf(scian) { return SCIAN_SEGMENT[String(scian || '').trim()] || 'otro'; }

// 우선순위 초기값(디렉터 조정 가능): A = 도매·신품 부품상·서스펜션 정비 / B = 일반정비 6명 이상 / C = 나머지
export function priorityOf(scian, perOcu) {
  const s = segmentOf(scian);
  if (s === 'mayorista' || s === 'refaccionaria' || s === 'taller_suspension') return 'A';
  if (s === 'taller_general' && perOcu && !/^0 a 5/i.test(String(perOcu))) return 'B';
  return 'C';
}

const t = (v, n = 300) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, n) : null; };
const num = (v) => { if (v == null || String(v).trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

// 가져오기 CSV 한 행(prospects_import_NL.csv 형식 또는 DENUE 원본 컬럼) → prospects 행
export function normalizeImportRow(r) {
  if (!r || typeof r !== 'object') return { error: 'empty' };
  const g = (...keys) => { for (const k of keys) if (r[k] != null && String(r[k]).trim() !== '') return r[k]; return null; };
  const denueId = t(g('denue_id', 'id'), 40);
  const name = t(g('nom_estab', 'nombre'), 200) || t(g('raz_social'), 200);
  const scian = t(g('scian_code', 'codigo_act'), 10);
  const lat = num(g('lat', 'latitud')); const lng = num(g('lng', 'longitud'));
  if (!denueId) return { error: 'no_denue_id' };
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { error: 'bad_geo', denue_id: denueId };
  const perOcu = t(g('per_ocu'), 40);
  let address = t(g('address'), 300);
  if (!address) {
    address = [g('tipo_vial'), g('nom_vial'), g('numero_ext'), g('letra_ext')].filter(Boolean).join(' ').trim() || null;
    if (address && g('numero_int')) address += ' int. ' + g('numero_int');
  }
  return {
    // DENUE 에 상호·법인명이 둘 다 비어 있는 곳도 실제 가게 → 「(Sin nombre)」 로 넣고 현장에서 채운다
    denue_id: denueId, clee: t(g('clee'), 40),
    nom_estab: name || `(Sin nombre) ${t(g('nombre_act'), 60) || scian || ''} · ${t(g('colonia', 'nomb_asent'), 60) || ''}`.trim(), raz_social: t(g('raz_social'), 200),
    scian_code: scian, segment: SEGMENTS.includes(g('segment')) ? g('segment') : segmentOf(scian),
    priority: ['A', 'B', 'C'].includes(g('priority')) ? g('priority') : priorityOf(scian, perOcu),
    per_ocu: perOcu, address, colonia: t(g('colonia', 'nomb_asent'), 150), cp: t(g('cp', 'cod_postal'), 10),
    cve_ent: t(g('cve_ent'), 4) || (String(g('clee') || '').slice(0, 2) || null),
    entidad: t(g('entidad'), 80), cve_mun: t(g('cve_mun'), 6), municipio: t(g('municipio'), 120),
    localidad: t(g('localidad'), 120), lat, lng, phone: t(g('phone', 'telefono'), 40),
    email: t(g('email', 'correoelec'), 150), web: t(g('web', 'www'), 200),
    denue_fecha_alta: t(g('denue_fecha_alta', 'fecha_alta'), 10),
  };
}

// 간단한 CSV 파서(따옴표·줄바꿈·BOM) → 헤더 기준 객체 배열
export function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cur); cur = ''; if (row.some((x) => x !== '')) rows.push(row); row = [];
    } else cur += c;
  }
  row.push(cur); if (row.some((x) => x !== '')) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] == null ? '' : r[i]])));
}

// ── 지역 판정 · 거리 · 순서 ─────────────────────────────────────────────
export function normTxt(v) {
  return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
// 후보가 속하는 지역(같은 주 + CP 우선 → municipio). 여러 개면 첫 번째(id 순).
export function territoryFor(p, territories) {
  const list = (territories || []).filter((x) => x.active !== false && String(x.cve_ent) === String(p.cve_ent));
  const cp = String(p.cp || '').trim();
  const byCp = list.find((x) => cp && (x.cps || []).map(String).includes(cp));
  if (byCp) return byCp;
  const m = normTxt(p.municipio);
  return list.find((x) => (!x.cps || !x.cps.length) && (x.municipios || []).some((y) => normTxt(y) === m)) || null;
}

export function distanceM(aLat, aLng, bLat, bLng) {
  if ([aLat, aLng, bLat, bLng].some((v) => v == null || !Number.isFinite(Number(v)))) return null;
  const R = 6371000, r = (d) => (Number(d) * Math.PI) / 180;
  const dLat = r(bLat - aLat), dLng = r(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
export const CHECKIN_WARN_M = 150;

// 최근접 이웃으로 방문 순서 정하기(출발점 없으면 첫 번째부터)
export function orderStops(stops, start = null) {
  const left = (stops || []).filter((s) => s && s.lat != null && s.lng != null).slice();
  const noGeo = (stops || []).filter((s) => s && (s.lat == null || s.lng == null));
  const out = [];
  let cur = start && start.lat != null ? start : left.shift();
  if (cur && !start) out.push(cur);
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((s, i) => { const d = distanceM(cur.lat, cur.lng, s.lat, s.lng); if (d < bd) { bd = d; bi = i; } });
    cur = left.splice(bi, 1)[0]; out.push(cur);
  }
  return out.concat(noGeo);
}

// ── 기존 고객 매칭 ─────────────────────────────────────────────────────
const STOP = new Set(['sa', 'de', 'cv', 'rl', 's', 'a', 'c', 'v', 'y', 'la', 'el', 'los', 'las', 'del', 'refaccionaria', 'refacciones', 'taller', 'automotriz', 'servicio', 'centro', 'hnos', 'hermanos', 'cia']);
function tokens(v) { return new Set(normTxt(String(v || '').replace(/\./g, '')).split(' ').filter((w) => w.length > 1 && !STOP.has(w))); }
export function nameSimilarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; A.forEach((w) => { if (B.has(w)) inter++; });
  return inter / (A.size + B.size - inter);
}
export function phoneKey(v) { const d = String(v || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; }
export function rfcKey(v) { const s = String(v || '').toUpperCase().replace(/[^A-ZÑ&0-9]/g, ''); return s.length >= 12 ? s : null; }

// 점수 0~100 + 이유. RFC 일치 = 100. 전화 일치 +45, 이름 유사도 최대 +45, 200m 이내 +15.
export function matchScore(p, c) {
  const reasons = [];
  if (rfcKey(p.rfc) && rfcKey(p.rfc) === rfcKey(c.rfc)) return { score: 100, reasons: ['rfc'] };
  let score = 0;
  const pk = phoneKey(p.phone);
  if (pk && [c.phone, c.buyer_phone].map(phoneKey).includes(pk)) { score += 45; reasons.push('telefono'); }
  const sim = Math.max(nameSimilarity(p.nom_estab, c.name), nameSimilarity(p.raz_social, c.name));
  if (sim > 0) { score += Math.round(sim * 45); if (sim >= 0.5) reasons.push('nombre'); }
  const d = distanceM(p.lat, p.lng, c.lat, c.lng);
  if (d != null && d <= 200) { score += 15; reasons.push('ubicacion'); }
  return { score: Math.min(99, score), reasons };
}
export function suggestCustomers(p, customers, { min = 22, limit = 5 } = {}) {
  return (customers || []).map((c) => ({ ...matchScore(p, c), customer_id: Number(c.id), name: c.name, code: c.code || null }))
    .filter((x) => x.score >= min).sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── Alta de clientes: 미리 채움(DENUE) ─────────────────────────────────
export function prefillFromProspect(p) {
  const v = {};
  const set = (k, val) => { if (val != null && String(val).trim() !== '') v[k] = val; };
  set('datos_generales.nombre_cuenta', p.nom_estab);
  const addr = String(p.address || '');
  const m = addr.match(/^(.*?)(?:\s+(\d+(?:\s?[A-Z])?(?:\s+int\.\s*\S+)?|SN))?$/i);
  set('datos_generales.calle', m ? m[1] : addr);
  set('datos_generales.numero', m && m[2] ? m[2] : null);
  set('datos_generales.colonia', p.colonia);
  set('datos_generales.codigo_postal', p.cp);
  set('datos_generales.ciudad', p.municipio);
  set('datos_generales.estado', p.entidad);
  set('datos_generales.telefono', p.phone);
  set('datos_generales.correo', p.email);
  const segTipo = { mayorista: ['Mayorista'], refaccionaria: ['Refaccionaria'], refaccionaria_usada: ['Refaccionaria'],
    taller_suspension: ['Reparación General'], taller_general: ['Reparación General'] }[p.segment];
  if (segTipo) set('tipo_taller.tipo_taller', segTipo);
  if (p.segment === 'taller_suspension') set('servicios.servicios', ['Chasis y Suspensión']);
  return v;
}

// ── Alta de clientes: AI 추출 프롬프트 ─────────────────────────────────
export function iaFields() {
  return ALTA_FIELDS.filter((f) => (f.fill || []).includes('ia'));
}
export { ALTA_FORM };
export function buildAltaPrompt({ transcript, companyName, prefill = {}, summaryText = '' }) {
  const lines = [];
  const seen = new Set();
  for (const f of iaFields()) {
    const k = f.group ? `competencia.N.${f.base}` : f.key;
    if (seen.has(k)) continue; seen.add(k);
    let ty = f.type;
    if (f.options) ty += ' — opciones: ' + f.options.join(' | ');
    lines.push(`- ${k} (${f.label_es}) : ${ty}`);
  }
  const pre = Object.entries(prefill).map(([k, v]) => `- ${k} = ${Array.isArray(v) ? v.join(', ') : v}`).join('\n') || '- (ninguno)';
  return [
    'Eres asistente de una distribuidora de autopartes en México (marca CTR: suspensión y dirección).',
    'Abajo está la transcripción de una visita de un vendedor a un prospecto. Llena el formato «Alta de clientes».',
    '',
    'REGLAS',
    '1. Usa SOLO lo que se dijo en la conversación. Si un dato no se mencionó, pon null. Nunca inventes ni supongas.',
    '2. Para cada campo devuelve {"valor": …, "evidencia": "frase breve de la conversación", "confianza": "alta|media|baja"}.',
    '3. multiselect = arreglo con valores EXACTOS de las opciones. boolean = true/false. integer/money = número sin símbolos (MXN).',
    '4. time = "HH:MM" 24h. Si el dato dicho contradice el dato precargado, devuelve lo dicho con confianza "media".',
    '5. competencia = hasta 3 marcas/proveedores que el cliente compra hoy, con un producto ejemplo y precios si se dijeron.',
    '6. potencial.* = montos MENSUALES en MXN que dijo el cliente. Si los dijo por semana multiplica por 4.3; si por año divide entre 12. Si no los dijo, null.',
    '7. tamano_cliente = tiendas/sucursales, almacenes, personal, vendedores, cómo entrega (opciones) y unidades de reparto, solo si se mencionaron.',
    '8. Responde SOLO con un objeto JSON, sin texto antes ni después.',
    '',
    `[Prospecto] ${companyName || 'desconocido'}`,
    '[Datos precargados de DENUE]', pre,
    summaryText ? `[Resumen ya generado de la visita]\n${String(summaryText).slice(0, 2000)}` : '',
    '',
    '[Campos que puedes llenar]', lines.join('\n'),
    '',
    'FORMATO DE RESPUESTA',
    '{"resumen":"3-6 oraciones en español","campos":{"datos_generales.contacto_principal":{"valor":null,"evidencia":null,"confianza":"baja"}},',
    ' "competencia":[{"marca":null,"proveedor":null,"producto_ejemplo":null,"precio_compra":null,"precio_venta_publico":null,"evidencia":null}],',
    ' "siguiente_paso":null,"fecha_siguiente_paso":null,"etapa_sugerida":"contactado|interesado|cotizado|descartado|null"}',
    '',
    '[Transcripción]',
    String(transcript || '').slice(0, 60000),
  ].filter((x) => x !== '').join('\n');
}

function extractJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}
const CONF = ['alta', 'media', 'baja'];
// 형식(type)에 맞게 값 보정. 못 맞추면 null(=AI 가 못 채운 것으로 본다)
export function coerceValue(f, v) {
  if (v == null || v === '') return null;
  switch (f.type) {
    case 'integer': { const n = Number(String(v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? Math.round(n) : null; }
    case 'money': { const n = Number(String(v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; }
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      const s = normTxt(v); if (['si', 'yes', 'true', '1'].includes(s)) return true; if (['no', 'false', '0'].includes(s)) return false; return null;
    }
    case 'multiselect': {
      const arr = Array.isArray(v) ? v : String(v).split(/[,;|]/);
      const opts = f.options || [];
      const out = [];
      for (const x of arr) { const hit = opts.find((o) => normTxt(o) === normTxt(x)); if (hit && !out.includes(hit)) out.push(hit); }
      return out.length ? out : null;
    }
    case 'time': { const m = String(v).match(/(\d{1,2})[:.h](\d{2})/); if (!m) return null; const h = +m[1], mi = +m[2]; return h < 24 && mi < 60 ? `${String(h).padStart(2, '0')}:${m[2]}` : null; }
    case 'email': { const s = String(v).trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null; }
    case 'phone': { const d = String(v).replace(/\D/g, ''); return d.length >= 8 ? d : null; }
    default: { const s = String(v).trim(); if (!s) return null; if (f.pattern && !new RegExp(f.pattern).test(s.toUpperCase())) return null; return s.slice(0, 300); }
  }
}

// AI 응답 → { resumen, campos:{key:{valor,evidencia,confianza}}, siguiente_paso, fecha_siguiente_paso, etapa_sugerida }
//   · 양식에 없는 키, ia 가 채울 수 없는 키(manual 전용 · RFC 제외)는 버린다
//   · competencia 배열은 competencia.<n>.<항목> 키로 펼친다
export function parseAltaDraft(text) {
  const j = extractJson(text);
  if (!j || typeof j !== 'object') return null;
  const campos = {};
  const put = (key, raw) => {
    const f = ALTA_FIELD_MAP[key];
    if (!f || !(f.fill || []).includes('ia') || !raw) return;
    const cell = typeof raw === 'object' && !Array.isArray(raw) ? raw : { valor: raw };
    const valor = coerceValue(f, cell.valor);
    if (valor == null) return;
    campos[key] = { valor, evidencia: cell.evidencia ? String(cell.evidencia).slice(0, 300) : null,
      confianza: CONF.includes(cell.confianza) ? cell.confianza : 'media' };
  };
  for (const [k, v] of Object.entries(j.campos || {})) put(k, v);
  (Array.isArray(j.competencia) ? j.competencia : []).slice(0, 3).forEach((c, i) => {
    if (!c || typeof c !== 'object') return;
    for (const base of ['marca', 'proveedor', 'producto_ejemplo', 'precio_compra', 'precio_venta_publico']) {
      if (c[base] != null) put(`competencia.${i + 1}.${base}`, { valor: c[base], evidencia: c.evidencia, confianza: c.confianza || 'media' });
    }
  });
  const okStage = ['contactado', 'interesado', 'cotizado', 'descartado'];
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(j.fecha_siguiente_paso || '')) ? j.fecha_siguiente_paso : null;
  return {
    resumen: j.resumen ? String(j.resumen).slice(0, 2000) : null,
    campos,
    siguiente_paso: j.siguiente_paso ? String(j.siguiente_paso).slice(0, 300) : null,
    fecha_siguiente_paso: fecha,
    etapa_sugerida: okStage.includes(j.etapa_sugerida) ? j.etapa_sugerida : null,
  };
}

// 검토 화면용 병합: 항목마다 { value, source, evidence, confidence, saved }
//   우선순위: AI 초안(이번 방문) > 이미 확정·저장된 값 > DENUE 미리 채움
export function mergeForReview({ prefill = {}, saved = {}, draft = null }) {
  const out = {};
  for (const f of ALTA_FIELDS) {
    const d = draft && draft.campos && draft.campos[f.key];
    const sv = saved[f.key];
    if (d) out[f.key] = { value: d.valor, source: 'ia', evidence: d.evidencia, confidence: d.confianza, saved: sv == null ? null : sv };
    else if (sv != null) out[f.key] = { value: sv, source: 'guardado', saved: sv };
    else if (prefill[f.key] != null) out[f.key] = { value: prefill[f.key], source: 'denue' };
    else out[f.key] = { value: null, source: null };
  }
  return out;
}

// 저장 전 검증 — 양식에 없는 키는 버리고, 형식이 틀린 값은 errors 로(필수 누락은 missingRequired)
export function validateAltaValues(values) {
  const clean = {}; const errors = [];
  for (const [k, raw] of Object.entries(values || {})) {
    const f = ALTA_FIELD_MAP[k];
    if (!f) continue;
    if (raw == null || raw === '' || (Array.isArray(raw) && !raw.length)) { clean[k] = null; continue; }
    const v = coerceValue(f, raw);
    if (v == null) errors.push({ key: k, error: 'formato' }); else clean[k] = v;
  }
  return { clean, errors };
}
// 확정 저장 때 비어 있으면 안 되는 항목(청구 섹션 제외 — 고객 등록 때 입력)
export function missingRequired(allValues) {
  return ALTA_FIELDS.filter((f) => f.required && f.section !== 'facturacion' && (allValues[f.key] == null || (Array.isArray(allValues[f.key]) && !allValues[f.key].length)))
    .map((f) => f.key);
}

// ── KPI ──────────────────────────────────────────────────────────────
export const METRICS = ['visitas', 'contactados', 'cotizaciones', 'nuevos_clientes', 'venta_nuevos'];
export function pct(actual, target) { const a = Number(actual) || 0, t2 = Number(target) || 0; return t2 > 0 ? Math.round((a / t2) * 1000) / 10 : null; }
// 월중에는 경과일 비례로 판정: ≥100% 초록, 70~99% 노랑, <70% 빨강
export function paceStatus(actual, target, day, daysInMonth) {
  const t2 = Number(target) || 0; if (t2 <= 0) return null;
  const expected = t2 * Math.min(1, Math.max(0, day) / Math.max(1, daysInMonth));
  const r = expected > 0 ? (Number(actual) || 0) / expected : 1;
  return r >= 1 ? 'ok' : r >= 0.7 ? 'warn' : 'bad';
}
export function periodBounds(period) {
  if (!/^\d{4}-\d{2}$/.test(String(period))) return null;
  const [y, m] = period.split('-').map(Number);
  const from = `${period}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { from, to: next, days: new Date(Date.UTC(y, m, 0)).getUTCDate() };
}

// ── 잠재성(월 서스펜션 구매액 기준) ─────────────────────────────────────
//   기준값은 디렉터가 바꿀 수 있게 상수로 둔다(MXN, IVA 제외, 월).
export const POTENTIAL_TIERS = [{ tier: 'A', min: 50000 }, { tier: 'B', min: 15000 }, { tier: 'C', min: 0 }];
const n0 = (v) => { const x = Number(v); return v == null || v === '' || !Number.isFinite(x) ? null : x; };
export function potentialOf(values = {}) {
  const ventaTotal = n0(values['potencial.venta_total_mensual']);
  const ventaSusp = n0(values['potencial.venta_suspension_mensual']);
  const compraTotal = n0(values['potencial.compra_total_mensual']);
  const compraSusp = n0(values['potencial.compra_suspension_mensual']);
  const tier = compraSusp == null ? null : POTENTIAL_TIERS.find((t) => compraSusp >= t.min).tier;
  return {
    venta_total: ventaTotal, venta_susp: ventaSusp, compra_total: compraTotal, compra_susp: compraSusp,
    share_susp_compra: compraTotal && compraSusp != null ? Math.round((compraSusp / compraTotal) * 1000) / 10 : null,
    share_susp_venta: ventaTotal && ventaSusp != null ? Math.round((ventaSusp / ventaTotal) * 1000) / 10 : null,
    tier,
  };
}
