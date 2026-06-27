// Q-2026-0048 / 0049 / 0050 견적 유효 고정 + 만료 백로그 원복 + 재고 예약(블럭) 재배분.
// 앱의 DB 연결을 그대로 사용. refatrix-api 디렉터리에서 실행할 것.
import { query, withTx, pool } from './src/db.js';

const QUOTE_NOS = ['Q-2026-0048', 'Q-2026-0049', 'Q-2026-0050'];

// 앱 quoteRoutes.assignReservations 와 동일한 선착순(greedy) 예약 재배분.
//  · 가용 = 물리재고 - 타 미결/유효고정 견적의 reserved_qty 합
//  · 견적 라인을 제품별로 묶어 line_no 순서로 채움. 제품행은 FOR UPDATE 로 직렬화.
async function assignReservations(c, quoteId) {
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

function showQuotes(rows) {
  for (const r of rows) {
    console.log(`  ${r.quote_no} | id=${r.id} | status=${r.status} | reserve_expires_at=${r.reserve_expires_at} | packing_printed_at=${r.packing_printed_at}`);
  }
}

try {
  console.log('=== 실행 전 ===');
  const before = (await query(
    `SELECT id, quote_no, status, reserve_expires_at, packing_printed_at
       FROM quotes WHERE quote_no = ANY($1) ORDER BY quote_no`, [QUOTE_NOS])).rows;
  if (!before.length) console.log('  (해당 견적 없음 — quote_no 확인 필요)');
  showQuotes(before);

  const result = await withTx(async (c) => {
    // ① 유효 고정(+만료면 되살림)
    const upd = (await c.query(
      `UPDATE quotes
          SET packing_printed_at = COALESCE(packing_printed_at, now()),
              status = CASE WHEN status='expired' THEN 'confirmed' ELSE status END,
              updated_at = now()
        WHERE quote_no = ANY($1)
        RETURNING id, quote_no, status`, [QUOTE_NOS])).rows;
    const ids = upd.map((r) => r.id).sort((a, b) => a - b);   // 먼저 만든 견적 우선

    // ② 만료 백로그 원복(이 견적이 만든 것만)
    let shCancelled = 0, devDeleted = 0;
    if (ids.length) {
      shCancelled = (await c.query(
        `UPDATE stock_shortages SET status='cancelled'
          WHERE source_quote_id = ANY($1) AND sales_invoice_id IS NULL AND status='open'
          RETURNING id`, [ids])).rowCount;
      devDeleted = (await c.query(
        `UPDATE product_dev_requests SET deleted_at=now(), updated_at=now()
          WHERE source_quote_id = ANY($1) AND deleted_at IS NULL AND status='received'
          RETURNING id`, [ids])).rowCount;
    }

    // ③ 예약(블럭) 재배분 — 현재 재고 기준, id 오름차순(선착순)
    for (const qid of ids) await assignReservations(c, qid);

    return { upd, ids, shCancelled, devDeleted };
  });

  console.log('\n=== 처리 결과 ===');
  console.log(`  견적 갱신: ${result.upd.length}건 -> ${result.upd.map((r) => r.quote_no + '(' + r.status + ')').join(', ') || '없음'}`);
  console.log(`  만료 부족분 취소(stock_shortages): ${result.shCancelled}건`);
  console.log(`  만료 개발요청 원복(product_dev_requests): ${result.devDeleted}건`);

  // ④ 라인별 확보(블럭) 현황 출력
  console.log('\n=== 라인별 재고 블럭(예약) 현황 ===');
  for (const qid of result.ids) {
    const q = (await query(`SELECT quote_no FROM quotes WHERE id=$1`, [qid])).rows[0];
    const lines = (await query(
      `SELECT ql.ctr_code, ql.product_name, ql.qty, ql.reserved_qty, p.stock_qty
         FROM quote_lines ql LEFT JOIN products p ON p.id=ql.product_id
        WHERE ql.quote_id=$1 AND ql.product_id IS NOT NULL
        ORDER BY ql.line_no, ql.id`, [qid])).rows;
    let okN = 0, shortN = 0, okQ = 0, shortQ = 0;
    for (const l of lines) {
      const qty = Number(l.qty) || 0, rsv = Number(l.reserved_qty) || 0;
      if (rsv >= qty) { okN++; okQ += qty; } else { shortN++; shortQ += (qty - rsv); }
    }
    console.log(`  ${q.quote_no}: 즉시매출가능 ${okN}SKU(${okQ}개) · 부족 ${shortN}SKU(${shortQ}개 모자람)`);
  }

  console.log('\n=== 실행 후 ===');
  const after = (await query(
    `SELECT id, quote_no, status, reserve_expires_at, packing_printed_at
       FROM quotes WHERE quote_no = ANY($1) ORDER BY quote_no`, [QUOTE_NOS])).rows;
  showQuotes(after);
  console.log('\n완료. 견적 목록 Ctrl+Shift+R 후 "📦 유효 고정" 배지와 수주현황 바를 확인하세요.');
} catch (e) {
  console.error('오류:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
