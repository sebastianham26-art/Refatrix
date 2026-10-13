// =====================================================================
// Refatrix ERP · metaLeadsAi.js — Meta 광고 문의 대화를 AI(Claude)로 읽어 구조화 (0271 · 2026-10-13 디렉터 지시)
//
//   「대화에 차종 · 연식 · 요청 부품 · particular/flotilla 같은 유형 · 지역이 있다 — 감지해서 보여줘야 한다」
//   규칙 추출(metaLeadExtract.js)은 철자 · 문맥을 놓친다:
//     · 「orquilla del berza 17」 · 「la del lado izq」 · 직원이 「¿Confirmas que es para un Nissan Sentra 2015?」 → 고객 「sí」
//   그래서 대화 전체(고객 + 우리 직원)를 Claude 가 읽고 아래 JSON 으로 돌려준다:
//     tipo(Particular · Taller mecánico · Refaccionaria · Mayorista · Flotilla · Taxi / app) + 근거(dicho/boton/inferido)
//     estado(멕시코 32개 주 중 하나) · ciudad · vehiculos[{marca, modelo, anio, piezas[]}] · telefono · intencion · resumen
//
//   비용: 대화 8건씩 한 번에(Haiku 4.5 기본 · META_LEADS_AI_MODEL). 대화 내용 지문(ai_hash)이 같으면 다시 보내지 않는다.
//   고객이 아무 말도 안 쓴 대화(버튼만)는 AI 에 보내지 않는다.
//   우선순위(화면 · 엑셀): 사람이 고친 값(m_*) > AI(ai_*) > 규칙(a_*).
// =====================================================================
import crypto from 'node:crypto';
import { query } from './db.js';
import { META_STATES } from './metaLeadExtract.js';

export const aiModel = () => process.env.META_LEADS_AI_MODEL || 'claude-haiku-4-5-20251001';
export const aiReady = () => !!process.env.ANTHROPIC_API_KEY && process.env.META_LEADS_AI !== '0';
const BATCH = 8;
const MAX_PER_RUN = () => Math.max(10, Math.min(3000, Number(process.env.META_LEADS_AI_MAX) || 800));
const TIMEOUT_MS = 90000;

export const TIPOS = ['Particular', 'Taller mecánico', 'Refaccionaria', 'Mayorista', 'Flotilla', 'Taxi / app'];
export const PARTES = ['Horquilla (brazo de control)', 'Rótula', 'Terminal exterior', 'Terminal interior', 'Bieleta / tornillo estabilizador',
  'Barra estabilizadora', 'Amortiguador', 'Base de amortiguador', 'Buje / cacahuate', 'Soporte de motor / transmisión', 'Maza / balero',
  'Cremallera / caja de dirección', 'Resorte / espiral', 'Tirante / tensor', 'Suspensión completa (kit)', 'Frenos (fuera de línea)'];

let callOverride = null;                     // 시험용 — (prompt) => {ok, text}
export function setMetaAiCaller(fn) { callOverride = fn || null; }

async function callClaude(prompt) {
  if (callOverride) return callOverride(prompt);
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: aiModel(), max_tokens: 4000, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
      signal: ctrl.signal,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: 'ai: ' + String((d.error && d.error.message) || 'http_' + r.status).slice(0, 200), transient: r.status === 429 || r.status >= 500 };
    return { ok: true, text: (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n') };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'ai: timeout' : 'ai: network', transient: true };
  } finally { clearTimeout(t); }
}

// 우리 봇의 정해진 안내문은 AI 에 보낼 필요가 없다(토큰 절약 · 우리 번호 오인 방지)
const BOT_RE = [
  /^Hola [^,]+, Qué gusto saludarte\./i, /^Para empezar, platícanos/i, /^Claro, te comparto el link de nuestra pagina/i,
  /^En un momento un agente se comunicará/i, /^Puedes enviarnos un WhatsApp directo/i, /^Sí! Hacemos envíos a todo México/i,
];
export function conversationText(messages, max = 1800) {
  const lines = [];
  for (const m of messages || []) {
    const t = String(m.text || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (m.me && BOT_RE.some((re) => re.test(t))) continue;
    lines.push((m.me ? 'R: ' : 'C: ') + t.slice(0, 400));
  }
  let s = lines.join('\n');
  if (s.length > max) s = '…' + s.slice(s.length - max);   // 길면 최근 쪽을 남긴다
  return s;
}
export const convHash = (messages) => crypto.createHash('sha1').update(JSON.stringify((messages || []).map((m) => [m.me ? 1 : 0, m.text || '']))).digest('hex').slice(0, 20);

export function buildPrompt(items) {
  return `Eres analista de ventas de Refatrix, distribuidor en México de refacciones de suspensión y dirección marca CTR.
Abajo hay conversaciones de Messenger/Instagram que llegaron por anuncios. "C:" = cliente, "R:" = Refatrix (agente o bot).
Para CADA conversación extrae datos SOLO de lo que se dice (no inventes). Usa los mensajes de Refatrix como contexto
(p. ej. si el agente pregunta "¿Confirmas que es para un Nissan Sentra 2015?" y el cliente dice "sí", el vehículo es Nissan Sentra 2015).

Reglas:
- "tipo": uno de ${JSON.stringify(TIPOS)} o null. Taxi, Uber, DiDi, "trabajo en app" = "Taxi / app". Mecánico/taller = "Taller mecánico".
  "tipo_fuente": "dicho" si el cliente lo escribió, "boton" si solo pulsó un botón del anuncio como "Soy Particular de MTY, quiero comprar…", "inferido" si se deduce del contexto.
- El texto de los botones del anuncio dice "de MTY" para todos: NO es la ubicación del cliente.
- "estado": uno de ${JSON.stringify(META_STATES)} o null. Solo si el cliente dice dónde está/vive o a dónde se envía. Deduce el estado de la ciudad (Monclova→Coahuila, Jiutepec→Morelos, Apodaca→Nuevo León). "ciudad": municipio/ciudad o null.
- "vehiculos": lista de {"marca","modelo","anio","piezas":[...],"cantidad"}. Corrige errores de escritura (verza/bersa→Versa, sentr→Sentra, kics→Kicks, abeo→Aveo).
  "anio": texto con el año o rango ("2017", "2013-2019") o null si no se dijo. Si piden "las 2" o "par", cantidad 2; si no, null.
  "piezas": usa estos nombres cuando apliquen: ${JSON.stringify(PARTES)}. Orquilla/horquilla/brazo = "Horquilla (brazo de control)". Si piden otra cosa, escríbela corta en español.
  Si piden piezas sin decir vehículo, usa {"marca":null,"modelo":null,"anio":null,"piezas":[...]}.
- "telefono": 10 dígitos del cliente si lo dio (NO 8118250003 ni 8116606680, son de Refatrix) o null.
- "intencion": lista corta entre "precio","catálogo","envío","dónde comprar","asesor","pedido","garantía","otro".
- "resumen": una frase en español (máx. 120 caracteres) con lo que busca el cliente y en qué quedó.

Responde SOLO con un arreglo JSON, un objeto por conversación, con "id" igual al de entrada. Sin texto adicional.

${items.map((it) => `### id=${it.id}\n${it.text}`).join('\n\n')}`;
}

export function parseAiJson(text) {
  const s = String(text || '');
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try { const v = JSON.parse(s.slice(a, b + 1)); return Array.isArray(v) ? v : null; } catch { return null; }
}

const clean = (v, n = 120) => { const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); return s && !/^(null|n\/a|none|-)$/i.test(s) ? s.slice(0, n) : null; };
// AI 답 1건 → 저장값(이름 맞추기 · 주 이름 검증 · 우리 번호 제거)
export function normalizeAi(o) {
  const tipo = TIPOS.find((t) => t.toLowerCase() === String(o.tipo || '').toLowerCase()) || null;
  const st = META_STATES.find((x) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    === String(o.estado || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()) || null;
  const veh = (Array.isArray(o.vehiculos) ? o.vehiculos : []).slice(0, 6).map((v) => ({
    marca: clean(v && v.marca, 30), modelo: clean(v && v.modelo, 40), anio: clean(v && v.anio, 15),
    piezas: (Array.isArray(v && v.piezas) ? v.piezas : []).map((p) => clean(p, 60)).filter(Boolean).slice(0, 10),
    cantidad: v && Number(v.cantidad) > 0 ? Math.min(999, Math.round(Number(v.cantidad))) : null,
  })).filter((v) => v.modelo || v.piezas.length);
  const vehicles = [...new Set(veh.filter((v) => v.modelo).map((v) => [v.marca, v.modelo, v.anio].filter(Boolean).join(' ')))];
  const parts = [...new Set(veh.flatMap((v) => v.piezas))];
  let phone = String(o.telefono || '').replace(/\D/g, '');
  if (phone.length === 12 && phone.startsWith('52')) phone = phone.slice(2);
  if (phone.length !== 10 || ['8118250003', '8116606680'].includes(phone)) phone = null;
  const intent = (Array.isArray(o.intencion) ? o.intencion : [o.intencion]).map((x) => clean(x, 20)).filter(Boolean);
  return {
    tipo, tipo_src: tipo ? (['dicho', 'boton', 'inferido'].includes(o.tipo_fuente) ? o.tipo_fuente : 'inferido') : null,
    state: st, city: st ? clean(o.ciudad, 60) : clean(o.ciudad, 60),
    demand: veh, vehicles: vehicles.length ? vehicles.join('; ') : null, parts: parts.length ? parts.join('; ') : null,
    phone, intent: intent.length ? [...new Set(intent)].join(', ') : null, summary: clean(o.resumen, 160),
  };
}

// ── 분석 실행 ──
export const aiState = { running: false, done: 0, total: 0, errors: 0, last_error: null, started_at: null, finished_at: null };

export async function analyzeThreads({ all = false, ids = null, q = query } = {}) {
  if (aiState.running) return { error: 'already_running' };
  if (!aiReady()) return { error: 'ai_not_configured' };
  Object.assign(aiState, { running: true, done: 0, total: 0, errors: 0, last_error: null, started_at: new Date().toISOString(), finished_at: null });
  try {
    const rows = (await q(`SELECT id, messages, in_count, ai_hash FROM meta_threads ${ids ? 'WHERE id = ANY($1::bigint[])' : ''} ORDER BY last_at DESC NULLS LAST`, ids ? [ids] : [])).rows;
    const todo = [];
    for (const r of rows) {
      const h = convHash(r.messages);
      if (!all && !ids && r.ai_hash === h) continue;
      if (!Number(r.in_count)) {   // 고객이 쓴 말이 없으면 AI 에 안 보냄
        await q(`UPDATE meta_threads SET ai_hash=$2, ai_at=now(), ai_tipo=NULL, ai_tipo_src=NULL, ai_state=NULL, ai_city=NULL, ai_vehicles=NULL, ai_parts=NULL, ai_demand=NULL, ai_phone=NULL, ai_intent=NULL, ai_summary=NULL, ai_error=NULL WHERE id=$1`, [r.id, h]);
        continue;
      }
      todo.push({ id: Number(r.id), hash: h, text: conversationText(r.messages) });
      if (todo.length >= MAX_PER_RUN()) break;
    }
    aiState.total = todo.length;
    for (let i = 0; i < todo.length; i += BATCH) {
      const chunk = todo.slice(i, i + BATCH);
      let res = await callClaude(buildPrompt(chunk));
      if (!res.ok && res.transient) { await new Promise((r) => setTimeout(r, 4000)); res = await callClaude(buildPrompt(chunk)); }
      const arr = res.ok ? parseAiJson(res.text) : null;
      const byId = new Map((arr || []).map((o) => [Number(o && o.id), o]));
      for (const it of chunk) {
        const o = byId.get(it.id);
        if (!o) {
          aiState.errors++; aiState.last_error = res.ok ? 'ai: 응답 형식' : res.error;
          await q(`UPDATE meta_threads SET ai_error=$2 WHERE id=$1`, [it.id, aiState.last_error]);
          continue;
        }
        const n = normalizeAi(o);
        await q(`UPDATE meta_threads SET ai_tipo=$2, ai_tipo_src=$3, ai_state=$4, ai_city=$5, ai_vehicles=$6, ai_parts=$7, ai_demand=$8::jsonb,
                   ai_phone=$9, ai_intent=$10, ai_summary=$11, ai_hash=$12, ai_at=now(), ai_model=$13, ai_error=NULL WHERE id=$1`,
          [it.id, n.tipo, n.tipo_src, n.state, n.city, n.vehicles, n.parts, JSON.stringify(n.demand), n.phone, n.intent, n.summary, it.hash, aiModel()]);
        aiState.done++;
      }
    }
    return { analyzed: aiState.done, errors: aiState.errors, total: aiState.total };
  } finally {
    aiState.running = false; aiState.finished_at = new Date().toISOString();
  }
}

// 가져오기 끝나면 바뀐 대화만 이어서 분석(기다리지 않음)
export function kickAnalyze(log = null) {
  if (!aiReady() || aiState.running) return;
  setTimeout(() => { analyzeThreads({}).catch((e) => log && log.warn({ err: String(e && e.message) }, '[meta-leads] ai failed')); }, 200);
}
