// =====================================================================
// Refatrix ERP · quoteShortage.js — 견적 부족분을 **견적 저장 즉시** 부족분 대장(stock_shortages)에 기록
//   2026-10-15 · 디렉터 지시
//     ① 부족분은 견적이 입력되는 순간 기록한다(예전: 매출 전환·만료 때에만 적혔다).
//     ② 견적을 삭제해도 부족분 기록은 지우지 않는다 — 로그로 보존할 가치가 있다.
//     ③ 부족분 내역에서 어느 견적에서 생겼는지(견적번호)가 보여야 한다(조회 쪽은 salesRoutes /api/shortages).
//
//   설계 — 견적 1건 × 제품 1개 = 부족 기록 1행(source_quote_id 로 묶인다)
//     · 견적이 살아 있는 동안(작성중·확정, 미삭제) 그 행은 견적의 **현재 부족**을 따라간다:
//         부족 = 요청수량 − 예약확보(reserved_qty, 요청수량으로 캡).
//         저장·수정·재고 재검증·입고 후 자동 예약 보충 때마다 다시 맞춘다. 최초 발생일(occurred_at)은 유지.
//     · 부족이 사라지면(수정으로 수량을 줄였거나 예약이 채워짐) 행을 지우지 않고 status='cancelled' 로 둔다
//         (resolved_by 비움 = 시스템 정리 표식). 다시 부족해지면 같은 행이 open 으로 돌아온다.
//     · 매출 전환 때 실제 출고량으로 마지막으로 맞추고 인보이스를 붙인다(mode:'convert').
//     · 만료·취소·삭제 대기·삭제된 견적의 행은 **그 상태 그대로 얼어붙는다** — 이후 이 모듈이 손대지 않는다.
//     · 살아 있는 견적의 행은 다른 판매의 FIFO 해소 대상이 아니다(shortageResolve.js) —
//         그 견적이 스스로 전환될 때 정리되기 때문이다(이중 해소 방지).
//   손대지 않는 행: 디렉터가 수동 해소/취소한 행(resolved_by 있음), 이미 해소량이 붙은 행,
//     개발완료 적재 행(note 의 [devreq:<id>]). 그런 행이 있는 제품은 새 행도 만들지 않는다.
// =====================================================================

const r3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** 멕시코 중부(UTC−6 고정) 오늘 날짜 YYYY-MM-DD — 화면 mxHoy() 와 같은 기준 */
export function mxToday(now = Date.now()) {
  return new Date(now - 360 * 60000).toISOString().slice(0, 10);
}

const LIVE = ['draft', 'confirmed'];

/**
 * 견적의 부족분 기록을 현재 상태에 맞춘다.
 * @param {{query:Function}} c   트랜잭션 client(withTx 의 c) — c.query 만 쓴다
 * @param {number} quoteId
 * @param {object} opt
 *   mode       'live'(기본) | 'convert'
 *   invoiceId  convert: 만들어진 인보이스 id(출고 0 이면 null)
 *   customerId convert: 전환 고객(불특정 견적을 전환하며 지정한 고객)
 *   fulfilled  convert: Map(product_id → 실제 출고 수량)
 *   occurredAt 신규 행 발생일(기본 멕시코 오늘)
 *   userId
 * @returns {Promise<{skipped?:string, open:number, cancelled:number, created:number}>}
 */
export async function syncQuoteShortages(c, quoteId, opt = {}) {
  const mode = opt.mode === 'convert' ? 'convert' : 'live';
  const out = { open: 0, cancelled: 0, created: 0 };
  const q = (await c.query(
    `SELECT id, quote_no, customer_id, status, deleted_at, created_by FROM quotes WHERE id=$1`, [quoteId])).rows[0];
  if (!q) return { ...out, skipped: 'not_found' };
  if (mode === 'live' && (q.deleted_at || !LIVE.includes(q.status))) return { ...out, skipped: 'not_live' };

  const userId = opt.userId != null ? opt.userId : (q.created_by || null);
  const customerId = mode === 'convert' && opt.customerId ? Number(opt.customerId) : (q.customer_id != null ? Number(q.customer_id) : null);
  const occurredAt = opt.occurredAt || mxToday();
  const invoiceId = mode === 'convert' && opt.invoiceId ? Number(opt.invoiceId) : null;

  // 제품별 합산(같은 제품이 두 줄로 들어와도 한 행)
  const lines = (await c.query(
    `SELECT product_id, qty, reserved_qty, final_price
       FROM quote_lines WHERE quote_id=$1 AND product_id IS NOT NULL`, [quoteId])).rows;
  const agg = new Map();
  for (const l of lines) {
    const pid = Number(l.product_id);
    const qty = Number(l.qty) || 0;
    const resv = Math.min(Math.max(Number(l.reserved_qty) || 0, 0), qty);
    const a = agg.get(pid) || { qty: 0, resv: 0, amt: 0 };
    a.qty = r3(a.qty + qty); a.resv = r3(a.resv + resv); a.amt += (Number(l.final_price) || 0) * qty;
    agg.set(pid, a);
  }

  // 이 견적의 기존 부족 행
  const rows = (await c.query(
    `SELECT id, product_id, status, resolved_qty, resolved_by, note, sales_invoice_id
       FROM stock_shortages WHERE source_quote_id=$1 ORDER BY id FOR UPDATE`, [quoteId])).rows;
  const isDev = (r) => /\[devreq:\d+\]/.test(String(r.note || ''));
  const editable = (r) => !isDev(r) && Number(r.resolved_qty) === 0
    && (r.status === 'open' || (r.status === 'cancelled' && r.resolved_by == null));
  const own = new Map();        // pid → 맞출 행
  const extra = [];             // 같은 제품의 여분 행(옛 전환 방식이 줄마다 만든 것) → 정리
  const locked = new Set();     // 손대면 안 되는 행이 있는 제품
  for (const r of rows) {
    const pid = Number(r.product_id);
    if (isDev(r)) continue;
    if (!editable(r)) { locked.add(pid); continue; }
    if (own.has(pid)) extra.push(r); else own.set(pid, r);
  }

  const tag = mode === 'convert'
    ? (invoiceId ? `견적 ${q.quote_no} 전환(인보이스 #${invoiceId}) — 미확보 부족분` : `견적 ${q.quote_no} 전환 — 출고 없음, 전량 부족`)
    : `견적 ${q.quote_no} — 재고부족(예약 미확보)`;

  const touched = new Set();
  for (const [pid, a] of agg) {
    if (locked.has(pid)) continue;
    const fulfilled = mode === 'convert'
      ? Math.min(Math.max(Number(opt.fulfilled && opt.fulfilled.get(pid)) || 0, 0), a.qty)
      : a.resv;
    const short = r3(a.qty - fulfilled);
    const unit = a.qty > 0 ? a.amt / a.qty : 0;
    const amount = r2(unit * short * 1.16);
    const ex = own.get(pid);
    if (short > 0) {
      if (ex) {
        await c.query(
          `UPDATE stock_shortages
              SET requested_qty=$1, fulfilled_qty=$2, shortage_qty=$3, shortage_amount_mxn=$4,
                  customer_id=$5, sales_invoice_id=$6, status='open', resolved_at=NULL, resolved_by=NULL, note=$7
            WHERE id=$8`,
          [a.qty, fulfilled, short, amount, customerId, invoiceId, tag, ex.id]);
        touched.add(Number(ex.id));
      } else {
        await c.query(
          `INSERT INTO stock_shortages
             (product_id, customer_id, sales_invoice_id, requested_qty, fulfilled_qty, shortage_qty,
              shortage_amount_mxn, occurred_at, source_quote_id, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [pid, customerId, invoiceId, a.qty, fulfilled, short, amount, occurredAt, quoteId, tag, userId]);
        out.created++;
      }
      out.open++;
    } else if (ex) {
      // 부족 없음 — 지우지 않고 시스템 정리(cancelled, resolved_by 비움)로 남긴다
      const why = mode === 'convert'
        ? `견적 ${q.quote_no} 전환 시 전량 출고 — 부족 없음`
        : `견적 ${q.quote_no} — 수정·재고 확보로 현재 부족 없음`;
      await c.query(
        `UPDATE stock_shortages
            SET requested_qty=$1, fulfilled_qty=$2, customer_id=$3, sales_invoice_id=$4,
                status='cancelled', resolved_at=NULL, resolved_by=NULL, note=$5
          WHERE id=$6`,
        [a.qty, fulfilled, customerId, invoiceId, why, ex.id]);
      touched.add(Number(ex.id));
      out.cancelled++;
    }
  }
  // 견적에서 빠진 제품의 행 + 여분 행 → 정리(삭제 아님)
  const gone = [...own.values()].filter((r) => !touched.has(Number(r.id))).concat(extra);
  for (const r of gone) {
    if (r.status === 'cancelled') continue;
    await c.query(
      `UPDATE stock_shortages SET status='cancelled', resolved_at=NULL, resolved_by=NULL, note=$1 WHERE id=$2`,
      [`견적 ${q.quote_no} — 수정으로 줄 삭제·중복 정리(기록 보존)`, r.id]);
    out.cancelled++;
  }
  return out;
}

/**
 * 견적이 살아 있는 상태를 벗어날 때(만료·취소·삭제) 그 견적의 부족 행에 사연을 덧붙인다.
 * 행은 지우지 않는다 — 수량·상태는 그대로 두고 note 끝에 한 번만 붙인다.
 */
export async function markQuoteShortages(c, quoteId, suffix) {
  if (!quoteId || !suffix) return 0;
  const r = await c.query(
    `UPDATE stock_shortages SET note = COALESCE(note,'') || $2
      WHERE source_quote_id=$1 AND status='open'
        AND COALESCE(note,'') NOT LIKE '%[devreq:%'
        AND POSITION($2 IN COALESCE(note,'')) = 0`, [quoteId, suffix]);
  return r.rowCount || 0;
}

/** 여러 견적을 각각 맞춘다(입고 후 자동 예약 보충 등). 실패한 견적은 건너뛴다. */
export async function syncQuoteShortagesMany(withTx, quoteIds, opt = {}) {
  let n = 0;
  for (const id of [...new Set((quoteIds || []).map(Number).filter(Boolean))]) {
    try { await withTx(async (c) => { await syncQuoteShortages(c, id, opt); }); n++; } catch (_) { /* best-effort */ }
  }
  return n;
}
