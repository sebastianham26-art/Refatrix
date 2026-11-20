// 0332 전자결재 원가·운반비 연결 (디렉터 2026-11-20)
//
//   결재 카테고리의 재무 과목에 따라 작성 화면에서 연결 대상을 고른다.
//     · 5030 수입부대비용 / 5040 수입운송비 → 수입 인보이스(입고 선적 · 선적 없는 수입배치)
//         → 집행되어 거래등록 실적이 되면, 수입 부대비용 분배 화면의 「재무에서 가져오기」가
//           그 인보이스의 승인된 수입배치를 분배 대상으로 자동 선택한다(원가 반영은 기존 분배·승인 절차 그대로).
//     · 6160 운반비(매출출고) → 매출 인보이스(균등 배분) · 고객 · 또는 「공통(매출비중 자동배분)」
//         → 결재의 자금계획 예정 거래에 거래등록과 같은 운반비 태그(transactions.customer_id + transaction_freight_allocations)를 단다.
//           실적 거래는 태그가 비어 있을 때만 채운다(거래등록에서 직접 고른 태그는 덮어쓰지 않음).
//   상신할 때 해당 과목이면 연결을 반드시 골라야 한다(costLinkMissing).
//   전자결재 라우트는 이 모듈 함수만 부른다(거래·재고 테이블 SQL 은 여기에).
import { n } from './approval.js';

export const IMPORT_COST_CODES = ['5030', '5040'];
export const FREIGHT_CODE = '6160';
export const MAX_LINK_IDS = 30;

export function linkKind(code) {
  if (IMPORT_COST_CODES.includes(String(code || ''))) return 'import';
  if (String(code || '') === FREIGHT_CODE) return 'freight';
  return null;
}

let _ready = { at: 0, ok: false };
export async function costLinkReady(q) {
  if (_ready.ok) return true;
  const now = Date.now();
  if (_ready.at && now - _ready.at < 30000) return false;
  try {
    const r = await q(`SELECT 1 FROM information_schema.columns WHERE table_name='approval_documents' AND column_name='freight_common'`);
    _ready = { at: now, ok: r.rows.length > 0 };
  } catch (_) { _ready = { at: now, ok: false }; }
  return _ready.ok;
}
export function _resetCostLinkReady() { _ready = { at: 0, ok: false }; }

const idList = (v) => (Array.isArray(v) ? [...new Set(v.map(Number).filter((x) => Number.isInteger(x) && x > 0))] : []);

// 요청 body → 연결 입력. body 에 cost_link 키가 없으면 undefined(기존 값 유지 — 구 클라이언트).
//   cost_link: { import_shipment_ids:[], import_batch_ids:[], freight_customer_id, freight_invoice_ids:[], freight_common }
export function normCostLink(body) {
  if (!body || !('cost_link' in body)) return undefined;
  const c = body.cost_link || {};
  const cid = Number(c.freight_customer_id);
  return {
    import_shipment_ids: idList(c.import_shipment_ids),
    import_batch_ids: idList(c.import_batch_ids),
    freight_customer_id: Number.isInteger(cid) && cid > 0 ? cid : null,
    freight_invoice_ids: idList(c.freight_invoice_ids),
    freight_common: c.freight_common === true,
  };
}

async function finCodeOfDoc(q, docId) {
  const r = (await q(
    `SELECT ac.fin_category_code AS code FROM approval_documents d LEFT JOIN approval_categories ac ON ac.id=d.category_id WHERE d.id=$1`,
    [docId])).rows[0];
  return r ? r.code || null : null;
}

// 저장 — 문서의 지금 재무 과목에 맞는 쪽만 남긴다(과목이 바뀌면 다른 쪽 선택은 지운다).
//   반환: null(입력 없음/미적용) | { kind, error? } — 잘못된 id 는 Stop 대신 { error } 로 돌려 호출부가 400 처리.
export async function saveCostLink(q, docId, link) {
  if (!(await costLinkReady(q))) return null;
  const kind = linkKind(await finCodeOfDoc(q, docId));
  if (link === undefined) {
    // 입력이 없어도 과목이 바뀌었으면 맞지 않는 쪽은 비운다
    if (kind !== 'import') await q(`UPDATE approval_documents SET import_shipment_ids=NULL, import_batch_ids=NULL WHERE id=$1 AND (import_shipment_ids IS NOT NULL OR import_batch_ids IS NOT NULL)`, [docId]);
    if (kind !== 'freight') await q(`UPDATE approval_documents SET freight_customer_id=NULL, freight_invoice_ids=NULL, freight_common=false WHERE id=$1 AND (freight_customer_id IS NOT NULL OR freight_invoice_ids IS NOT NULL OR freight_common)`, [docId]);
    return { kind };
  }
  let ships = [], bats = [], cust = null, invs = [], common = false;
  if (kind === 'import') {
    if (link.import_shipment_ids.length + link.import_batch_ids.length > MAX_LINK_IDS) return { kind, error: 'too_many_import_invoices' };
    if (link.import_shipment_ids.length) {
      ships = (await q(`SELECT id FROM inbound_shipments WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`, [link.import_shipment_ids])).rows.map((r) => Number(r.id));
      if (ships.length !== link.import_shipment_ids.length) return { kind, error: 'bad_import_invoice' };
    }
    if (link.import_batch_ids.length) {
      bats = (await q(`SELECT id FROM import_batches WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`, [link.import_batch_ids])).rows.map((r) => Number(r.id));
      if (bats.length !== link.import_batch_ids.length) return { kind, error: 'bad_import_invoice' };
    }
    ships = link.import_shipment_ids.filter((x) => ships.includes(x));   // 고른 순서 유지
    bats = link.import_batch_ids.filter((x) => bats.includes(x));
  } else if (kind === 'freight') {
    common = link.freight_common === true;
    if (!common) {
      if (link.freight_invoice_ids.length > 50) return { kind, error: 'bad_invoice' };
      if (link.freight_invoice_ids.length) {
        const rows = (await q(
          `SELECT id, customer_id FROM sales_invoices WHERE id = ANY($1::bigint[]) AND status='posted' AND deleted_at IS NULL`,
          [link.freight_invoice_ids])).rows;
        if (rows.length !== link.freight_invoice_ids.length) return { kind, error: 'bad_invoice' };
        invs = link.freight_invoice_ids.slice();
        const cs = new Set(rows.map((r) => Number(r.customer_id)));
        cust = cs.size === 1 ? [...cs][0] : null;                     // 거래등록과 같은 규칙 — 혼적이면 고객 NULL(배분행이 고객별)
      } else if (link.freight_customer_id) {
        const ok = (await q(`SELECT 1 FROM customers WHERE id=$1 AND deleted_at IS NULL`, [link.freight_customer_id])).rows.length;
        if (!ok) return { kind, error: 'bad_customer' };
        cust = link.freight_customer_id;
      }
    }
  }
  await q(
    `UPDATE approval_documents SET import_shipment_ids=$2, import_batch_ids=$3, freight_customer_id=$4, freight_invoice_ids=$5, freight_common=$6 WHERE id=$1`,
    [docId, ships.length ? ships : null, bats.length ? bats : null, cust, invs.length ? invs : null, common]);
  return { kind };
}

async function rawLink(q, docId) {
  const r = (await q(
    `SELECT d.import_shipment_ids, d.import_batch_ids, d.freight_customer_id, d.freight_invoice_ids, d.freight_common,
            ac.fin_category_code AS fin_code
       FROM approval_documents d LEFT JOIN approval_categories ac ON ac.id=d.category_id WHERE d.id=$1`, [docId])).rows[0];
  if (!r) return null;
  return {
    fin_code: r.fin_code || null,
    kind: linkKind(r.fin_code),
    ships: (r.import_shipment_ids || []).map(Number),
    bats: (r.import_batch_ids || []).map(Number),
    cust: r.freight_customer_id == null ? null : Number(r.freight_customer_id),
    invs: (r.freight_invoice_ids || []).map(Number),
    common: r.freight_common === true,
  };
}

// 상신 전 확인 — 해당 과목인데 연결을 안 골랐으면 오류 코드
export async function costLinkMissing(q, docId) {
  if (!(await costLinkReady(q))) return null;
  const l = await rawLink(q, docId);
  if (!l || !l.kind) return null;
  if (l.kind === 'import' && !l.ships.length && !l.bats.length) return 'import_invoice_required';
  if (l.kind === 'freight' && !l.common && !l.cust && !l.invs.length) return 'freight_link_required';
  return null;
}

// 선적·배치 id → 화면 표시용 행 + 원가 분배에 쓸 승인 배치
async function describeImports(q, ships, bats) {
  const out = [];
  if (ships.length) {
    const rows = (await q(
      `SELECT s.id, s.invoice_no, to_char(s.eta,'YYYY-MM-DD') AS eta, s.status, (s.deleted_at IS NOT NULL) AS deleted
         FROM inbound_shipments s WHERE s.id = ANY($1::bigint[])`, [ships])).rows;
    const bs = (await q(
      `SELECT id, batch_no, status, inbound_shipment_id FROM import_batches
        WHERE inbound_shipment_id = ANY($1::bigint[]) AND deleted_at IS NULL AND status <> 'rejected' ORDER BY id`, [ships])).rows;
    for (const id of ships) {
      const s = rows.find((r) => Number(r.id) === id);
      if (!s) continue;
      out.push({ type: 'ship', id, invoice_no: s.invoice_no || `선적#${id}`, eta: s.eta, ship_status: s.status, deleted: s.deleted === true,
        batches: bs.filter((b) => Number(b.inbound_shipment_id) === id).map((b) => ({ id: Number(b.id), batch_no: b.batch_no, status: b.status })) });
    }
  }
  if (bats.length) {
    const rows = (await q(
      `SELECT id, batch_no, to_char(import_date,'YYYY-MM-DD') AS d, status, (deleted_at IS NOT NULL) AS deleted FROM import_batches WHERE id = ANY($1::bigint[])`, [bats])).rows;
    for (const id of bats) {
      const b = rows.find((r) => Number(r.id) === id);
      if (!b) continue;
      out.push({ type: 'batch', id, invoice_no: b.batch_no || `입고#${id}`, import_date: b.d, deleted: b.deleted === true,
        batches: b.deleted || b.status === 'rejected' ? [] : [{ id, batch_no: b.batch_no, status: b.status }] });
    }
  }
  for (const x of out) {
    x.approved_batch_ids = x.batches.filter((b) => b.status === 'approved').map((b) => b.id);
    x.cost_ready = x.approved_batch_ids.length > 0;
  }
  return out;
}

// 상세·작성 화면용
export async function costLinkForDoc(q, docId) {
  if (!(await costLinkReady(q))) return null;
  const l = await rawLink(q, docId);
  if (!l) return null;
  const res = { kind: l.kind, fin_code: l.fin_code,
    import_shipment_ids: l.ships, import_batch_ids: l.bats,
    freight_customer_id: l.cust, freight_invoice_ids: l.invs, freight_common: l.common,
    imports: [], freight: null };
  if (l.ships.length || l.bats.length) res.imports = await describeImports(q, l.ships, l.bats);
  if (l.cust || l.invs.length || l.common) {
    const cust = l.cust ? (await q(`SELECT id, name FROM customers WHERE id=$1`, [l.cust])).rows[0] : null;
    const invs = l.invs.length ? (await q(
      `SELECT si.id, si.sat_no, to_char(si.inv_date,'YYYY-MM-DD') AS inv_date, si.total_mxn, si.customer_id, c.name AS customer_name
         FROM sales_invoices si LEFT JOIN customers c ON c.id=si.customer_id WHERE si.id = ANY($1::bigint[])`, [l.invs])).rows : [];
    res.freight = {
      common: l.common, customer_id: l.cust, customer_name: cust ? cust.name : null,
      invoices: l.invs.map((id) => invs.find((r) => Number(r.id) === id)).filter(Boolean).map((r) => ({
        id: Number(r.id), sat_no: r.sat_no || null, inv_date: r.inv_date, total_mxn: n(r.total_mxn),
        customer_id: Number(r.customer_id), customer_name: r.customer_name || '' })),
    };
  }
  return res;
}

// 한 줄 요약(수정 이력·이벤트용)
export function costLinkSummary(c) {
  if (!c) return '';
  if (c.kind === 'import') return (c.imports || []).map((x) => x.invoice_no).join(', ') || '—';
  if (c.kind === 'freight') {
    const f = c.freight;
    if (!f) return '—';
    if (f.common) return '공통(매출비중 자동배분)';
    if (f.invoices && f.invoices.length) return f.invoices.map((i) => `#${i.id}`).join(', ') + (f.customer_name ? ` · ${f.customer_name}` : ' · 고객 혼적');
    return f.customer_name ? `${f.customer_name} (고객 공통)` : '—';
  }
  return '';
}

// 작성 화면 목록 — 수입 인보이스(입고 선적 + 선적 없는 수입배치). 원가 금액은 내보내지 않는다.
export async function importInvoiceOptions(q, { search = '', include = [] } = {}) {
  const s = String(search || '').trim().toLowerCase();
  const like = s ? `%${s}%` : null;
  const ships = (await q(
    `SELECT s.id, s.invoice_no, to_char(s.eta,'YYYY-MM-DD') AS eta, s.status, to_char(s.created_at,'YYYY-MM-DD') AS created
       FROM inbound_shipments s
      WHERE s.deleted_at IS NULL AND s.status <> 'cancelled'
        AND ($1::text IS NULL OR lower(COALESCE(s.invoice_no,'')) LIKE $1)
      ORDER BY COALESCE(s.eta, s.created_at::date) DESC, s.id DESC LIMIT 150`, [like])).rows;
  const shipIds = ships.map((r) => Number(r.id));
  const bs = shipIds.length ? (await q(
    `SELECT id, batch_no, status, inbound_shipment_id FROM import_batches
      WHERE inbound_shipment_id = ANY($1::bigint[]) AND deleted_at IS NULL AND status <> 'rejected' ORDER BY id`, [shipIds])).rows : [];
  const bats = (await q(
    `SELECT id, batch_no, to_char(import_date,'YYYY-MM-DD') AS d, status FROM import_batches
      WHERE deleted_at IS NULL AND inbound_shipment_id IS NULL AND status <> 'rejected'
        AND ($1::text IS NULL OR lower(COALESCE(batch_no,'')) LIKE $1)
      ORDER BY import_date DESC, id DESC LIMIT 100`, [like])).rows;
  const SHIP_L = { incoming: '도착 전', receiving: '입고 중', closed: '입고 마감' };
  const BAT_L = { draft: '배치 작성 중', pending: '배치 승인 대기', approved: '원가 승인됨' };
  const items = ships.map((r) => {
    const b = bs.filter((x) => Number(x.inbound_shipment_id) === Number(r.id));
    const ab = b.find((x) => x.status === 'approved');
    return { key: `S${r.id}`, type: 'ship', id: Number(r.id), invoice_no: r.invoice_no || `선적#${r.id}`, date: r.eta || r.created,
      state: ab ? BAT_L.approved : (b[0] ? BAT_L[b[0].status] || b[0].status : SHIP_L[r.status] || r.status), cost_ready: !!ab };
  }).concat(bats.map((r) => ({ key: `B${r.id}`, type: 'batch', id: Number(r.id), invoice_no: r.batch_no || `입고#${r.id}`, date: r.d,
    state: BAT_L[r.status] || r.status, cost_ready: r.status === 'approved' })));
  // 이미 고른 것은 목록 밖이어도 포함(검색·기간 밖)
  const have = new Set(items.map((x) => x.key));
  const missing = (include || []).filter((k) => !have.has(k));
  if (missing.length) {
    const d = await describeImports(q, missing.filter((k) => k[0] === 'S').map((k) => Number(k.slice(1))), missing.filter((k) => k[0] === 'B').map((k) => Number(k.slice(1))));
    for (const x of d) items.push({ key: (x.type === 'ship' ? 'S' : 'B') + x.id, type: x.type, id: x.id, invoice_no: x.invoice_no, date: x.eta || x.import_date || null,
      state: x.deleted ? '삭제됨' : (x.cost_ready ? BAT_L.approved : ''), cost_ready: x.cost_ready });
  }
  return items;
}

// 운반비 — 고객 목록(최근 게시 인보이스가 있는 고객 우선) · 고객의 게시 인보이스
export async function freightCustomers(q, { search = '' } = {}) {
  const s = String(search || '').trim().toLowerCase();
  const rows = (await q(
    `SELECT c.id, c.name, c.code, MAX(si.inv_date) AS last_inv
       FROM customers c LEFT JOIN sales_invoices si ON si.customer_id=c.id AND si.status='posted' AND si.deleted_at IS NULL
      WHERE c.deleted_at IS NULL AND ($1::text IS NULL OR lower(c.name || ' ' || COALESCE(c.code,'')) LIKE $1)
      GROUP BY c.id ORDER BY MAX(si.inv_date) DESC NULLS LAST, c.name LIMIT 400`, [s ? `%${s}%` : null])).rows;
  return rows.map((r) => ({ id: Number(r.id), name: r.name, code: r.code || null, has_inv: r.last_inv != null }));
}
export async function freightInvoices(q, customerId) {
  const rows = (await q(
    `SELECT id, sat_no, to_char(inv_date,'YYYY-MM-DD') AS inv_date, total_mxn FROM sales_invoices
      WHERE customer_id=$1 AND status='posted' AND deleted_at IS NULL ORDER BY inv_date DESC, id DESC LIMIT 60`, [customerId])).rows;
  return rows.map((i) => ({ id: Number(i.id), sat_no: i.sat_no || null, inv_date: i.inv_date, total_mxn: n(i.total_mxn) }));
}

// 결재의 자금계획 예정·실적 거래에 운반비 태그 맞추기 — syncApprovalDoc 끝에서 호출(멱등).
//   · 예정(plan) 6160 거래: 결재 선택과 같게(다르면 교체). 6160 이 아닌 예정에 남은 태그는 제거.
//   · 실적(actual) 6160 거래: 고객 태그·배분이 모두 비어 있을 때만 채운다.
export async function syncCostLinkTxns(q, docId) {
  const out = { tagged: 0, cleared: 0 };
  if (!(await costLinkReady(q))) return out;
  const l = await rawLink(q, docId);
  if (!l) return out;
  const txns = (await q(
    `SELECT t.id, t.status, t.category_code, t.amount_mxn, t.customer_id,
            COALESCE((SELECT array_agg(a.sales_invoice_id ORDER BY a.id) FROM transaction_freight_allocations a WHERE a.transaction_id=t.id), '{}') AS inv
       FROM approval_payments p JOIN transactions t ON t.id=p.txn_id AND t.deleted_at IS NULL
      WHERE p.document_id=$1`, [docId])).rows;
  if (!txns.length) return out;
  const fin = await import('./routes/financeRoutes.js');   // 거래등록과 같은 태그 규칙(순환 import 회피 — 호출 시점 로드)
  const want = l.kind === 'freight' && (l.common || l.cust || l.invs.length);
  let tag = null;
  if (want) {
    tag = await fin.parseFreightTag(q, l.common ? { customer_id: null, freight_invoice_ids: [] } : { customer_id: l.cust, freight_invoice_ids: l.invs });
    if (tag.error) tag = null;   // 그사이 인보이스 취소 등 — 태그를 건드리지 않는다
  }
  for (const t of txns) {
    const cur = { cust: t.customer_id == null ? null : Number(t.customer_id), inv: (t.inv || []).map(Number) };
    const empty = cur.cust == null && !cur.inv.length;
    if (t.category_code !== FREIGHT_CODE) {
      if (t.status === 'plan' && !empty) {
        await fin.syncFreightTag(q, Number(t.id), { categoryCode: t.category_code, prevCategoryCode: FREIGHT_CODE, amountMxn: n(t.amount_mxn), tag: null });
        out.cleared++;
      }
      continue;
    }
    if (!tag) continue;
    if (t.status === 'actual' && !empty) continue;
    const wantInv = tag.invRows.map((r) => r.id);
    const same = cur.cust === (tag.customerId ?? null) && cur.inv.length === wantInv.length && cur.inv.every((x, i) => x === wantInv[i]);
    if (same) {
      await fin.syncFreightTag(q, Number(t.id), { categoryCode: FREIGHT_CODE, prevCategoryCode: FREIGHT_CODE, amountMxn: n(t.amount_mxn), tag: { set: false } });
      continue;
    }
    await fin.syncFreightTag(q, Number(t.id), { categoryCode: FREIGHT_CODE, prevCategoryCode: t.category_code, amountMxn: n(t.amount_mxn), tag });
    out.tagged++;
  }
  return out;
}

// 수입 부대비용 분배 화면 — 재무 실적 거래 → 연결된 전자결재와 그 수입 인보이스(승인 배치) { txnId: {...} }
export async function importLinksForTxns(q, txnIds) {
  const ids = (txnIds || []).map(Number).filter(Boolean);
  if (!ids.length || !(await costLinkReady(q))) return {};
  const rows = (await q(
    `SELECT p.txn_id, d.id AS doc_id, d.doc_no, d.title, d.import_shipment_ids, d.import_batch_ids
       FROM approval_payments p JOIN approval_documents d ON d.id=p.document_id AND d.deleted_at IS NULL
      WHERE p.txn_id = ANY($1::bigint[]) AND (d.import_shipment_ids IS NOT NULL OR d.import_batch_ids IS NOT NULL)`, [ids])).rows;
  const m = {};
  for (const r of rows) {
    const imp = await describeImports(q, (r.import_shipment_ids || []).map(Number), (r.import_batch_ids || []).map(Number));
    m[Number(r.txn_id)] = {
      doc_id: Number(r.doc_id), doc_no: r.doc_no, title: r.title,
      invoices: imp.map((x) => ({ invoice_no: x.invoice_no, cost_ready: x.cost_ready, approved_batch_ids: x.approved_batch_ids })),
      batch_ids: [...new Set(imp.flatMap((x) => x.approved_batch_ids))],
      pending: imp.filter((x) => !x.cost_ready).map((x) => x.invoice_no),
    };
  }
  return m;
}

// 재기안 — 원문서의 연결 선택을 새 문서로 복사
export async function copyCostLink(q, fromId, toId) {
  if (!(await costLinkReady(q))) return;
  await q(`UPDATE approval_documents n SET import_shipment_ids=o.import_shipment_ids, import_batch_ids=o.import_batch_ids,
             freight_customer_id=o.freight_customer_id, freight_invoice_ids=o.freight_invoice_ids, freight_common=o.freight_common
             FROM approval_documents o WHERE n.id=$2 AND o.id=$1`, [fromId, toId]);
}

