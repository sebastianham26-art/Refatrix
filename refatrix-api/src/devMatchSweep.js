// =====================================================================
// Refatrix ERP · devMatchSweep.js — 개발목록 ↔ 제품 카탈로그 자동 매칭
//   목적(디렉터 요청 2026-08-01): 제품 카탈로그(교차참조)·제품마스터가
//   정기/비정기로 업데이트될 때, 개발목록(개발필요내용)의 미완료 경쟁사
//   코드가 우리 제품과 매칭되면 → 경쟁사 코드 옆에 우리 CTR 코드를 붙이고
//   자동으로 「개발완료(developed)」 처리한다.
//
//   매칭 기준(개발필요내용 화면과 동일): 정규화 코드(대소문자·기호 무시)로
//   ① products.code(CTR) ② product_syd_codes ③ product_xref_codes 순.
//
//   호출 지점:
//   · 제품마스터 업로드 커밋 / 신규 제품 수동 생성 (productRoutes)
//   · 교차참조 카탈로그 업로드 / 스냅샷 복원 (xrefRoutes)
//   · 60분 주기 + 서버 기동 시 1회 스위퍼 (devRequestRoutes — 다른 경로 보강)
//   · 수동 점검 버튼 POST /api/dev-requests/match-sweep
//
//   완료 처리 시: result_product_id·result_ctr_code·developed_at(오늘) 기록,
//   감사로그(행별) + 관련자(고객 담당영업+디렉터)에게 집계 1건씩
//   dev_complete 알림 할일(기존 수동 개발완료와 동일 kind, 스팸 방지 위해 묶음).
// =====================================================================
import { query } from './db.js';
import { logEvent } from './audit.js';
import { normCode } from './devDemand.js';
import { generateOfferSheets } from './offerSheets.js';

function clip1(s, max) { s = String(s == null ? '' : s); return s.length > max ? s.slice(0, max) + '…' : s; }

// ── 개발완료 후속 파이프라인 (디렉터 요청 2026-08-01) ──
//   "개발완료 = 고객 오퍼 + 재고검증 → 구매 제안"
//   ① 개발요청의 수요를 부족분 대장(stock_shortages)에 적재
//      — 부족분 대장은 이미 ⓐ 부족분/발주 화면(공장 주문 근거) ⓑ Offer Sheet 생성기
//        ⓒ 판매 시 자동 해소(0156) 에 연결돼 있어, 여기 한 번만 적으면
//        구매 제안·오퍼·판매 추적이 전부 기존 흐름을 탄다.
//   ② 재고검증: 재고가 있으면 → 즉시 고객별 Offer Sheet 생성(기존 생성기 재사용).
//      재고가 없으면 → 부족분(open)이 그대로 "즉시 구매 제안"이 되고,
//      이후 수입입고 승인 시 기존 훅이 자동으로 오퍼시트를 만든다.
//   중복 가드: note 의 [devreq:<id>] 마커로 같은 개발요청의 재적재 방지(멱등).
export async function pushDevDemandAndOffer({ productId, rows, userId = null }) {
  const out = { shortages: 0, stock_qty: null, offer_sheets: 0, offer_items: 0 };
  if (!productId || !Array.isArray(rows) || !rows.length) return out;

  for (const r of rows) {
    const marker = `[devreq:${Number(r.id)}]`;
    const qty = Number(r.requested_qty) > 0 ? Number(r.requested_qty) : 1;   // 수량 미입력 접수도 최소 1개 신호
    const note = clip1(`개발완료 오퍼·발주 제안 — 개발요청 ${marker} 경쟁사코드 ${r.input_code || '-'}`, 300);
    const ins = await query(
      `INSERT INTO stock_shortages
         (product_id, customer_id, sales_invoice_id, requested_qty, fulfilled_qty, shortage_qty,
          occurred_at, source_quote_id, note, created_by)
       SELECT $1::bigint,$2::bigint,NULL,$3::numeric,0,$3::numeric,CURRENT_DATE,$4::bigint,$5,$6::bigint
        WHERE NOT EXISTS (SELECT 1 FROM stock_shortages ss WHERE ss.note LIKE $7)`,
      [productId, r.customer_id || null, qty, r.source_quote_id || null, note, userId, `%${marker}%`]);
    if (ins.rowCount) out.shortages += ins.rowCount;
  }

  // 재고검증
  try {
    const p = (await query(`SELECT stock_qty FROM products WHERE id=$1`, [productId])).rows[0];
    out.stock_qty = p && p.stock_qty != null ? Number(p.stock_qty) : 0;
  } catch (_) { out.stock_qty = null; }

  // 재고가 있으면 → 기다리던 수요(방금 적재분 포함)로 고객별 오퍼시트 즉시 생성
  if (out.stock_qty != null && out.stock_qty > 0) {
    try {
      const gen = await generateOfferSheets(query, { productIds: [Number(productId)], userId, origin: 'auto' });
      out.offer_sheets = Number(gen.sheets) || 0;
      out.offer_items = Number(gen.items) || 0;
    } catch (_) { /* 0151 미적용 등 — 부족 적재는 유지 */ }
  }
  return out;
}

// 미완료 개발요청을 카탈로그와 대조해 매칭분을 developed 로 전환.
// 반환: { checked, matched, items:[{id, input_code, ctr_code, customer_name}] }
export async function sweepDevRequestMatches({ userId = null, notify = true } = {}) {
  const reqs = (await query(
    `SELECT d.id, d.input_code, d.customer_id, d.requested_qty, d.source_quote_id,
            c.name AS customer_name, c.owner_id AS customer_owner_id
       FROM product_dev_requests d
       LEFT JOIN customers c ON c.id = d.customer_id
      WHERE d.deleted_at IS NULL
        AND d.status IN ('received','reviewed','factory_requested')
        AND d.input_code IS NOT NULL`)).rows;
  if (!reqs.length) return { checked: 0, matched: 0, items: [] };

  // 필요한 정규화 코드 집합
  const wanted = new Set();
  for (const r of reqs) { const n = normCode(r.input_code); if (n) wanted.add(n); }
  if (!wanted.size) return { checked: reqs.length, matched: 0, items: [] };

  // norm → {product_id, pri} (CTR > SYD > xref)
  const hit = new Map();
  const claim = (norm, productId, pri) => {
    if (!norm || !wanted.has(norm)) return;
    const cur = hit.get(norm);
    if (cur && cur.pri <= pri) return;
    hit.set(norm, { product_id: Number(productId), pri });
  };
  const prods = (await query(`SELECT id, code FROM products WHERE deleted_at IS NULL`)).rows;
  const codeById = new Map();
  for (const p of prods) { codeById.set(Number(p.id), p.code); claim(normCode(p.code), p.id, 1); }
  const syds = (await query(`SELECT product_id, syd_code FROM product_syd_codes`)).rows;
  for (const s of syds) claim(normCode(s.syd_code), s.product_id, 2);
  try {
    const xrefs = (await query(`SELECT product_id, norm_code FROM product_xref_codes`)).rows;
    for (const x of xrefs) claim(String(x.norm_code || ''), x.product_id, 3);
  } catch (_) { /* 0130 미적용 시 무시 */ }

  const items = [];
  for (const r of reqs) {
    const h = hit.get(normCode(r.input_code));
    if (!h) continue;
    const ctr = codeById.get(h.product_id);
    if (!ctr) continue;
    const upd = await query(
      `UPDATE product_dev_requests
          SET status='developed',
              developed_at=COALESCE(developed_at, CURRENT_DATE),
              result_product_id=$1, result_ctr_code=$2,
              updated_by=$3, updated_at=now()
        WHERE id=$4 AND deleted_at IS NULL AND status IN ('received','reviewed','factory_requested')
        RETURNING id`,
      [h.product_id, ctr, userId, Number(r.id)]);
    if (!upd.rows.length) continue;   // 동시 실행 등으로 이미 전환된 행 — 후속 처리 제외
    logEvent({
      userId, action: 'update', target: `dev_request:${r.id}`,
      detail: { auto_match: true, input_code: r.input_code, ctr },
    });
    items.push({
      id: Number(r.id), input_code: r.input_code, ctr_code: ctr, product_id: h.product_id,
      customer_id: r.customer_id != null ? Number(r.customer_id) : null,
      requested_qty: r.requested_qty != null ? Number(r.requested_qty) : null,
      source_quote_id: r.source_quote_id != null ? Number(r.source_quote_id) : null,
      customer_name: r.customer_name || null, customer_owner_id: r.customer_owner_id != null ? Number(r.customer_owner_id) : null,
    });
  }

  // 개발완료 후속: 수요 → 부족분 대장 + 재고검증 → 오퍼시트/구매 제안 (제품 단위로 묶어 처리)
  let offerSheets = 0, shortageRecords = 0, noStockProducts = 0;
  if (items.length) {
    const byProduct = new Map();
    for (const it of items) {
      if (!byProduct.has(it.product_id)) byProduct.set(it.product_id, []);
      byProduct.get(it.product_id).push(it);
    }
    for (const [pid, rows] of byProduct) {
      try {
        const res = await pushDevDemandAndOffer({ productId: pid, rows, userId });
        offerSheets += res.offer_sheets; shortageRecords += res.shortages;
        if (res.stock_qty != null && res.stock_qty <= 0) noStockProducts++;
      } catch (_) { /* best-effort */ }
    }
  }

  // 집계 알림(스팸 방지: 수신자별 1건) — 고객 담당영업 + 디렉터. 기존 개발완료 알림과 동일 kind.
  if (notify && items.length) {
    try {
      const recipients = new Set();
      for (const it of items) if (it.customer_owner_id) recipients.add(it.customer_owner_id);
      const dirs = (await query(`SELECT id FROM users WHERE role='director' AND deleted_at IS NULL`)).rows;
      for (const u of dirs) recipients.add(Number(u.id));
      const lines = items.slice(0, 15).map((it) =>
        `${it.input_code} → ${it.ctr_code}${it.customer_name ? ' (' + it.customer_name + ')' : ''}`);
      const more = items.length > 15 ? ` 외 ${items.length - 15}건` : '';
      const title = `개발완료(카탈로그 자동 매칭): ${items.length}건`;
      const tail = `\n— 오퍼시트 ${offerSheets}건 자동 생성 · 부족분(발주 근거) ${shortageRecords}건 기록`
        + (noStockProducts ? ` · 재고 없는 제품 ${noStockProducts}종 → 즉시 구매 검토 필요(부족분/발주 화면)` : '');
      const detail = clip1(`카탈로그/제품마스터 업데이트로 개발목록의 경쟁사 코드가 우리 제품과 매칭되어 자동 개발완료 처리되었습니다. 고객에게 안내하세요.\n` + lines.join('\n') + more + tail, 1800);
      for (const uid of recipients) {
        await query(
          `INSERT INTO todos (title, detail, assignee_id, due_date, kind, created_by)
           VALUES ($1,$2,$3,CURRENT_DATE,'dev_complete',$4)`,
          [title, detail, uid, userId]);
      }
    } catch (_) { /* 알림 실패해도 완료 처리 자체는 유지 */ }
  }
  return { checked: reqs.length, matched: items.length, items, offer_sheets: offerSheets, shortage_records: shortageRecords, no_stock_products: noStockProducts };
}
