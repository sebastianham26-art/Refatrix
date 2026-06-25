import { query, withTx } from '../db.js';
import { authGuard, requirePage, requirePageEdit, requireDirector } from '../middleware/authGuard.js';
import { round2 } from '../permissions.js';
import { logEvent } from '../audit.js';

// 반제(완납) 다음 달 15일
function nextMonth15(ym) {
  if (!ym) return null;
  const [y, m] = ym.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-15`;
}

// 열람 범위: 디렉터·재무담당·소시오 = 전체 영업사원 / 그 외(영업사원) = 본인만
export const SEE_ALL_ROLES = ['director', 'treasury', 'socio'];
// 지급(반제) 가능: 디렉터·재무담당
export const PAY_ROLES = ['director', 'treasury'];
export const canSeeAll = (perm) => SEE_ALL_ROLES.includes(perm.role);

// 인보이스별 확정 커미션 계산 (순수). row: subtotal_mxn,total_mxn,default_rate,cust_rate,paid_amount,last_pay_date
export function computeLine(r) {
  const rate = r.cust_rate != null ? Number(r.cust_rate) : (r.default_rate != null ? Number(r.default_rate) : 0);
  const base = Number(r.subtotal_mxn);
  const expected = round2(base * rate / 100);
  const paidAmt = Number(r.paid_amount || 0);
  const fullyPaid = paidAmt + 0.01 >= Number(r.total_mxn) && Number(r.total_mxn) > 0;
  const settleYm = fullyPaid && r.last_pay_date ? String(r.last_pay_date).slice(0, 7) : null;
  return { rate, base, expected, fullyPaid, settleYm, confirmed: fullyPaid ? expected : 0 };
}

// FIFO 충당 (순수·단위테스트용). lines: 확정·미지급 라인(오래된 순), 각 {invoice_id, expected, settle_ym}
// 인보이스 단위로만 충당(부분충당 없음). 남는 금액은 leftover 로 반환.
export function allocateFifo(lines, amount) {
  let remaining = round2(Number(amount) || 0);
  const allocs = [];
  for (const l of lines) {
    const exp = round2(Number(l.expected) || 0);
    if (exp <= 0) continue;
    if (exp <= remaining + 0.001) {
      allocs.push({ invoice_id: l.invoice_id, amount: exp, settle_ym: l.settle_ym || null });
      remaining = round2(remaining - exp);
    } else {
      break; // 다음 인보이스 커미션이 남은 금액보다 크면 멈춤(부분충당 안 함)
    }
  }
  const settled = round2(allocs.reduce((s, a) => s + a.amount, 0));
  return { allocs, settled, leftover: round2((Number(amount) || 0) - settled) };
}

const PAYABLE_SQL = `
  SELECT i.id AS invoice_id, i.sat_no, i.inv_date, i.subtotal_mxn, i.total_mxn,
         c.name AS customer_name, c.code AS customer_code,
         ca.default_rate, ccr.rate AS cust_rate,
         COALESCE(pa.paid_amount,0) AS paid_amount, pa.last_pay_date
    FROM sales_invoices i
    JOIN customers c ON c.id=i.customer_id
    JOIN commission_agents ca ON ca.user_id=i.owner_id AND ca.active=true
    LEFT JOIN commission_customer_rates ccr ON ccr.user_id=i.owner_id AND ccr.customer_id=i.customer_id
    LEFT JOIN (
      SELECT spa.invoice_id, SUM(spa.amount) AS paid_amount, to_char(MAX(sp.pay_date),'YYYY-MM-DD') AS last_pay_date
        FROM sales_payment_allocations spa JOIN sales_payments sp ON sp.id=spa.payment_id
       GROUP BY spa.invoice_id
    ) pa ON pa.invoice_id=i.id
    LEFT JOIN commission_payouts cp ON cp.invoice_id=i.id
   WHERE i.status <> 'deleted' AND i.owner_id=$1
     AND COALESCE(cp.paid,false)=false
   ORDER BY i.inv_date ASC, i.id ASC`;

// 한 영업사원의 확정(반제완납)·미지급 커미션 라인(FIFO 순) 반환
async function payableLines(agentId) {
  const rows = (await query(PAYABLE_SQL, [agentId])).rows;
  const out = [];
  for (const r of rows) {
    const c = computeLine(r);
    if (!c.fullyPaid || c.expected <= 0) continue; // 확정·금액>0 인 것만
    out.push({
      invoice_id: r.invoice_id, sat_no: r.sat_no, inv_date: String(r.inv_date).slice(0, 10),
      customer_name: r.customer_name, customer_code: r.customer_code,
      rate: c.rate, base: c.base, expected: c.expected, settle_ym: c.settleYm,
      due_date: c.settleYm ? nextMonth15(c.settleYm) : null,
    });
  }
  return out;
}

function parseDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  const mime = m[1];
  const ok = mime.startsWith('image/') || mime === 'application/pdf';
  if (!ok) return null;
  return { mime, b64: m[2] };
}

export default async function commissionRoutes(app) {
  // ── 커미션 대상 영업사원 + 기본률 목록 (디렉터) ──
  app.get('/api/commission/agents', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    let rows;
    try {
      rows = (await query(
        `SELECT u.id AS user_id, u.name, u.role, t.name AS team_name,
                ca.default_rate, ca.active, ca.note
           FROM users u
           LEFT JOIN sales_teams t ON t.id=u.team_id
           LEFT JOIN commission_agents ca ON ca.user_id=u.id
          WHERE u.deleted_at IS NULL AND u.role IN ('sales','sales_support')
          ORDER BY t.sort_order NULLS LAST, u.name`)).rows;
    } catch (e) {
      if (e && e.code === '42P01') return reply.code(503).send({ error: 'commission_not_migrated', note: '커미션 테이블이 없습니다. 서버에서 마이그레이션(npm run migrate · 0055)을 실행하세요.' });
      throw e;
    }
    return {
      items: rows.map((r) => ({
        user_id: r.user_id, name: r.name, role: r.role, team_name: r.team_name,
        default_rate: r.default_rate != null ? Number(r.default_rate) : null,
        active: r.active === true, is_agent: r.default_rate != null, note: r.note || null,
      })),
    };
  });

  // ── 커미션 대상 지정/수정 (디렉터) ──
  app.post('/api/commission/agents', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const { user_id, default_rate, active = true, note } = req.body || {};
    if (!user_id || default_rate == null) return reply.code(400).send({ error: 'user_id_rate_required' });
    const uid = req.ctx.perm.userId;
    await query(
      `INSERT INTO commission_agents (user_id, default_rate, active, note, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$5)
       ON CONFLICT (user_id) DO UPDATE SET default_rate=$2, active=$3, note=$4, updated_by=$5, updated_at=now()`,
      [user_id, default_rate, active === true, note || null, uid]);
    await logEvent({ userId: uid, action: 'update', target: `commission_agent:${user_id}`, detail: { default_rate, active } });
    return { ok: true };
  });

  // ── 고객별 예외율 지정/삭제 (디렉터) ──
  app.post('/api/commission/customer-rate', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const { user_id, customer_id, rate } = req.body || {};
    if (!user_id || !customer_id) return reply.code(400).send({ error: 'user_customer_required' });
    const uid = req.ctx.perm.userId;
    if (rate == null || rate === '') {
      await query(`DELETE FROM commission_customer_rates WHERE user_id=$1 AND customer_id=$2`, [user_id, customer_id]);
      return { ok: true, removed: true };
    }
    await query(
      `INSERT INTO commission_customer_rates (user_id, customer_id, rate, created_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, customer_id) DO UPDATE SET rate=$3`,
      [user_id, customer_id, rate, uid]);
    return { ok: true };
  });

  app.get('/api/commission/customer-rates', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const args = []; let cond = '';
    if (req.query.user_id) { args.push(Number(req.query.user_id)); cond = ` WHERE ccr.user_id=$1`; }
    const rows = (await query(
      `SELECT ccr.user_id, ccr.customer_id, ccr.rate, c.name AS customer_name, c.code AS customer_code
         FROM commission_customer_rates ccr JOIN customers c ON c.id=ccr.customer_id${cond}
        ORDER BY c.name`, args)).rows;
    return { items: rows.map((r) => ({ ...r, rate: Number(r.rate) })) };
  });

  // ── 커미션 내역 (영업사원 본인 / 디렉터·재무·소시오 전체·영업사원별) ──
  app.get('/api/commission/overview', { preHandler: [authGuard, requirePage('commission')] }, async (req) => {
    const perm = req.ctx.perm;
    const seeAll = canSeeAll(perm);
    const canPay = PAY_ROLES.includes(perm.role);
    const view = ['customer', 'month', 'all'].includes(req.query.view) ? req.query.view : 'customer';

    const args = [];
    let ownerCond = '';
    if (!seeAll) { args.push(Number(perm.userId)); ownerCond = ` AND i.owner_id=$${args.length}`; }
    else if (req.query.agent_id) { args.push(Number(req.query.agent_id)); ownerCond = ` AND i.owner_id=$${args.length}`; }

    let rows;
    try {
      rows = (await query(
        `SELECT i.id AS invoice_id, i.sat_no, i.inv_date, i.subtotal_mxn, i.total_mxn,
              i.owner_id, ag.name AS agent_name,
              c.id AS customer_id, c.name AS customer_name, c.code AS customer_code,
              ca.default_rate, ccr.rate AS cust_rate,
              COALESCE(pa.paid_amount,0) AS paid_amount, pa.last_pay_date,
              cp.paid AS payout_paid, cp.paid_date AS payout_paid_date
         FROM sales_invoices i
         JOIN customers c ON c.id=i.customer_id
         JOIN commission_agents ca ON ca.user_id=i.owner_id AND ca.active=true
         JOIN users ag ON ag.id=i.owner_id
         LEFT JOIN commission_customer_rates ccr ON ccr.user_id=i.owner_id AND ccr.customer_id=i.customer_id
         LEFT JOIN (
           SELECT spa.invoice_id, SUM(spa.amount) AS paid_amount, to_char(MAX(sp.pay_date),'YYYY-MM-DD') AS last_pay_date
             FROM sales_payment_allocations spa JOIN sales_payments sp ON sp.id=spa.payment_id
            GROUP BY spa.invoice_id
         ) pa ON pa.invoice_id=i.id
         LEFT JOIN commission_payouts cp ON cp.invoice_id=i.id
        WHERE i.status <> 'deleted'${ownerCond}
        ORDER BY i.inv_date DESC, i.id DESC`, args)).rows;
    } catch (e) {
      if (e && e.code === '42P01') return { view, is_director: perm.role === 'director', can_pay: canPay, see_all: seeAll, agent_id: null, not_migrated: true, summary: { invoice_count: 0, total_base: 0, total_expected: 0, total_confirmed: 0, total_paid: 0, total_unpaid: 0 }, groups: [], by_agent: null };
      throw e;
    }

    const lines = rows.map((r) => {
      const c = computeLine(r);
      return {
        invoice_id: r.invoice_id, sat_no: r.sat_no, inv_date: String(r.inv_date).slice(0, 10),
        agent_id: r.owner_id, agent_name: r.agent_name,
        customer_id: r.customer_id, customer_name: r.customer_name, customer_code: r.customer_code,
        rate: c.rate, base: c.base, expected: c.expected, confirmed: c.confirmed,
        fully_paid: c.fullyPaid, settle_ym: c.settleYm,
        due_date: c.settleYm ? nextMonth15(c.settleYm) : null,
        paid: r.payout_paid === true, paid_date: r.payout_paid_date ? String(r.payout_paid_date).slice(0, 10) : null,
      };
    });

    const sum = (arr, k) => round2(arr.reduce((s, x) => s + Number(x[k] || 0), 0));
    const summary = {
      invoice_count: lines.length,
      total_base: sum(lines, 'base'),
      total_expected: sum(lines, 'expected'),
      total_confirmed: sum(lines, 'confirmed'),
      total_paid: sum(lines.filter((l) => l.paid), 'confirmed'),
      total_unpaid: round2(sum(lines.filter((l) => l.fully_paid && !l.paid), 'confirmed')),
    };

    let groups = [];
    if (view === 'customer') {
      const by = {};
      for (const l of lines) {
        const g = (by[l.customer_id] ||= { key: l.customer_id, label: `${l.customer_code || ''} ${l.customer_name}`.trim(), lines: [] });
        g.lines.push(l);
      }
      groups = Object.values(by);
    } else if (view === 'month') {
      const by = {};
      for (const l of lines) {
        const ym = l.inv_date.slice(0, 7);
        const g = (by[ym] ||= { key: ym, label: ym, lines: [] });
        g.lines.push(l);
      }
      groups = Object.values(by).sort((a, b) => b.key.localeCompare(a.key));
    } else {
      groups = [{ key: 'all', label: '전체', lines }];
    }
    groups = groups.map((g) => ({
      key: g.key, label: g.label,
      invoice_count: g.lines.length,
      base: sum(g.lines, 'base'),
      expected: sum(g.lines, 'expected'),
      confirmed: sum(g.lines, 'confirmed'),
      lines: g.lines,
    }));

    let byAgent = null;
    if (seeAll && !req.query.agent_id) {
      const by = {};
      for (const l of lines) {
        const a = (by[l.agent_id] ||= { agent_id: l.agent_id, agent_name: l.agent_name, lines: [] });
        a.lines.push(l);
      }
      byAgent = Object.values(by).map((a) => ({
        agent_id: a.agent_id, agent_name: a.agent_name,
        invoice_count: a.lines.length,
        expected: sum(a.lines, 'expected'),
        confirmed: sum(a.lines, 'confirmed'),
        paid: round2(sum(a.lines.filter((l) => l.paid), 'confirmed')),
        unpaid: round2(sum(a.lines.filter((l) => l.fully_paid && !l.paid), 'confirmed')),
      }));
    }

    return { view, is_director: perm.role === 'director', can_pay: canPay, see_all: seeAll, agent_id: req.query.agent_id ? Number(req.query.agent_id) : null, summary, groups, by_agent: byAgent };
  });

  // ── 지급 대상(확정·미지급) 라인 + 합계 (전체열람자 or 본인) ──
  app.get('/api/commission/payable', { preHandler: [authGuard, requirePage('commission')] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const seeAll = canSeeAll(perm);
    const agentId = seeAll ? Number(req.query.agent_id || 0) : Number(perm.userId);
    if (!agentId) return reply.code(400).send({ error: 'agent_required', note: '영업사원을 선택하세요.' });
    if (!seeAll && Number(req.query.agent_id) && Number(req.query.agent_id) !== Number(perm.userId)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    let lines;
    try { lines = await payableLines(agentId); }
    catch (e) { if (e && e.code === '42P01') return { agent_id: agentId, not_migrated: true, lines: [], total: 0 }; throw e; }
    const total = round2(lines.reduce((s, l) => s + Number(l.expected || 0), 0));
    return { agent_id: agentId, can_pay: PAY_ROLES.includes(perm.role), lines, total };
  });

  // ── 지급 전표 등록 + 반제(FIFO) + 증빙 (디렉터·재무) ──
  app.post('/api/commission/payments', { preHandler: [authGuard, requirePageEdit('commission')] }, async (req, reply) => {
    const perm = req.ctx.perm; const uid = perm.userId;
    const { agent_id, amount, paid_date, note, evidence } = req.body || {};
    const agentId = Number(agent_id);
    const amt = round2(Number(amount));
    if (!agentId || !(amt > 0)) return reply.code(400).send({ error: 'agent_amount_required' });
    const evi = parseDataUrl(evidence);
    if (!evi) return reply.code(400).send({ error: 'evidence_required', note: '은행 송금증 또는 시스템 화면 캡처(이미지/PDF)를 증빙으로 첨부해야 지급으로 인정됩니다.' });
    const payDate = (paid_date && /^\d{4}-\d{2}-\d{2}$/.test(paid_date)) ? paid_date : new Date().toISOString().slice(0, 10);

    let lines;
    try { lines = await payableLines(agentId); }
    catch (e) { if (e && e.code === '42P01') return reply.code(503).send({ error: 'commission_not_migrated', note: '커미션 지급 테이블이 없습니다. npm run migrate(0086)을 실행하세요.' }); throw e; }
    if (!lines.length) return reply.code(409).send({ error: 'nothing_payable', note: '이 영업사원의 확정(반제완납)·미지급 커미션이 없습니다.' });

    const { allocs, settled, leftover } = allocateFifo(lines, amt);
    if (!allocs.length) return reply.code(409).send({ error: 'amount_too_small', note: `가장 오래된 미지급 커미션(${round2(lines[0].expected)})보다 지급액이 적습니다. 인보이스 단위로 충당됩니다.` });

    const result = await withTx(async (cx) => {
      const pay = (await cx.query(
        `INSERT INTO commission_payments (agent_id, amount, settled, paid_date, note, evi_name, evi_mime, evi_data, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [agentId, amt, settled, payDate, note || null, (req.body?.evi_name || null), evi.mime, evi.b64, uid])).rows[0];
    const paymentId = pay.id;
      for (const a of allocs) {
        await cx.query(
          `INSERT INTO commission_payment_allocations (payment_id, invoice_id, amount) VALUES ($1,$2,$3)`,
          [paymentId, a.invoice_id, a.amount]);
        await cx.query(
          `INSERT INTO commission_payouts (invoice_id, agent_id, amount, settle_ym, due_date, paid, paid_date, payment_id, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8,$8)
           ON CONFLICT (invoice_id) DO UPDATE SET amount=$3, settle_ym=$4, due_date=$5, paid=true, paid_date=$6, payment_id=$7, updated_by=$8, updated_at=now()`,
          [a.invoice_id, agentId, a.amount, a.settle_ym, a.settle_ym ? nextMonth15(a.settle_ym) : null, payDate, paymentId, uid]);
      }
      return { paymentId };
    });

    await logEvent({ userId: uid, action: 'create', target: `commission_payment:${result.paymentId}`, detail: { agent_id: agentId, amount: amt, settled, count: allocs.length } });
    return { ok: true, payment_id: result.paymentId, settled_count: allocs.length, settled, leftover, total_paid_amount: amt };
  });

  // ── 지급 전표 목록 (전체열람자 or 본인) — 증빙 데이터 제외 ──
  app.get('/api/commission/payments', { preHandler: [authGuard, requirePage('commission')] }, async (req, reply) => {
    const perm = req.ctx.perm; const seeAll = canSeeAll(perm);
    const args = []; let cond = '';
    if (!seeAll) { args.push(Number(perm.userId)); cond = ` AND p.agent_id=$${args.length}`; }
    else if (req.query.agent_id) { args.push(Number(req.query.agent_id)); cond = ` AND p.agent_id=$${args.length}`; }
    let rows;
    try {
      rows = (await query(
        `SELECT p.id, p.agent_id, ag.name AS agent_name, p.amount, p.settled, p.paid_date, p.note,
                p.evi_name, p.evi_mime, p.created_at,
                (SELECT COUNT(*) FROM commission_payment_allocations a WHERE a.payment_id=p.id) AS alloc_count
           FROM commission_payments p JOIN users ag ON ag.id=p.agent_id
          WHERE 1=1${cond}
          ORDER BY p.paid_date DESC, p.id DESC`, args)).rows;
    } catch (e) {
      if (e && e.code === '42P01') return { items: [], not_migrated: true };
      throw e;
    }
    return {
      items: rows.map((r) => ({
        id: r.id, agent_id: r.agent_id, agent_name: r.agent_name,
        amount: Number(r.amount), settled: Number(r.settled),
        paid_date: String(r.paid_date).slice(0, 10), note: r.note || null,
        evi_name: r.evi_name || null, has_evidence: !!r.evi_mime, evi_mime: r.evi_mime || null,
        alloc_count: Number(r.alloc_count), created_at: r.created_at,
      })),
    };
  });

  // ── 증빙 파일 열람 (전체열람자 or 본인 전표) — 인증헤더 fetch ──
  app.get('/api/commission/payments/:id/evidence', { preHandler: [authGuard, requirePage('commission')] }, async (req, reply) => {
    const perm = req.ctx.perm; const id = Number(req.params.id);
    const r = (await query(`SELECT agent_id, evi_mime, evi_data, evi_name FROM commission_payments WHERE id=$1`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeAll(perm) && Number(r.agent_id) !== Number(perm.userId)) return reply.code(403).send({ error: 'forbidden' });
    const buf = Buffer.from(r.evi_data, 'base64');
    reply.header('Content-Type', r.evi_mime || 'application/octet-stream');
    reply.header('Content-Disposition', `inline; filename="${(r.evi_name || ('evidence-' + id)).replace(/"/g, '')}"`);
    return reply.send(buf);
  });

  // ── (레거시) 인보이스별 단건 지급 처리 (디렉터) — 증빙 없는 빠른 마킹. 신규는 전표(payments) 사용 ──
  app.post('/api/commission/payout/:invoiceId/pay', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const invoiceId = Number(req.params.invoiceId);
    const uid = req.ctx.perm.userId;
    const paidDate = req.body?.paid_date || new Date().toISOString().slice(0, 10);
    const r = (await query(
      `SELECT i.id, i.owner_id, i.subtotal_mxn, i.total_mxn,
              ca.default_rate, ccr.rate AS cust_rate,
              COALESCE(pa.paid_amount,0) AS paid_amount, pa.last_pay_date
         FROM sales_invoices i
         JOIN commission_agents ca ON ca.user_id=i.owner_id AND ca.active=true
         LEFT JOIN commission_customer_rates ccr ON ccr.user_id=i.owner_id AND ccr.customer_id=i.customer_id
         LEFT JOIN (
           SELECT spa.invoice_id, SUM(spa.amount) AS paid_amount, to_char(MAX(sp.pay_date),'YYYY-MM-DD') AS last_pay_date
             FROM sales_payment_allocations spa JOIN sales_payments sp ON sp.id=spa.payment_id
            GROUP BY spa.invoice_id
         ) pa ON pa.invoice_id=i.id
        WHERE i.id=$1`, [invoiceId])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    const fullyPaid = Number(r.paid_amount) + 0.01 >= Number(r.total_mxn) && Number(r.total_mxn) > 0;
    if (!fullyPaid) return reply.code(409).send({ error: 'not_settled', note: '반제(완납) 완료 후에 확정 커미션을 지급 처리할 수 있습니다.' });
    const rate = r.cust_rate != null ? Number(r.cust_rate) : Number(r.default_rate || 0);
    const amount = round2(Number(r.subtotal_mxn) * rate / 100);
    const settleYm = String(r.last_pay_date).slice(0, 7);
    await query(
      `INSERT INTO commission_payouts (invoice_id, agent_id, amount, settle_ym, due_date, paid, paid_date, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,true,$6,$7,$7)
       ON CONFLICT (invoice_id) DO UPDATE SET amount=$3, settle_ym=$4, due_date=$5, paid=true, paid_date=$6, updated_by=$7, updated_at=now()`,
      [invoiceId, r.owner_id, amount, settleYm, nextMonth15(settleYm), paidDate, uid]);
    await logEvent({ userId: uid, action: 'update', target: `commission_payout:${invoiceId}`, detail: { paid: true, amount } });
    return { ok: true, amount };
  });
}
