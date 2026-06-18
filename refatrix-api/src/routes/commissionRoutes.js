import { query } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
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

export default async function commissionRoutes(app) {
  // ── 커미션 대상 영업사원 + 기본률 목록 (디렉터) ──
  app.get('/api/commission/agents', { preHandler: [authGuard, requireDirector] }, async () => {
    const rows = (await query(
      `SELECT u.id AS user_id, u.name, u.role, t.name AS team_name,
              ca.default_rate, ca.active, ca.note
         FROM users u
         LEFT JOIN sales_teams t ON t.id=u.team_id
         LEFT JOIN commission_agents ca ON ca.user_id=u.id
        WHERE u.deleted_at IS NULL AND u.role IN ('sales','sales_support')
        ORDER BY t.sort_order NULLS LAST, u.name`)).rows;
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

  // ── 커미션 내역 (영업사원 본인 / 디렉터 전체·영업사원별) ──
  //   view: customer | month | all   (기본 customer)
  //   agent_id: 디렉터가 특정 영업사원만 볼 때
  app.get('/api/commission/overview', { preHandler: [authGuard, requirePage('commission')] }, async (req) => {
    const perm = req.ctx.perm;
    const isDir = perm.role === 'director';
    const view = ['customer', 'month', 'all'].includes(req.query.view) ? req.query.view : 'customer';

    // 권한: 영업사원은 본인(owner=self)만. 디렉터는 전체 또는 agent_id 지정.
    const args = [];
    let ownerCond = '';
    if (!isDir) { args.push(Number(perm.userId)); ownerCond = ` AND i.owner_id=$${args.length}`; }
    else if (req.query.agent_id) { args.push(Number(req.query.agent_id)); ownerCond = ` AND i.owner_id=$${args.length}`; }

    const rows = (await query(
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

    // 인보이스별 커미션 계산
    const lines = rows.map((r) => {
      const rate = r.cust_rate != null ? Number(r.cust_rate) : (r.default_rate != null ? Number(r.default_rate) : 0);
      const base = Number(r.subtotal_mxn);          // ex-IVA 소계
      const expected = round2(base * rate / 100);
      const paidAmt = Number(r.paid_amount);
      const fullyPaid = paidAmt + 0.01 >= Number(r.total_mxn) && Number(r.total_mxn) > 0;
      const settleYm = fullyPaid && r.last_pay_date ? String(r.last_pay_date).slice(0, 7) : null;
      const confirmed = fullyPaid ? expected : 0;
      return {
        invoice_id: r.invoice_id, sat_no: r.sat_no, inv_date: String(r.inv_date).slice(0, 10),
        agent_id: r.owner_id, agent_name: r.agent_name,
        customer_id: r.customer_id, customer_name: r.customer_name, customer_code: r.customer_code,
        rate, base, expected, confirmed,
        fully_paid: fullyPaid, settle_ym: settleYm,
        due_date: settleYm ? nextMonth15(settleYm) : null,
        paid: r.payout_paid === true, paid_date: r.payout_paid_date ? String(r.payout_paid_date).slice(0, 10) : null,
      };
    });

    // 합계/요약
    const sum = (arr, k) => round2(arr.reduce((s, x) => s + Number(x[k] || 0), 0));
    const summary = {
      invoice_count: lines.length,
      total_base: sum(lines, 'base'),
      total_expected: sum(lines, 'expected'),
      total_confirmed: sum(lines, 'confirmed'),
      total_paid: sum(lines.filter((l) => l.paid), 'confirmed'),
      total_unpaid: round2(sum(lines.filter((l) => l.fully_paid && !l.paid), 'confirmed')),
    };

    // view별 그룹
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

    // 디렉터 전체 보기일 때 영업사원별 요약 추가
    let byAgent = null;
    if (isDir && !req.query.agent_id) {
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

    return { view, is_director: isDir, agent_id: req.query.agent_id ? Number(req.query.agent_id) : null, summary, groups, by_agent: byAgent };
  });

  // ── 확정 커미션 지급 처리 (디렉터) ──
  app.post('/api/commission/payout/:invoiceId/pay', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const invoiceId = Number(req.params.invoiceId);
    const uid = req.ctx.perm.userId;
    const paidDate = req.body?.paid_date || new Date().toISOString().slice(0, 10);
    // 확정 커미션 재계산(반제 완료분만)
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
