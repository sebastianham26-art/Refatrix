// =====================================================================
// Refatrix ERP · rackStock.js  (랙별 재고 / Inventario por ubicación) · 0245
//
//   제품 × 랙 × 수량을 유지하는 단일 모듈. 다른 라우트는 이 파일의 함수만 부른다.
//
//   디렉터 결정(2026-10-01):
//     · 실사 반영 시 SKU 별 "랙마다 몇 개"를 그대로 저장한다.
//     · 포장작업지시서는 여러 위치 중 **fast moving 랙을 먼저** 보여준다.
//     · 포장 때 랙 바코드는 스캔하지 않는다 — **지시서에 적힌 위치에서 자동 차감**한다.
//
//   피킹 순서(pickOrder): ① fast moving 랙(rack_kinds.kind='fast') ② 가용수량 많은 랙
//                         (들르는 랙 수 최소화) ③ 랙 번호 자연정렬.
//   가용수량 = 랙 수량 − 다른 견적이 이미 지시서로 잡아 둔 미차감 수량(quote_pick_alloc).
//
//   총량 기준은 여전히 products.stock_qty 다. 랙 수량 합과의 차이는 「위치 미지정」이며,
//   차감할 랙 수량이 모자라면 남는 분량은 위치 미지정에서 나간 것으로 본다(음수 랙 없음).
//
//   안전장치: 매출·실사·위치변경 트랜잭션 안에서는 rackSafe() 로 SAVEPOINT 를 걸어 부른다.
//   랙 기록이 실패해도 본 업무(매출 등록 등)는 막지 않는다 — 실패는 로그에 남는다.
//
//   0269 (디렉터 지시 2026-10-12) — 아래 「0269」 절:
//     · importRacks   : 창고 실사로 받은 SKU × 랙 × 수량 업로드. 파일에 나온 SKU 는 그 내용으로 통째로 맞춘다.
//                       SKU 별 랙 합계가 등록 재고(stock_qty)를 넘으면 그 SKU 는 저장하지 않는다(초과 차단).
//     · transferRack  : 창고담당자 위치수정 = 「기존 위치 → 새 위치 + 수량」. 합계가 그대로라 재고를 벗어날 수 없다.
//                       위치 미지정 → 랙은 미지정 수량까지만, 랙 → 위치 미지정도 가능.
//                       다른 포장지시서가 잡아 둔 수량은 옮기지 않는다(종이 지시서 위치가 틀어지므로).
//     · recordPick    : 포장 때 「실제로 이 랙에서 집었다」 기록. 매출 전환 때 이 위치에서 차감된다.
// =====================================================================
import { query } from './db.js';

export const RACK_BUILD = '20261012re1';

// ---- 스키마 준비 여부(마이그레이션 0245 전 배포 대비) ----------------------
let readyFlag = false, probeAt = 0;
export async function rackStockReady() {
  if (readyFlag) return true;
  if (Date.now() - probeAt < 5000) return false;   // 마이그레이션 직후 5초 안에 켜진다
  probeAt = Date.now();
  try {
    const r = await query(`SELECT to_regclass('public.quote_pick_alloc') IS NOT NULL AS ok`);
    readyFlag = !!(r.rows[0] && r.rows[0].ok);
  } catch (_) { readyFlag = false; }
  return readyFlag;
}
/** 시험용 */
export function setRackStockReady(v) { readyFlag = !!v; probeAt = Date.now(); }

// 0269(업로드·위치수정·피킹기록) 준비 여부 — 마이그레이션 전에 백엔드만 올라가도 기존 랙 기능은 그대로 돈다.
let editFlag = false, editProbeAt = 0;
export async function rackEditReady() {
  if (editFlag) return true;
  if (Date.now() - editProbeAt < 5000) return false;
  editProbeAt = Date.now();
  try {
    const r = await query(
      `SELECT to_regclass('public.rack_stock_imports') IS NOT NULL
              AND EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_name='quote_pick_alloc' AND column_name='picked_at') AS ok`);
    editFlag = !!(r.rows[0] && r.rows[0].ok);
  } catch (_) { editFlag = false; }
  return editFlag;
}
/** 시험용 */
export function setRackEditReady(v) { editFlag = !!v; editProbeAt = Date.now(); }

// ---- 공용 유틸 -------------------------------------------------------------
const n3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
export function normRack(v) { return String(v == null ? '' : v).trim().toUpperCase(); }
export function rackNatKey(v) { return normRack(v).replace(/\d+/g, (d) => d.padStart(6, '0')); }
function runner(exec) {
  if (!exec) return query;
  if (typeof exec === 'function') return exec;
  return (s, p) => exec.query(s, p);
}

/** 피킹 순서 정렬 — fast 먼저 → 수량(key) 많은 순 → 랙 번호 자연정렬 */
export function pickOrder(rows, key = 'qty') {
  return rows.slice().sort((a, b) => {
    const fa = a.kind === 'fast' ? 0 : 1, fb = b.kind === 'fast' ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const qa = Number(a[key]) || 0, qb = Number(b[key]) || 0;
    if (qa !== qb) return qb - qa;
    const ka = rackNatKey(a.rack), kb = rackNatKey(b.rack);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** 가용수량으로 피킹 위치를 나눈다(순수 함수 — 시험 대상).
 *  rows: [{rack, qty, kind, held}]  → [{rack, qty, kind}] (+ 남으면 {rack:null, qty})
 *  1차: 가용(qty−held)으로 fast 우선 배분. 2차: 그래도 남으면 다른 견적이 잡아 둔 실물까지
 *  (먼저 포장하는 쪽이 가져간다). 3차: 랙에 없으면 위치 미지정. */
export function splitPick(rows, want, { strict = false } = {}) {
  let rem = n3(want);
  const out = [];
  const taken = new Map();
  const add = (r, q) => {
    const k = r.rack; taken.set(k, n3((taken.get(k) || 0) + q));
    const ex = out.find((o) => o.rack === k);
    if (ex) ex.qty = n3(ex.qty + q); else out.push({ rack: k, qty: n3(q), kind: r.kind || 'carton' });
    rem = n3(rem - q);
  };
  const withAvail = rows.map((r) => ({ ...r, avail: Math.max(0, n3((Number(r.qty) || 0) - (Number(r.held) || 0))) }));
  for (const r of pickOrder(withAvail, 'avail')) {
    if (rem <= 0) break;
    const q = Math.min(rem, r.avail);
    if (q > 0) add(r, q);
  }
  if (rem > 0 && !strict) {        // strict = 다른 지시서가 잡은 수량은 끝까지 건드리지 않는다(출고 차감용)
    for (const r of pickOrder(rows, 'qty')) {
      if (rem <= 0) break;
      const left = n3((Number(r.qty) || 0) - (taken.get(r.rack) || 0));
      const q = Math.min(rem, left);
      if (q > 0) add(r, q);
    }
  }
  if (rem > 0) out.push({ rack: null, qty: n3(rem), kind: null });
  return out;
}

// ---- 조회 -------------------------------------------------------------------
/** 제품별 랙 수량(피킹 순서로 정렬) — Map(pid → [{rack, qty, kind}]) */
export async function rackMap(exec, productIds) {
  const run = runner(exec);
  const ids = [...new Set((productIds || []).map(Number).filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;
  const rows = (await run(
    `SELECT s.product_id, s.rack, s.qty,
            COALESCE((SELECT k.kind FROM rack_kinds k WHERE UPPER(TRIM(k.rack)) = s.rack
                       ORDER BY k.updated_at DESC LIMIT 1), 'carton') AS kind
       FROM product_rack_stock s
      WHERE s.product_id = ANY($1::bigint[]) AND s.qty > 0`, [ids])).rows;
  for (const r of rows) {
    const pid = Number(r.product_id);
    if (!map.has(pid)) map.set(pid, []);
    map.get(pid).push({ rack: r.rack, qty: n3(r.qty), kind: r.kind });
  }
  for (const [k, v] of map) map.set(k, pickOrder(v));
  return map;
}

/** 다른(미전환) 견적이 지시서로 잡아 둔 랙별 미차감 수량 — Map(rack → qty) */
async function openHolds(run, productId, excludeQuoteId) {
  const rows = (await run(
    `SELECT pa.rack, SUM(pa.qty) AS held
       FROM quote_pick_alloc pa
       JOIN quotes q ON q.id = pa.quote_id
      WHERE pa.product_id = $1 AND pa.rack IS NOT NULL AND pa.consumed_invoice_id IS NULL
        AND pa.quote_id <> $2
        AND q.deleted_at IS NULL AND q.invoice_id IS NULL
        AND q.status IN ('draft','confirmed','expired')   -- 출력된 만료 견적도 전환 가능하므로 잡아 둔다
      GROUP BY pa.rack`, [productId, excludeQuoteId || 0])).rows;
  const m = new Map();
  for (const r of rows) m.set(r.rack, n3(r.held));
  return m;
}

/** 피킹 계획(저장하지 않음) */
export async function planPick(exec, productId, qty, { excludeQuoteId = null, strict = false } = {}) {
  const run = runner(exec);
  const racks = (await rackMap(run, [productId])).get(Number(productId)) || [];
  const holds = await openHolds(run, productId, excludeQuoteId);
  return splitPick(racks.map((r) => ({ ...r, held: holds.get(r.rack) || 0 })), qty, { strict });
}

async function quoteAllocRows(run, quoteId) {
  // 0269 전이면 picked 컬럼이 없다 — NULL 로 대신해 기존 동작 그대로
  const pk = (await rackEditReady())
    ? `pa.picked_at, (SELECT u.name FROM users u WHERE u.id = pa.picked_by) AS picked_by_name`
    : `NULL::timestamptz AS picked_at, NULL::text AS picked_by_name`;
  return (await run(
    `SELECT pa.id, pa.product_id, pa.rack, pa.qty, pa.seq, pa.consumed_invoice_id, ${pk},
            COALESCE((SELECT k.kind FROM rack_kinds k WHERE UPPER(TRIM(k.rack)) = pa.rack
                       ORDER BY k.updated_at DESC LIMIT 1), 'carton') AS kind
       FROM quote_pick_alloc pa
      WHERE pa.quote_id = $1
      ORDER BY pa.product_id, pa.seq, pa.id`, [quoteId])).rows;
}
/** 저장된 피킹 위치 → 화면용. picked = 창고가 실제 피킹 랙을 기록한 줄(0269). */
function allocOut(a) {
  const o = { rack: a.rack, qty: n3(a.qty), kind: a.rack ? a.kind : null };
  if (a.picked_at) { o.picked = true; o.picked_at = a.picked_at; o.picked_by_name = a.picked_by_name || ''; }
  return o;
}
function groupItems(items) {
  const m = new Map();
  for (const it of items || []) {
    const pid = Number(it.product_id); const q = n3(it.qty);
    if (!pid || q <= 0) continue;
    m.set(pid, n3((m.get(pid) || 0) + q));
  }
  return m;
}

/** 견적의 피킹 위치(표시용). 지시서로 저장된 위치가 있고 수량이 맞으면 그것, 아니면 새 계획.
 *  items: [{product_id, qty}] → { [pid]: [{rack, qty, kind}] , _saved:{[pid]:bool} } */
export async function quotePicks(exec, quoteId, items) {
  const run = runner(exec);
  const want = groupItems(items);
  const saved = await quoteAllocRows(run, quoteId);
  const out = {}; const fixed = {};
  for (const [pid, qty] of want) {
    let mine = saved.filter((a) => Number(a.product_id) === pid && a.consumed_invoice_id == null);
    // 이미 매출로 차감된 견적이면 차감에 쓴 위치를 그대로 보여준다(새 계획으로 바뀌어 보이지 않게)
    if (!mine.length) mine = saved.filter((a) => Number(a.product_id) === pid && a.consumed_invoice_id != null);
    const sum = n3(mine.reduce((s, a) => s + Number(a.qty), 0));
    if (mine.length && sum === qty) {
      out[pid] = mine.map(allocOut);
      fixed[pid] = true;
    } else {
      out[pid] = await planPick(run, pid, qty, { excludeQuoteId: quoteId });
      fixed[pid] = false;
    }
  }
  return { picks: out, saved: fixed };
}

/** 포장작업지시서 출력 시 피킹 위치를 저장(재출력하면 수량이 바뀐 SKU 만 다시 잡는다). */
export async function snapshotQuotePicks(exec, quoteId, items, userId) {
  const run = runner(exec);
  const want = groupItems(items);
  // 동시 출력 방어: 같은 견적 두 번 클릭 → 견적 행 잠금 / 다른 견적이 같은 SKU 를 동시에 → SKU 별 잠금(트랜잭션 끝까지)
  await run(`SELECT id FROM quotes WHERE id=$1 FOR UPDATE`, [quoteId]);
  for (const pid of [...want.keys()].sort((a, b) => a - b)) await run(`SELECT pg_advisory_xact_lock(245, $1::int)`, [pid]);
  const saved = await quoteAllocRows(run, quoteId);
  // 견적에서 빠진(또는 즉시재고가 아니게 된) SKU 의 미차감 위치는 지운다.
  const gone = [...new Set(saved.filter((a) => a.consumed_invoice_id == null && !want.has(Number(a.product_id)))
    .map((a) => Number(a.product_id)))];
  if (gone.length) {
    await run(`DELETE FROM quote_pick_alloc WHERE quote_id=$1 AND consumed_invoice_id IS NULL AND product_id = ANY($2::bigint[])`,
      [quoteId, gone]);
  }
  const out = {};
  for (const [pid, qty] of want) {
    const mine = saved.filter((a) => Number(a.product_id) === pid && a.consumed_invoice_id == null);
    const sum = n3(mine.reduce((s, a) => s + Number(a.qty), 0));
    if (mine.length && sum === qty) {
      out[pid] = mine.map(allocOut);
      continue;
    }
    if (mine.length) await run(`DELETE FROM quote_pick_alloc WHERE quote_id=$1 AND product_id=$2 AND consumed_invoice_id IS NULL`, [quoteId, pid]);
    const plan = await planPick(run, pid, qty, { excludeQuoteId: quoteId });
    let seq = 0;
    for (const p of plan) {
      await run(`INSERT INTO quote_pick_alloc (quote_id, product_id, rack, qty, seq, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [quoteId, pid, p.rack, p.qty, seq++, userId || null]);
    }
    out[pid] = plan;
  }
  return out;
}

// ---- 수량 변경(원장 포함) ----------------------------------------------------
async function ledger(run, pid, rack, delta, after, meta) {
  await run(
    `INSERT INTO product_rack_moves (product_id, rack, delta, qty_after, reason, ref, sales_invoice_id, quote_id, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [pid, rack, n3(delta), n3(after), meta.reason, meta.ref || null, meta.invoiceId || null, meta.quoteId || null,
      meta.note || null, meta.userId || null]);
}

/** 랙에서 최대 want 만큼 뺀다 → 실제로 뺀 수량 */
export async function takeFromRack(exec, productId, rack, want, meta) {
  const run = runner(exec);
  const r = normRack(rack); const w = n3(want);
  if (!r || w <= 0) return 0;
  const cur = (await run(`SELECT qty FROM product_rack_stock WHERE product_id=$1 AND rack=$2 FOR UPDATE`, [productId, r])).rows[0];
  const have = cur ? n3(cur.qty) : 0;
  const take = Math.min(have, w);
  if (take <= 0) return 0;
  const after = n3(have - take);
  if (after <= 0) await run(`DELETE FROM product_rack_stock WHERE product_id=$1 AND rack=$2`, [productId, r]);
  else await run(`UPDATE product_rack_stock SET qty=$3, updated_by=$4, updated_at=now() WHERE product_id=$1 AND rack=$2`,
    [productId, r, after, meta.userId || null]);
  await ledger(run, productId, r, -take, after, meta);
  return take;
}

/** 랙에 qty 를 더한다 → 더한 뒤 수량 */
export async function addToRack(exec, productId, rack, qty, meta) {
  const run = runner(exec);
  const r = normRack(rack); const q = n3(qty);
  if (!r || q <= 0) return null;
  const row = (await run(
    `INSERT INTO product_rack_stock (product_id, rack, qty, updated_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (product_id, rack) DO UPDATE SET qty = product_rack_stock.qty + EXCLUDED.qty,
        updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING qty`, [productId, r, q, meta.userId || null])).rows[0];
  await ledger(run, productId, r, q, row.qty, meta);
  return n3(row.qty);
}

/** 랙 수량을 정확히 qty 로 맞춘다(실사·수동) → delta */
export async function setRackQty(exec, productId, rack, qty, meta) {
  const run = runner(exec);
  const r = normRack(rack); const q = Math.max(0, n3(qty));
  if (!r) return 0;
  const cur = (await run(`SELECT qty FROM product_rack_stock WHERE product_id=$1 AND rack=$2 FOR UPDATE`, [productId, r])).rows[0];
  const have = cur ? n3(cur.qty) : 0;
  const delta = n3(q - have);
  if (delta === 0) return 0;
  if (q === 0) await run(`DELETE FROM product_rack_stock WHERE product_id=$1 AND rack=$2`, [productId, r]);
  else await run(
    `INSERT INTO product_rack_stock (product_id, rack, qty, updated_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (product_id, rack) DO UPDATE SET qty = EXCLUDED.qty, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [productId, r, q, meta.userId || null]);
  await ledger(run, productId, r, delta, q, meta);
  return delta;
}

/** 매출 출고 차감 — 견적 지시서 위치 → (모자라면) 남은 랙을 피킹 순서로 → 그래도 남으면 위치 미지정.
 *  lines: [{product_id, qty}] */
export async function deductForSale(exec, { invoiceId, quoteId = null, lines, userId }) {
  const run = runner(exec);
  const want = groupItems(lines);
  const meta = { reason: 'sale', ref: `sales:${invoiceId}`, invoiceId, quoteId, userId };
  const result = [];
  for (const [pid, qty] of want) {
    const used = [];
    // ① 지시서에 적힌 위치(랙이 있는 분량만). 지시서가 「위치 미지정」으로 낸 분량은 랙에서 빼지 않는다.
    let pref = [];
    if (quoteId) {
      pref = (await run(
        `SELECT id, rack, qty FROM quote_pick_alloc
          WHERE quote_id=$1 AND product_id=$2 AND consumed_invoice_id IS NULL ORDER BY seq, id`, [quoteId, pid])).rows;
    }
    let fromRacks;                       // 랙에서 빠져야 할 수량
    if (pref.length) {
      fromRacks = Math.min(qty, n3(pref.filter((p) => p.rack).reduce((s, p) => s + Number(p.qty), 0)));
    } else {
      pref = await planPick(run, pid, qty, { excludeQuoteId: quoteId || 0, strict: true });
      fromRacks = n3(pref.filter((p) => p.rack).reduce((s, p) => s + Number(p.qty), 0));
    }
    let rem = fromRacks;
    for (const p of pref) {
      if (rem <= 0) break;
      if (!p.rack) continue;
      const t = await takeFromRack(run, pid, p.rack, Math.min(rem, n3(p.qty)), meta);
      if (t > 0) { rem = n3(rem - t); used.push({ rack: normRack(p.rack), qty: t }); }
    }
    if (rem > 0) {   // 지시서 위치의 실물 기록이 모자람 → 다른 견적이 잡지 않은 랙에서만 피킹 순서대로
      const plan = await planPick(run, pid, rem, { excludeQuoteId: quoteId || 0, strict: true });
      for (const p of plan) {
        if (rem <= 0 || !p.rack) continue;
        const t = await takeFromRack(run, pid, p.rack, Math.min(rem, p.qty), meta);
        if (t > 0) { rem = n3(rem - t); used.push({ rack: p.rack, qty: t }); }
      }
    }
    if (quoteId) {
      await run(`UPDATE quote_pick_alloc SET consumed_invoice_id=$1 WHERE quote_id=$2 AND product_id=$3 AND consumed_invoice_id IS NULL`,
        [invoiceId, quoteId, pid]);
    }
    rem = n3(qty - used.reduce((s, u) => s + u.qty, 0));   // 랙에서 못 뺀 분량 = 위치 미지정에서 출고
    result.push({ product_id: pid, qty, racks: used, unassigned: n3(rem) });
  }
  return result;
}

/** 매출 삭제·수정 시 그 인보이스가 뺀 랙 수량을 같은 랙으로 되돌린다(여러 번 불러도 안전). */
export async function restoreForSale(exec, invoiceId, userId) {
  const run = runner(exec);
  const rows = (await run(
    `SELECT product_id, rack, SUM(delta) AS net FROM product_rack_moves
      WHERE sales_invoice_id=$1 AND reason IN ('sale','sale_reverse')
      GROUP BY product_id, rack HAVING SUM(delta) < 0`, [invoiceId])).rows;
  const meta = { reason: 'sale_reverse', ref: `sales_reverse:${invoiceId}`, invoiceId, userId };
  for (const r of rows) await addToRack(run, Number(r.product_id), r.rack, -Number(r.net), meta);
  // 견적이 미전환으로 돌아가면 같은 위치를 다시 쓰도록 지시서 위치의 차감 표시를 푼다.
  await run(`UPDATE quote_pick_alloc SET consumed_invoice_id=NULL WHERE consumed_invoice_id=$1`, [invoiceId]);
  return rows.length;
}

/** 재고실사 반영 — 세션에서 센 랙별 수량으로 그 SKU 의 랙 재고를 통째로 맞춘다.
 *  opts.only: Set(pid) 이면 그 제품만, opts.skip: Set(pid) 는 제외. 랙이 하나도 안 찍힌 SKU 는 손대지 않는다. */
export async function applyCountToRacks(exec, countId, { only = null, skip = null, userId = null, code = '' } = {}) {
  const run = runner(exec);
  const rows = (await run(
    `SELECT product_id, UPPER(TRIM(rack_scanned)) AS rack, SUM(counted_qty) AS q
       FROM stock_count_lines
      WHERE count_id=$1 AND item_kind='part' AND product_id IS NOT NULL
        AND NULLIF(TRIM(COALESCE(rack_scanned,'')),'') IS NOT NULL
      GROUP BY product_id, UPPER(TRIM(rack_scanned))`, [countId])).rows;
  const byPid = new Map();
  for (const r of rows) {
    const pid = Number(r.product_id);
    if (only && !only.has(pid)) continue;
    if (skip && skip.has(pid)) continue;
    if (!byPid.has(pid)) byPid.set(pid, new Map());
    const m = byPid.get(pid); m.set(r.rack, n3((m.get(r.rack) || 0) + Number(r.q)));
  }
  // 이 실사가 실제로 돈 랙(어느 SKU 든 한 번이라도 찍힌 랙). 그 랙 안에서는 실사 수량이 정답이고,
  // 실사가 가지 않은 랙(다른 구역)의 기록은 건드리지 않는다 — 부분 실사(예: AE 랙만)가 다른 구역 재고를 지우지 않게.
  const visited = new Set(rows.map((r) => r.rack));
  const meta = { reason: 'count', ref: `count:${countId}`, userId, note: code ? `재고실사 ${code}` : null };
  let skus = 0, changed = 0;
  for (const [pid, counted] of byPid) {
    const cur = (await run(`SELECT rack FROM product_rack_stock WHERE product_id=$1`, [pid])).rows
      .map((x) => x.rack).filter((rk) => visited.has(rk));
    const all = new Set([...cur, ...counted.keys()]);
    for (const rack of all) {
      const d = await setRackQty(run, pid, rack, counted.get(rack) || 0, meta);
      if (d !== 0) changed += 1;
    }
    skus += 1;
  }
  return { skus, changed };
}

/** 위치변경(rack_moves) — 출발 랙에서 빼고 도착 랙에 더한다. 출발 랙 기록이 모자라면
 *  모자란 분량은 위치 미지정에서 올라온 것으로 본다(도착 랙에는 옮긴 수량 전부를 더한다). */
export async function relocate(exec, productId, fromRack, toRack, qty, { userId = null, ref = null, note = null } = {}) {
  const run = runner(exec);
  const q = n3(qty);
  if (q <= 0 || !normRack(toRack)) return { taken: 0, added: 0 };
  const meta = { reason: 'relocate', ref, userId, note };
  const taken = fromRack ? await takeFromRack(run, productId, fromRack, q, meta) : 0;
  await addToRack(run, productId, toRack, q, meta);
  return { taken, added: q };
}

/** 특정 참조(예: 'inbound_item:91')로 더했던 랙 수량을 그대로 되돌린다(적치 리셋 등). 여러 번 불러도 안전. */
export async function reverseByRef(exec, ref, reason, userId) {
  const run = runner(exec);
  const rows = (await run(
    `SELECT product_id, rack, SUM(delta) AS net FROM product_rack_moves
      WHERE ref=$1 GROUP BY product_id, rack HAVING SUM(delta) <> 0`, [ref])).rows;
  const meta = { reason, ref, userId, note: '되돌림' };
  for (const r of rows) {
    const net = Number(r.net);
    if (net > 0) await takeFromRack(run, Number(r.product_id), r.rack, net, meta);
    else await addToRack(run, Number(r.product_id), r.rack, -net, meta);
  }
  return rows.length;
}

/** 트랜잭션 안에서 랙 작업을 격리해 실행 — 실패해도 본 업무는 계속된다. */
let spSeq = 0;
export async function rackSafe(client, label, fn) {
  if (!(await rackStockReady())) return null;
  const sp = 'rs_' + String(label || 'x').replace(/[^a-z0-9_]/gi, '') + '_' + (++spSeq % 100000);
  await client.query(`SAVEPOINT ${sp}`);
  try {
    const r = await fn((s, p) => client.query(s, p));
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return r;
  } catch (e) {
    try { await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); } catch (_) {}
    try { console.error('[rackStock]', label, e && e.message); } catch (_) {}
    return null;
  }
}

/** 화면 표시용 짧은 문자열 — "AE5-1 ×4 · AE1-3 ×8" */
export function picksText(list) {
  return (list || []).filter((p) => p.rack).map((p) => `${p.rack} ×${n3(p.qty)}`).join(' · ');
}


// =====================================================================
// 0269 · 실사 랙 업로드 · 창고 위치수정 · 피킹 기록 (디렉터 지시 2026-10-12)
//
//   잠금 순서(교착 방지 — 모든 0269 쓰기가 같은 순서를 따른다):
//     ① products 행 FOR UPDATE  — 매출 등록도 먼저 products 를 UPDATE 하므로, 매출과 직렬화되어
//        커밋 전 재고(stock_qty)를 잘못 읽지 않는다.
//     ② pg_advisory_xact_lock(245, pid) — 포장지시서 출력(snapshotQuotePicks)과 직렬화.
//     ③ product_rack_stock 행 FOR UPDATE ORDER BY rack.
//   여러 SKU 를 다루는 업로드는 product_id 오름차순 · 묶음(트랜잭션)마다 나눠 처리한다.
//
//   「위치 미지정」 가용 = 재고 − 랙 합 − 다른 지시서가 위치 미지정으로 잡아 둔 수량.
//   위치수정은 다른 지시서의 계획(출력된 위치)을 지킨다 — 종이 지시서가 틀어지지 않게.
//   피킹 기록은 실물 기준 — 다른 지시서의 「계획」은 막지 않고, 다른 지시서가 이미 「기록」한 수량만 뺀다
//   (먼저 포장하는 쪽이 가져간다 · 10-01 계획 규칙과 같다).
// =====================================================================
export class RackError extends Error {
  constructor(code, note, extra) { super(note || code); this.code = code; this.note = note || code; this.extra = extra || null; }
}
/** 새로 만드는 랙 이름 검사 — 영문·숫자로 시작, 영문·숫자·-_./ 만, 40자 이내. 맞지 않으면 null */
export function validRack(v) {
  const r = normRack(v);
  if (!r || r.length > 40) return null;
  return /^[A-Z0-9][A-Z0-9\-_.\/]*$/.test(r) ? r : null;
}

const OPEN_Q = `q.deleted_at IS NULL AND q.invoice_id IS NULL AND q.status IN ('draft','confirmed','expired')`;

/** 다른(미전환) 견적이 잡아 둔 위치 — Map(rack|'' → {qty, picked, quotes:[no]}).
 *  '' = 위치 미지정으로 잡힌 분량. picked = 그중 창고가 실제 피킹으로 기록한 수량. */
export async function holdsDetail(exec, productId, excludeQuoteId = 0) {
  const run = runner(exec);
  const pk = (await rackEditReady()) ? `SUM(CASE WHEN pa.picked_at IS NOT NULL THEN pa.qty ELSE 0 END)` : `0`;
  const rows = (await run(
    `SELECT COALESCE(pa.rack, '') AS rack, SUM(pa.qty) AS held, ${pk} AS picked,
            string_agg(DISTINCT COALESCE(q.quote_no, '#' || q.id::text), ', ') AS quotes
       FROM quote_pick_alloc pa
       JOIN quotes q ON q.id = pa.quote_id
      WHERE pa.product_id = $1 AND pa.consumed_invoice_id IS NULL
        AND pa.quote_id <> $2 AND ${OPEN_Q}
      GROUP BY COALESCE(pa.rack, '')`, [productId, excludeQuoteId || 0])).rows;
  const m = new Map();
  for (const r of rows) m.set(r.rack, { qty: n3(r.held), picked: n3(r.picked), quotes: String(r.quotes || '').split(', ').filter(Boolean) });
  return m;
}

/** 한 SKU 의 재고·랙 현황. lock=true → 위 잠금 순서 ①②③ (트랜잭션 끝까지) */
async function skuState(run, productId, { lock = false } = {}) {
  const p = (await run(`SELECT id, code, stock_qty FROM products WHERE id=$1 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [productId])).rows[0];
  if (!p) throw new RackError('not_found', '제품을 찾을 수 없습니다.');
  if (lock) await run(`SELECT pg_advisory_xact_lock(245, $1::int)`, [productId]);
  const racks = new Map();
  for (const r of (await run(`SELECT rack, qty FROM product_rack_stock WHERE product_id=$1 ORDER BY rack${lock ? ' FOR UPDATE' : ''}`, [productId])).rows) {
    racks.set(r.rack, n3(r.qty));
  }
  const stock = n3(p.stock_qty);
  const located = n3([...racks.values()].reduce((s, q) => s + q, 0));
  return { code: p.code, stock, racks, located, unassigned: Math.max(0, n3(stock - located)), over: Math.max(0, n3(located - stock)) };
}

// ---- ② 창고 위치수정 ----------------------------------------------------------
/** 위치수정 — moves: [{from, to, qty}] (from/to 가 null·'' 이면 「위치 미지정」).
 *  합계 보존 이동만 허용하므로 랙 합이 등록 재고를 넘을 수 없다.
 *  · 랙 → 랙 / 랙 → 위치 미지정 : 출발 랙 수량 − 다른 지시서가 잡은 수량까지
 *  · 위치 미지정 → 랙           : 위치 미지정 − 다른 지시서가 위치 미지정으로 잡은 수량까지
 *  전부 검사한 뒤 한 번에 적용한다(하나라도 틀리면 아무것도 바뀌지 않음 — 호출 측 트랜잭션). */
export async function transferRack(exec, productId, moves, { userId = null, note = null } = {}) {
  const run = runner(exec);
  const pid = Number(productId);
  const list = (Array.isArray(moves) ? moves : [moves]).filter(Boolean);
  if (!list.length) throw new RackError('no_moves', '옮길 내용이 없습니다.');
  const st = await skuState(run, pid, { lock: true });
  const holds = await holdsDetail(run, pid, 0);
  const nullHold = holds.get('') ? holds.get('').qty : 0;
  const sim = new Map(st.racks);         // 순서대로 적용해 보며 검사
  let un = Math.max(0, n3(st.stock - st.located - nullHold));
  const plan = [];
  for (const m of list) {
    // 출발 랙은 이미 기록된 이름이면 그대로(옛 규칙으로 만들어진 이름 포함), 도착 랙은 새 이름 규칙 검사
    const fromN = m.from ? normRack(m.from) : null;
    const from = fromN ? (sim.has(fromN) ? fromN : validRack(fromN)) : null;
    const toN = m.to ? normRack(m.to) : null;
    const to = toN ? (sim.has(toN) ? toN : validRack(toN)) : null;
    const qty = n3(m.qty);
    if (m.from && !from) throw new RackError('bad_rack', `출발 랙 이름이 올바르지 않습니다: ${m.from}`);
    if (m.to && !to) throw new RackError('bad_rack', `도착 랙 이름이 올바르지 않습니다: ${m.to}`);
    if (!(qty > 0)) throw new RackError('bad_qty', '옮길 수량은 0보다 커야 합니다.');
    if (!from && !to) throw new RackError('same_place', '출발과 도착이 모두 「위치 미지정」입니다.');
    if (from && to && from === to) throw new RackError('same_place', `출발과 도착이 같은 랙입니다: ${from}`);
    if (from) {
      const have = sim.get(from) || 0;
      if (qty > have) throw new RackError('not_enough', `${st.code} · ${from} 에는 ${have}개뿐입니다(옮기려는 수량 ${qty}).`, { rack: from, have });
      const h = holds.get(from);
      const movable = n3(have - (h ? h.qty : 0));
      if (qty > movable) {
        throw new RackError('held',
          `${st.code} · ${from} 의 ${h.qty}개는 포장작업지시서(${h.quotes.join(', ')})가 피킹 위치로 잡고 있습니다. 지금 옮길 수 있는 수량은 ${Math.max(0, movable)}개입니다.`,
          { rack: from, have, held: h.qty, quotes: h.quotes, movable: Math.max(0, movable) });
      }
      sim.set(from, n3(have - qty));
    } else {
      if (qty > un) {
        const h = holds.get('');
        throw new RackError('over_stock',
          `${st.code} · 랙에 올릴 수 있는 위치 미지정 수량은 ${un}개입니다(등록 재고 ${st.stock} − 랙 합 ${st.located}`
          + (h ? ` − 지시서 ${h.quotes.join(', ')} 가 위치 미지정으로 잡은 ${h.qty}` : '') + `). 재고를 넘겨 랙에 올릴 수 없습니다.`,
          { unassigned: un });
      }
      un = n3(un - qty);
    }
    if (to) sim.set(to, n3((sim.get(to) || 0) + qty)); else un = n3(un + qty);
    plan.push({ from, to, qty });
  }
  const ref = `transfer:${pid}:${Date.now()}`;
  for (const p of plan) {
    const meta = { reason: 'transfer', ref, userId,
      note: `${p.from || '위치 미지정'} → ${p.to || '위치 미지정'}` + (note ? ` · ${String(note).slice(0, 160)}` : '') };
    if (p.from) {
      const t = await takeFromRack(run, pid, p.from, p.qty, meta);
      if (n3(t) !== p.qty) throw new RackError('not_enough', `${p.from} 수량이 바뀌었습니다. 다시 시도하세요.`);
    }
    if (p.to) await addToRack(run, pid, p.to, p.qty, meta);
  }
  const after = await skuState(run, pid);
  return { moved: plan, ref, stock: after.stock, located: after.located, unassigned: after.unassigned,
    racks: [...after.racks].map(([rack, qty]) => ({ rack, qty })) };
}

// ---- ① 실사 랙 업로드 ---------------------------------------------------------
/** rows: [{line, code, rack, qty, sig}] → SKU 별 분석(저장하지 않음).
 *  · 코드: 제품번호(대소문자·공백 무시) → EAN(앞자리 0 무시) → SYD(scode) 순. EAN·SYD 가 여러 제품에 걸리면 쓰지 않는다.
 *  · 같은 코드가 여러 줄이면: 완전히 같은 줄(sig)은 1번만 센다(중복 입력), 다르면 랙별로 합친다.
 *  · status: ok(랙 합 = 재고) / under(랙 합 < 재고 → 나머지 위치 미지정) / over(랙 합 > 재고 → 저장 안 함)
 *            error(그 SKU 에 읽을 수 없는 줄이 있음 → 저장 안 함: 일부만 저장하면 빠진 랙이 0 으로 지워진다) */
export async function analyzeImport(exec, rows) {
  const run = runner(exec);
  const errors = [];
  const clean = [];
  const errCodes = new Set();
  for (const r of rows || []) {
    const code = String(r.code == null ? '' : r.code).trim().toUpperCase();
    const line = r.line || null;
    if (!code) { errors.push({ line, msg: '코드 없음' }); continue; }
    const rack = validRack(r.rack);
    if (!rack) { errors.push({ line, code, msg: `랙 이름 오류: ${r.rack == null || r.rack === '' ? '(빈칸)' : r.rack}` }); errCodes.add(code); continue; }
    const blankQty = r.qty == null || String(r.qty).trim() === '';
    const qty = blankQty ? NaN : Number(String(r.qty).replace(/,/g, '').trim());
    if (!isFinite(qty) || qty < 0) { errors.push({ line, code, msg: `수량 오류: ${blankQty ? '(빈칸)' : r.qty}` }); errCodes.add(code); continue; }
    clean.push({ line, code, rack, qty: n3(qty), sig: r.sig || null });
  }
  const codes = [...new Set([...clean.map((r) => r.code), ...errCodes])];
  const found = new Map();      // 입력 코드 → 제품
  if (codes.length) {
    const prods = (await run(
      `SELECT id, code, name, stock_qty, ean, scode FROM products
        WHERE deleted_at IS NULL
          AND (UPPER(TRIM(code)) = ANY($1::text[]) OR ltrim(TRIM(COALESCE(ean,'')),'0') = ANY($2::text[])
               OR UPPER(TRIM(COALESCE(scode,''))) = ANY($1::text[]))`,
      [codes, codes.map((c) => c.replace(/^0+/, '')).filter(Boolean)])).rows;
    const byCode = new Map(), byEan = new Map(), byS = new Map();
    const once = (m, k, p) => { if (!k) return; m.set(k, m.has(k) && Number(m.get(k) && m.get(k).id) !== Number(p.id) ? null : p); };  // 여러 제품이면 null
    for (const p of prods) {
      byCode.set(String(p.code || '').trim().toUpperCase(), p);
      if (p.ean) once(byEan, String(p.ean).trim().replace(/^0+/, ''), p);
      if (p.scode) once(byS, String(p.scode).trim().toUpperCase(), p);
    }
    for (const c of codes) {
      const p = byCode.get(c) || byEan.get(c.replace(/^0+/, '')) || byS.get(c) || null;
      if (p) found.set(c, p);
    }
  }
  const unknown = new Map();
  const bySku = new Map();
  const touch = (pid, p) => {
    if (!bySku.has(pid)) bySku.set(pid, { p, racks: new Map(), lines: [], sigs: new Set(), dup: 0, errLines: [] });
    return bySku.get(pid);
  };
  for (const r of clean) {
    const p = found.get(r.code);
    if (!p) { const u = unknown.get(r.code) || { code: r.code, lines: [] }; u.lines.push(r.line); unknown.set(r.code, u); continue; }
    const g = touch(Number(p.id), p);
    if (r.sig) { if (g.sigs.has(r.sig)) { g.dup += 1; continue; } g.sigs.add(r.sig); }   // 같은 줄 반복 입력은 한 번만
    g.racks.set(r.rack, n3((g.racks.get(r.rack) || 0) + r.qty));
    g.lines.push(r.line);
  }
  for (const e of errors) {      // 오류 줄이 있는 SKU 는 통째로 보류
    if (!e.code) continue;
    const p = found.get(e.code);
    if (p) touch(Number(p.id), p).errLines.push(e.line);
  }
  const pids = [...bySku.keys()];
  const cur = await rackMap(run, pids);
  const holdRows = pids.length ? (await run(
    `SELECT pa.product_id, SUM(pa.qty) AS held, string_agg(DISTINCT COALESCE(q.quote_no,'#'||q.id::text), ', ') AS quotes
       FROM quote_pick_alloc pa JOIN quotes q ON q.id = pa.quote_id
      WHERE pa.product_id = ANY($1::bigint[]) AND pa.consumed_invoice_id IS NULL AND ${OPEN_Q}
      GROUP BY pa.product_id`, [pids])).rows : [];
  const holds = new Map(holdRows.map((h) => [Number(h.product_id), { qty: n3(h.held), quotes: h.quotes }]));
  const skus = [];
  for (const [pid, g] of bySku) {
    const racks = [...g.racks].map(([rack, qty]) => ({ rack, qty })).filter((x) => x.qty > 0)
      .sort((a, b) => (rackNatKey(a.rack) < rackNatKey(b.rack) ? -1 : 1));
    const total = n3(racks.reduce((s, x) => s + x.qty, 0));
    const stock = n3(g.p.stock_qty);
    const current = (cur.get(pid) || []).map((x) => ({ rack: x.rack, qty: x.qty }))
      .sort((a, b) => (rackNatKey(a.rack) < rackNatKey(b.rack) ? -1 : 1));
    const same = current.length === racks.length && current.every((c, i) => c.rack === racks[i].rack && c.qty === racks[i].qty);
    skus.push({
      product_id: pid, code: g.p.code, name: g.p.name || '', stock, total, racks, current,
      status: g.errLines.length ? 'error' : total > stock ? 'over' : total < stock ? 'under' : 'ok',
      diff: n3(total - stock), unchanged: same && !g.errLines.length, dup_lines: g.dup, lines: g.lines, err_lines: g.errLines,
      holds: holds.get(pid) || null,
    });
  }
  skus.sort((a, b) => String(a.code).localeCompare(String(b.code), 'en', { numeric: true }));
  const cnt = (s) => skus.filter((x) => x.status === s).length;
  return {
    skus, unknown: [...unknown.values()], errors,
    counts: { rows: (rows || []).length, skus: skus.length, ok: cnt('ok'), under: cnt('under'), over: cnt('over'), error_skus: cnt('error'),
      unchanged: skus.filter((x) => x.unchanged).length, unknown: unknown.size, errors: errors.length,
      held: skus.filter((x) => x.holds && !x.unchanged && x.status !== 'over' && x.status !== 'error').length,
      dup_lines: skus.reduce((s, x) => s + x.dup_lines, 0) },
  };
}

const IMPORT_CHUNK = 100;      // 한 트랜잭션에 잠그는 SKU 수(advisory lock · 공유메모리 한도 안쪽)
/** 업로드 적용 — 파일에 나온 SKU(초과·오류 제외)의 랙재고를 파일 내용으로 통째로 맞춘다(파일에 없는 랙 = 0).
 *  파일에 없는 SKU 는 건드리지 않는다.
 *  tx: (fn) => withTx(fn) — SKU 를 product_id 오름차순으로 IMPORT_CHUNK 개씩 나눠 각각 짧은 트랜잭션에서 저장한다
 *  (교착이 나면 그 묶음만 최대 3번 다시). 묶음마다 SKU 잠금 → 재고 재확인 → 저장. */
export async function applyImport(tx, rows, { userId = null, fileName = null, note = null } = {}) {
  const an = await analyzeImport(null, rows);
  const id = Number((await tx(async (c) => (await c.query(
    `INSERT INTO rack_stock_imports (file_name, note, rows_in, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
    [fileName ? String(fileName).slice(0, 200) : null, note ? String(note).slice(0, 300) : null, (rows || []).length, userId])).rows[0].id)));
  const meta = { reason: 'import', ref: `rack_import:${id}`, userId, note: `실사 랙 업로드 #${id}` + (fileName ? ` · ${String(fileName).slice(0, 80)}` : '') };
  let skus = 0, changed = 0;
  const blocked = [];      // 저장하지 않은 SKU (over / error / gone)
  const heldHit = [];      // 지시서가 잡은 랙이 잡힌 수량보다 작아진 SKU(경고)
  for (const s of an.skus) {
    if (s.status === 'error') blocked.push({ product_id: s.product_id, code: s.code, reason: 'error', lines: s.err_lines });
  }
  const todo = an.skus.filter((s) => s.status !== 'error' && !s.unchanged).sort((a, b) => a.product_id - b.product_id);
  for (let i = 0; i < todo.length; i += IMPORT_CHUNK) {
    const chunk = todo.slice(i, i + IMPORT_CHUNK);
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await tx(async (c) => {
          const run = (q, p) => c.query(q, p);
          const out = { skus: 0, changed: 0, blocked: [], held: [] };
          for (const s of chunk) {
            let st;
            try { st = await skuState(run, s.product_id, { lock: true }); }
            catch (e) { if (e instanceof RackError) { out.blocked.push({ product_id: s.product_id, code: s.code, reason: 'gone' }); continue; } throw e; }
            if (s.total > st.stock) { out.blocked.push({ product_id: s.product_id, code: s.code, reason: 'over', stock: st.stock, total: s.total }); continue; }
            const want = new Map(s.racks.map((x) => [x.rack, x.qty]));
            const all = [...new Set([...st.racks.keys(), ...want.keys()])].sort();
            let touched = false;
            for (const rack of all) {
              const d = await setRackQty(run, s.product_id, rack, want.get(rack) || 0, meta);
              if (d !== 0) { out.changed += 1; touched = true; }
            }
            if (touched) {
              out.skus += 1;
              const h = await holdsDetail(run, s.product_id, 0);
              const hit = [...h].filter(([rk, x]) => rk && x.qty > (want.get(rk) || 0)).map(([rk, x]) => `${rk}(${x.quotes.join(', ')} ${x.qty})`);
              if (hit.length) out.held.push({ product_id: s.product_id, code: s.code, racks: hit });
            }
          }
          return out;
        });
        skus += res.skus; changed += res.changed; blocked.push(...res.blocked); heldHit.push(...res.held);
        break;
      } catch (e) {
        if (e && e.code === '40P01' && attempt < 3) continue;     // 교착 → 이 묶음만 다시
        throw e;
      }
    }
  }
  const summary = { counts: an.counts, blocked, held: heldHit, unknown: an.unknown.map((u) => u.code), errors: an.errors.length };
  await tx(async (c) => c.query(`UPDATE rack_stock_imports SET skus=$2, blocked=$3, summary=$4 WHERE id=$1`,
    [id, skus, blocked.length, JSON.stringify(summary)]));
  return { id, skus, changed, blocked, held: heldHit, counts: an.counts, unknown: an.unknown, errors: an.errors };
}

// ---- ③ 피킹 기록 --------------------------------------------------------------
/** 이 견적에서 이 SKU 를 집을 수 있는 위치.
 *  랙: 랙 수량 − 다른 지시서가 이미 「피킹 기록」한 수량 (다른 지시서의 계획은 막지 않고 안내만 — held_other)
 *  위치 미지정: 재고 − 랙 합 − 다른 지시서가 위치 미지정으로 「기록」한 수량 */
async function pickOptionsRun(run, quoteId, productId, st) {
  const holds = await holdsDetail(run, productId, quoteId);
  const kinds = (await rackMap(run, [productId])).get(Number(productId)) || [];
  const racks = pickOrder(kinds.map((k) => {
    const h = holds.get(k.rack);
    return { rack: k.rack, qty: k.qty, kind: k.kind, held_other: h ? h.qty : 0, picked_other: h ? h.picked : 0,
      held_quotes: h ? h.quotes : [], max: Math.max(0, n3(k.qty - (h ? h.picked : 0))) };
  }), 'max');
  const hn = holds.get('');
  const unassigned = Math.max(0, n3(st.stock - st.located - (hn ? hn.picked : 0)));
  return { stock: st.stock, located: st.located, unassigned, racks };
}
export async function pickOptions(exec, quoteId, productId) {
  const run = runner(exec);
  const st = await skuState(run, productId);
  return pickOptionsRun(run, quoteId, productId, st);
}

async function lockOpenQuote(run, quoteId) {
  const q = (await run(`SELECT id, invoice_id, status, deleted_at FROM quotes WHERE id=$1 FOR UPDATE`, [quoteId])).rows[0];
  if (!q || q.deleted_at) throw new RackError('not_found', '오더를 찾을 수 없습니다.');
  if (q.invoice_id || q.status === 'converted') throw new RackError('already_converted', '이미 매출로 전환된 오더입니다 — 피킹 위치는 차감이 끝났습니다.');
}

/** 실제 피킹 위치 기록 — picks: [{rack|null, qty}] 합계 = required.
 *  재고 수량은 바뀌지 않고, 매출 전환 때 이 위치에서 차감된다. 호출 측 트랜잭션 안에서 부른다. */
export async function recordPick(exec, quoteId, productId, picks, required, userId) {
  const run = runner(exec);
  const pid = Number(productId);
  await lockOpenQuote(run, quoteId);
  const st = await skuState(run, pid, { lock: true });
  const opt = await pickOptionsRun(run, quoteId, pid, st);
  const max = new Map(opt.racks.map((r) => [r.rack, r]));
  const merged = new Map();
  for (const p of picks || []) {
    const q = n3(p.qty);
    if (!isFinite(q) || q < 0) throw new RackError('bad_qty', `수량 오류: ${p.qty}`);
    if (q === 0) continue;
    const k = p.rack ? normRack(p.rack) : '';
    merged.set(k, n3((merged.get(k) || 0) + q));
  }
  const total = n3([...merged.values()].reduce((s, q) => s + q, 0));
  if (total !== n3(required)) throw new RackError('qty_mismatch', `피킹 수량 합계(${total})가 포장할 수량(${n3(required)})과 다릅니다.`, { total, required: n3(required) });
  for (const [k, q] of merged) {
    if (!k) {
      if (q > opt.unassigned) throw new RackError('over_stock', `위치 미지정에서 집을 수 있는 수량은 ${opt.unassigned}개입니다.`, { unassigned: opt.unassigned });
      continue;
    }
    const r = max.get(k);
    if (!r) throw new RackError('no_rack_stock', `${k} 에는 이 제품의 랙재고 기록이 없습니다. 먼저 📍 랙별 재고에서 위치를 수정하세요.`, { rack: k });
    if (q > r.max) {
      throw new RackError('held', r.picked_other > 0
        ? `${k} 의 ${r.picked_other}개는 다른 오더(${r.held_quotes.join(', ')})가 이미 피킹했습니다 — ${r.max}개까지만 기록할 수 있습니다.`
        : `${k} 에는 ${r.qty}개뿐입니다.`, { rack: k, max: r.max });
    }
  }
  await run(`DELETE FROM quote_pick_alloc WHERE quote_id=$1 AND product_id=$2 AND consumed_invoice_id IS NULL`, [quoteId, pid]);
  // 피킹 순서: 기록한 랙(피킹 순서) → 위치 미지정
  const ordered = pickOrder([...merged].filter(([k]) => k).map(([k, q]) => ({ rack: k, qty: q, kind: (max.get(k) || {}).kind })));
  let seq = 0;
  for (const r of ordered) {
    await run(`INSERT INTO quote_pick_alloc (quote_id, product_id, rack, qty, seq, created_by, picked_at, picked_by)
               VALUES ($1,$2,$3,$4,$5,$6,now(),$6)`, [quoteId, pid, r.rack, r.qty, seq++, userId || null]);
  }
  if (merged.get('')) {
    await run(`INSERT INTO quote_pick_alloc (quote_id, product_id, rack, qty, seq, created_by, picked_at, picked_by)
               VALUES ($1,$2,NULL,$3,$4,$5,now(),$5)`, [quoteId, pid, merged.get(''), seq++, userId || null]);
  }
  return (await quoteAllocRows(run, quoteId)).filter((a) => Number(a.product_id) === pid && a.consumed_invoice_id == null).map(allocOut);
}

/** 피킹 기록 취소 — 이 SKU 의 기록을 지우고 지시서 계획(fast 먼저)으로 다시 잡는다. */
export async function resetPick(exec, quoteId, productId, required, userId) {
  const run = runner(exec);
  const pid = Number(productId);
  await lockOpenQuote(run, quoteId);
  await skuState(run, pid, { lock: true });
  await run(`DELETE FROM quote_pick_alloc WHERE quote_id=$1 AND product_id=$2 AND consumed_invoice_id IS NULL`, [quoteId, pid]);
  const plan = await planPick(run, pid, required, { excludeQuoteId: quoteId });
  let seq = 0;
  for (const p of plan) {
    await run(`INSERT INTO quote_pick_alloc (quote_id, product_id, rack, qty, seq, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [quoteId, pid, p.rack, p.qty, seq++, userId || null]);
  }
  return plan;
}
