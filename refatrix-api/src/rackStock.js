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
// =====================================================================
import { query } from './db.js';

export const RACK_BUILD = '20261001rs2';

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
  return (await run(
    `SELECT pa.id, pa.product_id, pa.rack, pa.qty, pa.seq, pa.consumed_invoice_id,
            COALESCE((SELECT k.kind FROM rack_kinds k WHERE UPPER(TRIM(k.rack)) = pa.rack
                       ORDER BY k.updated_at DESC LIMIT 1), 'carton') AS kind
       FROM quote_pick_alloc pa
      WHERE pa.quote_id = $1
      ORDER BY pa.product_id, pa.seq, pa.id`, [quoteId])).rows;
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
      out[pid] = mine.map((a) => ({ rack: a.rack, qty: n3(a.qty), kind: a.rack ? a.kind : null }));
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
      out[pid] = mine.map((a) => ({ rack: a.rack, qty: n3(a.qty), kind: a.rack ? a.kind : null }));
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
