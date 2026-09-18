// 견적 조립 — **화면과 수신 창구가 같은 것을 쓴다.**
//
//   예전에는 이 함수들이 quoteRoutes.js 안에 갇혀 있었다. 그래서 CRM 이 견적을 넣으려면
//   ERP 화면용 API 를 직원 계정으로 호출하는 수밖에 없었고, 실제로 그렇게 하다가
//   **남의 고객(NAJAR)에 견적이 붙는 사고**가 났다.
//
//   이제 조립기는 여기 한 곳에 있다. 코드 해석 규칙·재고 예약·번호 채번이 바뀌면
//   화면과 수신 창구가 **같이** 바뀐다. 두 벌로 두면 반드시 어긋난다 — 이 프로젝트에서
//   이미 여러 번 겪었다.
import { query } from './db.js';
import { computeQuoteLine, stockFlag, formatQuoteNo, round2 } from './quotes.js';


// ============ 코드 해석 (CTR 또는 SYD) ============
// 입력 코드 하나를 받아 매칭 후보를 반환. CTR 정확매칭 우선, 없으면 SYD 역검색.
// 반환: { matches: [{product_id, ctr_code, list_price, app, name, syd_codes[]}], source:'ctr'|'syd'|'none' }
export async function resolveCode(code) {
  const c = String(code || '').trim();
  if (!c) return { matches: [], source: 'none' };
  // 1) CTR 정확매칭
  const ctr = (await query(
    `SELECT id, code, name, app, list_price, is_active FROM products WHERE deleted_at IS NULL AND code=$1`, [c])).rows;
  let rows = ctr, source = 'ctr';
  if (!rows.length) {
    // 2) SYD 역검색
    rows = (await query(
      `SELECT p.id, p.code, p.name, p.app, p.list_price, p.is_active
         FROM product_syd_codes s JOIN products p ON p.id=s.product_id AND p.deleted_at IS NULL
        WHERE s.syd_code=$1`, [c])).rows;
    source = rows.length ? 'syd' : 'none';
  }
  if (!rows.length) return { matches: [], source: 'none' };
  const ids = rows.map((r) => r.id);
  const sydRows = (await query(`SELECT product_id, syd_code FROM product_syd_codes WHERE product_id = ANY($1)`, [ids])).rows;
  const sydByPid = {};
  for (const s of sydRows) (sydByPid[s.product_id] ||= []).push(s.syd_code);
  return {
    source,
    matches: rows.map((r) => ({
      product_id: r.id, ctr_code: r.code, name: r.name, app: r.app,
      list_price: Number(r.list_price) || 0, syd_codes: sydByPid[r.id] || [],
      // 0179 — 비활성(판매중단) SKU 는 화면에 표시는 하되 신규 라인 저장에서 막는다.
      is_active: r.is_active !== false,
    })),
  };
}

/**
 * 화면(ERP) 경로가 **저장하는** issue 값 — 비활성만 남긴다.
 *
 *   buildLines 는 `not_found`·`multi_match`·`inactive` 세 가지를 붙인다.
 *   그중 화면 경로가 DB 에 남기는 것은 **`inactive` 하나뿐**이다.
 *   코드를 못 찾은 줄(not_found)은 예전부터 그대로 저장·확정돼 왔고, 여기서 같이
 *   막으면 이번 요구(판매중단 SKU 수요 기록)와 상관없는 동작이 조용히 바뀐다.
 *   포털 수신 창구(0220)는 지금처럼 **세 가지 전부** 저장한다 — 남이 보낸 견적은
 *   0원짜리 줄이 섞여도 사람이 볼 때까지 아무도 모르기 때문이다.
 */
export const screenIssue = (issue) => (issue === 'inactive' ? 'inactive' : null);

/**
 * 비활성 SKU 별 **판매중단 시각** — Map(product_id → Date|null).
 *
 *   견적 수정 때 「이 줄이 중단 전부터 있던 줄인가, 중단 후에 새로 들어온 요청인가」를
 *   가르는 데 쓴다. 중단 **전에** 만들어진 견적은 예전처럼 확정·인보이스 발행이 가능해야
 *   하고(0179 가 견적→매출 전환을 막지 않은 것과 같은 이유), 중단 **후에** 들어온 요청은
 *   수요로 기록하되 확정이 잠겨야 한다.
 */
export async function inactiveSinceMap(productIds) {
  const ids = [...new Set((productIds || []).map(Number).filter((x) => Number.isFinite(x) && x > 0))];
  const map = new Map();
  if (!ids.length) return map;
  const rows = (await query(
    `SELECT p.id,
            COALESCE(
              (SELECT max(l.changed_at) FROM product_status_log l
                WHERE l.product_id = p.id AND l.action = 'deactivate'),
              p.status_changed_at) AS since_at
       FROM products p
      WHERE p.id = ANY($1::bigint[]) AND p.deleted_at IS NULL AND p.is_active = FALSE`, [ids])).rows;
  for (const r of rows) map.set(Number(r.id), r.since_at || null);
  return map;
}

// 0179 · 저장하려는 라인 중 「비활성 SKU」를 골라낸다(신규 사용 차단).
//   allowedIds = 이미 그 견적에 들어 있던 product_id 집합 —
//   비활성 전에 만들어진 기존 견적을 계속 수정·정리할 수 있어야 하므로 예외로 둔다.
export async function inactiveTargets(inputLines, allowedIds = null) {
  const hits = [];
  for (const ln of (Array.isArray(inputLines) ? inputLines : [])) {
    let pid = Number(ln.product_id) || null;
    if (!pid) {
      const res = await resolveCode(ln.code);
      if (res.matches.length === 1) pid = res.matches[0].product_id;
    }
    if (!pid) continue;
    if (allowedIds && allowedIds.has(Number(pid))) continue;
    const p = (await query(
      `SELECT id, code, name FROM products WHERE id=$1 AND deleted_at IS NULL AND NOT is_active`, [pid])).rows[0];
    if (p && !hits.some((h) => h.product_id === Number(p.id))) {
      hits.push({ product_id: Number(p.id), code: p.code, name: p.name });
    }
  }
  return hits;
}

// ============ 재고 예약(블럭) · 만료(무효화) 공통 ============
// 가용재고 = 현재고 − 타 미결·미만료 견적의 reserved_qty 합. 물리 stock_qty는 예약으로 안 건드림.
// 한 견적의 매칭 라인들을 제품별로 묶어 생성순(line_no)으로 선착순 greedy 배분한다.
//  · 같은 트랜잭션(c) 안에서 product 행을 FOR UPDATE 로 잠가, 동시 저장이 같은 재고를 중복 예약하지 못하게 직렬화.
//  · '타 견적' 합은 이미 커밋된 reserved_qty 만 보이므로(잠금 대기 후 읽음) 선착순이 보장된다.
export async function assignReservations(c, quoteId) {
  const lines = (await c.query(
    `SELECT id, product_id, qty FROM quote_lines
      WHERE quote_id=$1 AND product_id IS NOT NULL ORDER BY product_id, line_no, id`, [quoteId])).rows;
  const byProd = {};
  for (const l of lines) { (byProd[Number(l.product_id)] ||= []).push(l); }
  for (const pid of Object.keys(byProd)) {
    const p = (await c.query(`SELECT stock_qty FROM products WHERE id=$1 FOR UPDATE`, [Number(pid)])).rows[0];
    const physical = p && p.stock_qty != null ? Number(p.stock_qty) : 0;
    const other = (await c.query(
      `SELECT COALESCE(SUM(ql.reserved_qty),0) AS s
         FROM quote_lines ql JOIN quotes q ON q.id=ql.quote_id
        WHERE ql.product_id=$1 AND q.id<>$2 AND q.status IN ('draft','confirmed')
          AND (q.reserve_expires_at > now() OR q.packing_printed_at IS NOT NULL)
          AND q.deleted_at IS NULL`, [Number(pid), quoteId])).rows[0];
    let remaining = Math.max(0, physical - (Number(other.s) || 0));
    for (const l of byProd[pid]) {
      const want = Number(l.qty) || 0;
      const give = Math.max(0, Math.min(want, remaining));
      remaining -= give;
      await c.query(`UPDATE quote_lines SET reserved_qty=$1 WHERE id=$2`, [give, l.id]);
    }
  }
}

// ============ 견적 저장/수정 ============
export async function nextQuoteNo(c, year) {
  const r = (await c.query(`SELECT COUNT(*)::int AS n FROM quotes WHERE quote_no LIKE $1`, [`Q-${year}-%`])).rows[0];
  return formatQuoteNo(year, (r.n || 0) + 1);
}

/**
 * 라인 입력 → 계산 후 저장용 행 생성
 *
 *   각 행에 `issue` 를 함께 붙인다 — **왜 이 줄이 이상한지**를 한 단어로 남기는 칸이다.
 *     not_found   코드를 찾지 못했다(단가 0 으로 들어간다)
 *     multi_match SYD 코드가 여러 제품에 걸렸다 — 사람이 골라야 한다
 *     inactive    판매중단 SKU
 *   화면 경로는 이 값을 저장하지 않는다(예전 그대로 동작). CRM 수신 창구만 저장해서
 *   **문제 줄이 있는 견적은 확정을 막는다.** 0원 줄이 붙은 견적이 고객에게 나가는 것이
 *   지금 가장 위험한 일이다.
 */
export async function buildLines(customerDiscount, ivaRate, inputLines) {
  const rows = [];
  let lineNo = 0;
  for (const ln of inputLines) {
    lineNo++;
    const qty = Number(ln.qty) || 0;
    let prod = null;
    let issue = null;
    if (ln.product_id) prod = (await query(`SELECT id, code, name, app, list_price, stock_qty, is_active FROM products WHERE id=$1 AND deleted_at IS NULL`, [Number(ln.product_id)])).rows[0] || null;
    else {
      const res = await resolveCode(ln.code);
      if (res.matches.length === 1) prod = (await query(`SELECT id, code, name, app, list_price, stock_qty, is_active FROM products WHERE id=$1`, [res.matches[0].product_id])).rows[0];
      // 다중매칭은 저장 단계에서 product_id가 와야 함(화면에서 선택). 여기선 미매칭 처리.
      else if (res.matches.length > 1) issue = 'multi_match';
    }
    if (!prod) {
      rows.push({ line_no: lineNo, product_id: null, input_code: ln.code || null, ctr_code: null, syd_codes: null, product_name: null, app_text: null, qty, list_price: 0, discount_rate: customerDiscount, final_price: 0, line_subtotal: 0, line_iva: 0, line_total: 0, avail_stock: null, stock_flag: 'not_found', issue: issue || 'not_found' });
      continue;
    }
    if (prod.is_active === false) issue = 'inactive';
    const sydRows = (await query(`SELECT syd_code FROM product_syd_codes WHERE product_id=$1`, [prod.id])).rows.map((x) => x.syd_code);
    const calc = computeQuoteLine({ listPrice: prod.list_price, discountRate: customerDiscount, qty, ivaRate });
    const avail = prod.stock_qty != null ? Number(prod.stock_qty) : null;
    rows.push({
      line_no: lineNo, product_id: prod.id, input_code: ln.code || prod.code, ctr_code: prod.code,
      syd_codes: sydRows.join(' / '), product_name: prod.name, app_text: prod.app, qty,
      list_price: round2(prod.list_price), discount_rate: customerDiscount,
      final_price: calc.finalPrice, line_subtotal: calc.lineSubtotal, line_iva: calc.lineIva, line_total: calc.lineTotal,
      avail_stock: avail, stock_flag: stockFlag({ matched: true, qty, availStock: avail }),
      issue,
    });
  }
  return rows;
}