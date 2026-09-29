// =====================================================================
// 고객 독점 정책 (공지 2026-09-28 시행 · 디렉터 확정 2026-09-29) — 0235
//
//   대상: customers.excl_policy = true (2026-09-28 이전 매출이 없던 고객 + 이후 신규 고객)
//
//   1) RFC 독점 30일  — 기산일 = 디렉터 승인일(customers.rfc_excl_from). 기산일 포함 30일.
//                       그 안에 등록자가 첫 인보이스를 내면 → 그 날부터 판매 독점 1년.
//                       못 내면 자동 소멸 → 누구나 판매 가능.
//   2) 판매 독점 1년  — 첫 인보이스(개방 상태에서는 그 인보이스의 판매 영업사원) 날짜부터.
//                       기간 안에 서로 다른 6개월 이상 매출 → 같은 사람에게 +1년 자동 연장.
//                       못 채우면 개방 → 다음 인보이스를 낸 사람이 새 1년.
//   3) 커미션        — 인보이스 날짜의 독점권자로 **고정**(sales_invoices.commission_agent_id).
//                       기존 거래 고객(excl_policy=false)은 발행 시점 고객 담당자로 고정.
//
//   판정은 언제나 등록일·인보이스 이력에서 **새로 계산**한다(캐시는 목록 배지용).
//   만료가 날짜로 결정되므로 크론이 필요 없다. 인보이스 삭제·NC·금액조정 뒤에는 다시 계산한다.
// =====================================================================
import { query, withTx } from './db.js';

export const RFC_DAYS = 30;          // 기산일 포함 30일
export const RENEW_MONTHS = 6;       // 1년 안에 서로 다른 6개월
export const POLICY_START = '2026-09-28';

// ── 날짜(YYYY-MM-DD 문자열) ─────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
function parse(ymd) { const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number); return { y, m, d }; }
function fmt(dt) { return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`; }
export function addDays(ymd, n) {
  const { y, m, d } = parse(ymd);
  return fmt(new Date(Date.UTC(y, m - 1, d + n)));
}
// 1년 기간의 마지막 날(포함): 2026-10-03 → 2027-10-02. 2/29 시작은 다음 해 2/28.
export function yearEnd(ymd) {
  const { y, m, d } = parse(ymd);
  const lastDay = new Date(Date.UTC(y + 1, m, 0)).getUTCDate();
  const same = fmt(new Date(Date.UTC(y + 1, m - 1, Math.min(d, lastDay))));
  return d > lastDay ? same : addDays(same, -1);
}
export function daysBetween(a, b) {   // b - a (일)
  const pa = parse(a), pb = parse(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
}
export function todayMx(now = new Date()) {
  // America/Mexico_City (DST 없음, UTC-6)
  return fmt(new Date(now.getTime() - 6 * 3600 * 1000));
}

// ── 순수 계산 ─────────────────────────────────────────────────────────
// input: { rfcFrom, rfcAgent, invoices:[{id, date, seller, net}], today }
//   invoices: 삭제되지 않은 인보이스. net = ex-IVA 매출 − 적용 NC. net ≤ 0(전액 반품)은
//   기간을 시작·연장하지 않는다(귀속만 받는다). 최소 금액은 없다.
// output: { periods:[{kind, agent, starts_on, ends_on, source_invoice_id, months:[YYYY-MM], renewed}],
//           invoiceAgent:{id:agent}, current: period|null, open: boolean }
export function computeExclusivity({ rfcFrom = null, rfcAgent = null, invoices = [], today }) {
  const td = today || todayMx();
  const invs = [...invoices]
    .filter((i) => i && i.date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : Number(a.id) - Number(b.id)));
  const periods = [];
  const invoiceAgent = {};
  let cur = null;

  if (rfcFrom && rfcAgent) {
    cur = { kind: 'rfc', agent: Number(rfcAgent), starts_on: rfcFrom, ends_on: addDays(rfcFrom, RFC_DAYS - 1),
      source_invoice_id: null, months: [], renewed: false };
  }
  const newSale = (agent, start, srcId, renewed = false) => ({ kind: 'sale', agent: agent == null ? null : Number(agent),
    starts_on: start, ends_on: yearEnd(start), source_invoice_id: srcId, months: [], renewed });

  // 기간이 끝난 뒤 date 가 오면: 판매 독점은 6개월 충족 시 연장, 아니면 닫는다.
  const rollTo = (date) => {
    while (cur && date > cur.ends_on) {
      periods.push(cur);
      if (cur.kind === 'sale' && cur.months.length >= RENEW_MONTHS) {
        cur = newSale(cur.agent, addDays(cur.ends_on, 1), null, true);
      } else {
        cur = null;
      }
    }
  };

  for (const inv of invs) {
    const counted = Number(inv.net) > 0;
    rollTo(inv.date);
    let agent;
    if (!cur) {
      agent = inv.seller == null ? null : Number(inv.seller);
      if (counted && agent != null) cur = newSale(agent, inv.date, Number(inv.id));
    } else if (cur.kind === 'rfc') {
      agent = cur.agent;                         // RFC 독점 중에는 등록자에게 귀속
      if (counted) {
        if (inv.date > cur.starts_on) periods.push({ ...cur, ends_on: addDays(inv.date, -1) });
        cur = newSale(cur.agent, inv.date, Number(inv.id));
      }
    } else {
      agent = cur.agent;
    }
    if (counted && cur && cur.kind === 'sale') {
      const ym = inv.date.slice(0, 7);
      if (!cur.months.includes(ym)) cur.months.push(ym);
    }
    invoiceAgent[inv.id] = agent;
  }
  rollTo(td);
  if (cur) periods.push(cur);
  const current = cur && td >= cur.starts_on && td <= cur.ends_on ? cur : null;
  return { periods, invoiceAgent, current, open: !current };
}

// ── DB 로딩 ───────────────────────────────────────────────────────────
async function colReady() {
  const r = await query(`SELECT 1 FROM information_schema.columns
                          WHERE table_name='customers' AND column_name='excl_policy'`);
  return r.rows.length > 0;
}
let readyCache = null;
export async function exclusivityReady() {
  if (readyCache === true) return true;
  readyCache = await colReady();
  return readyCache;
}

export async function loadInput(q, customerId) {
  const c = (await q(
    `SELECT c.id, c.name, c.excl_policy, c.doc_gate, c.owner_id, c.team_id,
            to_char(c.rfc_excl_from,'YYYY-MM-DD') AS rfc_excl_from, c.rfc_excl_agent_id
       FROM customers c WHERE c.id=$1`, [customerId])).rows[0];
  if (!c) return null;
  const invoices = (await q(
    `SELECT i.id, to_char(i.inv_date,'YYYY-MM-DD') AS date, i.seller_id AS seller,
            i.subtotal_mxn - COALESCE((SELECT SUM(n.base_mxn) FROM notas_credito n
                                        WHERE n.invoice_id=i.id AND n.status='applied'),0) AS net
       FROM sales_invoices i
      WHERE i.customer_id=$1 AND i.deleted_at IS NULL AND COALESCE(i.status,'posted') <> 'deleted'
      ORDER BY i.inv_date, i.id`, [customerId])).rows
    .map((r) => ({ id: Number(r.id), date: r.date, seller: r.seller == null ? null : Number(r.seller), net: Number(r.net) }));
  return { customer: c, invoices };
}

export async function evaluate(q, customerId, today) {
  const inp = await loadInput(q, customerId);
  if (!inp) return null;
  const c = inp.customer;
  if (!c.excl_policy) return { customer: c, policy: false, current: null, open: false, periods: [], invoiceAgent: {} };
  const r = computeExclusivity({ rfcFrom: c.rfc_excl_from, rfcAgent: c.rfc_excl_agent_id, invoices: inp.invoices, today });
  return { customer: c, policy: true, ...r };
}

// ── 판매 가능 여부 (견적 저장 · 매출 등록 · 전환) ──────────────────────
//   · 독점 중 → 판매 영업사원은 독점권자로 고정. 영업(role=sales)이 남의 독점 고객을 팔면 차단.
//     디렉터·영업지원은 대신 등록할 수 있다(판매자는 독점권자).
//   · 개방 → 판매 영업사원 필수(영업 본인이면 자동). 그 사람이 첫 인보이스로 1년 독점을 가져간다.
//   · 기존 거래 고객 → 판매자 = 요청값 → 영업 본인 → 고객 담당자.
// returns { ok, seller_id, holder, error, note, code }
export async function resolveSeller(q, { customerId, requestedSeller, perm }) {
  if (!(await exclusivityReady())) return { ok: true, seller_id: requestedSeller || null };
  const ev = await evaluate(q, customerId);
  if (!ev) return { ok: false, code: 404, error: 'customer_not_found' };
  const actorIsRep = perm && perm.role === 'sales';
  const actor = perm ? Number(perm.userId) : null;
  const req = requestedSeller ? Number(requestedSeller) : null;
  if (!ev.policy) {
    return { ok: true, seller_id: req || (actorIsRep ? actor : null) || (ev.customer.owner_id ? Number(ev.customer.owner_id) : null) };
  }
  if (ev.current) {
    const holder = Number(ev.current.agent);
    const name = await userName(q, holder);
    if (actorIsRep && actor !== holder) {
      return { ok: false, code: 409, error: 'exclusive_other', holder: { id: holder, name, until: ev.current.ends_on, kind: ev.current.kind },
        note: `이 고객은 ${name} 님의 독점 고객입니다(${ev.current.ends_on} 까지). 독점 기간 중에는 다른 영업사원이 판매할 수 없습니다.` };
    }
    return { ok: true, seller_id: holder, holder: { id: holder, name, until: ev.current.ends_on, kind: ev.current.kind }, locked: true };
  }
  const seller = req || (actorIsRep ? actor : null);
  if (!seller) {
    return { ok: false, code: 400, error: 'seller_required',
      note: '독점권이 없는(개방) 고객입니다. 판매 영업사원을 선택하세요 — 이 판매로 그 영업사원이 1년 독점권을 갖습니다.' };
  }
  if (actorIsRep && seller !== actor) {
    return { ok: false, code: 403, error: 'seller_self_only', note: '영업사원은 본인 이름으로만 판매할 수 있습니다.' };
  }
  return { ok: true, seller_id: seller, open: true };
}

async function userName(q, id) {
  if (!id) return null;
  const r = (await q(`SELECT name FROM users WHERE id=$1`, [id])).rows[0];
  return r ? r.name : `#${id}`;
}

// ── 재계산: 인보이스 귀속 + 캐시 + 담당자 동기화 ───────────────────────
//   독점권자가 바뀌면 고객마스터 담당자(와 팀)도 옮긴다 — 화면·팀 가시성이 그대로 따라온다.
//   이미 지급된 커미션은 commission_payouts 로 동결되므로(BENEFICIARY) 여기서 건드려도 안전하다.
export async function recomputeCustomer(customerId, { today } = {}) {
  if (!customerId || !(await exclusivityReady())) return null;
  return withTx(async (c) => {
    const q = c.query.bind(c);
    await q(`SELECT id FROM customers WHERE id=$1 FOR UPDATE`, [customerId]);
    const ev = await evaluate(q, customerId, today);
    if (!ev || !ev.policy) return ev;
    for (const [id, agent] of Object.entries(ev.invoiceAgent)) {
      await q(`UPDATE sales_invoices SET commission_agent_id=$1
                WHERE id=$2 AND commission_agent_id IS DISTINCT FROM $1`, [agent, Number(id)]);
    }
    const cur = ev.current;
    await q(`UPDATE customers SET excl_kind=$1, excl_agent_id=$2, excl_until=$3, excl_synced_at=now()
              WHERE id=$4`, [cur ? cur.kind : null, cur ? cur.agent : null, cur ? cur.ends_on : null, customerId]);
    if (cur && cur.agent && Number(ev.customer.owner_id) !== Number(cur.agent)) {
      const u = (await q(`SELECT team_id FROM users WHERE id=$1`, [cur.agent])).rows[0];
      await q(`UPDATE customers SET owner_id=$1, team_id=COALESCE($2, team_id) WHERE id=$3`,
        [cur.agent, u ? u.team_id : null, customerId]);
    }
    return ev;
  });
}

// 기동 시·하루 한 번: 독점 대상 고객 전체 캐시 갱신(만료 반영). 실패해도 서비스는 계속.
export async function sweepAll(log) {
  if (!(await exclusivityReady())) return 0;
  const ids = (await query(`SELECT id FROM customers WHERE excl_policy AND deleted_at IS NULL ORDER BY id`)).rows;
  let n = 0;
  for (const r of ids) {
    try { await recomputeCustomer(Number(r.id)); n += 1; } catch (e) { log?.warn?.({ err: e, customer: r.id }, 'exclusivity sweep'); }
  }
  return n;
}

export function startExclusivitySweep(app) {
  const run = () => sweepAll(app.log).then((n) => app.log.info(`[exclusivity] swept ${n}`)).catch(() => {});
  setTimeout(run, 15000).unref?.();
  setInterval(run, 6 * 3600 * 1000).unref?.();
}

// ── 변경 요청 뒤 자동 재계산 (삭제·수정 승인·NC·금액조정·일자변경) ──────
const HOOK_PATTERNS = [
  { re: /^\/api\/sales\/change-requests\/(\d+)\/approve/, sql: `SELECT i.customer_id FROM sales_change_requests r JOIN sales_invoices i ON i.id=r.invoice_id WHERE r.id=$1` },
  { re: /^\/api\/sales\/(\d+)(\/(inv-date|adjust-total|sat-no))?$/, sql: `SELECT customer_id FROM sales_invoices WHERE id=$1` },
  { re: /^\/api\/nc\/(\d+)(\/(apply|void))?$/, sql: `SELECT customer_id FROM notas_credito WHERE id=$1` },
];
export function registerExclusivityHooks(app) {
  app.addHook('onResponse', async (req, reply) => {
    if (req.method === 'GET' || reply.statusCode >= 300) return;
    const url = String(req.url || '').split('?')[0];
    for (const p of HOOK_PATTERNS) {
      const m = url.match(p.re);
      if (!m) continue;
      try {
        const r = (await query(p.sql, [Number(m[1])])).rows[0];
        if (r && r.customer_id) await recomputeCustomer(Number(r.customer_id));
      } catch (e) { app.log.warn({ err: e }, 'exclusivity hook'); }
      return;
    }
  });
}

// ── 화면용 요약 ─────────────────────────────────────────────────────────
export async function statusFor(customerId) {
  const ready = await exclusivityReady();
  if (!ready) return { ready: false };
  const ev = await evaluate(query, customerId);
  if (!ev) return null;
  const c = ev.customer;
  const td = todayMx();
  const names = {};
  const ids = [...new Set(ev.periods.map((p) => p.agent).filter(Boolean))];
  if (ids.length) {
    for (const r of (await query(`SELECT id, name FROM users WHERE id = ANY($1)`, [ids])).rows) names[Number(r.id)] = r.name;
  }
  const out = (p) => p && ({
    kind: p.kind, agent_id: p.agent, agent_name: names[p.agent] || null, starts_on: p.starts_on, ends_on: p.ends_on,
    days_left: daysBetween(td, p.ends_on), months: p.months.length, months_needed: p.kind === 'sale' ? RENEW_MONTHS : null,
    renewed: p.renewed,
  });
  const docs = (await query(
    `SELECT doc_type FROM customer_documents WHERE customer_id=$1 AND deleted_at IS NULL`, [customerId])).rows.map((r) => r.doc_type);
  const has = (t) => docs.includes(t);
  const disc = (await query(`SELECT discount, credit_days, discount_agreed, credit_days_agreed FROM customers WHERE id=$1`, [customerId])).rows[0] || {};
  return {
    ready: true, policy: ev.policy, today: td,
    current: out(ev.current), open: ev.policy && !ev.current,
    history: ev.periods.map(out),
    gate: {
      applies: !!c.doc_gate,
      discount_ok: !c.doc_gate || (has('constancia') && has('domicilio')),
      credit_ok: !c.doc_gate || has('factura_compra'),
      missing: c.doc_gate ? ['constancia', 'domicilio', 'factura_compra'].filter((t) => !has(t)) : [],
      discount_agreed: disc.discount_agreed == null ? null : Number(disc.discount_agreed),
      discount_effective: disc.discount == null ? 0 : Number(disc.discount),
      credit_days_agreed: disc.credit_days_agreed == null ? null : Number(disc.credit_days_agreed),
      credit_days_effective: disc.credit_days == null ? 0 : Number(disc.credit_days),
    },
  };
}
