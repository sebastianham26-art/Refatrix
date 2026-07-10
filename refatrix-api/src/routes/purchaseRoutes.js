import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';

// 구매단가(USD) 열람 권한: 디렉터·소시오만 공개. 그 외 역할은 값 자체를 내려주지 않음(null).
export function canSeeCost(perm) {
  return perm.role === 'director' || perm.role === 'socio';
}

// "1,234.50" / " 100 " / 빈칸 등 방어적 숫자 파싱 → 실패 시 null
export function parseNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/,/g, '').replace(/\s+/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// 업로드 행 정규화·검증. 반환: { valid:[{code,qty,cost,amount,ref}], errors:[{i,code,reason}] }
// (미등록 코드는 valid 로 남기고 매칭 단계에서 product_id=null 로 보존 — 기록은 잃지 않음)
export function normalizeRows(rows) {
  const valid = [];
  const errors = [];
  (rows || []).forEach((r, i) => {
    const code = (r.code == null ? '' : String(r.code)).trim();
    const ref = (r.ref == null ? '' : String(r.ref)).trim();
    const qty = parseNum(r.qty);
    const cost = parseNum(r.cost_usd);
    const rowNo = r._row || (i + 1);
    if (!code) { errors.push({ i: rowNo, code, reason: '제품코드 없음' }); return; }
    if (!ref) { errors.push({ i: rowNo, code, reason: '구매참조번호 없음' }); return; }
    if (qty === null || qty <= 0) { errors.push({ i: rowNo, code, reason: '수량 오류(숫자·>0)' }); return; }
    if (cost === null || cost < 0) { errors.push({ i: rowNo, code, reason: '구매원가 오류(숫자·≥0)' }); return; }
    valid.push({ code, ref, qty, cost, amount: Math.round(qty * cost * 100) / 100 });
  });
  return { valid, errors };
}

// 코드 → 제품 매칭 맵(소문자 기준). rows: [{code,...}]
async function matchProducts(codes) {
  const lc = [...new Set(codes.map((c) => c.toLowerCase()))];
  if (!lc.length) return new Map();
  const r = await query(
    `SELECT id, code FROM products WHERE lower(code) = ANY($1) AND deleted_at IS NULL`, [lc]);
  const m = new Map();
  for (const row of r.rows) m.set(String(row.code).toLowerCase(), { id: Number(row.id), code: row.code });
  return m;
}

export default async function purchaseRoutes(app) {
  const gate = { preHandler: [authGuard, requirePage('purchase')] };

  // 미리보기: 검증·매칭 결과만 반환(DB 기록 없음)
  app.post('/api/purchases/preview', gate, async (req, reply) => {
    const { rows = [] } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) return reply.code(400).send({ error: 'rows_required' });
    const seeCost = canSeeCost(req.ctx.perm);
    const { valid, errors } = normalizeRows(rows);
    const matched = await matchProducts(valid.map((v) => v.code));
    const lines = valid.map((v) => {
      const p = matched.get(v.code.toLowerCase());
      const base = { ...v, product_id: p ? p.id : null, matched: !!p };
      if (!seeCost) { base.cost = null; base.amount = null; }   // 구매단가 비공개
      return base;
    });
    // 참조번호별 그룹 요약
    const groups = {};
    for (const l of lines) {
      const g = groups[l.ref] || (groups[l.ref] = { ref: l.ref, line_count: 0, total_qty: 0, total_usd: 0, unmatched: 0 });
      g.line_count += 1; g.total_qty += l.qty; g.total_usd += (l.amount || 0); if (!l.matched) g.unmatched += 1;
    }
    // 이미 기록된 동일 참조번호 경고
    const refs = Object.keys(groups);
    let existing = [];
    if (refs.length) {
      const er = await query(
        `SELECT ref_no, COUNT(*)::int AS n FROM purchase_orders
         WHERE deleted_at IS NULL AND ref_no = ANY($1) GROUP BY ref_no`, [refs]);
      existing = er.rows.map((x) => ({ ref: x.ref_no, n: Number(x.n) }));
    }
    return {
      cost_visible: seeCost,
      lines,
      errors,
      groups: Object.values(groups).map((g) => ({ ...g, total_qty: Math.round(g.total_qty * 1000) / 1000, total_usd: seeCost ? Math.round(g.total_usd * 100) / 100 : null })),
      existing_refs: existing,
      summary: { total: lines.length, matched: lines.filter((l) => l.matched).length, unmatched: lines.filter((l) => !l.matched).length, error_rows: errors.length },
    };
  });

  // 기록(커밋): 유효행을 참조번호 단위 PO 로 그룹핑해 저장. 오류행은 건너뛰고 요약 반환(전체 롤백 아님).
  app.post('/api/purchases', gate, async (req, reply) => {
    const { rows = [], note = null, order_date = null } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) return reply.code(400).send({ error: 'rows_required' });
    const { valid, errors } = normalizeRows(rows);
    if (!valid.length) return reply.code(400).send({ error: 'no_valid_rows', errors });
    const matched = await matchProducts(valid.map((v) => v.code));
    const userId = req.ctx.perm.userId;

    // 참조번호 단위 그룹
    const byRef = new Map();
    for (const v of valid) {
      const p = matched.get(v.code.toLowerCase());
      const item = { input_code: v.code, product_id: p ? p.id : null, qty: v.qty, unit_cost_usd: v.cost, amount_usd: v.amount };
      if (!byRef.has(v.ref)) byRef.set(v.ref, []);
      byRef.get(v.ref).push(item);
    }

    const out = await withTx(async (c) => {
      const created = [];
      for (const [ref, items] of byRef) {
        const po = (await c.query(
          `INSERT INTO purchase_orders (ref_no, order_date, currency, status, note, created_by)
           VALUES ($1, COALESCE($2::date, CURRENT_DATE), 'USD', 'recorded', $3, $4) RETURNING id`,
          [ref, order_date, note, userId])).rows[0];
        for (const it of items) {
          await c.query(
            `INSERT INTO purchase_order_lines (po_id, product_id, input_code, qty, unit_cost_usd, amount_usd)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [po.id, it.product_id, it.input_code, it.qty, it.unit_cost_usd, it.amount_usd]);
        }
        created.push({ po_id: Number(po.id), ref, lines: items.length, unmatched: items.filter((x) => x.product_id == null).length });
      }
      return created;
    });

    await logEvent({ userId, deviceId: req.ctx.deviceId, action: 'create', target: `purchase:${out.map((o) => o.po_id).join(',')}` });
    return {
      created: out,
      po_count: out.length,
      inserted_lines: valid.length,
      unmatched: out.reduce((s, o) => s + o.unmatched, 0),
      skipped_rows: errors.length,
      errors,
    };
  });

  // 구매내역 목록(참조번호·기간·코드 검색) + 집계
  app.get('/api/purchases', gate, async (req) => {
    const q = (req.query.q || '').trim();
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const params = [];
    const where = ['p.deleted_at IS NULL'];
    if (from) { params.push(from); where.push(`p.order_date >= $${params.length}`); }
    if (to) { params.push(to); where.push(`p.order_date <= $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      const pi = params.length;
      where.push(`(p.ref_no ILIKE $${pi} OR EXISTS (SELECT 1 FROM purchase_order_lines lx WHERE lx.po_id = p.id AND lx.input_code ILIKE $${pi}))`);
    }
    params.push(limit);
    const r = await query(
      `SELECT p.id, p.ref_no, p.order_date, p.currency, p.status, p.note, p.created_at,
              u.name AS created_by_name,
              COUNT(l.id)::int AS line_count,
              COALESCE(SUM(l.qty),0) AS total_qty,
              COALESCE(SUM(l.amount_usd),0) AS total_usd,
              SUM(CASE WHEN l.product_id IS NOT NULL THEN 1 ELSE 0 END)::int AS matched_cnt,
              SUM(CASE WHEN l.product_id IS NULL THEN 1 ELSE 0 END)::int AS unmatched_cnt
       FROM purchase_orders p
       LEFT JOIN purchase_order_lines l ON l.po_id = p.id
       LEFT JOIN users u ON u.id = p.created_by
       WHERE ${where.join(' AND ')}
       GROUP BY p.id, u.name
       ORDER BY p.order_date DESC, p.id DESC
       LIMIT $${params.length}`, params);
    const seeCost = canSeeCost(req.ctx.perm);
    const items = r.rows.map((x) => ({
      id: Number(x.id), ref_no: x.ref_no, order_date: x.order_date, currency: x.currency,
      status: x.status, note: x.note, created_at: x.created_at, created_by_name: x.created_by_name,
      line_count: Number(x.line_count), total_qty: Number(x.total_qty),
      total_usd: seeCost ? Number(x.total_usd) : null,        // 구매단가 비공개
      matched_cnt: Number(x.matched_cnt), unmatched_cnt: Number(x.unmatched_cnt),
    }));
    const summary = {
      po_count: items.length,
      total_usd: seeCost ? Math.round(r.rows.reduce((s, x) => s + Number(x.total_usd), 0) * 100) / 100 : null,
      total_qty: Math.round(items.reduce((s, i) => s + i.total_qty, 0) * 1000) / 1000,
      unmatched_lines: items.reduce((s, i) => s + i.unmatched_cnt, 0),
    };
    return { cost_visible: seeCost, items, summary };
  });

  // 상세(라인)
  app.get('/api/purchases/:id', gate, async (req, reply) => {
    const id = Number(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const h = (await query(
      `SELECT p.id, p.ref_no, p.order_date, p.currency, p.status, p.note, p.created_at,
              u.name AS created_by_name
       FROM purchase_orders p LEFT JOIN users u ON u.id = p.created_by
       WHERE p.id = $1 AND p.deleted_at IS NULL`, [id])).rows[0];
    if (!h) return reply.code(404).send({ error: 'not_found' });
    const lr = await query(
      `SELECT l.id, l.input_code, l.product_id, pr.code AS matched_code, pr.name AS product_name,
              pr.stock_qty, l.qty, l.unit_cost_usd, l.amount_usd, l.received_qty
       FROM purchase_order_lines l
       LEFT JOIN products pr ON pr.id = l.product_id
       WHERE l.po_id = $1 ORDER BY l.id`, [id]);
    const seeCost = canSeeCost(req.ctx.perm);
    const lines = lr.rows.map((x) => ({
      id: Number(x.id), input_code: x.input_code, product_id: x.product_id ? Number(x.product_id) : null,
      matched_code: x.matched_code, product_name: x.product_name,
      stock_qty: x.stock_qty == null ? null : Number(x.stock_qty),
      qty: Number(x.qty),
      unit_cost_usd: seeCost ? Number(x.unit_cost_usd) : null,   // 구매단가 비공개
      amount_usd: seeCost ? Number(x.amount_usd) : null,
      received_qty: Number(x.received_qty), backorder_qty: Number(x.qty) - Number(x.received_qty),
      matched: x.product_id != null,
    }));
    return {
      cost_visible: seeCost,
      header: { id: Number(h.id), ref_no: h.ref_no, order_date: h.order_date, currency: h.currency, status: h.status, note: h.note, created_at: h.created_at, created_by_name: h.created_by_name },
      lines,
      total_qty: Math.round(lines.reduce((s, l) => s + l.qty, 0) * 1000) / 1000,
      total_usd: seeCost ? Math.round(lr.rows.reduce((s, x) => s + Number(x.amount_usd), 0) * 100) / 100 : null,
    };
  });

  // 전체 라인 평면 뷰 — 참조번호 무관, SKU·구매참조번호·backorder·현재고·예상재고(현재+추가)
  app.get('/api/purchases/lines', gate, async (req) => {
    const seeCost = canSeeCost(req.ctx.perm);
    const q = (req.query.q || '').trim();
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();
    const boOnly = req.query.backorder_only === '1' || req.query.backorder_only === 'true';
    const limit = Math.min(Number(req.query.limit) || 1000, 3000);
    const params = [];
    const where = ['p.deleted_at IS NULL', "p.status <> 'cancelled'"];
    if (boOnly) where.push('(l.qty - l.received_qty) > 0');
    if (from) { params.push(from); where.push(`p.order_date >= $${params.length}`); }
    if (to) { params.push(to); where.push(`p.order_date <= $${params.length}`); }
    if (q) {
      params.push(`%${q}%`); const pi = params.length;
      where.push(`(l.input_code ILIKE $${pi} OR pr.code ILIKE $${pi} OR pr.name ILIKE $${pi} OR p.ref_no ILIKE $${pi})`);
    }
    params.push(limit);
    const r = await query(
      `SELECT l.id, p.id AS po_id, p.ref_no, p.order_date,
              l.input_code, l.product_id, pr.code AS matched_code, pr.name AS product_name,
              pr.stock_qty, l.qty, l.received_qty,
              (l.qty - l.received_qty) AS backorder,
              l.unit_cost_usd, l.amount_usd
       FROM purchase_order_lines l
       JOIN purchase_orders p ON p.id = l.po_id
       LEFT JOIN products pr ON pr.id = l.product_id
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(pr.code, l.input_code) ASC, p.order_date DESC, l.id DESC
       LIMIT $${params.length}`, params);
    const items = r.rows.map((x) => {
      const stock = x.stock_qty == null ? null : Number(x.stock_qty);
      const backorder = Number(x.backorder);
      return {
        id: Number(x.id), po_id: Number(x.po_id), ref_no: x.ref_no, order_date: x.order_date,
        input_code: x.input_code, product_id: x.product_id ? Number(x.product_id) : null,
        matched_code: x.matched_code, product_name: x.product_name, matched: x.product_id != null,
        stock_qty: stock, qty: Number(x.qty), received_qty: Number(x.received_qty),
        backorder, projected: stock == null ? null : Math.round((stock + backorder) * 1000) / 1000,   // 현재고 + backorder = 입고 후 예상재고
        unit_cost_usd: seeCost ? Number(x.unit_cost_usd) : null,
        amount_usd: seeCost ? Number(x.amount_usd) : null,
      };
    });
    const skuSet = new Set(items.map((i) => (i.matched ? i.matched_code : i.input_code)));
    const summary = {
      line_count: items.length,
      total_backorder: Math.round(items.reduce((s, i) => s + i.backorder, 0) * 1000) / 1000,
      sku_count: skuSet.size,
      total_usd: seeCost ? Math.round(items.reduce((s, i) => s + (i.amount_usd || 0), 0) * 100) / 100 : null,
    };
    return { cost_visible: seeCost, items, summary };
  });

  // 소프트 삭제(디렉터 전용) — 오기입 정정용
  app.delete('/api/purchases/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const r = await query(
      `UPDATE purchase_orders SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id]);
    if (!r.rows.length) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, deviceId: req.ctx.deviceId, action: 'delete', target: `purchase:${id}` });
    return { ok: true, id };
  });
}
