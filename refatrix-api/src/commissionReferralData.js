// =====================================================================
// Refatrix ERP · commissionReferralData.js  (0307 · 2026-10-29)
//   소개 커미션 DB 헬퍼 — 라우트(commissionReferralRoutes)와 커미션 지급(commissionRoutes)이 같이 쓴다.
//   commissionRoutes 와 서로 import 하므로(순환) 모듈 최상위에서 그쪽 값을 쓰지 않는다 — SQL 은 호출 시점에 만든다.
// =====================================================================
import { query } from './db.js';
import {
  computeLine, BENEFICIARY_LATERAL, PERIOD_LATERAL, PAYMODE_LATERAL, NC_LATERAL, COMMISSION_SCOPE,
} from './routes/commissionRoutes.js';
import {
  buildReferralTerms, referralHash, buildReferralDoc, docsStatus, effectiveFrom,
  computeReferralLine, computeReferralAdjustment, signStatus, normInfo,
} from './commissionReferral.js';

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// 반제(완납) 다음 달 15일
export function payDateOf(ym) {
  if (!ym) return null;
  const [y, m] = ym.split('-').map(Number);
  return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-15`;
}

// 0307 적용 여부 — 마이그레이션 전 배포에도 커미션 지급이 500 없이 동작하도록(소개 커미션만 꺼짐). 60초 캐시.
let _ready = { v: null, at: 0 };
export async function referralsReady() {
  if (_ready.v === true) return true;
  if (_ready.v === false && Date.now() - _ready.at < 60000) return false;
  const r = await query(`SELECT 1 FROM information_schema.tables WHERE table_name='commission_referral_payouts'`);
  _ready = { v: r.rows.length > 0, at: Date.now() };
  return _ready.v;
}
export function _resetReady() { _ready = { v: null, at: 0 }; }

export const REF_COLS = `r.id, r.referrer_id, r.referred_id, r.rate, to_char(r.start_date,'YYYY-MM-DD') AS start_date,
  to_char(r.end_date,'YYYY-MM-DD') AS end_date, r.referred_info, r.active, to_char(r.docs_complete_on,'YYYY-MM-DD') AS docs_complete_on,
  r.note, ua.name AS referrer_name, ub.name AS referred_user_name,
  to_char(r.created_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS created_at_local`;
const REF_FROM = `FROM commission_referrals r JOIN users ua ON ua.id=r.referrer_id JOIN users ub ON ub.id=r.referred_id`;

export function normRef(r) {
  if (!r) return null;
  return {
    id: Number(r.id), referrer_id: Number(r.referrer_id), referred_id: Number(r.referred_id), rate: Number(r.rate),
    start_date: r.start_date, end_date: r.end_date || null, referred_info: normInfo(r.referred_info || {}),
    active: r.active === true, docs_complete_on: r.docs_complete_on || null, note: r.note || null,
    referrer_name: r.referrer_name || '', referred_user_name: r.referred_user_name || '', created_at: r.created_at_local || null,
  };
}

export async function loadReferral(id) {
  return normRef((await query(`SELECT ${REF_COLS} ${REF_FROM} WHERE r.id=$1`, [Number(id)])).rows[0]);
}
// filter: { referrerId, onlyActive }
export async function listReferrals({ referrerId = null, onlyActive = false } = {}) {
  const args = []; const cond = [];
  if (referrerId) { args.push(Number(referrerId)); cond.push(`r.referrer_id=$${args.length}`); }
  if (onlyActive) cond.push('r.active');
  return (await query(`SELECT ${REF_COLS} ${REF_FROM}${cond.length ? ' WHERE ' + cond.join(' AND ') : ''} ORDER BY r.active DESC, r.start_date DESC, r.id DESC`, args)).rows.map(normRef);
}

let _company = { v: null, at: 0 };
export async function companyInfo() {
  if (_company.v && Date.now() - _company.at < 60000) return _company.v;
  let c = {};
  try { c = (await query(`SELECT emisor, rfc, domicilio FROM company_settings WHERE id=1`)).rows[0] || {}; } catch (e) { if (!e || e.code !== '42P01') throw e; }
  _company = { v: c, at: Date.now() };
  return c;
}

// 현재 계약서(조건·해시·문서)
export async function currentDoc(ref) {
  const terms = buildReferralTerms(ref, { referrerName: ref.referrer_name, referredUserName: ref.referred_user_name, company: await companyInfo() });
  const hash = referralHash(terms);
  const doc = buildReferralDoc(terms);
  return { terms, hash, doc };
}

// 서류(파일 내용 제외)
export async function docsOf(referralId) {
  return (await query(
    `SELECT id, party, doc_type, to_char(issued_date,'YYYY-MM-DD') AS issued_date, file_name, mime_type, file_size,
            to_char(uploaded_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD') AS uploaded_on,
            to_char(uploaded_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS uploaded_at_local
       FROM commission_referral_docs WHERE referral_id=$1 AND deleted_at IS NULL ORDER BY uploaded_at DESC, id DESC`, [Number(referralId)])).rows
    .map((d) => ({ ...d, id: Number(d.id), file_size: Number(d.file_size) }));
}

// 서명 이력
export async function signaturesOf(referralId) {
  return (await query(
    `SELECT id, version_hash, to_char(signed_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS signed_at_local,
            to_char(signed_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD') AS signed_on, user_agent
       FROM commission_referral_signatures WHERE referral_id=$1 ORDER BY signed_at DESC, id DESC`, [Number(referralId)])).rows
    .map((s) => ({ id: Number(s.id), version: s.version_hash, signed_at: s.signed_at_local, signed_on: s.signed_on, user_agent: s.user_agent }));
}

// 계약 상태 묶음: 서류 · 서명 · 효력일
export async function referralState(ref) {
  const docs = await docsOf(ref.id);
  const ds = docsStatus(docs, ref.referred_info.persona);
  const sigs = await signaturesOf(ref.id);
  const { hash } = await currentDoc(ref);
  const first = sigs.length ? sigs[sigs.length - 1].signed_on : null;
  const eff = ref.active ? effectiveFrom({ start_date: ref.start_date, docs_complete_on: ref.docs_complete_on, first_signed_on: first }) : null;
  return {
    docs, docs_status: ds, signatures: sigs, version: hash,
    sign_status: signStatus(hash, sigs[0] ? { version_hash: sigs[0].version } : null),
    first_signed_on: first, effective_from: eff,
  };
}

// 서류 완비일 재계산 — 완비되면 처음 완비된 날을 유지, 미완비가 되면 비운다.
export async function recomputeDocsComplete(q, referralId) {
  const ref = (await q(`SELECT referred_info, to_char(docs_complete_on,'YYYY-MM-DD') AS d FROM commission_referrals WHERE id=$1`, [referralId])).rows[0];
  if (!ref) return null;
  const docs = (await q(
    `SELECT id, party, doc_type, to_char(issued_date,'YYYY-MM-DD') AS issued_date,
            to_char(uploaded_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD') AS uploaded_on
       FROM commission_referral_docs WHERE referral_id=$1 AND deleted_at IS NULL`, [referralId])).rows;
  const ds = docsStatus(docs, normInfo(ref.referred_info || {}).persona);
  const next = ds.complete ? (ref.d || ds.complete_on) : null;
  if ((ref.d || null) !== next) await q(`UPDATE commission_referrals SET docs_complete_on=$2, updated_at=now() WHERE id=$1`, [referralId, next]);
  return next;
}

// ── B 의 커미션 대상 인보이스 + A 소개 커미션 판정 ─────────────────────
let _sql = null;
function linesSql() {
  if (_sql) return _sql;
  _sql = `
  SELECT i.id AS invoice_id, i.sat_no,
         to_char(i.inv_date,'YYYY-MM-DD') AS inv_date, to_char(i.inv_date,'YYYY-MM') AS inv_ym,
         (i.subtotal_mxn - nc.base) AS subtotal_mxn, (i.total_mxn - nc.total) AS total_mxn, nc.base AS nc_base,
         c.id AS customer_id, c.name AS customer_name, c.code AS customer_code,
         per.basis, per.rate, per.match_on, ccr.rate AS cust_rate, pp.amt AS pp_amt, pp.w AS pp_w, po.rate AS po_rate,
         COALESCE(pa.paid_amount,0) AS paid_amount, pa.last_pay_date,
         rp.paid AS rp_paid, rp.amount AS rp_amount, rp.settle_ym AS rp_settle_ym, to_char(rp.paid_date,'YYYY-MM-DD') AS rp_paid_date
    FROM sales_invoices i
    JOIN customers c ON c.id=i.customer_id
    LEFT JOIN commission_payouts cp ON cp.invoice_id=i.id${BENEFICIARY_LATERAL}
    JOIN commission_agents ca ON ca.user_id=ben.uid AND ca.active=true
    LEFT JOIN commission_customer_rates ccr ON ccr.user_id=ben.uid AND ccr.customer_id=i.customer_id${PERIOD_LATERAL}${PAYMODE_LATERAL}${NC_LATERAL}
    LEFT JOIN (
      SELECT spa.invoice_id, SUM(spa.amount) AS paid_amount, to_char(MAX(sp.pay_date),'YYYY-MM-DD') AS last_pay_date
        FROM sales_payment_allocations spa JOIN sales_payments sp ON sp.id=spa.payment_id
       GROUP BY spa.invoice_id
    ) pa ON pa.invoice_id=i.id
    LEFT JOIN commission_referral_payouts rp ON rp.referral_id=$2 AND rp.invoice_id=i.id
   WHERE i.status <> 'deleted' AND ben.uid=$1
     AND (${COMMISSION_SCOPE} OR rp.id IS NOT NULL)
   ORDER BY i.inv_date ASC, i.id ASC`;
  return _sql;
}

// 한 소개 계약의 전체 라인(표시·지급 공통). state 를 넘기면 다시 읽지 않는다.
export async function referralLines(ref, state = null) {
  const st = state || await referralState(ref);
  const rows = (await query(linesSql(), [ref.referred_id, ref.id])).rows;
  const ctx = { rate: ref.rate, effective: st.effective_from, end: ref.end_date };
  const out = [];
  for (const r of rows) {
    const c = computeLine(r);
    const x = computeReferralLine(c, r, ctx);
    if (x.status === 'none') continue;
    const lastPay = r.last_pay_date ? String(r.last_pay_date).slice(0, 10) : null;
    // 계약 시작 전에 끝난 이력은 보여주지 않는다.
    //   보이는 것: 지급분 · 시작일 이후 발행 · 시작일 이후 완납 · 아직 미수(시작 후 완납되면 대상이 되므로)
    const visible = x.status === 'paid' || x.status === 'pending' || r.inv_date >= ref.start_date || (lastPay && lastPay >= ref.start_date);
    if (!visible) continue;
    const total = Number(r.total_mxn) || 0, paid = Number(r.paid_amount) || 0;
    out.push({
      referral_id: ref.id, invoice_id: Number(r.invoice_id), sat_no: r.sat_no, inv_date: r.inv_date,
      customer_id: Number(r.customer_id), customer_name: r.customer_name, customer_code: r.customer_code,
      sale_base: r2(c.base),                                     // 인보이스 순매출(ex-IVA · NC 차감)
      base: x.base,                                              // 소개 커미션 기준액(수금일 판정은 기간 안 수금분)
      paid_pct: total > 0 ? Math.min(100, Math.round(paid / total * 1000) / 10) : 0,
      open_amount: r2(Math.max(0, total - paid)),                // 남은 잔액(IVA 포함)
      last_pay_date: lastPay, status: x.status, rate: ref.rate,
      amount: x.amount, potential: x.potential || 0,
      settle_ym: x.settleYm, pay_date: x.settleYm ? payDateOf(x.settleYm) : null,
      paid_date: r.rp_paid_date || null,
    });
  }
  return out;
}

// A 의 지급 대상(확정·미지급) 소개 커미션 라인. settleYm 지정 시 그 달만. 0307 전이면 [].
export async function payableReferralLines(referrerId, settleYm) {
  if (!(await referralsReady())) return [];
  const out = [];
  for (const ref of await listReferrals({ referrerId, onlyActive: true })) {
    const lines = await referralLines(ref);
    for (const l of lines) {
      if (l.status !== 'confirmed') continue;
      if (settleYm && l.settle_ym !== settleYm) continue;
      out.push({ ...l, referred_name: ref.referred_info.name || ref.referred_user_name });
    }
  }
  out.sort((a, b) => String(a.last_pay_date).localeCompare(String(b.last_pay_date)) || a.invoice_id - b.invoice_id);
  return out;
}

// 지급 후 B 매출 감소 → A 차감(다음 지급에서). 0307 전이면 [].
export async function pendingReferralAdjustments(referrerId) {
  if (!(await referralsReady())) return [];
  const rows = (await query(
    `SELECT rp.id AS payout_id, rp.referral_id, rp.invoice_id, i.sat_no, to_char(i.inv_date,'YYYY-MM-DD') AS inv_date,
            c.name AS customer_name, rp.amount AS paid_amount, rp.base_mxn AS paid_base,
            (i.status = 'deleted' OR i.deleted_at IS NOT NULL) AS deleted,
            (i.subtotal_mxn - nc.base) AS cur_base, nc.base AS nc_base
       FROM commission_referral_payouts rp
       JOIN sales_invoices i ON i.id=rp.invoice_id
       JOIN customers c ON c.id=i.customer_id${NC_LATERAL}
      WHERE rp.paid = true AND rp.base_mxn IS NOT NULL AND rp.referrer_id=$1
      ORDER BY i.inv_date ASC, i.id ASC`, [Number(referrerId)])).rows;
  const out = [];
  for (const r of rows) {
    const a = computeReferralAdjustment(r);
    if (!a) continue;
    out.push({ payout_id: Number(r.payout_id), referral_id: Number(r.referral_id), invoice_id: Number(r.invoice_id), sat_no: r.sat_no, inv_date: r.inv_date, customer_name: r.customer_name, ...a });
  }
  return out;
}

// 월 배치 집계용 — 모든 소개 계약의 확정(미지급)·지급 라인 {settle_ym, owner_id(=A), expected, paid}
export async function confirmedReferralMonthLines() {
  if (!(await referralsReady())) return [];
  const out = [];
  for (const ref of await listReferrals({ onlyActive: false })) {
    if (!ref.active) {
      // 해지된 계약은 이미 지급한 것만 집계(동결 금액)
      const rows = (await query(`SELECT settle_ym, amount FROM commission_referral_payouts WHERE referral_id=$1 AND paid`, [ref.id])).rows;
      for (const r of rows) out.push({ settle_ym: r.settle_ym, owner_id: ref.referrer_id, expected: Number(r.amount), paid: true });
      continue;
    }
    for (const l of await referralLines(ref)) {
      if (l.status === 'confirmed') out.push({ settle_ym: l.settle_ym, owner_id: ref.referrer_id, expected: l.amount, paid: false });
      else if (l.status === 'paid' && l.settle_ym) out.push({ settle_ym: l.settle_ym, owner_id: ref.referrer_id, expected: l.amount, paid: true });
    }
  }
  return out;
}

// 지급 전표 안(트랜잭션)에서 소개 커미션 반영. cx = PoolClient.
//   allocs: 이번에 지급하는 확정 라인 · adjustments: 지급 후 차감분
export async function writeReferralPayment(cx, { referrerId, allocs = [], adjustments = [], payDate, paymentId, uid }) {
  if (!allocs.length && !adjustments.length) return;
  for (const a of allocs) {
    await cx.query(
      `INSERT INTO commission_referral_payouts (referral_id, invoice_id, referrer_id, amount, base_mxn, rate, settle_ym, paid, paid_date, payment_id, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$9,$10,$10)
       ON CONFLICT (referral_id, invoice_id) DO UPDATE SET amount=$4, base_mxn=$5, rate=$6, settle_ym=$7, paid=true, paid_date=$8, payment_id=$9, updated_by=$10, updated_at=now()`,
      [a.referral_id, a.invoice_id, referrerId, a.amount, a.sale_base, a.rate, a.settle_ym, payDate, paymentId, uid]);
  }
  for (const adj of adjustments) {
    await cx.query(
      `INSERT INTO commission_referral_adjustments (payout_id, payment_id, amount, old_amount, new_amount, old_base, new_base, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [adj.payout_id, paymentId, adj.amount, adj.paid_amount, adj.new_amount, adj.paid_base, adj.new_base, adj.reason]);
    await cx.query(`UPDATE commission_referral_payouts SET amount=$2, base_mxn=$3, updated_by=$4, updated_at=now() WHERE id=$1`,
      [adj.payout_id, adj.new_amount, adj.new_base, uid]);
  }
}
