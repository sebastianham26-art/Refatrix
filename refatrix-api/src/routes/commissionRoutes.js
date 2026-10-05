import { query, withTx } from '../db.js';
import { authGuard, requirePage, requirePageEdit, requireDirector } from '../middleware/authGuard.js';
import { round2 } from '../permissions.js';
import { logEvent } from '../audit.js';
// 완납 판정 공통 허용치(잔액 0.5 페소 미만 = 완납) — 수금/정산·고객 화면과 같은 기준 (2026-10-05)
import { AR_PAID_EPS } from '../ar.js';
// 성과급(Bono) — 목표 달성률 기반. 커미션과 분리된 축(0190).
import { registerBonusRoutes, snapshotBonusForMonth, payableBonus, markBonusPaid } from './commissionBonus.js';

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

// 커미션 판정 모드 (순수). per = 발행일이 속한 기간(basis·match_on).
//   'revenue' : 발행일 기간이 매출 기준 → 발행 즉시 확정
//   'invoice' : 발행일 기간이 수금 기준 + 발행일 판정(종전) → 완납 시 전액 확정
//   'payment' : 발행일 기간이 수금 기준 + 수금일 판정, 또는 발행일을 덮는 기간이 없음(기간 시작 전 발행)
//               → 수금일이 수금일-판정 기간에 속한 수금액만 적립(pp_w), 완납 시 적립분 확정 (0250)
export function commissionMode(r) {
  if (r.basis === 'revenue') return 'revenue';
  if (r.basis === 'collection' && r.match_on !== 'payment') return 'invoice';
  return 'payment';
}

// 인보이스별 커미션 계산 (순수).
//   row: subtotal_mxn,total_mxn(NC 차감 순액),rate(발행일 기간율),cust_rate,basis,match_on,
//        paid_amount(현금 수금 합계),last_pay_date,inv_ym,
//        pp_amt(수금일-판정 기간 안의 수금액, IVA 포함),pp_w(Σ 수금액×율),po_rate(지속(∞) 수금일-판정 기간의 율)
//   - revenue : 발행 즉시 전액 확정. 인식월 = 발행월.
//   - invoice : 반제완납 시 전액 확정. 인식월 = 완납월.
//   - payment : 적립 = Σ(기간 내 수금액 × 율) × (subtotal/total). 완납 시 적립분 확정. 인식월 = 완납월.
//               expected = 적립 + (미완납이면 남은 잔액이 지금 율로 수금될 때의 커미션).
//   반환 base 는 항상 인보이스 순매출(ex-IVA) — 지급 후 매출 조정(차액 정산)의 기준.
//   relevant=false 면 커미션과 무관한 줄(수금일 판정인데 적립 0 이고 더 받을 것도 없음) → 목록에서 뺀다.
export function computeLine(r) {
  const base = Number(r.subtotal_mxn) || 0;
  const total = Number(r.total_mxn) || 0;
  const paidAmt = Number(r.paid_amount || 0);
  const fullyPaid = total > 0 && (total - paidAmt) < AR_PAID_EPS;   // 수금 화면과 같은 완납 기준
  const mode = commissionMode(r);
  const custRate = r.cust_rate != null ? Number(r.cust_rate) : null;
  if (mode !== 'payment') {
    const rate = custRate != null ? custRate : (r.rate != null ? Number(r.rate) : 0);
    const expected = round2(base * rate / 100);
    if (mode === 'revenue') {
      const settleYm = r.inv_ym ? String(r.inv_ym).slice(0, 7) : null;
      return { rate, base, expected, basis: 'revenue', mode, fullyPaid, recognized: true, confirmed: expected, settleYm, accrued: expected, collected_base: base, potential: 0, relevant: true };
    }
    const settleYm = fullyPaid && r.last_pay_date ? String(r.last_pay_date).slice(0, 7) : null;
    return { rate, base, expected, basis: 'collection', mode, fullyPaid, recognized: fullyPaid, confirmed: fullyPaid ? expected : 0, settleYm, accrued: fullyPaid ? expected : 0, collected_base: fullyPaid ? base : 0, potential: fullyPaid ? 0 : expected, relevant: true };
  }
  // 수금일 판정
  const ratio = total > 0 ? base / total : 0;
  const accrued = round2((Number(r.pp_w) || 0) * ratio / 100);
  const collectedBase = round2((Number(r.pp_amt) || 0) * ratio);
  const openRate = custRate != null ? custRate : (r.po_rate != null ? Number(r.po_rate) : null);
  const remainingCash = Math.max(0, total - paidAmt);
  const potential = (!fullyPaid && openRate != null) ? round2(remainingCash * ratio * openRate / 100) : 0;
  const expected = round2(accrued + potential);
  const rate = openRate != null ? openRate : (collectedBase > 0 ? round2(accrued / collectedBase * 100) : (r.rate != null ? Number(r.rate) : 0));
  const recognized = fullyPaid && accrued > 0;
  const settleYm = recognized && r.last_pay_date ? String(r.last_pay_date).slice(0, 7) : null;
  return {
    rate, base, expected, basis: 'collection', mode, fullyPaid, recognized,
    confirmed: recognized ? accrued : 0, settleYm, accrued, collected_base: collectedBase, potential,
    relevant: accrued > 0 || potential > 0,
  };
}

// 'YYYY-MM-DD' 다음 날짜 (연속성 검증용, 벽시계 무관)
export function nextDay(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// 기간 집합 검증 (순수). 반환 {ok:true, periods:[정렬·정규화]} 또는 {ok:false, error}.
//   규칙: ① 각 기간 유효(시작일·기준·율) ② 시작일 오름차순 ③ 겹침·빈틈 없음(연속)
//         ④ 마지막 기간만 종료일 비움(∞), 나머지는 종료일 필수.
export function validatePeriods(input) {
  const list = Array.isArray(input) ? input : [];
  if (!list.length) return { ok: false, error: 'no_periods', note: '최소 한 개의 기간이 필요합니다.' };
  const norm = [];
  for (const p of list) {
    const start = String(p.start_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return { ok: false, error: 'bad_start', note: '시작일 형식이 올바르지 않습니다.' };
    const end = p.end_date ? String(p.end_date).slice(0, 10) : null;
    if (end !== null && !/^\d{4}-\d{2}-\d{2}$/.test(end)) return { ok: false, error: 'bad_end', note: '종료일 형식이 올바르지 않습니다.' };
    if (end !== null && end < start) return { ok: false, error: 'end_before_start', note: `종료일(${end})이 시작일(${start})보다 빠릅니다.` };
    const basis = p.basis === 'revenue' ? 'revenue' : (p.basis === 'collection' ? 'collection' : null);
    if (!basis) return { ok: false, error: 'bad_basis', note: '기준은 매출(revenue) 또는 수금(collection)이어야 합니다.' };
    const rate = Number(p.rate);
    if (!(rate >= 0)) return { ok: false, error: 'bad_rate', note: '지급률(%)은 0 이상이어야 합니다.' };
    // 기간 판정(0250): 수금 기준만 'payment'(수금일) 가능. 매출 기준은 항상 발행일.
    const matchOn = basis === 'collection' && p.match_on === 'payment' ? 'payment' : 'invoice';
    norm.push({ start_date: start, end_date: end, basis, rate, match_on: matchOn });
  }
  norm.sort((a, b) => a.start_date.localeCompare(b.start_date));
  for (let i = 0; i < norm.length; i++) {
    const isLast = i === norm.length - 1;
    if (isLast) {
      if (norm[i].end_date !== null) return { ok: false, error: 'last_must_be_open', note: '가장 최근(마지막) 기간은 종료일을 비워 ∞(지속)로 두어야 앞으로의 매출이 계속 커미션 대상이 됩니다.' };
    } else {
      if (norm[i].end_date === null) return { ok: false, error: 'gap_open_middle', note: '중간 기간은 종료일이 있어야 합니다. ∞(지속)는 마지막 기간에만 허용됩니다.' };
      const next = norm[i + 1];
      if (norm[i].end_date >= next.start_date) return { ok: false, error: 'overlap', note: `기간이 겹칩니다: ${norm[i].start_date}~${norm[i].end_date} 와 ${next.start_date}~. 겹치지 않게 조정하세요.` };
      if (nextDay(norm[i].end_date) !== next.start_date) return { ok: false, error: 'gap', note: `기간 사이에 빈틈이 있습니다: ${norm[i].end_date} 다음은 ${nextDay(norm[i].end_date)} 부터여야 하는데 ${next.start_date} 로 비어 있습니다.` };
    }
  }
  return { ok: true, periods: norm };
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

// 커미션 수혜자 = 고객마스터 담당자(customers.owner_id). (2026-09-28)
//   예외: 고객의 팀에 "팀 커미션 수혜자"(sales_teams.commission_user_id, 0233)가 지정돼 있으면 그 사람.
//         예) 06_Tele 팀 고객 매출 → Maria. to_jsonb 로 읽어 0233 미적용 DB 에서도 오류 없이 담당자 기준으로 동작.
//   인보이스 owner_id 는 "매출을 등록한 사람"(대개 영업지원)이 들어가므로 커미션 귀속에 쓰지 않는다.
//   단, 이미 지급(반제)된 라인은 지급받은 사람(commission_payouts.agent_id)으로 동결 — 담당 이관 후에도 불변.
//   0235 (2026-09-29) · 디렉터 결정: **인보이스 날짜의 독점권자로 고정** → sales_invoices.commission_agent_id.
//         독점 대상 고객은 exclusivity.js 가 독점 기간으로 계산해 넣고, 기존 고객은 발행 시점 담당자를 박제한다.
//         담당을 이관해도 과거 인보이스의 커미션은 따라가지 않는다. 값이 없으면(0235 전 DB) 종전대로 고객 담당자.
//         순서: 지급 동결 → 팀 수혜자(06_Tele → Maria) → 인보이스 귀속 → 고객 담당자.
//   전제: 쿼리에 sales_invoices i, customers c, commission_payouts cp 가 먼저 조인돼 있어야 한다.
export const BENEFICIARY_LATERAL = `
    CROSS JOIN LATERAL (
      SELECT CASE WHEN cp.paid IS TRUE THEN cp.agent_id
                  ELSE COALESCE(
                    (SELECT (to_jsonb(st)->>'commission_user_id')::bigint FROM sales_teams st WHERE st.id = c.team_id),
                    (to_jsonb(i)->>'commission_agent_id')::bigint,
                    c.owner_id) END AS uid
    ) ben`;

// 적용된 크레딧 노트(Nota de crédito) 합계 — 커미션은 "인보이스 − 적용 NC" 순액 기준. (2026-09-28)
//   NC 는 인보이스 금액을 바꾸지 않고 비현금 반제로만 들어가므로(0085), 여기서 차감해야 할인·반품분에 커미션이 붙지 않는다.
//   수금액(pa)은 sales_payments 와 JOIN 하므로 현금 반제만 잡힌다(NC 배분은 payment_id NULL).
//   → 완납 판정 = 현금수금 ≥ (인보이스 합계 − NC 합계).
export const NC_LATERAL = `
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(n.base_mxn),0) AS base, COALESCE(SUM(n.total_mxn),0) AS total
        FROM notas_credito n
       WHERE n.invoice_id = i.id AND n.status = 'applied'
    ) nc ON true`;

// 지급 후 매출 조정 → 다음 지급에서 차액 정산(차감/추가). 디렉터 결정 A (2026-09-28).
//   지급 시점의 순매출(commission_payouts.base_mxn)과 지금 순매출을 비교해, 지급 당시 실효율로 차액을 낸다.
//   요율·기간 변경은 차액을 만들지 않는다(지급 당시 율 고정). 매출 삭제 = 순매출 0 → 전액 환수.
//   base_mxn 이 없는(0232 이전 지급) 라인은 대상에서 제외.
export function computeAdjustment(r) {
  const paidAmt = Number(r.paid_amount) || 0;
  const paidBase = Number(r.paid_base) || 0;
  if (!(paidBase > 0)) return null;
  const curBase = r.deleted ? 0 : Math.max(0, Number(r.cur_base) || 0);
  const newAmt = round2(curBase * paidAmt / paidBase);
  const delta = round2(newAmt - paidAmt);
  if (Math.abs(delta) < 0.01) return null;
  const reason = r.deleted ? 'deleted' : (Number(r.nc_base) > 0 && curBase < paidBase ? 'nota_credito' : 'amount_change');
  return { amount: delta, new_amount: newAmt, new_base: round2(curBase), paid_amount: round2(paidAmt), paid_base: round2(paidBase), reason };
}

// 0232(commission_payouts.base_mxn) 적용 여부 — 마이그레이션 전 배포에도 500 없이 동작(차액 정산만 꺼짐). 60초 캐시.
let _baseReady = { v: null, at: 0 };
export async function payoutBaseReady() {
  if (_baseReady.v === true) return true;
  if (_baseReady.v === false && Date.now() - _baseReady.at < 60000) return false;
  const r = await query(`SELECT 1 FROM information_schema.columns WHERE table_name='commission_payouts' AND column_name='base_mxn'`);
  _baseReady = { v: r.rows.length > 0, at: Date.now() };
  return _baseReady.v;
}

// 0250(commission_agent_periods.match_on) 적용 여부 — 60초 캐시. 미적용이면 모두 발행일 판정(종전).
let _matchReady = { v: null, at: 0 };
export async function matchOnReady() {
  if (_matchReady.v === true) return true;
  if (_matchReady.v === false && Date.now() - _matchReady.at < 60000) return false;
  const r = await query(`SELECT 1 FROM information_schema.columns WHERE table_name='commission_agent_periods' AND column_name='match_on'`);
  _matchReady = { v: r.rows.length > 0, at: Date.now() };
  return _matchReady.v;
}

const ADJ_SQL = `
  SELECT cp.invoice_id, i.sat_no, to_char(i.inv_date,'YYYY-MM-DD') AS inv_date,
         c.name AS customer_name, c.code AS customer_code,
         cp.agent_id, cp.amount AS paid_amount, cp.base_mxn AS paid_base,
         (i.status = 'deleted' OR i.deleted_at IS NOT NULL) AS deleted,
         (i.subtotal_mxn - nc.base) AS cur_base, nc.base AS nc_base
    FROM commission_payouts cp
    JOIN sales_invoices i ON i.id = cp.invoice_id
    JOIN customers c ON c.id = i.customer_id${NC_LATERAL}
   WHERE cp.paid = true AND cp.base_mxn IS NOT NULL AND cp.agent_id = $1
   ORDER BY i.inv_date ASC, i.id ASC`;

// 한 영업사원의 미정산 차액(지급 후 매출 조정분). 0232 전이면 [].
export async function pendingAdjustments(agentId) {
  if (!(await payoutBaseReady())) return [];
  const rows = (await query(ADJ_SQL, [agentId])).rows;
  const out = [];
  for (const r of rows) {
    const a = computeAdjustment(r);
    if (!a) continue;
    out.push({ invoice_id: r.invoice_id, sat_no: r.sat_no, inv_date: r.inv_date, customer_name: r.customer_name, customer_code: r.customer_code, ...a });
  }
  return out;
}

// 인보이스 발행일이 속하는 기간(매출/수금 기준 + 율 + 판정기준)을 가져오는 LATERAL.
//   기간들은 겹치지 않으므로 최대 1건. 안 잡히면 per.basis IS NULL → 수금일 판정 기간이 있으면 그쪽으로(0250).
//   match_on 은 to_jsonb 로 읽어 0250 미적용 DB 에서도 오류 없이 'invoice'(종전)로 동작.
export const PERIOD_LATERAL = `
    LEFT JOIN LATERAL (
      SELECT cap.basis, cap.rate, COALESCE(to_jsonb(cap)->>'match_on','invoice') AS match_on
        FROM commission_agent_periods cap
       WHERE cap.user_id = ben.uid
         AND i.inv_date >= cap.start_date
         AND (cap.end_date IS NULL OR i.inv_date <= cap.end_date)
       ORDER BY cap.start_date DESC
       LIMIT 1
    ) per ON true`;

// 수금일 판정(0250): 수금일이 「수금 기준 + 수금일 판정」 기간에 속한 수금액과 Σ(수금액×율).
//   율은 고객별 예외율(ccr)이 있으면 그 율. 현금 반제만(sales_payments JOIN) — NC 배분은 제외.
//   전제: ben, ccr 가 먼저 조인돼 있어야 한다.
export const PAYMODE_LATERAL = `
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(spa.amount),0) AS amt,
             COALESCE(SUM(spa.amount * COALESCE(ccr.rate, cap.rate)),0) AS w
        FROM sales_payment_allocations spa
        JOIN sales_payments sp ON sp.id = spa.payment_id
        JOIN commission_agent_periods cap
          ON cap.user_id = ben.uid AND cap.basis = 'collection'
         AND COALESCE(to_jsonb(cap)->>'match_on','invoice') = 'payment'
         AND sp.pay_date >= cap.start_date AND (cap.end_date IS NULL OR sp.pay_date <= cap.end_date)
       WHERE spa.invoice_id = i.id
    ) pp ON true
    LEFT JOIN LATERAL (
      SELECT cap.rate
        FROM commission_agent_periods cap
       WHERE cap.user_id = ben.uid AND cap.basis = 'collection' AND cap.end_date IS NULL
         AND COALESCE(to_jsonb(cap)->>'match_on','invoice') = 'payment'
       LIMIT 1
    ) po ON true`;

// 커미션 대상 인보이스 조건: 발행일 기간이 있거나, 수금일 판정으로 적립됐거나 앞으로 적립될 수 있음.
//   (적립 0·더 받을 것 없는 줄은 computeLine().relevant=false 로 JS 에서 뺀다)
export const COMMISSION_SCOPE = `(per.basis IS NOT NULL OR pp.amt > 0 OR po.rate IS NOT NULL)`;

const PAYABLE_SQL = `
  SELECT i.id AS invoice_id, i.sat_no,
         to_char(i.inv_date,'YYYY-MM-DD') AS inv_date, to_char(i.inv_date,'YYYY-MM') AS inv_ym,
         (i.subtotal_mxn - nc.base) AS subtotal_mxn, (i.total_mxn - nc.total) AS total_mxn,
         c.name AS customer_name, c.code AS customer_code,
         per.basis, per.rate, per.match_on, ccr.rate AS cust_rate, pp.amt AS pp_amt, pp.w AS pp_w, po.rate AS po_rate,
         COALESCE(pa.paid_amount,0) AS paid_amount, pa.last_pay_date
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
   WHERE i.status <> 'deleted' AND ben.uid=$1
     AND ${COMMISSION_SCOPE}
     AND COALESCE(cp.paid,false)=false
   ORDER BY i.inv_date ASC, i.id ASC`;

// 한 영업사원의 확정(매출=발행즉시 / 수금=반제완납)·미지급 커미션 라인(FIFO 순). settleYm 지정 시 그 달만.
async function payableLines(agentId, settleYm) {
  const rows = (await query(PAYABLE_SQL, [agentId])).rows;
  const out = [];
  for (const r of rows) {
    const c = computeLine(r);
    if (!c.recognized || c.expected <= 0) continue; // 확정(인식됨)·금액>0 인 것만
    if (settleYm && c.settleYm !== settleYm) continue; // 월 스코프
    out.push({
      invoice_id: r.invoice_id, sat_no: r.sat_no, inv_date: String(r.inv_date).slice(0, 10),
      customer_name: r.customer_name, customer_code: r.customer_code, basis: c.basis, mode: c.mode,
      rate: c.rate, base: c.base, collected_base: c.collected_base, expected: c.expected, settle_ym: c.settleYm,
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

// 월별 배치 집계 (순수·테스트용). lines: 확정 라인 [{settle_ym, owner_id, expected, paid}]
export function summarizeByMonth(lines) {
  const by = {};
  for (const l of lines) {
    if (!l.settle_ym) continue;
    const g = (by[l.settle_ym] ||= { settle_ym: l.settle_ym, confirmed: 0, paid: 0, agents: new Set() });
    g.confirmed = round2(g.confirmed + Number(l.expected || 0));
    if (l.paid) g.paid = round2(g.paid + Number(l.expected || 0));
    g.agents.add(l.owner_id);
  }
  return Object.values(by)
    .map((g) => ({ settle_ym: g.settle_ym, confirmed: g.confirmed, paid: g.paid, unpaid: round2(g.confirmed - g.paid), agent_count: g.agents.size }))
    .sort((a, b) => b.settle_ym.localeCompare(a.settle_ym));
}

// 전체 영업사원의 확정 커미션 라인(settle_ym 포함) — 배치 집계/확정용
const CONFIRMED_LINES_SQL = `
  SELECT i.id AS invoice_id, ben.uid AS owner_id, (i.subtotal_mxn - nc.base) AS subtotal_mxn, (i.total_mxn - nc.total) AS total_mxn,
         to_char(i.inv_date,'YYYY-MM') AS inv_ym,
         per.basis, per.rate, per.match_on, ccr.rate AS cust_rate, pp.amt AS pp_amt, pp.w AS pp_w, po.rate AS po_rate,
         COALESCE(pa.paid_amount,0) AS paid_amount, pa.last_pay_date,
         cp.paid AS payout_paid, cp.amount AS payout_amount
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
   WHERE i.status <> 'deleted'
     AND ${COMMISSION_SCOPE}`;

async function confirmedMonthLines() {
  const rows = (await query(CONFIRMED_LINES_SQL, [])).rows;
  const out = [];
  for (const r of rows) {
    const c = computeLine(r);
    if (!c.recognized || c.expected <= 0) continue;
    // 이미 지급된 라인은 지급 시점 금액(payout_amount)으로 동결.
    const paid = r.payout_paid === true;
    const amt = paid && r.payout_amount != null ? Number(r.payout_amount) : c.expected;
    out.push({ settle_ym: c.settleYm, owner_id: r.owner_id, expected: amt, paid });
  }
  return out;
}

export default async function commissionRoutes(app) {
  // 성과급(Bono) 라우트 등록 — /api/commission/bonus/*, /progress, /performance, /my-bonus
  registerBonusRoutes(app);

  // ── 커미션 대상 영업사원 + 기본률 목록 (디렉터·재무·소시오 열람 / sales 차단) ──
  app.get('/api/commission/agents', { preHandler: [authGuard, requirePage('commission')] }, async (req, reply) => {
    if (!canSeeAll(req.ctx.perm)) return reply.code(403).send({ error: 'forbidden' });
    let rows, prows;
    try {
      rows = (await query(
        `SELECT u.id AS user_id, u.name, u.role, t.name AS team_name,
                ca.default_rate, ca.active, ca.note, ca.effective_from
           FROM users u
           LEFT JOIN sales_teams t ON t.id=u.team_id
           LEFT JOIN commission_agents ca ON ca.user_id=u.id
          WHERE u.deleted_at IS NULL AND u.role IN ('sales','sales_support')
          ORDER BY t.sort_order NULLS LAST, u.name`)).rows;
      prows = (await query(
        `SELECT user_id, id, to_char(start_date,'YYYY-MM-DD') AS start_date,
                to_char(end_date,'YYYY-MM-DD') AS end_date, basis, rate,
                COALESCE(to_jsonb(cap)->>'match_on','invoice') AS match_on
           FROM commission_agent_periods cap
          ORDER BY user_id, start_date`)).rows;
    } catch (e) {
      if (e && e.code === '42P01') return reply.code(503).send({ error: 'commission_not_migrated', note: '커미션 테이블이 없습니다. 서버에서 마이그레이션(npm run migrate · 0055/0143)을 실행하세요.' });
      throw e;
    }
    const periodsBy = {};
    for (const p of prows) {
      (periodsBy[p.user_id] ||= []).push({ id: p.id, start_date: p.start_date, end_date: p.end_date || null, basis: p.basis, rate: Number(p.rate), match_on: p.match_on });
    }
    return {
      match_on_ready: await matchOnReady(),
      items: rows.map((r) => {
        const periods = periodsBy[r.user_id] || [];
        return {
          user_id: r.user_id, name: r.name, role: r.role, team_name: r.team_name,
          default_rate: r.default_rate != null ? Number(r.default_rate) : null,
          active: r.active === true, is_agent: periods.length > 0 || r.default_rate != null,
          note: r.note || null,
          effective_from: r.effective_from ? String(r.effective_from).slice(0, 10) : null,
          periods,
        };
      }),
    };
  });

  // ── 커미션 대상 지정/수정 (디렉터) ──
  app.post('/api/commission/agents', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const { user_id, default_rate, active = true, note, effective_from } = req.body || {};
    if (!user_id || default_rate == null) return reply.code(400).send({ error: 'user_id_rate_required' });
    const effFrom = (effective_from && /^\d{4}-\d{2}-\d{2}$/.test(effective_from)) ? effective_from : null;
    const uid = req.ctx.perm.userId;
    await query(
      `INSERT INTO commission_agents (user_id, default_rate, active, note, effective_from, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$6)
       ON CONFLICT (user_id) DO UPDATE SET default_rate=$2, active=$3, note=$4, effective_from=$5, updated_by=$6, updated_at=now()`,
      [user_id, default_rate, active === true, note || null, effFrom, uid]);
    await logEvent({ userId: uid, action: 'update', target: `commission_agent:${user_id}`, detail: { default_rate, active, effective_from: effFrom } });
    return { ok: true };
  });

  // ── 기간별 조건(매출/수금 기준 + 율) 저장 (디렉터) — 그 사원의 기간 집합을 통째 교체 ──
  app.post('/api/commission/agents/:uid/periods', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const uid = Number(req.params.uid);
    if (!uid) return reply.code(400).send({ error: 'user_required' });
    const active = req.body && req.body.active === false ? false : true;
    const note = (req.body && req.body.note != null) ? String(req.body.note).slice(0, 500) : null;
    const dir = req.ctx.perm.userId;

    // 비활성(대상 해제): 기간 비우고 commission_agents.active=false.
    if (!active) {
      try {
        await withTx(async (cx) => {
          await cx.query(`DELETE FROM commission_agent_periods WHERE user_id=$1`, [uid]);
          await cx.query(
            `INSERT INTO commission_agents (user_id, default_rate, active, note, created_by, updated_by)
             VALUES ($1,0,false,$2,$3,$3)
             ON CONFLICT (user_id) DO UPDATE SET active=false, note=$2, updated_by=$3, updated_at=now()`,
            [uid, note, dir]);
        });
      } catch (e) { if (e && e.code === '42P01') return reply.code(503).send({ error: 'commission_not_migrated', note: 'npm run migrate(0143)을 실행하세요.' }); throw e; }
      await logEvent({ userId: dir, action: 'update', target: `commission_agent:${uid}`, detail: { active: false } });
      return { ok: true, active: false, periods: [] };
    }

    // 활성: 기간 집합 검증 후 통째 교체.
    const v = validatePeriods((req.body && req.body.periods) || []);
    if (!v.ok) return reply.code(400).send({ error: v.error, note: v.note });
    const mReady = await matchOnReady();
    if (!mReady && v.periods.some((p) => p.match_on === 'payment')) {
      return reply.code(503).send({ error: 'migration_required', note: '수금일 판정을 저장하려면 서버에서 npm run migrate(0250)를 먼저 실행하세요.' });
    }
    try {
      await withTx(async (cx) => {
        await cx.query(
          `INSERT INTO commission_agents (user_id, default_rate, active, note, created_by, updated_by)
           VALUES ($1,$2,true,$3,$4,$4)
           ON CONFLICT (user_id) DO UPDATE SET default_rate=$2, active=true, note=$3, updated_by=$4, updated_at=now()`,
          [uid, v.periods[v.periods.length - 1].rate, note, dir]);
        await cx.query(`DELETE FROM commission_agent_periods WHERE user_id=$1`, [uid]);
        for (const p of v.periods) {
          if (mReady) {
            await cx.query(
              `INSERT INTO commission_agent_periods (user_id, start_date, end_date, basis, rate, match_on, created_by, updated_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
              [uid, p.start_date, p.end_date, p.basis, p.rate, p.match_on, dir]);
          } else {
            await cx.query(
              `INSERT INTO commission_agent_periods (user_id, start_date, end_date, basis, rate, created_by, updated_by)
               VALUES ($1,$2,$3,$4,$5,$6,$6)`,
              [uid, p.start_date, p.end_date, p.basis, p.rate, dir]);
          }
        }
      });
    } catch (e) { if (e && e.code === '42P01') return reply.code(503).send({ error: 'commission_not_migrated', note: 'npm run migrate(0143)을 실행하세요.' }); throw e; }
    await logEvent({ userId: dir, action: 'update', target: `commission_agent:${uid}`, detail: { active: true, periods: v.periods.length } });
    return { ok: true, active: true, periods: v.periods };
  });

  // ── 팀 커미션 수혜자 (0233) — 그 팀 고객의 매출 커미션을 고객 담당자 대신 이 사람에게 귀속 ──
  //   예) 06_Tele → Maria. 열람: 디렉터·재무·소시오 / 지정: 디렉터.
  app.get('/api/commission/teams', { preHandler: [authGuard, requirePage('commission')] }, async (req, reply) => {
    if (!canSeeAll(req.ctx.perm)) return reply.code(403).send({ error: 'forbidden' });
    const rows = (await query(
      `SELECT t.id, t.name, (to_jsonb(t)->>'commission_user_id')::bigint AS commission_user_id,
              (SELECT COUNT(*) FROM customers c WHERE c.team_id=t.id) AS customer_count
         FROM sales_teams t WHERE t.deleted_at IS NULL ORDER BY t.sort_order, t.name`)).rows;
    const ready = (await query(`SELECT 1 FROM information_schema.columns WHERE table_name='sales_teams' AND column_name='commission_user_id'`)).rows.length > 0;
    const names = {};
    const ids = rows.map((r) => r.commission_user_id).filter(Boolean);
    if (ids.length) for (const u of (await query(`SELECT id, name FROM users WHERE id = ANY($1)`, [ids])).rows) names[String(u.id)] = u.name;
    return {
      migrated: ready,
      items: rows.map((r) => ({
        id: Number(r.id), name: r.name, customer_count: Number(r.customer_count),
        commission_user_id: r.commission_user_id != null ? Number(r.commission_user_id) : null,
        commission_user_name: r.commission_user_id != null ? (names[String(r.commission_user_id)] || null) : null,
      })),
    };
  });

  app.post('/api/commission/teams/:id/beneficiary', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const teamId = Number(req.params.id);
    const raw = req.body ? req.body.user_id : null;
    const userId = raw === null || raw === '' || raw === undefined ? null : Number(raw);
    if (!teamId || (userId !== null && !(userId > 0))) return reply.code(400).send({ error: 'bad_request' });
    if (userId !== null) {
      const u = (await query(`SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL`, [userId])).rows[0];
      if (!u) return reply.code(400).send({ error: 'user_not_found' });
    }
    try {
      const r = await query(`UPDATE sales_teams SET commission_user_id=$2 WHERE id=$1 RETURNING id`, [teamId, userId]);
      if (!r.rows.length) return reply.code(404).send({ error: 'team_not_found' });
    } catch (e) {
      if (e && e.code === '42703') return reply.code(503).send({ error: 'migration_required', note: 'npm run migrate(0233)을 실행하세요.' });
      throw e;
    }
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `sales_team:${teamId}`, detail: { commission_user_id: userId } });
    return { ok: true, team_id: teamId, commission_user_id: userId };
  });

  // ── 내 커미션 조건(기간별 기준·율) — 로그인한 본인만(영업사원 포함) ──
  app.get('/api/commission/my-periods', { preHandler: [authGuard, requirePage('commission')] }, async (req, reply) => {
    const uid = Number(req.ctx.perm.userId);
    let rows;
    try {
      rows = (await query(
        `SELECT id, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date, basis, rate,
                COALESCE(to_jsonb(cap)->>'match_on','invoice') AS match_on
           FROM commission_agent_periods cap WHERE user_id=$1 ORDER BY start_date`, [uid])).rows;
    } catch (e) { if (e && e.code === '42P01') return { periods: [], not_migrated: true }; throw e; }
    return { periods: rows.map((r) => ({ id: r.id, start_date: r.start_date, end_date: r.end_date || null, basis: r.basis, rate: Number(r.rate), match_on: r.match_on })) };
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
    if (!seeAll) { args.push(Number(perm.userId)); ownerCond = ` AND ben.uid=$${args.length}`; }
    else if (req.query.agent_id) { args.push(Number(req.query.agent_id)); ownerCond = ` AND ben.uid=$${args.length}`; }

    let rows;
    try {
      rows = (await query(
        `SELECT i.id AS invoice_id, i.sat_no,
              to_char(i.inv_date,'YYYY-MM-DD') AS inv_date, to_char(i.inv_date,'YYYY-MM') AS inv_ym,
              (i.subtotal_mxn - nc.base) AS subtotal_mxn, (i.total_mxn - nc.total) AS total_mxn, nc.base AS nc_base,
              ben.uid AS owner_id, ag.name AS agent_name,
              c.id AS customer_id, c.name AS customer_name, c.code AS customer_code,
              per.basis, per.rate, per.match_on, ccr.rate AS cust_rate, pp.amt AS pp_amt, pp.w AS pp_w, po.rate AS po_rate,
              COALESCE(pa.paid_amount,0) AS paid_amount, pa.last_pay_date,
              cp.paid AS payout_paid, to_char(cp.paid_date,'YYYY-MM-DD') AS payout_paid_date, cp.amount AS payout_amount
         FROM sales_invoices i
         JOIN customers c ON c.id=i.customer_id
         LEFT JOIN commission_payouts cp ON cp.invoice_id=i.id${BENEFICIARY_LATERAL}
         JOIN commission_agents ca ON ca.user_id=ben.uid AND ca.active=true
         JOIN users ag ON ag.id=ben.uid
         LEFT JOIN commission_customer_rates ccr ON ccr.user_id=ben.uid AND ccr.customer_id=i.customer_id${PERIOD_LATERAL}${PAYMODE_LATERAL}${NC_LATERAL}
         LEFT JOIN (
           SELECT spa.invoice_id, SUM(spa.amount) AS paid_amount, to_char(MAX(sp.pay_date),'YYYY-MM-DD') AS last_pay_date
             FROM sales_payment_allocations spa JOIN sales_payments sp ON sp.id=spa.payment_id
            GROUP BY spa.invoice_id
         ) pa ON pa.invoice_id=i.id
        WHERE i.status <> 'deleted'
          AND ${COMMISSION_SCOPE}${ownerCond}
        ORDER BY i.inv_date DESC, i.id DESC`, args)).rows;
    } catch (e) {
      if (e && e.code === '42P01') return { view, is_director: perm.role === 'director', can_pay: canPay, see_all: seeAll, agent_id: null, not_migrated: true, summary: { invoice_count: 0, total_base: 0, total_expected: 0, total_confirmed: 0, total_paid: 0, total_unpaid: 0 }, groups: [], by_agent: null };
      throw e;
    }

    let bmap = {};
    try {
      const brows = (await query(`SELECT settle_ym, status FROM commission_batches`)).rows;
      for (const b of brows) bmap[b.settle_ym] = b.status;
    } catch (e) { if (!(e && e.code === '42P01')) throw e; }

    const lines = rows.map((r) => {
      const c = computeLine(r);
      const paid = r.payout_paid === true;
      if (!paid && !c.relevant) return null; // 수금일 판정인데 적립 0·더 받을 것 없음(기간 전 완납 등)
      // 지급된 라인은 지급 시점 금액(payout_amount)으로 동결(기간 조건 변경에도 불변).
      const confirmedShown = paid && r.payout_amount != null ? Number(r.payout_amount) : c.confirmed;
      const bstatus = c.settleYm ? (bmap[c.settleYm] || 'open') : null;
      return {
        invoice_id: r.invoice_id, sat_no: r.sat_no, inv_date: String(r.inv_date).slice(0, 10),
        agent_id: r.owner_id, agent_name: r.agent_name,
        customer_id: r.customer_id, customer_name: r.customer_name, customer_code: r.customer_code,
        rate: c.rate, base: c.base, nc_base: Number(r.nc_base) || 0, expected: c.expected, confirmed: confirmedShown,
        basis: c.basis, mode: c.mode, recognized: c.recognized, fully_paid: c.fullyPaid,
        accrued: c.accrued, collected_base: c.collected_base, potential: c.potential,
        settle_ym: c.settleYm, batch_status: bstatus,
        due_date: c.settleYm ? nextMonth15(c.settleYm) : null,
        paid, paid_date: r.payout_paid_date ? String(r.payout_paid_date).slice(0, 10) : null,
      };
    }).filter(Boolean);

    const sum = (arr, k) => round2(arr.reduce((s, x) => s + Number(x[k] || 0), 0));
    const summary = {
      invoice_count: lines.length,
      total_base: sum(lines, 'base'),
      total_expected: sum(lines, 'expected'),
      total_confirmed: sum(lines, 'confirmed'),
      total_paid: sum(lines.filter((l) => l.paid), 'confirmed'),
      total_unpaid: round2(sum(lines.filter((l) => l.recognized && !l.paid), 'confirmed')),
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
        unpaid: round2(sum(a.lines.filter((l) => l.recognized && !l.paid), 'confirmed')),
      }));
    }

    // 지급 후 매출 조정으로 생긴 미정산 차액(한 영업사원 선택 시 / 영업사원 본인)
    const adjAgent = !seeAll ? Number(perm.userId) : (req.query.agent_id ? Number(req.query.agent_id) : 0);
    const adjustments = adjAgent ? await pendingAdjustments(adjAgent) : [];
    summary.adjustment_total = round2(adjustments.reduce((s, a) => s + a.amount, 0));
    return { view, is_director: perm.role === 'director', can_pay: canPay, see_all: seeAll, agent_id: req.query.agent_id ? Number(req.query.agent_id) : null, summary, groups, by_agent: byAgent, adjustments };
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
    const settleYm = (/^\d{4}-\d{2}$/.test(req.query.settle_ym || '')) ? req.query.settle_ym : null;
    try { lines = await payableLines(agentId, settleYm); }
    catch (e) { if (e && e.code === '42P01') return { agent_id: agentId, not_migrated: true, lines: [], total: 0 }; throw e; }
    const commissionTotal = round2(lines.reduce((s, l) => s + Number(l.expected || 0), 0));
    // 확정·미지급 성과급(월 1건)도 같은 전표로 지급된다. 커미션 라인 충당 후 남는 금액으로 충당.
    const bonus = settleYm ? await payableBonus(agentId, settleYm) : null;
    // 지급 후 매출 조정 차액(차감은 음수) — 이번 지급에 함께 정산된다.
    const adjustments = await pendingAdjustments(agentId);
    const adjustmentTotal = round2(adjustments.reduce((s, a) => s + a.amount, 0));
    const total = round2(commissionTotal + (bonus ? bonus.amount : 0) + adjustmentTotal);
    return {
      agent_id: agentId, settle_ym: settleYm, can_pay: PAY_ROLES.includes(perm.role),
      lines, commission_total: commissionTotal, bonus, adjustments, adjustment_total: adjustmentTotal, total,
    };
  });

  // ── 지급 전표 등록 + 반제(FIFO) + 증빙 (디렉터·재무) ──
  app.post('/api/commission/payments', { preHandler: [authGuard, requirePageEdit('commission')] }, async (req, reply) => {
    const perm = req.ctx.perm; const uid = perm.userId;
    const { agent_id, amount, paid_date, note, evidence } = req.body || {};
    const agentId = Number(agent_id);
    const amt = round2(Number(amount));
    if (!agentId || !(amt > 0)) return reply.code(400).send({ error: 'agent_amount_required' });
    const settleYm = (req.body && /^\d{4}-\d{2}$/.test(req.body.settle_ym || '')) ? req.body.settle_ym : null;
    if (!settleYm) return reply.code(400).send({ error: 'settle_ym_required', note: '지급할 확정 월(반제 완료월)을 지정해야 합니다.' });
    const evi = parseDataUrl(evidence);
    if (!evi) return reply.code(400).send({ error: 'evidence_required', note: '인사 송금 내역(은행 송금증·화면 캡처, 이미지/PDF)을 증빙으로 첨부해야 지급으로 인정됩니다.' });

    // 그 달이 디렉터 확정(또는 인사전달) 상태여야 지급 가능
    let batch;
    try { batch = (await query(`SELECT settle_ym, status, pay_date FROM commission_batches WHERE settle_ym=$1`, [settleYm])).rows[0]; }
    catch (e) { if (e && e.code === '42P01') return reply.code(503).send({ error: 'commission_not_migrated', note: 'npm run migrate(0086~0088)을 실행하세요.' }); throw e; }
    if (!batch) return reply.code(409).send({ error: 'not_confirmed', note: '먼저 디렉터가 그 달을 확정해야 지급할 수 있습니다.' });

    // node-pg는 DATE를 JS Date 객체로 반환 → String().slice(0,10)="Mon Jul 13"(연도 잘림)이 되어 INSERT가 터짐. 안전 변환.
    const _ymd = (v) => { if (v == null) return null; if (v instanceof Date) { if (isNaN(v.getTime())) return null; return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`; } const s = String(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
    const payDate = (paid_date && /^\d{4}-\d{2}-\d{2}$/.test(paid_date)) ? paid_date
      : (_ymd(batch.pay_date) || new Date().toISOString().slice(0, 10));

    let lines;
    try { lines = await payableLines(agentId, settleYm); }
    catch (e) { if (e && e.code === '42P01') return reply.code(503).send({ error: 'commission_not_migrated', note: 'npm run migrate(0086~0088)을 실행하세요.' }); throw e; }
    // 확정·미지급 성과급(월 1건). 커미션 라인이 없어도 성과급만으로 지급할 수 있다.
    const bonus = await payableBonus(agentId, settleYm);
    if (!lines.length && !bonus) return reply.code(409).send({ error: 'nothing_payable', note: '그 달, 이 영업사원의 확정·미지급 커미션·성과급이 없습니다.' });

    // 지급 후 매출 조정 차액은 이번 전표에서 전액 정산(차감=음수·추가=양수). 차감이 지급할 금액보다 크면 이월.
    const adjustments = await pendingAdjustments(agentId);
    const adjTotal = round2(adjustments.reduce((s, a) => s + a.amount, 0));
    const grossDue = round2(lines.reduce((s, l) => s + Number(l.expected || 0), 0) + (bonus ? bonus.amount : 0));
    if (adjTotal < 0 && grossDue + adjTotal < -0.001) {
      return reply.code(409).send({ error: 'adjustment_exceeds', note: `지급 후 매출 조정으로 차감할 금액(${-adjTotal})이 이번 달 지급 대상(${grossDue})보다 큽니다. 차감액은 다음 지급으로 이월됩니다.` });
    }
    // 입력액 + 차감액(또는 − 추가액)만큼 커미션 라인을 FIFO 충당.
    const { allocs, settled, leftover } = allocateFifo(lines, round2(amt - adjTotal));
    // 성과급은 커미션 라인을 FIFO 로 충당하고 남은 금액으로 충당(부분충당 없음).
    const bonusPaid = (bonus && leftover + 0.001 >= bonus.amount) ? bonus : null;
    // 차감은 이번 전표로 실제 충당되는 커미션·성과급 범위 안에서만 반영(현금 지급 < 0 이 되는 정산 방지).
    if (adjustments.length && round2(settled + (bonusPaid ? bonusPaid.amount : 0) + adjTotal) < -0.001) {
      return reply.code(409).send({ error: 'amount_too_small', note: `지급액이 작아 차감(${-adjTotal})을 반영할 수 없습니다. 기본 지급액(커미션 + 성과급 − 차감)으로 등록하세요.` });
    }
    if (!allocs.length && !bonusPaid && !(adjustments.length && adjTotal > 0)) {
      const smallest = lines.length ? round2(lines[0].expected) : (bonus ? bonus.amount : 0);
      return reply.code(409).send({ error: 'amount_too_small', note: `충당할 수 있는 가장 작은 단위(${smallest})보다 지급액이 적습니다. 커미션은 인보이스 단위, 성과급은 월 단위로 충당됩니다.` });
    }

    const baseReady = await payoutBaseReady();
    const baseOf = Object.fromEntries(lines.map((l) => [String(l.invoice_id), l.base]));
    const result = await withTx(async (cx) => {
      const pay = (await cx.query(
        `INSERT INTO commission_payments (agent_id, amount, settled, paid_date, note, evi_name, evi_mime, evi_data, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [agentId, amt, round2(settled + adjTotal), payDate, note || null, (req.body?.evi_name || null), evi.mime, evi.b64, uid])).rows[0];
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
        // 지급 시점 순매출 스냅샷 — 이후 매출 조정 차액 계산의 기준(0232)
        if (baseReady) await cx.query(`UPDATE commission_payouts SET base_mxn=$2 WHERE invoice_id=$1`, [a.invoice_id, baseOf[String(a.invoice_id)] ?? null]);
      }
      // 차액 정산: 전표 배분(음수 가능) + 지급액·기준 순매출을 조정 후 값으로 갱신 → 같은 차액이 다시 잡히지 않음
      for (const adj of adjustments) {
        await cx.query(
          `INSERT INTO commission_payment_allocations (payment_id, invoice_id, amount) VALUES ($1,$2,$3)`,
          [paymentId, adj.invoice_id, adj.amount]);
        await cx.query(
          `UPDATE commission_payouts SET amount=$2, base_mxn=$3, payment_id=$4, updated_by=$5, updated_at=now() WHERE invoice_id=$1 AND paid=true`,
          [adj.invoice_id, adj.new_amount, adj.new_base, paymentId, uid]);
      }
      if (bonusPaid) await markBonusPaid(cx, bonusPaid.id, payDate, paymentId, uid);
      return { paymentId };
    });

    const bonusAmt = bonusPaid ? bonusPaid.amount : 0;
    const settledAll = round2(settled + bonusAmt + adjTotal);
    await logEvent({ userId: uid, action: 'create', target: `commission_payment:${result.paymentId}`, detail: { agent_id: agentId, amount: amt, settled: settledAll, count: allocs.length, bonus: bonusAmt, adjustments: adjustments.length, adjustment_total: adjTotal } });
    return {
      ok: true, payment_id: result.paymentId, settled_count: allocs.length,
      settled: settledAll, commission_settled: settled, bonus_settled: bonusAmt,
      adjustment_count: adjustments.length, adjustment_settled: adjTotal,
      leftover: round2(leftover - bonusAmt), total_paid_amount: amt,
    };
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
        `SELECT p.id, p.agent_id, ag.name AS agent_name, p.amount, p.settled,
                to_char(p.paid_date,'YYYY-MM-DD') AS paid_date, p.note,
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

  // ── 월별 지급 배치 목록 (반제 완료월 단위) — canSeeAll ──
  app.get('/api/commission/batches', { preHandler: [authGuard, requirePage('commission')] }, async (req, reply) => {
    if (!canSeeAll(req.ctx.perm)) return reply.code(403).send({ error: 'forbidden' });
    let months, batches;
    try {
      months = summarizeByMonth(await confirmedMonthLines());
      // pay_date 는 DATE — node-pg 가 Date 객체로 주면 화면에서 "Sat Aug 15" 로 깨지므로 문자열로 고정.
      batches = (await query(`SELECT settle_ym, status, to_char(pay_date,'YYYY-MM-DD') AS pay_date, total_amount, agent_count, confirmed_at, handed_at, handed_note FROM commission_batches`)).rows;
    } catch (e) {
      if (e && e.code === '42P01') return { items: [], not_migrated: true };
      throw e;
    }
    const bmap = {};
    for (const b of batches) bmap[b.settle_ym] = b;
    const items = months.map((m) => {
      const b = bmap[m.settle_ym];
      const allPaid = m.confirmed > 0 && m.unpaid <= 0.001;
      const status = !b ? 'open' : (allPaid ? 'paid' : b.status); // open=집계중(미확정)
      return {
        settle_ym: m.settle_ym, confirmed: m.confirmed, paid: m.paid, unpaid: m.unpaid, agent_count: m.agent_count,
        status, pay_date: b ? (b.pay_date ? String(b.pay_date).slice(0, 10) : null) : nextMonth15(m.settle_ym),
        confirmed_at: b && b.confirmed_at ? b.confirmed_at : null,
        handed_at: b && b.handed_at ? b.handed_at : null,
        handed_note: b ? (b.handed_note || null) : null,
      };
    });
    return { items, can_confirm: req.ctx.perm.role === 'director', can_hand: PAY_ROLES.includes(req.ctx.perm.role) };
  });

  // ── 월 확정 (디렉터) — 제외/조정 없음. 그 달 확정 커미션을 스냅샷으로 잠금 ──
  app.post('/api/commission/batches/:ym/confirm', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const ym = String(req.params.ym || '');
    if (!/^\d{4}-\d{2}$/.test(ym)) return reply.code(400).send({ error: 'bad_ym' });
    const uid = req.ctx.perm.userId;
    let months;
    try { months = summarizeByMonth(await confirmedMonthLines()); }
    catch (e) { if (e && e.code === '42P01') return reply.code(503).send({ error: 'commission_not_migrated' }); throw e; }
    const m = months.find((x) => x.settle_ym === ym);
    if (!m || m.confirmed <= 0) return reply.code(409).send({ error: 'nothing_to_confirm', note: '확정할 커미션(반제 완료분)이 없는 달입니다.' });
    const exists = (await query(`SELECT settle_ym FROM commission_batches WHERE settle_ym=$1`, [ym])).rows[0];
    if (exists) return reply.code(409).send({ error: 'already_confirmed', note: '이미 확정된 달입니다. (확정 취소는 없습니다)' });
    await query(
      `INSERT INTO commission_batches (settle_ym, status, pay_date, total_amount, agent_count, confirmed_by, confirmed_at)
       VALUES ($1,'confirmed',$2,$3,$4,$5,now())`,
      [ym, nextMonth15(ym), m.confirmed, m.agent_count, uid]);
    // 같은 시점에 그 달의 성과급도 스냅샷으로 동결(목표·실적·달성률·금액). 테이블 없으면 건너뜀.
    let bonusSnap = { skipped: true, count: 0 };
    try { bonusSnap = await snapshotBonusForMonth(ym, uid); } catch (e) { if (app.log && app.log.warn) app.log.warn({ err: e }, 'bonus snapshot failed'); }
    await logEvent({ userId: uid, action: 'confirm', target: `commission_batch:${ym}`, detail: { total: m.confirmed, agents: m.agent_count, bonus_snapshots: bonusSnap.count } });
    return { ok: true, settle_ym: ym, total_amount: m.confirmed, agent_count: m.agent_count, pay_date: nextMonth15(ym), bonus_snapshots: bonusSnap.count };
  });

  // ── 인사 전달 기록 (재무·디렉터) — 넘긴 시점 + 로그 ──
  app.post('/api/commission/batches/:ym/hand-off', { preHandler: [authGuard, requirePageEdit('commission')] }, async (req, reply) => {
    const ym = String(req.params.ym || '');
    if (!/^\d{4}-\d{2}$/.test(ym)) return reply.code(400).send({ error: 'bad_ym' });
    const uid = req.ctx.perm.userId;
    const note = (req.body && req.body.note) ? String(req.body.note).slice(0, 500) : null;
    let b;
    try { b = (await query(`SELECT settle_ym, status FROM commission_batches WHERE settle_ym=$1`, [ym])).rows[0]; }
    catch (e) { if (e && e.code === '42P01') return reply.code(503).send({ error: 'commission_not_migrated' }); throw e; }
    if (!b) return reply.code(409).send({ error: 'not_confirmed', note: '먼저 디렉터가 그 달을 확정해야 합니다.' });
    if (b.status === 'handed') return reply.code(409).send({ error: 'already_handed', note: '이미 인사 전달이 기록된 달입니다.' });
    await query(`UPDATE commission_batches SET status='handed', handed_by=$2, handed_at=now(), handed_note=$3 WHERE settle_ym=$1`, [ym, uid, note]);
    await logEvent({ userId: uid, action: 'hand_off', target: `commission_batch:${ym}`, detail: { note } });
    return { ok: true, settle_ym: ym, handed_at: new Date().toISOString() };
  });

  // ── (레거시) 인보이스별 단건 지급 처리 (디렉터) — 증빙 없는 빠른 마킹. 신규는 전표(payments) 사용 ──
  app.post('/api/commission/payout/:invoiceId/pay', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const invoiceId = Number(req.params.invoiceId);
    const uid = req.ctx.perm.userId;
    const paidDate = req.body?.paid_date || new Date().toISOString().slice(0, 10);
    const r = (await query(
      `SELECT i.id, ben.uid AS owner_id, (i.subtotal_mxn - nc.base) AS subtotal_mxn, (i.total_mxn - nc.total) AS total_mxn,
              to_char(i.inv_date,'YYYY-MM') AS inv_ym,
              per.basis, per.rate, per.match_on, ccr.rate AS cust_rate, pp.amt AS pp_amt, pp.w AS pp_w, po.rate AS po_rate,
              COALESCE(pa.paid_amount,0) AS paid_amount, pa.last_pay_date
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
        WHERE i.id=$1
          AND ${COMMISSION_SCOPE}`, [invoiceId])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found', note: '커미션 대상이 아니거나(해당 발행일을 덮는 기간 없음) 인보이스를 찾을 수 없습니다.' });
    const c = computeLine(r);
    if (!c.relevant) return reply.code(404).send({ error: 'not_found', note: '커미션 대상이 아닙니다(수금일 판정 기간 안에 수금된 금액이 없음).' });
    if (!c.recognized) return reply.code(409).send({ error: 'not_settled', note: c.basis === 'collection' ? '반제(완납) 완료 후에 확정 커미션을 지급 처리할 수 있습니다.' : '커미션 확정 대상이 아닙니다.' });
    const amount = c.confirmed;
    const settleYm = c.settleYm;
    await query(
      `INSERT INTO commission_payouts (invoice_id, agent_id, amount, settle_ym, due_date, paid, paid_date, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,true,$6,$7,$7)
       ON CONFLICT (invoice_id) DO UPDATE SET amount=$3, settle_ym=$4, due_date=$5, paid=true, paid_date=$6, updated_by=$7, updated_at=now()`,
      [invoiceId, r.owner_id, amount, settleYm, nextMonth15(settleYm), paidDate, uid]);
    if (await payoutBaseReady()) await query(`UPDATE commission_payouts SET base_mxn=$2 WHERE invoice_id=$1`, [invoiceId, c.base]);
    await logEvent({ userId: uid, action: 'update', target: `commission_payout:${invoiceId}`, detail: { paid: true, amount } });
    return { ok: true, amount };
  });
}
