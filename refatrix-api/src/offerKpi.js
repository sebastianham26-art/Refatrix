// =====================================================================
// Offer Sheet KPI — 부족분 → 오퍼시트 발송 → 매출(인보이스) 전환 자동 매칭
//   (디렉터 확정 2026-08-03: 자동 매칭 · 인보이스 기준(IVA 제외) · 직원별 귀속)
//
//   매칭 규칙:
//     - 대상 시트: 발송됨(sent_at 있음) · 취소 아님 · 미삭제.
//     - 인보이스가 [발송일, 발송일+KPI_WINDOW_DAYS] 안이고
//       같은 고객 + 시트에 담긴 SKU(제안수량>0)면 그 시트의 실적.
//     - 시트별·SKU별 귀속 수량은 제안수량(offer_qty 합)까지만 — 캡 초과분은
//       오퍼와 무관한 일반 판매로 보고 제외.
//     - 같은 고객·SKU에 시트가 여럿이면 먼저 발송된 시트부터 귀속(이중 집계 없음).
//     - 금액 = 귀속수량 × 인보이스 단가(ex-IVA). 직원 귀속 = 시트 sent_by.
//   계산은 조회 시점에 수행(스냅샷 없음) — 인보이스 삭제·시트 취소가 즉시 반영된다.
// =====================================================================

export const KPI_WINDOW_DAYS = 30;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const d10 = (s) => String(s || '').slice(0, 10);

function addDays(ymd, n) {
  const t = new Date(ymd + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/**
 * 순수 계산부 (pg 없이 테스트 가능)
 * @param {Array} sheets   [{id, offer_no, customer_id, customer_name, sent_date:'YYYY-MM-DD',
 *                           sent_by, sent_by_name, lines:[{product_id, offer_qty}]}]
 * @param {Array} invoices [{id, sat_no, customer_id, product_id, qty, unit_price,
 *                           inv_date:'YYYY-MM-DD', ctr_code, product_name}]
 *                         — 대상 월의 인보이스만 넘길 것 (정렬 불문, 내부에서 날짜순 처리)
 * @returns {{matches:Array, staff:Array, totals:Object}}
 */
export function computeOfferKpi(sheets, invoices, windowDays = KPI_WINDOW_DAYS) {
  // 시트별 SKU 잔여 귀속 가능량(제안수량 합)
  const sh = (sheets || []).map((s) => ({
    ...s,
    until: addDays(s.sent_date, windowDays),
    remain: new Map((s.lines || []).filter((l) => Number(l.offer_qty) > 0)
      .reduce((m, l) => {
        const k = Number(l.product_id);
        m.set(k, (m.get(k) || 0) + Number(l.offer_qty));
        return m;
      }, new Map())),
  }));
  const inv = (invoices || []).slice().sort((a, b) =>
    d10(a.inv_date) < d10(b.inv_date) ? -1 : d10(a.inv_date) > d10(b.inv_date) ? 1 : (Number(a.id) - Number(b.id)));

  const matches = [];
  for (const i of inv) {
    let left = Number(i.qty) || 0;
    if (left <= 0) continue;
    const pid = Number(i.product_id);
    // 후보: 같은 고객 + SKU 잔여 있음 + 날짜창 안 — 먼저 발송된 시트부터
    const cands = sh.filter((s) => Number(s.customer_id) === Number(i.customer_id)
      && (s.remain.get(pid) || 0) > 0
      && d10(i.inv_date) >= s.sent_date && d10(i.inv_date) <= s.until)
      .sort((a, b) => (a.sent_date < b.sent_date ? -1 : a.sent_date > b.sent_date ? 1 : Number(a.id) - Number(b.id)));
    for (const s of cands) {
      if (left <= 0) break;
      const take = Math.min(left, s.remain.get(pid) || 0);
      if (take <= 0) continue;
      s.remain.set(pid, (s.remain.get(pid) || 0) - take);
      left -= take;
      matches.push({
        invoice_id: Number(i.id), sat_no: i.sat_no || null, inv_date: d10(i.inv_date),
        offer_sheet_id: Number(s.id), offer_no: s.offer_no || null,
        customer_id: Number(i.customer_id), customer_name: s.customer_name || i.customer_name || null,
        product_id: pid, ctr_code: i.ctr_code || null, product_name: i.product_name || null,
        qty: take, unit_price: r2(i.unit_price), amount_mxn: r2(take * (Number(i.unit_price) || 0)),
        staff_id: s.sent_by != null ? Number(s.sent_by) : null,
        staff_name: s.sent_by_name || null,
      });
    }
  }

  // 직원별 집계 (sent_by 기준)
  const byStaff = new Map();
  const staffKey = (id, name) => (id != null ? String(id) : 'none');
  for (const s of sh) {
    const k = staffKey(s.sent_by, s.sent_by_name);
    if (!byStaff.has(k)) byStaff.set(k, { staff_id: s.sent_by != null ? Number(s.sent_by) : null, staff_name: s.sent_by_name || '(미지정)', sheets_sent: 0, sheets_matched: 0, invoices: 0, matched_amount_mxn: 0, _sheets: new Set() });
  }
  for (const m of matches) {
    const k = staffKey(m.staff_id, m.staff_name);
    if (!byStaff.has(k)) byStaff.set(k, { staff_id: m.staff_id, staff_name: m.staff_name || '(미지정)', sheets_sent: 0, sheets_matched: 0, invoices: 0, matched_amount_mxn: 0, _sheets: new Set() });
    const st = byStaff.get(k);
    st.matched_amount_mxn = r2(st.matched_amount_mxn + m.amount_mxn);
    st.invoices += 1;
    st._sheets.add(m.offer_sheet_id);
  }
  const staff = [...byStaff.values()].map((s) => ({
    staff_id: s.staff_id, staff_name: s.staff_name,
    sheets_sent: s.sheets_sent, sheets_matched: s._sheets.size,
    invoices: s.invoices, matched_amount_mxn: r2(s.matched_amount_mxn),
  })).sort((a, b) => b.matched_amount_mxn - a.matched_amount_mxn);

  const totals = {
    matched_amount_mxn: r2(matches.reduce((a, m) => a + m.amount_mxn, 0)),
    invoices: matches.length,
    sheets_matched: new Set(matches.map((m) => m.offer_sheet_id)).size,
  };
  return { matches, staff, totals };
}

/**
 * DB 로딩 + 계산 + 프로모 결합. q = query 함수.
 * ym = 'YYYY-MM' (인보이스 발행 월 기준)
 */
export async function loadOfferKpi(q, ym) {
  const ymStart = ym + '-01';
  const [y, m] = ym.split('-').map(Number);
  const ymNext = (m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`) + '-01';
  const sentFrom = addDays(ymStart, -KPI_WINDOW_DAYS); // 이전 달 말 발송분도 창이 이번 달에 걸침

  // 발송된 시트(취소·비활성 제외) — 발송일이 [월초−창, 월말] 안이면 후보
  //   비활성(0183 disabled_at)은 "없던 오퍼로 친다"는 뜻이라 전환 KPI·프로모에서도 빠진다.
  const sheetRows = (await q(
    `SELECT os.id, os.offer_no, os.customer_id, os.sent_by, os.sent_at::text AS sent_at,
            c.name AS customer_name, us.name AS sent_by_name
       FROM offer_sheets os
       JOIN customers c ON c.id = os.customer_id
       LEFT JOIN users us ON us.id = os.sent_by
      WHERE os.deleted_at IS NULL AND os.status <> 'cancelled' AND os.sent_at IS NOT NULL
        AND os.disabled_at IS NULL
        AND os.sent_at::text >= $1 AND os.sent_at::text < $2`,
    [sentFrom, ymNext])).rows;
  const sheets = [];
  for (const r of sheetRows) {
    const lines = (await q(
      `SELECT oi.product_id, SUM(oi.offer_qty) AS offer_qty
         FROM offer_sheet_items oi WHERE oi.offer_sheet_id = $1
        GROUP BY oi.product_id`, [Number(r.id)])).rows
      .map((l) => ({ product_id: Number(l.product_id), offer_qty: Number(l.offer_qty) }));
    sheets.push({
      id: Number(r.id), offer_no: r.offer_no, customer_id: Number(r.customer_id),
      customer_name: r.customer_name, sent_by: r.sent_by != null ? Number(r.sent_by) : null,
      sent_by_name: r.sent_by_name || null, sent_date: d10(r.sent_at), lines,
    });
  }

  // 이번 달 발송 건수(직원별) — 매칭과 별개로 활동량 표시용
  const sentThisMonth = sheetRows.filter((r) => d10(r.sent_at) >= ymStart && d10(r.sent_at) < ymNext);

  // 이번 달 인보이스 중 (시트 고객×SKU) 후보만
  const pairs = new Map();
  for (const s of sheets) for (const l of s.lines) pairs.set(s.customer_id + ':' + l.product_id, true);
  let invoices = [];
  if (pairs.size) {
    const invRows = (await q(
      `SELECT i.id, i.sat_no, i.customer_id, i.product_id, i.qty, i.unit_price, i.inv_date::text AS inv_date,
              p.code AS ctr_code, p.name AS product_name
         FROM invoices i
         JOIN products p ON p.id = i.product_id
        WHERE i.deleted_at IS NULL AND i.inv_date >= $1 AND i.inv_date < $2`,
      [ymStart, ymNext])).rows;
    invoices = invRows
      .filter((i) => pairs.has(Number(i.customer_id) + ':' + Number(i.product_id)))
      .map((i) => ({ ...i, id: Number(i.id), customer_id: Number(i.customer_id), product_id: Number(i.product_id), qty: Number(i.qty), unit_price: Number(i.unit_price) }));
  }

  const out = computeOfferKpi(sheets, invoices);
  // 직원별 발송 건수 채우기 (매칭 0이어도 발송했으면 표시)
  const sentCnt = new Map();
  for (const r of sentThisMonth) {
    const k = r.sent_by != null ? String(Number(r.sent_by)) : 'none';
    sentCnt.set(k, (sentCnt.get(k) || 0) + 1);
    if (!out.staff.some((s) => String(s.staff_id != null ? s.staff_id : 'none') === (r.sent_by != null ? String(Number(r.sent_by)) : 'none'))) {
      out.staff.push({ staff_id: r.sent_by != null ? Number(r.sent_by) : null, staff_name: r.sent_by_name || '(미지정)', sheets_sent: 0, sheets_matched: 0, invoices: 0, matched_amount_mxn: 0 });
    }
  }
  for (const s of out.staff) s.sheets_sent = sentCnt.get(s.staff_id != null ? String(s.staff_id) : 'none') || 0;

  const promo = (await q(`SELECT id, ym, goal_amount_mxn, prize_text, active FROM offer_promos WHERE ym = $1`, [ym])).rows[0] || null;
  if (promo) {
    for (const s of out.staff) s.achieved = promo.active !== false && Number(promo.goal_amount_mxn) > 0 && s.matched_amount_mxn >= Number(promo.goal_amount_mxn);
  }
  return {
    ym, window_days: KPI_WINDOW_DAYS,
    promo: promo ? { id: Number(promo.id), ym: promo.ym, goal_amount_mxn: Number(promo.goal_amount_mxn), prize_text: promo.prize_text || '', active: promo.active !== false } : null,
    staff: out.staff, matches: out.matches, totals: { ...out.totals, sheets_sent: sentThisMonth.length },
  };
}
