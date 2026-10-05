// =====================================================================
// Refatrix ERP · 커미션 조건 합의 (0251 · 2026-10-05)
//   커미션 대상자(커미셔너·직원)가 자기 조건 문서(스페인어)를 읽고 **본인 PIN** 을 넣으면 합의로 기록된다.
//   · 조건 문서는 ERP 설정(커미션 기간·율·판정, 고객 예외율, 성과급)에서 그때그때 생성한다.
//   · 조건 + 규칙 문구 버전(RULES_VERSION)으로 해시를 만들어, 바뀌면 「재합의 필요」.
//   · 합의 한 번 = commission_agreements 한 줄(조건·문서 스냅샷 · 시각 · IP · 기기). 수정·삭제 불가.
//   · 재합의가 없어도 커미션 계산·지급은 막지 않는다(디렉터 결정: PIN 입력이 합의의 증명).
//   커미셔너 = 「안내서(guiacom)」 권한이 있는 사용자 / 그 외 커미션 대상 = 직원.
// =====================================================================
import { createHash } from 'node:crypto';
import { query } from '../db.js';
import { authGuard } from '../middleware/authGuard.js';
import { verifyPin } from '../auth.js';
import { logEvent } from '../audit.js';

const SEE_ALL_ROLES = ['director', 'treasury', 'socio'];
const canSeeAll = (perm) => SEE_ALL_ROLES.includes(perm.role);

// 규칙 문구 버전 — 문서의 공통 규칙(지급일·조정·독점 등) 문구를 바꾸면 올린다 → 전원 재합의 대상.
export const RULES_VERSION = '2026-10-05';

const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctTxt = (n) => `${Number(n)}%`;

// ── 조건 정규화 (순수) ─────────────────────────────────────────────
//   해시가 표시 순서·타입 차이로 흔들리지 않도록 값을 고정 형태로 만든다.
export function buildTerms({ type, periods = [], custRates = [], bonus = null }) {
  const ps = periods.map((p) => ({
    start: String(p.start_date).slice(0, 10),
    end: p.end_date ? String(p.end_date).slice(0, 10) : null,
    basis: p.basis === 'revenue' ? 'revenue' : 'collection',
    match_on: p.basis === 'collection' && p.match_on === 'payment' ? 'payment' : 'invoice',
    rate: Number(p.rate),
  })).sort((a, b) => a.start.localeCompare(b.start));
  const cr = custRates.map((c) => ({ customer: String(c.customer_name || ''), code: c.customer_code || null, rate: Number(c.rate) }))
    .sort((a, b) => a.customer.localeCompare(b.customer));
  let bn = null;
  if (bonus && bonus.enabled) {
    bn = {
      basis: bonus.basis === 'collection' ? 'collection' : 'revenue',
      start: bonus.start_month || null, end: bonus.end_month || null,
      tiers: (bonus.tiers || []).map((t) => ({ min_rate: Number(t.min_rate), amount: Number(t.amount) })).sort((a, b) => a.min_rate - b.min_rate),
      targets: Object.keys(bonus.targets || {}).sort().map((m) => ({ month: m, amount: Number(bonus.targets[m]) })),
    };
  }
  return { rules: RULES_VERSION, type: type === 'comisionista' ? 'comisionista' : 'empleado', periods: ps, customer_rates: cr, bonus: bn };
}

export function termsHash(terms) {
  return createHash('sha256').update(JSON.stringify(terms)).digest('hex').slice(0, 12);
}

const baseLabel = (p) => (p.basis === 'revenue'
  ? 'Venta — al emitir la factura'
  : (p.match_on === 'payment' ? 'Cobranza — por fecha de cobro' : 'Cobranza — facturas emitidas en el periodo, cobradas al 100%'));
const vigencia = (p) => (p.end ? `${p.start} a ${p.end}` : `Desde ${p.start}`);

// ── 문서 생성 (순수) — 스페인어. **굵게** 표기만 쓰고, 화면이 이스케이프 후 <b> 로 바꾼다. ──
export function buildDoc(terms, who = {}) {
  const sections = [];
  const cur = terms.periods.find((p) => !p.end) || terms.periods[terms.periods.length - 1] || null;
  const isCom = terms.type === 'comisionista';

  // 1. 커미션
  const items = [];
  if (!cur) {
    items.push('Aún no tienes condiciones de comisión registradas.');
  } else if (cur.basis === 'revenue') {
    items.push(`Ganas el **${pctTxt(cur.rate)} del valor sin IVA** de cada factura **al emitirla** (menos notas de crédito).`);
  } else if (cur.match_on === 'payment') {
    items.push(`Cada cobro que entra dentro de la vigencia suma el **${pctTxt(cur.rate)} del monto cobrado sin IVA**, sin importar cuándo se emitió la factura.`);
    items.push('La comisión de una factura **se paga cuando la factura queda cobrada al 100%** (saldo menor a $0.50). Mientras tenga saldo pendiente, la comisión queda acumulada en espera.');
  } else {
    items.push(`Ganas el **${pctTxt(cur.rate)} del valor sin IVA** de cada factura emitida dentro de la vigencia y **cobrada al 100%** (saldo menor a $0.50).`);
    items.push('Una factura con saldo pendiente no paga comisión hasta que se cobre completa.');
  }
  const prev = terms.periods.filter((p) => p !== cur);
  if (prev.length) items.push('Los periodos anteriores de la tabla se pagan con sus propias condiciones.');
  if (terms.customer_rates.length) {
    items.push('Clientes con tasa especial: ' + terms.customer_rates.map((c) => `**${c.customer}** ${pctTxt(c.rate)}`).join(', ') + '.');
  }
  sections.push({
    key: 'commission', title: 'Tu comisión',
    table: { head: ['Vigencia', 'Base', 'Tasa'], rows: terms.periods.map((p) => [vigencia(p), baseLabel(p), pctTxt(p.rate)]), right: [2] },
    items,
  });

  // 2. 성과급
  if (terms.bonus) {
    const b = terms.bonus;
    const tiers = b.tiers.filter((t) => t.amount > 0);
    const min = tiers.length ? tiers[0].min_rate : null;
    const rows = [];
    if (min != null) rows.push([`Menos de ${min}%`, 'Sin bono']);
    tiers.forEach((t, i) => rows.push([`${t.min_rate}% o más` + (tiers[i + 1] ? ` (menos de ${tiers[i + 1].min_rate}%)` : ''), money(t.amount)]));
    const bItems = [
      `Se mide contra tu **meta ${b.basis === 'revenue' ? 'de venta' : 'de cobranza'} de cada mes** (sin IVA). Solo aplica el escalón más alto alcanzado.`,
      b.basis === 'revenue'
        ? 'Venta del mes = facturas emitidas en el mes, sin IVA, menos notas de crédito.'
        : 'La meta de cobranza la calcula el sistema con las facturas que vencen en el mes según los días de crédito del cliente.',
      `Vigencia del bono: ${b.start || '—'}${b.end ? ` a ${b.end}` : ' en adelante'}.`,
    ];
    sections.push({
      key: 'bonus', title: 'Tu bono mensual',
      table: { head: ['Cumplimiento de la meta', 'Bono'], rows, right: [1] },
      table2: b.targets.length ? { head: ['Mes', b.basis === 'revenue' ? 'Meta de venta (sin IVA)' : 'Meta (sin IVA)'], rows: b.targets.map((t) => [t.month, money(t.amount)]), right: [1] } : null,
      items: bItems,
    });
  }

  // 3. 지급
  const pay = [];
  pay.push(cur && cur.basis === 'revenue'
    ? 'Se paga el **día 15 del mes siguiente** al mes en que se emitió la factura.'
    : 'Se paga el **día 15 del mes siguiente** al mes en que la factura quedó cobrada al 100%.');
  if (isCom) pay.push('Para pagarte necesitamos **tu factura de comisión (CFDI)** por el monto confirmado.');
  if (terms.bonus) pay.push('El bono se calcula al cerrar cada mes, queda fijo y se paga junto con la comisión.');
  pay.push('Puedes ver tus facturas, cobros, comisión y metas en el ERP › Comisión.');
  sections.push({ key: 'pay', title: 'Cuándo y cómo se paga', items: pay });

  // 4. 조정·고객
  sections.push({
    key: 'adjust', title: 'Ajustes y clientes',
    items: [
      'La comisión es del **titular del cliente en el ERP** en la fecha de la factura.',
      'Si después de pagada la comisión la venta baja (cancelación, nota de crédito o corrección), **la diferencia se descuenta del siguiente pago**.',
      'Exclusividad de clientes nuevos: el RFC registrado da 30 días; quien factura primero obtiene 1 año, que se renueva con ventas en al menos 6 meses distintos.',
      'Las condiciones de descuento y crédito al cliente las define Refatrix.',
    ],
  });

  const hash = termsHash(terms);
  const declaration = `Leí y entiendo estas condiciones (versión #${hash}). Acepto que mi comisión${terms.bonus ? ' y mi bono' : ''} se calculen y paguen así. Al ingresar mi PIN confirmo esta aceptación.`;
  return {
    title: 'Acuerdo de condiciones de comisión',
    version: hash, rules_version: RULES_VERSION,
    who: { name: who.name || null, team: who.team || null, type: isCom ? 'Comisionista (externo)' : 'Empleado' },
    sections, declaration,
  };
}

// 현황판 한 줄 요약(한국어)
export function summaryKo(terms) {
  const cur = terms.periods.find((p) => !p.end) || terms.periods[terms.periods.length - 1];
  if (!cur) return '조건 없음';
  const b = cur.basis === 'revenue' ? '매출' : (cur.match_on === 'payment' ? '수금(수금일)' : '수금');
  let s = `${b} ${cur.rate}% · ${cur.start}~`;
  if (terms.periods.length > 1) s += ` 외 ${terms.periods.length - 1}기간`;
  if (terms.customer_rates.length) s += ` · 예외율 ${terms.customer_rates.length}곳`;
  if (terms.bonus) s += ' · 성과급 ' + terms.bonus.tiers.filter((t) => t.amount > 0).map((t) => `${t.min_rate}%↑${Math.round(t.amount / 1000)}k`).join('/');
  return s;
}

// 상태: agreed(현재 조건에 합의) / changed(예전 조건에만 합의) / pending(합의 없음)
export function statusOf(currentHash, latest) {
  if (!latest) return 'pending';
  return latest.version_hash === currentHash ? 'agreed' : 'changed';
}

// ── DB ───────────────────────────────────────────────────────────────
let _ready = { v: null, at: 0 };
async function tableReady() {
  if (_ready.v === true) return true;
  if (_ready.v === false && Date.now() - _ready.at < 60000) return false;
  const r = await query(`SELECT 1 FROM information_schema.tables WHERE table_name='commission_agreements'`);
  _ready = { v: r.rows.length > 0, at: Date.now() };
  return _ready.v;
}

// 커미션 대상 = commission_agents.active 이고 기간이 1개 이상
async function agentRows(onlyUid = null) {
  const args = []; let cond = '';
  if (onlyUid) { args.push(onlyUid); cond = ` AND u.id=$1`; }
  return (await query(
    `SELECT u.id, u.name, u.role, t.name AS team_name,
            EXISTS (SELECT 1 FROM user_page_access a WHERE a.user_id=u.id AND a.page_key='guiacom') AS is_com
       FROM users u
       JOIN commission_agents ca ON ca.user_id=u.id AND ca.active=true
       LEFT JOIN sales_teams t ON t.id=u.team_id
      WHERE u.deleted_at IS NULL${cond}
        AND EXISTS (SELECT 1 FROM commission_agent_periods p WHERE p.user_id=u.id)
      ORDER BY t.sort_order NULLS LAST, u.name`, args)).rows;
}

async function loadTerms(u) {
  const uid = Number(u.id);
  const periods = (await query(
    `SELECT to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date, basis, rate,
            COALESCE(to_jsonb(cap)->>'match_on','invoice') AS match_on
       FROM commission_agent_periods cap WHERE user_id=$1 ORDER BY start_date`, [uid])).rows;
  const custRates = (await query(
    `SELECT c.name AS customer_name, c.code AS customer_code, ccr.rate
       FROM commission_customer_rates ccr JOIN customers c ON c.id=ccr.customer_id WHERE ccr.user_id=$1`, [uid])).rows;
  let bonus = null;
  try {
    const p = (await query(`SELECT enabled, basis, start_month, end_month FROM bonus_plans WHERE user_id=$1`, [uid])).rows[0];
    if (p && p.enabled) {
      const tiers = (await query(`SELECT min_rate, amount FROM bonus_tiers WHERE user_id=$1`, [uid])).rows;
      const targets = {};
      for (const t of (await query(`SELECT month, revenue_target FROM bonus_targets WHERE user_id=$1`, [uid])).rows) targets[t.month] = Number(t.revenue_target);
      bonus = { enabled: true, basis: p.basis, start_month: p.start_month, end_month: p.end_month, tiers, targets };
    }
  } catch (e) { if (!(e && e.code === '42P01')) throw e; }
  const terms = buildTerms({ type: u.is_com ? 'comisionista' : 'empleado', periods, custRates, bonus });
  const hash = termsHash(terms);
  const doc = buildDoc(terms, { name: u.name, team: u.team_name });
  return { terms, hash, doc };
}

const AGREE_COLS = `id, user_id, version_hash, agent_type, summary,
  to_char(agreed_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS agreed_at_local, ip, user_agent`;

async function history(uid) {
  if (!(await tableReady())) return [];
  return (await query(`SELECT ${AGREE_COLS} FROM commission_agreements WHERE user_id=$1 ORDER BY agreed_at DESC, id DESC`, [uid])).rows
    .map((r) => ({ id: Number(r.id), version: r.version_hash, summary: r.summary, agreed_at: r.agreed_at_local, device: deviceLabel(r.user_agent) }));
}

// User-Agent → 짧은 기기 표기
export function deviceLabel(ua) {
  const s = String(ua || '');
  if (!s) return null;
  const os = /Android/i.test(s) ? 'Android' : (/iPhone|iPad/i.test(s) ? 'iOS' : (/Windows/i.test(s) ? 'Windows' : (/Mac OS/i.test(s) ? 'Mac' : null)));
  const br = /Edg\//.test(s) ? 'Edge' : (/Chrome\//.test(s) ? 'Chrome' : (/Safari\//.test(s) ? 'Safari' : (/Firefox\//.test(s) ? 'Firefox' : null)));
  return [br, os].filter(Boolean).join(' / ') || null;
}

// PIN 오입력 제한 — 사람당 15분에 5회
const fails = new Map();
function tooManyFails(uid) {
  const now = Date.now();
  const arr = (fails.get(uid) || []).filter((t) => now - t < 15 * 60 * 1000);
  fails.set(uid, arr);
  return arr.length >= 5;
}
function noteFail(uid) { const arr = fails.get(uid) || []; arr.push(Date.now()); fails.set(uid, arr); }
export function _resetPinFails() { fails.clear(); }

export default async function commissionAgreementRoutes(app) {
  // ── 내 조건 문서 + 상태 + 이력 ──
  app.get('/api/commission/agreement/me', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const uid = Number(perm.userId);
    const rows = await agentRows(uid);
    const seeAll = canSeeAll(perm);
    if (!rows.length) return { is_agent: false, see_all: seeAll };
    const { terms, hash, doc } = await loadTerms(rows[0]);
    const hist = await history(uid);
    const latest = hist[0] ? { version_hash: hist[0].version } : null;
    return {
      is_agent: true, see_all: seeAll, migrated: await tableReady(),
      version: hash, status: statusOf(hash, latest), doc, terms,
      history: hist.map((h) => ({ ...h, current: h.version === hash })),
    };
  });

  // ── 합의 (본인 PIN) ──
  app.post('/api/commission/agreement/me', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const uid = Number(perm.userId);
    if (!(await tableReady())) return reply.code(503).send({ error: 'migration_required', note: 'npm run migrate(0251)을 먼저 실행하세요.' });
    const rows = await agentRows(uid);
    if (!rows.length) return reply.code(403).send({ error: 'not_agent', note: 'No tienes condiciones de comisión registradas.' });
    const b = req.body || {};
    if (b.agree !== true) return reply.code(400).send({ error: 'agree_required', note: 'Marca la casilla de aceptación.' });
    const { terms, hash, doc } = await loadTerms(rows[0]);
    if (String(b.version || '') !== hash) {
      return reply.code(409).send({ error: 'version_changed', note: 'Las condiciones cambiaron mientras leías. Revisa la nueva versión y acepta de nuevo.', version: hash });
    }
    if (tooManyFails(uid)) return reply.code(429).send({ error: 'too_many_attempts', note: 'Demasiados intentos con PIN incorrecto. Intenta de nuevo en 15 minutos.' });
    const me = (await query(`SELECT pin_hash FROM users WHERE id=$1 AND deleted_at IS NULL`, [uid])).rows[0];
    if (!me || !verifyPin(String(b.pin || ''), me.pin_hash)) {
      noteFail(uid);
      await logEvent({ userId: uid, action: 'agree_fail', target: `commission_agreement:${uid}`, detail: { reason: 'bad_pin', version: hash } });
      return reply.code(403).send({ error: 'bad_pin', note: 'PIN incorrecto.' });
    }
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    const r = (await query(
      `INSERT INTO commission_agreements (user_id, version_hash, agent_type, terms, doc, summary, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING ${AGREE_COLS}`,
      [uid, hash, terms.type, JSON.stringify(terms), JSON.stringify(doc), summaryKo(terms), req.ip || null, ua || null])).rows[0];
    fails.delete(uid);
    await logEvent({ userId: uid, action: 'agree', target: `commission_agreement:${r.id}`, detail: { version: hash } });
    return { ok: true, id: Number(r.id), version: hash, agreed_at: r.agreed_at_local, device: deviceLabel(r.user_agent) };
  });

  // ── 현황판 (디렉터·재무·소시오) ──
  app.get('/api/commission/agreement/board', { preHandler: [authGuard] }, async (req, reply) => {
    if (!canSeeAll(req.ctx.perm)) return reply.code(403).send({ error: 'forbidden' });
    const ready = await tableReady();
    const out = [];
    for (const u of await agentRows()) {
      const { terms, hash } = await loadTerms(u);
      const hist = ready ? await history(Number(u.id)) : [];
      const latest = hist[0] || null;
      out.push({
        user_id: Number(u.id), name: u.name, team_name: u.team_name, type: terms.type,
        summary: summaryKo(terms), version: hash,
        status: statusOf(hash, latest ? { version_hash: latest.version } : null),
        latest, count: hist.length,
      });
    }
    const n = (s) => out.filter((x) => x.status === s).length;
    return { migrated: ready, items: out, counts: { agreed: n('agreed'), pending: n('pending'), changed: n('changed') } };
  });

  // ── 특정 사원의 현재 문서 미리보기 (디렉터·재무·소시오) ──
  app.get('/api/commission/agreement/preview/:uid', { preHandler: [authGuard] }, async (req, reply) => {
    if (!canSeeAll(req.ctx.perm)) return reply.code(403).send({ error: 'forbidden' });
    const rows = await agentRows(Number(req.params.uid));
    if (!rows.length) return reply.code(404).send({ error: 'not_agent' });
    const { terms, hash, doc } = await loadTerms(rows[0]);
    const hist = await history(Number(rows[0].id));
    return {
      user_id: Number(rows[0].id), name: rows[0].name, version: hash, doc, terms,
      status: statusOf(hash, hist[0] ? { version_hash: hist[0].version } : null),
      history: hist.map((h) => ({ ...h, current: h.version === hash })),
    };
  });

  // ── 합의 당시 문서 원문(스냅샷) — 본인 또는 전체열람자 ──
  app.get('/api/commission/agreement/doc/:id', { preHandler: [authGuard] }, async (req, reply) => {
    if (!(await tableReady())) return reply.code(404).send({ error: 'not_found' });
    const r = (await query(`SELECT ${AGREE_COLS}, doc, terms FROM commission_agreements WHERE id=$1`, [Number(req.params.id)])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeAll(req.ctx.perm) && Number(r.user_id) !== Number(req.ctx.perm.userId)) return reply.code(403).send({ error: 'forbidden' });
    return {
      id: Number(r.id), user_id: Number(r.user_id), version: r.version_hash, agreed_at: r.agreed_at_local,
      ip: canSeeAll(req.ctx.perm) ? r.ip : null, device: deviceLabel(r.user_agent), doc: r.doc, terms: r.terms,
    };
  });
}
