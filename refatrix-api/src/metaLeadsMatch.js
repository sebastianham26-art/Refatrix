// =====================================================================
// Refatrix ERP · metaLeadsMatch.js — Meta 광고 문의 → CTR 부품번호 × 수량 (0272 · 2026-10-13 디렉터 지시)
//
//   「AI 를 돌려서라도 차종별 판매기회에서 부품번호를 특정해 — 최종적으로 수요품목을 수량과 함께 알도록」
//
//   1) 문의의 수요 줄(차종 · 연식 · 부품 · 수량) — 사람이 고친 차종/부품 > AI(ai_demand) > 규칙(a_*)
//   2) 후보: 카탈로그 적용차종 product_applications(모델 단어 일치 · 연식 범위) ∩ 제품명 부품 종류(PART_RULES)
//   3) 결정
//      · 같은 부품 · 같은 위치 · 같은 쪽에 코드가 하나씩만 → 규칙으로 확정(좌우 둘이면 둘 다)
//      · 여럿(연식 없음 · 세대/버전 · 상하 불명) → AI 가 대화 + 후보 목록을 읽고 고름(AI 없으면 「후보」로 남김)
//      · 후보 0 → 「카탈로그 없음」(개발 필요) · 차종 미상 → 「차종 미상」
//   4) 수량: 고객이 말한 수(par = 2, 좌우면 쪽당 1) · 안 말했으면 1(qty_src='supuesto')
//   지문(items_hash) = 수요 + 후보 코드 (+ AI 를 썼으면 대화 지문 · AI 준비 여부) — 같으면 건너뜀.
// =====================================================================
import crypto from 'node:crypto';
import { query } from './db.js';
import { aiReady, aiModel, callClaude, conversationText, convHash, parseAiJson, setAfterAnalyze } from './metaLeadsAi.js';

export const N = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

// 부품 종류 — AI 부품명(PARTES) ↔ 제품명(DESCRIPCIÓN) 정규식. 위에서부터 첫 일치.
export const PART_RULES = [
  { p: 'Horquilla (brazo de control)', key: /HORQUILLA|ORQUILLA|BRAZO DE CONTROL|BRAZO (INFERIOR|SUPERIOR)|CONTROL ARM/, re: /HORQUILLA|BRAZO (DE )?CONTROL|BRAZO (INFERIOR|SUPERIOR)/, not: /AUXILIAR|PITMAN|BUJE/ },
  { p: 'Rótula', key: /ROTULA/, re: /ROTULA/ },
  { p: 'Terminal exterior', key: /TERMINAL.*EXT/, re: /TERMINAL.*EXT/ },
  { p: 'Terminal interior', key: /TERMINAL.*INT|AXIAL/, re: /TERMINAL.*INT|AXIAL|BIELETA DE DIRECCION/ },
  { p: 'Terminal', key: /^TERMINAL/, re: /TERMINAL|BIELETA DE DIRECCION/ },
  { p: 'Bieleta / tornillo estabilizador', key: /BIELETA|TORNILLO|LINK/, re: /TORNILLO.*ESTAB|BIELETA|LINK/, not: /DIRECCION/ },
  { p: 'Barra estabilizadora', key: /BARRA ESTAB/, re: /BARRA ESTAB/ },
  { p: 'Base de amortiguador', key: /BASE.*AMORT|SOPORTE.*AMORT|CAZOLETA/, re: /(BASE|SOPORTE).*AMORT|CAZOLETA/ },
  { p: 'Amortiguador', key: /AMORTIGUADOR/, re: /AMORTIGUADOR/, not: /BASE|SOPORTE|CUBRE|TOPE|KIT/ },
  { p: 'Buje / cacahuate', key: /BUJE|CACAHUATE/, re: /BUJE|CACAHUATE/ },
  { p: 'Soporte de motor / transmisión', key: /SOPORTE.*(MOTOR|TRANSM)/, re: /SOPORTE.*(MOTOR|TRANSM|CAJA)/ },
  { p: 'Maza / balero', key: /MAZA|BALERO/, re: /MAZA|BALERO/ },
  { p: 'Cremallera / caja de dirección', key: /CREMALLERA|CAJA DE DIREC/, re: /CREMALLERA|CAJA DE DIRECCION/ },
  { p: 'Resorte / espiral', key: /RESORTE|ESPIRAL/, re: /RESORTE|ESPIRAL/ },
  { p: 'Tirante / tensor', key: /TIRANTE|TENSOR/, re: /TIRANTE|TENSOR/ },
  { p: 'Brazo auxiliar', key: /AUXILIAR/, re: /BRAZO AUXILIAR/ },
  { p: 'Brazo pitman', key: /PITMAN/, re: /PITMAN/ },
];
const OUT_OF_LINE = /KIT|SUSPENSION COMPLETA|FRENO|BALATA|DISCO/;

export function partRule(pieza) {
  const n = N(pieza);
  if (!n || OUT_OF_LINE.test(n)) return null;
  return PART_RULES.find((r) => N(r.p) === n) || PART_RULES.find((r) => r.key.test(n)) || null;
}

// 좌우 · 위치(상하) — 코드 꼬리(L/R) 또는 제품명
export function sideOf(code, name) {
  const c = String(code || '').toUpperCase(); const n = N(name);
  if (/\d[A-Z]*L$/.test(c) || /\bIZQ|\bLH\b|LADO IZQ/.test(n)) return 'L';
  if (/\d[A-Z]*R$/.test(c) || /\bDER(\b|ECH|\.)|\bRH\b/.test(n)) return 'R';
  return null;
}
export const slotOf = (name) => N(name).replace(/\b(IZQUIERD[AO]|IZQ\.?|DERECH[AO]|DER\.?|LH|RH|L|R)\b/g, ' ').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export function yearsOf(anio) {
  const ex = (s) => { const n = Number(s); if (!n) return null; if (s.length === 2) return n <= 40 ? 2000 + n : 1900 + n; return n >= 1960 && n <= 2040 ? n : null; };
  const m = String(anio || '').match(/(\d{4}|\b\d{2}\b)(?:\s*(?:-|a|al|\/)\s*(\d{4}|\d{2}))?/);
  if (!m) return [null, null];
  const a = ex(m[1]); const b = m[2] ? ex(m[2]) : a;
  if (!a) return [null, null];
  return [Math.min(a, b || a), Math.max(a, b || a)];
}

const MAKERS = ['NISSAN', 'CHEVROLET', 'CHEVY', 'VOLKSWAGEN', 'VW', 'FORD', 'TOYOTA', 'HONDA', 'DODGE', 'CHRYSLER', 'JEEP', 'RAM', 'KIA', 'HYUNDAI', 'MAZDA',
  'MITSUBISHI', 'RENAULT', 'SEAT', 'PEUGEOT', 'SUZUKI', 'BUICK', 'GMC', 'GM', 'CADILLAC', 'AUDI', 'BMW', 'MERCEDES', 'FIAT', 'MG', 'JAC', 'BAIC', 'ISUZU', 'PONTIAC'];
const MAKER_ALIAS = { CHEVY: 'CHEVROLET', VW: 'VOLKSWAGEN', GM: 'CHEVROLET' };
const makerKey = (m) => { const n = N(m).split(/[ ,]/)[0]; return MAKER_ALIAS[n] || n; };
const YEAR_TAIL = /\s+((?:19|20)\d\d(?:\s*-\s*(?:19|20)\d\d)?)$/;
// 「Nissan Versa 2018」 → {marca, modelo, anio}
export function splitVehicle(s) {
  let t = String(s || '').trim(); let anio = null;
  const y = t.match(YEAR_TAIL); if (y) { anio = y[1].replace(/\s/g, ''); t = t.slice(0, y.index).trim(); }
  const w = t.split(/\s+/); let marca = null;
  if (w.length > 1 && MAKERS.includes(N(w[0]))) { marca = w.shift(); }
  return { marca, modelo: w.join(' ') || null, anio };
}
const splitList = (s) => String(s || '').split(/;\s*/).map((x) => x.trim()).filter(Boolean);

// 한 문의의 수요 줄 [{marca, modelo, anio, piezas, cantidad}]
export function demandOf(row) {
  const fromText = (veh, parts) => {
    const vs = splitList(veh).map(splitVehicle); const ps = splitList(parts);
    if (!vs.length && !ps.length) return [];
    return (vs.length ? vs : [{ marca: null, modelo: null, anio: null }]).map((v) => ({ ...v, piezas: ps, cantidad: null }));
  };
  if (row.m_vehicles != null || row.m_parts != null) {
    return fromText(row.m_vehicles != null ? row.m_vehicles : (row.ai_vehicles || row.a_vehicles), row.m_parts != null ? row.m_parts : (row.ai_parts || row.a_parts));
  }
  if (Array.isArray(row.ai_demand) && row.ai_demand.length) return row.ai_demand.map((d) => ({ marca: d.marca || null, modelo: d.modelo || null, anio: d.anio || null, piezas: d.piezas || [], cantidad: d.cantidad || null }));
  return fromText(row.a_vehicles, row.a_parts);
}

// 고객이 한쪽만 말했나(「lado izquierdo」) — 대화의 고객 줄만
export function sideHint(messages) {
  const t = N((messages || []).filter((m) => !m.me).map((m) => m.text || '').join(' '));
  const l = /\bIZQ|IZQUIERD|PILOTO|\bLH\b/.test(t), r = /\bDERECH|COPILOTO|\bRH\b/.test(t);
  return l && !r ? 'L' : (r && !l ? 'R' : (l && r ? 'both' : null));
}

const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 차종 · 연식 → 적용 제품(모든 부품). 실행 1회 동안 캐시.
export async function vehicleProducts(line, cache, q = query) {
  const [y1, y2] = yearsOf(line.anio);
  const tries = [line.modelo];
  const first = String(line.modelo || '').split(/\s+/)[0];
  if (first && first.length >= 2 && first !== line.modelo) tries.push(first);
  for (const model of tries) {
    if (!model || model.length < 2) continue;
    const key = [model.toLowerCase(), y1, y2].join('|');
    if (!cache.has(key)) {
      const rows = (await q(`SELECT p.id, p.code, p.name, pa.maker, pa.model, pa.year_from, pa.year_to
           FROM product_applications pa JOIN products p ON p.id = pa.product_id AND p.deleted_at IS NULL AND COALESCE(p.is_active, true)
          WHERE (pa.model ~* $1 OR pa.app_text ~* $1)
            AND ($2::int IS NULL OR pa.year_to IS NULL OR pa.year_to >= $2)
            AND ($3::int IS NULL OR pa.year_from IS NULL OR pa.year_from <= $3)
          LIMIT 600`, ['\\m' + reEsc(model) + '\\M', y1, y2])).rows;
      cache.set(key, rows);
    }
    let rows = cache.get(key);
    if (!rows.length) continue;
    if (line.marca) { const mk = makerKey(line.marca); const same = rows.filter((r) => r.maker && N(r.maker).split(/[ ,]+/).map((x) => MAKER_ALIAS[x] || x).includes(mk)); if (same.length) rows = same; }
    const by = new Map();
    for (const r of rows) {
      const id = Number(r.id); const yrs = r.year_from && r.year_to ? `${r.year_from}-${r.year_to}` : (r.year_from || r.year_to || '');
      const g = by.get(id) || { pid: id, code: r.code, name: r.name || '', apps: [] };
      const a = [r.model, yrs].filter(Boolean).join(' ');
      if (g.apps.length < 3 && !g.apps.includes(a)) g.apps.push(a);
      by.set(id, g);
    }
    return [...by.values()];
  }
  return [];
}

// 한 줄 · 한 부품의 후보 → 규칙 결정
export function decide(line, pieza, cands, hint) {
  const base = { model: [line.marca, line.modelo].filter(Boolean).join(' ') || null, anio: line.anio || null, pieza };
  base.veh = [base.model, base.anio].filter(Boolean).join(' ') || null;
  if (!line.modelo) return { items: [{ ...base, status: 'sin_vehiculo', qty: line.cantidad || null, qty_src: line.cantidad ? 'dicho' : null }], ambiguous: false };
  if (!cands.length) return { items: [{ ...base, status: 'sin_catalogo', qty: line.cantidad || 1, qty_src: line.cantidad ? 'dicho' : 'supuesto' }], ambiguous: false };
  const withSide = cands.map((c) => ({ ...c, side: sideOf(c.code, c.name), slot: slotOf(c.name) }));
  const cells = new Map();                              // slot|side → 코드들
  for (const c of withSide) { const k = c.slot + '|' + (c.side || '-'); (cells.get(k) || cells.set(k, []).get(k)).push(c); }
  const slots = new Set(withSide.map((c) => c.slot));
  const single = slots.size === 1 && [...cells.values()].every((v) => v.length === 1);
  if (single) {
    let pick = withSide;
    if ((hint === 'L' || hint === 'R') && pick.some((c) => c.side === hint)) pick = pick.filter((c) => c.side === hint);
    const sides = pick.filter((c) => c.side).length;
    const q = line.cantidad ? (sides > 1 ? Math.max(1, Math.ceil(line.cantidad / sides)) : line.cantidad) : 1;
    const conf = yearsOf(line.anio)[0] ? 'alta' : 'media';
    return { items: pick.map((c) => ({ ...base, code: c.code, pid: c.pid, name: c.name, side: c.side, qty: q, qty_src: line.cantidad ? 'dicho' : 'supuesto', conf, src: 'regla', status: 'ok' })), ambiguous: false };
  }
  return { items: withSide.slice(0, 20).map((c) => ({ ...base, code: c.code, pid: c.pid, name: c.name, side: c.side, apps: c.apps, qty: null, qty_src: null, conf: 'baja', src: 'regla', status: 'candidato' })), ambiguous: true };
}

export function buildMatchPrompt(threads) {
  return `Eres especialista del catálogo CTR (suspensión y dirección) de Refatrix México.
Para cada conversación hay "pedidos" (vehículo + pieza) con una lista de CANDIDATOS del catálogo. Elige los números de parte CTR que el cliente necesita.
Reglas:
- Usa SOLO códigos de la lista de candidatos de ese pedido.
- Usa lo que diga la conversación: año, versión, motor, carrocería, posición (inferior/superior, delantera/trasera) y lado (izquierdo/derecho).
- Si la pieza viene en lado izquierdo y derecho y el cliente no dice cuál, incluye ambos lados.
- "cantidad": piezas de ESE número de parte. Si el cliente dice cuántas ("par", "las 2", "4 piezas", flotilla de N unidades) úsalo y "cantidad_dicha": true; si no, 1 y "cantidad_dicha": false.
- Si no se puede decidir entre candidatos (falta año o versión), incluye los posibles con "confianza":"baja". Seguro = "alta", probable = "media".
Responde SOLO un arreglo JSON, sin texto adicional:
[{"id":<id>,"pedidos":[{"n":<n>,"partes":[{"codigo":"...","cantidad":1,"cantidad_dicha":false,"confianza":"alta"}]}]}]

${threads.map((t) => `### id=${t.id}
Conversación:
${t.text}
Pedidos:
${t.asks.map((a) => `n=${a.n} · ${a.veh || a.model || '?'} · ${a.pieza}${a.cantidad ? ' · cantidad dicha: ' + a.cantidad : ''}
${a.cands.map((c) => `  - ${c.code} | ${c.name} | ${(c.apps || []).join('; ')}`).join('\n')}`).join('\n')}`).join('\n\n')}`;
}

// AI 답 → 그 질의(ask)의 확정 품목. 후보에 없는 코드는 버린다.
export function applyAi(ask, ans) {
  const parts = Array.isArray(ans && ans.partes) ? ans.partes : [];
  const byCode = new Map(ask.cands.map((c) => [N(c.code), c]));
  const out = [];
  for (const p of parts) {
    const c = byCode.get(N(p && p.codigo)); if (!c || out.some((o) => o.code === c.code)) continue;
    const qty = Number(p.cantidad) > 0 ? Math.min(9999, Math.round(Number(p.cantidad))) : 1;
    const conf = ['alta', 'media', 'baja'].includes(p.confianza) ? p.confianza : 'media';
    out.push({ ...ask.base, code: c.code, pid: c.pid, name: c.name, side: c.side, qty, qty_src: p.cantidad_dicha ? 'dicho' : 'supuesto', conf, src: 'ia', status: 'ok' });
  }
  return out;
}

// ── 실행 ──
export const matchState = { running: false, done: 0, total: 0, ai_calls: 0, errors: 0, last_error: null, finished_at: null };
let current = null; let pendingAll = false;
const AI_BATCH = 5;
const MAX_ASK_PER_THREAD = 6;

async function run({ all = false, ids = null, q = query } = {}) {
  Object.assign(matchState, { running: true, done: 0, total: 0, ai_calls: 0, errors: 0, last_error: null });
  try {
    const rows = (await q(`SELECT id, messages, in_count, m_vehicles, m_parts, ai_vehicles, ai_parts, ai_demand, a_vehicles, a_parts, items_hash
                             FROM meta_threads ${ids ? 'WHERE id = ANY($1::bigint[])' : ''} ORDER BY last_at DESC NULLS LAST`, ids ? [ids] : [])).rows;
    matchState.total = rows.length;
    const cache = new Map(); const useAi = aiReady();
    const aiQueue = [];
    for (const r of rows) {
      const lines = demandOf(r); const hint = sideHint(r.messages);
      const items = []; const asks = []; const sig = [];
      for (const line of lines) {
        const vp = line.modelo ? await vehicleProducts(line, cache, q) : [];
        for (const pieza of (line.piezas.length ? line.piezas : [])) {
          const rule = partRule(pieza); if (!rule) continue;
          const cands = vp.filter((c) => rule.re.test(N(c.name)) && !(rule.not && rule.not.test(N(c.name))));
          sig.push([line.modelo, line.anio, pieza, line.cantidad, cands.map((c) => c.code).sort()]);
          const d = decide(line, rule.p, cands, hint);
          if (d.ambiguous && asks.length < MAX_ASK_PER_THREAD) {
            asks.push({ n: asks.length + 1, base: { model: d.items[0].model, anio: d.items[0].anio, veh: d.items[0].veh, pieza: rule.p }, veh: d.items[0].veh, pieza: rule.p, cantidad: line.cantidad,
              cands: d.items.map((i) => ({ code: i.code, pid: i.pid, name: i.name, side: i.side, apps: i.apps })), fallback: d.items.map(({ apps, ...i }) => i) });
          } else items.push(...d.items.map(({ apps, ...i }) => i));
        }
      }
      const needAi = asks.length > 0 && useAi;
      const hash = crypto.createHash('sha1').update(JSON.stringify([sig, hint, needAi ? convHash(r.messages) : null, asks.length ? useAi : null])).digest('hex').slice(0, 20);
      if (!all && !ids && r.items_hash === hash) { matchState.done++; continue; }
      if (needAi) { aiQueue.push({ id: Number(r.id), hash, items, asks, text: conversationText(r.messages, 1500) }); continue; }
      for (const a of asks) items.push(...a.fallback);
      await q(`UPDATE meta_threads SET ai_items=$2::jsonb, items_hash=$3, items_at=now(), items_error=NULL WHERE id=$1`, [r.id, JSON.stringify(items), hash]);
      matchState.done++;
    }
    for (let i = 0; i < aiQueue.length; i += AI_BATCH) {
      const chunk = aiQueue.slice(i, i + AI_BATCH);
      let res = await callClaude(buildMatchPrompt(chunk)); matchState.ai_calls++;
      if (!res.ok && res.transient) { await new Promise((r) => setTimeout(r, 4000)); res = await callClaude(buildMatchPrompt(chunk)); matchState.ai_calls++; }
      const arr = res.ok ? parseAiJson(res.text) : null;
      const byId = new Map((arr || []).map((o) => [Number(o && o.id), o]));
      for (const t of chunk) {
        const o = byId.get(t.id); const items = [...t.items]; let err = null;
        if (!o) { err = res.ok ? 'ai: 응답 형식' : res.error; matchState.errors++; matchState.last_error = err; }
        const peds = new Map(((o && o.pedidos) || []).map((p) => [Number(p && p.n), p]));
        for (const a of t.asks) {
          const chosen = o ? applyAi(a, peds.get(a.n)) : [];
          items.push(...(chosen.length ? chosen : a.fallback));
        }
        // 실패면 지문을 남기지 않는다 → 다음에 다시 시도
        await q(`UPDATE meta_threads SET ai_items=$2::jsonb, items_hash=$3, items_at=now(), items_error=$4 WHERE id=$1`, [t.id, JSON.stringify(items), err ? null : t.hash, err]);
        matchState.done++;
      }
    }
    return { total: matchState.total, ai_calls: matchState.ai_calls, errors: matchState.errors, model: aiModel() };
  } finally {
    matchState.running = false; matchState.finished_at = new Date().toISOString();
  }
}

// 하나씩 줄 세워 실행(동시 실행 없음)
export async function matchThreads(opts = {}) {
  while (current) await current.catch(() => {});
  current = run(opts);
  try { return await current; } finally { current = null; }
}

export function kickMatch(log = null) {
  if (current) { pendingAll = true; return; }
  setTimeout(async () => {
    try { await matchThreads({}); } catch (e) { if (log) log.warn({ err: String(e && e.message) }, '[meta-leads] match failed'); }
    if (pendingAll) { pendingAll = false; kickMatch(log); }
  }, 100);
}
setAfterAnalyze(() => kickMatch());

// 사람이 적은 「코드 수량」 줄 → m_items. 모르는 코드는 unknown 으로 돌려준다.
export async function parseManualItems(text, q = query) {
  const rows = String(text || '').split(/[\n;,]+/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^([A-Za-z0-9\-./]+)\s*(?:[x×*]\s*)?(\d+)?$/i);
    return m ? { code: m[1], qty: m[2] ? Math.min(9999, Number(m[2])) : 1 } : { code: l, qty: 1 };
  });
  if (!rows.length) return { items: null, unknown: [] };
  const norms = rows.map((r) => r.code.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  const found = (await q(`SELECT id, code, name, regexp_replace(upper(code), '[^A-Z0-9]', '', 'g') AS n FROM products WHERE deleted_at IS NULL AND regexp_replace(upper(code), '[^A-Z0-9]', '', 'g') = ANY($1)`, [norms])).rows;
  const by = new Map(found.map((f) => [f.n, f]));
  const items = []; const unknown = [];
  rows.forEach((r, i) => {
    const f = by.get(norms[i]); if (!f) { unknown.push(r.code); return; }
    const ex = items.find((x) => x.code === f.code); if (ex) { ex.qty += r.qty; return; }
    items.push({ code: f.code, pid: Number(f.id), name: f.name || '', side: sideOf(f.code, f.name), qty: r.qty, qty_src: 'manual', conf: 'manual', src: 'manual', status: 'ok' });
  });
  return { items, unknown };
}
