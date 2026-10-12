// =====================================================================
// Refatrix ERP · devOffer.js — 개발완료 건 오퍼 상태 · 고객 오퍼시트 생성 (2026-10-12)
//   디렉터 요청: 개발완료되면 「경쟁사 코드 → CTR 코드」를 알려 주고, 고객별로 보고,
//   부족 해소 판매오퍼와 같은 형태로 고객에게 오퍼시트를 보낼 수 있게.
//
//   새 표·컬럼 없음. 연결 고리는 이미 있는 것:
//     개발완료 → 부족분 대장(stock_shortages, note 에 [devreq:<id>]) → offer_sheet_items.shortage_id
//   그래서 개발요청 1건의 오퍼 진행은 「그 마커의 부족 기록 → 그 기록이 담긴 최신 시트」로 읽는다.
//
//   오퍼 상태(offer_state) — 개발완료 건만:
//     sold        부족 기록이 판매로 전부 해소(인보이스 발행)
//     sheet_ready 살아있는 시트(발송 대기)   sheet_sent 발송 완료
//     disabled    시트가 비활성(중단) — 다시 만들어지지 않음
//     no_customer 고객 미지정 — 오퍼 불가
//     inactive    결과 제품이 판매중단(비활성)
//     no_stock    재고 0 — 입고 승인 때 자동으로 오퍼시트 생성
//     offerable   지금 오퍼시트를 만들 수 있음
//   수량·단가 규칙은 기존 생성기 그대로: 제안수량 = min(요청수량, 현재고), 단가 = 정가 × (1 − 고객할인).
// =====================================================================
import { query, withTx } from './db.js';
import { ensureDevDemand } from './devMatchSweep.js';
import { generateOfferSheets, devIdFromNote } from './offerSheets.js';

/** devIds → Map(devId → {shortage_id, shortage_status, open_qty, sheet}) */
export async function devOfferInfo(devIds, exec = query) {
  const out = new Map();
  const want = new Set((devIds || []).map(Number).filter(Boolean));
  if (!want.size) return out;
  const shs = (await exec(
    `SELECT id, note, status, (shortage_qty - resolved_qty) AS open_qty
       FROM stock_shortages
      WHERE note LIKE '%[devreq:%' AND status <> 'cancelled'
      ORDER BY id`)).rows;
  const byShortage = new Map();
  for (const s of shs) {
    const did = devIdFromNote(s.note);
    if (!did || !want.has(did) || out.has(did)) continue;
    const rec = { shortage_id: Number(s.id), shortage_status: s.status, open_qty: Number(s.open_qty), sheet: null };
    out.set(did, rec); byShortage.set(Number(s.id), rec);
  }
  if (!byShortage.size) return out;
  // 시트: 살아있는(취소 아님 또는 비활성) 것을 우선, 그다음 최신
  const sheets = (await exec(
    `SELECT oi.shortage_id, os.id, os.offer_no, os.status, os.disabled_at, os.sent_at
       FROM offer_sheet_items oi
       JOIN offer_sheets os ON os.id = oi.offer_sheet_id AND os.deleted_at IS NULL
      WHERE oi.shortage_id = ANY($1::bigint[])
      ORDER BY oi.shortage_id,
               (os.status = 'cancelled' AND os.disabled_at IS NULL),
               os.created_at DESC, os.id DESC`, [[...byShortage.keys()]])).rows;
  for (const r of sheets) {
    const rec = byShortage.get(Number(r.shortage_id));
    if (!rec || rec.sheet) continue;
    rec.sheet = { id: Number(r.id), offer_no: r.offer_no, status: r.status, disabled: !!r.disabled_at, sent_at: r.sent_at || null };
  }
  return out;
}

/** 개발요청 행(+제품 재고·활성) + devOfferInfo → offer_state */
export function devOfferState(r, info) {
  if (r.status !== 'developed') return null;
  if (!r.customer_id) return 'no_customer';
  if (info && info.shortage_status === 'resolved') return 'sold';
  const sh = info && info.sheet;
  if (sh && sh.disabled) return 'disabled';
  if (sh && sh.status === 'ready') return 'sheet_ready';
  if (sh && sh.status === 'sent') return 'sheet_sent';
  if (!r.result_product_id) return 'no_customer';
  if (r.result_is_active === false) return 'inactive';
  if (!(Number(r.result_stock_qty) > 0)) return 'no_stock';
  return 'offerable';
}

/**
 * 개발완료 건으로 고객 오퍼시트 생성.
 *   ① 대상 개발요청의 수요를 부족분 대장에 적재(없으면 — 08-01 이전 개발완료분 등)
 *   ② 생성기를 devRequestIds 로 좁혀 실행 → 고객별 「개발완료」 시트(일반 부족분과 섞이지 않음)
 * @param {{customerId?:number, devRequestIds?:number[], userId?:number}} p
 */
export async function createDevOfferSheets({ customerId = null, devRequestIds = null, userId = null } = {}) {
  const args = []; const conds = [
    `d.deleted_at IS NULL`, `d.status = 'developed'`, `d.customer_id IS NOT NULL`, `d.result_product_id IS NOT NULL`];
  if (customerId) { args.push(Number(customerId)); conds.push(`d.customer_id = $${args.length}`); }
  if (Array.isArray(devRequestIds) && devRequestIds.length) {
    args.push(devRequestIds.map(Number).filter(Boolean)); conds.push(`d.id = ANY($${args.length}::bigint[])`);
  }
  const reqs = (await query(
    `SELECT d.id, d.input_code, d.customer_id, d.requested_qty, d.source_quote_id, d.result_product_id
       FROM product_dev_requests d WHERE ${conds.join(' AND ')}`, args)).rows;
  if (!reqs.length) return { sheets: 0, items: 0, customers: [], targets: 0 };
  return withTx(async (c) => {
    const exec = c.query.bind(c);
    const byProduct = new Map();
    for (const r of reqs) {
      const pid = Number(r.result_product_id);
      if (!byProduct.has(pid)) byProduct.set(pid, []);
      byProduct.get(pid).push(r);
    }
    for (const [pid, rows] of byProduct) await ensureDevDemand({ productId: pid, rows, userId, exec });
    const gen = await generateOfferSheets(exec, {
      devRequestIds: reqs.map((r) => Number(r.id)), customerIds: customerId ? [Number(customerId)] : null,
      origin: 'manual', userId,
    });
    return { ...gen, targets: reqs.length };
  });
}
