// =====================================================================
// Refatrix ERP · monthlyReport.js — 월간 WhatsApp 보고 (숫자=SQL 확정치, AI 미사용)
//   gatherMonthly(q, ym, today) : DB 조회 → 보고 데이터 객체
//   buildReportKo(d) / buildReportEs(d) : 데이터 → WhatsApp 본문(한국어/스페인어)
//   · 매출 = sales_invoices posted subtotal_mxn(IVA 제외) — 영업 대시보드와 동일 기준.
//   · 목표 = target_customer_months 당월 합(이월 미포함 순수 월목표).
//   · 신규 고객 = 첫 posted 인보이스가 당월인 고객. repeat = 전체 − 신규 매출.
//   · 수금 = sales_payments 당월 입금 총액(선수금 포함).
//   · overdue/open invoice = 현재 시점 미수 잔액 기준(월과 무관한 "현재" 스냅샷).
//   · 견적 = draft/confirmed/converted (취소·가격표 제외). 매출 연결 = converted.
//   · 부서별 이슈 = 라이브 WBR 보드(이번주+다음주).
//   pg-mem 호환: FILTER/to_char 미사용, 날짜는 범위 파라미터, 집계 후 JS 계산.
// =====================================================================

const ORG_KO = { sales: '영업', support: '영업지원', pm: '제품마케팅', wh: '창고', mgmt: '경영총괄' };
const ORG_ES = { sales: 'Ventas', support: 'Soporte de Ventas', pm: 'Producto y Marketing', wh: 'Almacén', mgmt: 'Dirección General' };

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function r2(v) { return Math.round(num(v) * 100) / 100; }
export function fmtMxn(v) { return 'MX$' + Math.round(num(v)).toLocaleString('en-US'); }
export function fmtQty(v) { return num(v).toLocaleString('en-US', { maximumFractionDigits: 0 }); }

// ym 'YYYY-MM' → [당월 시작, 익월 시작, 전월 시작) ISO 날짜 문자열
export function monthRange(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const from = `${y}-${pad(mo)}-01`;
  const to = mo === 12 ? `${y + 1}-01-01` : `${y}-${pad(mo + 1)}-01`;
  const prevFrom = mo === 1 ? `${y - 1}-12-01` : `${y}-${pad(mo - 1)}-01`;
  return { ym, from, to, prevFrom };
}

// DB 조회 → 보고 데이터. q = query 함수, today = 'YYYY-MM-DD'(미수 판정 기준일).
export async function gatherMonthly(q, ym, today) {
  const r = monthRange(ym);
  if (!r) throw new Error('bad_ym');

  // ① 매출(당월·전월, IVA 제외) + 월목표
  const sales = num((await q(
    `SELECT COALESCE(SUM(subtotal_mxn),0) AS a FROM sales_invoices
      WHERE status='posted' AND inv_date >= $1 AND inv_date < $2`, [r.from, r.to])).rows[0].a);
  const salesPrev = num((await q(
    `SELECT COALESCE(SUM(subtotal_mxn),0) AS a FROM sales_invoices
      WHERE status='posted' AND inv_date >= $1 AND inv_date < $2`, [r.prevFrom, r.from])).rows[0].a);
  const target = num((await q(
    `SELECT COALESCE(SUM(amount),0) AS a FROM target_customer_months WHERE ym = $1`, [ym])).rows[0].a);

  // ② 신규 고객(첫 posted 인보이스가 당월) — 고객별 첫 매출일 + 당월 매출을 한 번에 집계 후 JS 판별
  const custRows = (await q(
    `SELECT c.id, c.name, MIN(i.inv_date) AS first_date,
            SUM(CASE WHEN i.inv_date >= $1 AND i.inv_date < $2 THEN i.subtotal_mxn ELSE 0 END) AS rev
       FROM sales_invoices i JOIN customers c ON c.id = i.customer_id
      WHERE i.status='posted'
      GROUP BY c.id, c.name`, [r.from, r.to])).rows;
  const inMonth = (d) => { const s = String(d instanceof Date ? d.toISOString().slice(0, 10) : d).slice(0, 10); return s >= r.from && s < r.to; };
  const newCust = custRows.filter((c) => inMonth(c.first_date))
    .map((c) => ({ id: Number(c.id), name: c.name, rev: r2(c.rev) }))
    .sort((a, b) => b.rev - a.rev);
  const newRev = r2(newCust.reduce((a, c) => a + c.rev, 0));
  const repeatRev = r2(Math.max(0, sales - newRev));

  // ③ 수금(당월 입금 총액, 선수금 포함)
  const collected = num((await q(
    `SELECT COALESCE(SUM(amount),0) AS a FROM sales_payments
      WHERE pay_date >= $1 AND pay_date < $2`, [r.from, r.to])).rows[0].a);

  // ④ 현재 미수(open invoice) / overdue — posted 인보이스의 잔액을 JS 로 판별
  const arRows = (await q(
    `SELECT i.id, i.total_mxn, i.due_date, COALESCE(p.paid,0) AS paid
       FROM sales_invoices i
       LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) p
         ON p.invoice_id = i.id
      WHERE i.status='posted'`, [])).rows;
  let openCnt = 0, openAmt = 0, overdueAmt = 0, overdueCnt = 0;
  const todayS = String(today).slice(0, 10);
  for (const row of arRows) {
    const bal = r2(num(row.total_mxn) - num(row.paid));
    if (bal <= 0.005) continue;
    openCnt += 1; openAmt += bal;
    const due = row.due_date ? String(row.due_date instanceof Date ? row.due_date.toISOString().slice(0, 10) : row.due_date).slice(0, 10) : null;
    if (due && due < todayS) { overdueAmt += bal; overdueCnt += 1; }
  }
  openAmt = r2(openAmt); overdueAmt = r2(overdueAmt);

  // ⑤ 견적(당월, 취소·가격표 제외) + 매출 연결(converted)
  const qRows = (await q(
    `SELECT status, sku_count, total_qty FROM quotes
      WHERE deleted_at IS NULL AND quote_date >= $1 AND quote_date < $2
        AND status IN ('draft','confirmed','converted')`, [r.from, r.to])).rows;
  const quotes = { n: qRows.length, sku: 0, qty: 0, convN: 0, convSku: 0, convQty: 0 };
  for (const row of qRows) {
    quotes.sku += num(row.sku_count); quotes.qty += num(row.total_qty);
    if (row.status === 'converted') { quotes.convN += 1; quotes.convSku += num(row.sku_count); quotes.convQty += num(row.total_qty); }
  }

  // ⑥ 부서별 이슈(라이브 WBR 보드)
  let issues = {};
  try {
    const b = (await q(`SELECT data FROM wbr_board WHERE id=1`, [])).rows[0];
    issues = (b && b.data && b.data.issues) || {};
  } catch (_) { issues = {}; }

  const momPct = salesPrev > 0 ? r2((sales - salesPrev) / salesPrev * 100) : null;
  const targetPct = target > 0 ? Math.round(sales / target * 100) : null;
  return {
    ym, today: todayS,
    sales: r2(sales), salesPrev: r2(salesPrev), momPct, target: r2(target), targetPct,
    newCust, newRev, repeatRev,
    collected: r2(collected),
    openCnt, openAmt, overdueCnt, overdueAmt,
    quotes, issues,
  };
}

function issueLines(issues, orgNames) {
  const out = [];
  for (const k of Object.keys(orgNames)) {
    const t = issues[k] || {};
    const items = [].concat(Array.isArray(t.this) ? t.this : [], Array.isArray(t.next) ? t.next : [])
      .map((x) => String(x || '').trim()).filter(Boolean);
    if (!items.length) continue;
    out.push(`[${orgNames[k]}]`);
    for (const it of items) out.push(`- ${it}`);
  }
  return out;
}

export function buildReportKo(d) {
  const L = [];
  L.push(`📊 REFATRIX 월간 보고 (${d.ym})`);
  L.push('');
  L.push('1) 매출과 수금');
  const mom = d.momPct == null ? '전월 실적이 없어 비교 불가' : `전월 대비 ${d.momPct >= 0 ? '+' : ''}${d.momPct}% ${d.momPct >= 0 ? '성장' : '감소'}`;
  const tgt = d.targetPct == null ? '월 목표 미설정' : `목표 대비 ${d.targetPct}% 달성`;
  L.push(`당월 매출은 ${fmtMxn(d.sales)}(IVA 제외)입니다. ${mom}했고, ${tgt}입니다.`);
  if (d.newCust.length) {
    L.push(`신규 고객은 ${d.newCust.length}개사를 발굴하여 ${fmtMxn(d.newRev)}의 매출을 하였습니다. 고객명은 ${d.newCust.map((c) => c.name).join(', ')}입니다.`);
    L.push(`전체 매출 중 신규 고객 매출을 제외한 ${fmtMxn(d.repeatRev)}가 기존 고객의 repeat order로부터 생성되었습니다.`);
  } else {
    L.push(`당월 신규 고객 매출은 없으며, 전체 매출 ${fmtMxn(d.repeatRev)}가 기존 고객의 repeat order로부터 생성되었습니다.`);
  }
  L.push(`수금은 총 ${fmtMxn(d.collected)}을 수금하였습니다.`);
  L.push(`현재 overdue는 ${fmtMxn(d.overdueAmt)}(${d.overdueCnt}건)이고, open invoice는 ${d.openCnt}개이며, 금액으로는 ${fmtMxn(d.openAmt)}입니다.`);
  L.push('');
  L.push('2) 견적 추이 분석');
  L.push(`견적은 총 ${d.quotes.n}건이며, SKU 수량 ${fmtQty(d.quotes.sku)}개, 총 수량 ${fmtQty(d.quotes.qty)}개였습니다.`);
  L.push(`이 중 매출로 연결된 것은 ${d.quotes.convN}건 / SKU ${fmtQty(d.quotes.convSku)}개 / 수량 ${fmtQty(d.quotes.convQty)}개입니다.`);
  L.push('');
  L.push('3) 각 부서별 주요 이슈는 다음과 같습니다.');
  const il = issueLines(d.issues, ORG_KO);
  if (il.length) L.push(...il); else L.push('- 등록된 이슈가 없습니다.');
  return L.join('\n');
}

export function buildReportEs(d) {
  const L = [];
  L.push(`📊 REFATRIX Informe Mensual (${d.ym})`);
  L.push('');
  L.push('1) Ventas y Cobranza');
  const mom = d.momPct == null ? 'sin mes anterior comparable' : `${d.momPct >= 0 ? 'crecimiento de +' : 'variación de '}${d.momPct}% vs. mes anterior`;
  const tgt = d.targetPct == null ? 'objetivo mensual no definido' : `avance del ${d.targetPct}% vs. objetivo`;
  L.push(`Ventas del mes: ${fmtMxn(d.sales)} (sin IVA), ${mom}, ${tgt}.`);
  if (d.newCust.length) {
    L.push(`Se desarrollaron ${d.newCust.length} clientes nuevos con ventas de ${fmtMxn(d.newRev)}. Clientes: ${d.newCust.map((c) => c.name).join(', ')}.`);
    L.push(`${fmtMxn(d.repeatRev)} provienen de pedidos repetidos (repeat orders) de clientes existentes.`);
  } else {
    L.push(`Sin clientes nuevos este mes; ${fmtMxn(d.repeatRev)} provienen de pedidos repetidos de clientes existentes.`);
  }
  L.push(`Cobranza total del mes: ${fmtMxn(d.collected)}.`);
  L.push(`Actualmente vencido (overdue): ${fmtMxn(d.overdueAmt)} (${d.overdueCnt} facturas); facturas abiertas: ${d.openCnt} por ${fmtMxn(d.openAmt)}.`);
  L.push('');
  L.push('2) Cotizaciones');
  L.push(`Total ${d.quotes.n} cotizaciones, ${fmtQty(d.quotes.sku)} SKUs, ${fmtQty(d.quotes.qty)} piezas.`);
  L.push(`Convertidas a venta: ${d.quotes.convN} cotizaciones / ${fmtQty(d.quotes.convSku)} SKUs / ${fmtQty(d.quotes.convQty)} piezas.`);
  L.push('');
  L.push('3) Temas principales por equipo:');
  const il = issueLines(d.issues, ORG_ES);
  if (il.length) L.push(...il); else L.push('- Sin temas registrados.');
  return L.join('\n');
}
