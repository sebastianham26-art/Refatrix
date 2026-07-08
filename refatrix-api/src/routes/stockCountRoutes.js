// stockCountRoutes.js · rev 20260705r8 (redeploy marker — 기동 성공 시 아래 로그가 찍힘)
import { query, withTx } from '../db.js';
import { authGuard, requirePage, requirePageEdit } from '../middleware/authGuard.js';
import { fieldVisible, round2 } from '../permissions.js';
import { logEvent } from '../audit.js';
import { verifyPin } from '../auth.js';

// =====================================================================
// Refatrix ERP · stockCountRoutes.js  (재고실사 / Inventory Count)
//   · 권한: 'warehouse' 페이지(창고담당) + 디렉터 바이패스.
//   · 대조 기준 = 실물 시스템 재고 products.stock_qty (가용재고 아님).
//     가용재고(= 현재고 − 미결·미만료 견적 예약)는 참고 컬럼으로만 제공.
//   · 감사 전용: 실사 기록은 재고를 바꾸지 않음.
//     디렉터 "실물로 맞추기"(apply) 시에만 stock_movements(adjust) + stock_qty 갱신.
//   · 금액 영향(원가/정가 환산)은 unit_cost 권한자(또는 디렉터)에게만 반환.
// =====================================================================

export default async function stockCountRoutes(app) {
  try { console.log("[stockCountRoutes] loaded rev 20260705r8"); } catch (e) {}
  const isDirector = (req) => req.ctx.perm.role === 'director';
  const canSeeValue = (req) => isDirector(req) || fieldVisible(req.ctx.perm, 'unit_cost');
  const num = (v) => (v == null ? 0 : Number(v));

  // ---- 코드 해석: CTR → EAN → SYD → 프로모(코드/바코드) → 미등록 --------
  async function resolveCode(codeRaw, exec = query) {
    const c = String(codeRaw || '').trim();
    if (!c) return { item_kind: 'unknown', source: 'none' };

    // 1) 자동차부품 CTR 코드 정확매칭
    let rows = (await exec(
      `SELECT id, code, name, app FROM products
        WHERE deleted_at IS NULL AND UPPER(code) = UPPER($1) ORDER BY code LIMIT 1`, [c])).rows;
    if (rows.length) return { item_kind: 'part', source: 'ctr', product: rows[0] };

    // 2) EAN-13 바코드
    rows = (await exec(
      `SELECT id, code, name, app FROM products
        WHERE deleted_at IS NULL AND ean IS NOT NULL AND TRIM(ean) <> ''
          AND UPPER(TRIM(ean)) = UPPER($1) ORDER BY code LIMIT 1`, [c])).rows;
    if (rows.length) return { item_kind: 'part', source: 'ean', product: rows[0] };

    // 3) SYD(경쟁사) 역검색
    rows = (await exec(
      `SELECT p.id, p.code, p.name, p.app
         FROM product_syd_codes s JOIN products p ON p.id = s.product_id AND p.deleted_at IS NULL
        WHERE UPPER(s.syd_code) = UPPER($1) ORDER BY p.code LIMIT 1`, [c])).rows;
    if (rows.length) return { item_kind: 'part', source: 'syd', product: rows[0] };

    // 4) 프로모션 코드/바코드
    rows = (await exec(
      `SELECT id, code, name FROM promo_items
        WHERE deleted_at IS NULL AND active = TRUE
          AND (UPPER(code) = UPPER($1)
               OR (barcode IS NOT NULL AND TRIM(barcode) <> '' AND UPPER(TRIM(barcode)) = UPPER($1)))
        ORDER BY code LIMIT 1`, [c])).rows;
    if (rows.length) return { item_kind: 'promo', source: 'promo', promo: rows[0] };

    return { item_kind: 'unknown', source: 'none' };
  }

  // 부품 가용재고(참고용) = 현재고 − 미결·미만료 견적 예약분 (견적/현장조사와 동일 정의)
  async function availFor(productId, exec = query) {
    const r = (await exec(
      `SELECT p.stock_qty,
              COALESCE((SELECT SUM(ql.reserved_qty)
                          FROM quote_lines ql JOIN quotes q ON q.id = ql.quote_id
                         WHERE ql.product_id = p.id
                           AND q.status IN ('draft','confirmed')
                           AND (q.reserve_expires_at > now() OR q.packing_printed_at IS NOT NULL)
                           AND q.deleted_at IS NULL), 0) AS reserved
         FROM products p WHERE p.id = $1`, [productId])).rows[0];
    if (!r) return 0;
    return Math.max(0, num(r.stock_qty) - num(r.reserved));
  }

  async function nextCode(exec = query) {
    // exec 은 query(함수) 또는 withTx 클라이언트(.query) 둘 다 올 수 있음 → 정규화
    const run = typeof exec === 'function' ? exec : (s, p) => exec.query(s, p);
    const year = new Date().getFullYear();
    const r = (await run(`SELECT COUNT(*)::int AS n FROM stock_counts WHERE code LIKE $1`, [`SC-${year}-%`])).rows[0];
    return `SC-${year}-${String((r.n || 0) + 1).padStart(4, '0')}`;
  }

  function sessRow(r) {
    return {
      id: Number(r.id), code: r.code, status: r.status, scope_note: r.scope_note || '',
      started_by: r.started_by != null ? Number(r.started_by) : null, started_by_name: r.started_by_name || '',
      started_at: r.started_at, submitted_at: r.submitted_at, reconciled_at: r.reconciled_at,
      lines: r.lines != null ? Number(r.lines) : 0,
      del_requested_at: r.del_requested_at || null,
      del_requested_by: r.del_requested_by != null ? Number(r.del_requested_by) : null,
      del_requested_by_name: r.del_requested_by_name || '',
    };
  }

  // ================= 세션 =================

  // 목록(최근 순). 창고담당은 전부 볼 수 있게(협업). 디렉터도 전체.
  app.get('/api/stock-counts', { preHandler: [authGuard, requirePage('warehouse')] }, async (req) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = (await query(
      `SELECT sc.*, u.name AS started_by_name, du.name AS del_requested_by_name,
              (SELECT COUNT(*) FROM stock_count_lines l WHERE l.count_id = sc.id) AS lines
         FROM stock_counts sc
         LEFT JOIN users u ON u.id = sc.started_by
         LEFT JOIN users du ON du.id = sc.del_requested_by
        WHERE sc.status <> 'canceled'
        ORDER BY sc.started_at DESC LIMIT $1`, [limit])).rows;
    return { items: rows.map(sessRow) };
  });

  // 진행중(draft) 세션 — 이어쓰기용
  app.get('/api/stock-counts/active', { preHandler: [authGuard, requirePage('warehouse')] }, async (req) => {
    const rows = (await query(
      `SELECT sc.*, u.name AS started_by_name,
              (SELECT COUNT(*) FROM stock_count_lines l WHERE l.count_id = sc.id) AS lines
         FROM stock_counts sc LEFT JOIN users u ON u.id = sc.started_by
        WHERE sc.status = 'draft'
        ORDER BY sc.started_at DESC`, [])).rows;
    return { items: rows.map(sessRow) };
  });

  // 새 실사 세션
  app.post('/api/stock-counts', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req) => {
    const scope = String((req.body && req.body.scope_note) || '').trim().slice(0, 300) || null;
    const uid = req.ctx.perm.userId;
    const row = await withTx(async (c) => {
      const code = await nextCode(c);
      return (await c.query(
        `INSERT INTO stock_counts (code, status, scope_note, started_by)
         VALUES ($1,'draft',$2,$3) RETURNING *`, [code, scope, uid])).rows[0];
    });
    await logEvent({ userId: uid, action: 'create', target: `stock_count:${row.id}`, detail: { code: row.code } });
    return sessRow(row);
  });

  // 세션 상세 + 라인
  app.get('/api/stock-counts/:id', { preHandler: [authGuard, requirePage('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const sc = (await query(
      `SELECT sc.*, u.name AS started_by_name FROM stock_counts sc
         LEFT JOIN users u ON u.id = sc.started_by WHERE sc.id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    const lines = (await query(
      `SELECT l.*, COALESCE(p.name, pi.name) AS item_name, ru.name AS del_requested_by_name,
              (SELECT STRING_AGG(DISTINCT s.syd_code, ', ') FROM product_syd_codes s
                 WHERE s.product_id = l.product_id AND s.syd_code IS NOT NULL AND TRIM(s.syd_code) <> '') AS syd_code
         FROM stock_count_lines l
         LEFT JOIN products p ON p.id = l.product_id
         LEFT JOIN promo_items pi ON pi.id = l.promo_item_id
         LEFT JOIN users ru ON ru.id = l.del_requested_by
        WHERE l.count_id=$1 ORDER BY l.id`, [id])).rows;
    return {
      ...sessRow(sc),
      lines: lines.map((l) => ({
        id: Number(l.id), item_kind: l.item_kind,
        product_id: l.product_id != null ? Number(l.product_id) : null,
        promo_item_id: l.promo_item_id != null ? Number(l.promo_item_id) : null,
        raw_code: l.raw_code, matched_code: l.matched_code || '', match_source: l.match_source || '',
        syd_code: l.syd_code || '',
        item_name: l.item_name || '', rack_scanned: l.rack_scanned || '', counted_qty: num(l.counted_qty),
        del_requested_at: l.del_requested_at || null, del_requested_by: l.del_requested_by != null ? Number(l.del_requested_by) : null, del_requested_by_name: l.del_requested_by_name || '',
      })),
    };
  });

  // 코드 해석(입력 즉시 미리보기) — 저장은 별도
  app.get('/api/stock-counts/resolve', { preHandler: [authGuard, requirePage('warehouse')] }, async (req) => {
    const r = await resolveCode(req.query.code);
    if (r.item_kind === 'part') {
      const avail = await availFor(r.product.id);
      const sys = (await query(`SELECT stock_qty, rack_location FROM products WHERE id=$1`, [r.product.id])).rows[0];
      return {
        item_kind: 'part', source: r.source, product_id: Number(r.product.id),
        matched_code: r.product.code, name: r.product.name || '', app: r.product.app || '',
        system_qty: num(sys && sys.stock_qty), avail_qty: avail, rack_location: (sys && sys.rack_location) || '',
      };
    }
    if (r.item_kind === 'promo') {
      const p = (await query(`SELECT stock_qty, rack_location FROM promo_items WHERE id=$1`, [r.promo.id])).rows[0];
      return {
        item_kind: 'promo', source: 'promo', promo_item_id: Number(r.promo.id),
        matched_code: r.promo.code, name: r.promo.name || '',
        system_qty: num(p && p.stock_qty), avail_qty: null, rack_location: (p && p.rack_location) || '',
      };
    }
    return { item_kind: 'unknown', source: 'none' };
  });

  // 라인 기록(건별 자동저장). body: { raw_code, rack_scanned, counted_qty }
  app.post('/api/stock-counts/:id/lines', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const raw = String(b.raw_code || '').trim();
    if (!raw) return reply.code(400).send({ error: 'empty_code' });
    let qty = Number(b.counted_qty);
    if (!isFinite(qty)) qty = 1;
    if (qty < 0) return reply.code(400).send({ error: 'bad_qty' });
    const rack = String(b.rack_scanned || '').trim().slice(0, 120) || null;

    const sc = (await query(`SELECT id, status FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (sc.status !== 'draft') return reply.code(409).send({ error: 'not_draft' });

    const r = await resolveCode(raw);
    const kind = r.item_kind;
    const productId = kind === 'part' ? Number(r.product.id) : null;
    const promoId = kind === 'promo' ? Number(r.promo.id) : null;
    const matched = kind === 'part' ? r.product.code : (kind === 'promo' ? r.promo.code : null);

    const row = (await query(
      `INSERT INTO stock_count_lines
         (count_id, item_kind, product_id, promo_item_id, raw_code, matched_code, match_source, rack_scanned, counted_qty, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [id, kind, productId, promoId, raw, matched, r.source, rack, qty, req.ctx.perm.userId])).rows[0];

    const name = kind === 'part' ? (r.product.name || '') : (kind === 'promo' ? (r.promo.name || '') : '');
    let systemQty = null, availQty = null, sydCode = '';
    if (kind === 'part') {
      systemQty = num((await query(`SELECT stock_qty FROM products WHERE id=$1`, [productId])).rows[0].stock_qty);
      availQty = await availFor(productId);
      sydCode = (await query(`SELECT STRING_AGG(DISTINCT syd_code, ', ') AS s FROM product_syd_codes WHERE product_id=$1 AND syd_code IS NOT NULL AND TRIM(syd_code) <> ''`, [productId])).rows[0].s || '';
    }
    else if (kind === 'promo') { systemQty = num((await query(`SELECT stock_qty FROM promo_items WHERE id=$1`, [promoId])).rows[0].stock_qty); }

    return {
      id: Number(row.id), item_kind: kind, source: r.source, product_id: productId, promo_item_id: promoId,
      raw_code: raw, matched_code: matched || '', syd_code: sydCode, item_name: name, rack_scanned: rack || '',
      counted_qty: qty, system_qty: systemQty, avail_qty: availQty,
    };
  });

  // 라인 수정(수량/랙)
  app.patch('/api/stock-counts/:id/lines/:lineId', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id); const lineId = Number(req.params.lineId);
    const sc = (await query(`SELECT status FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (sc.status !== 'draft') return reply.code(409).send({ error: 'not_draft' });
    const b = req.body || {};
    const sets = []; const args = [];
    if (b.counted_qty != null) {
      const q = Number(b.counted_qty);
      if (!isFinite(q) || q < 0) return reply.code(400).send({ error: 'bad_qty' });
      args.push(q); sets.push(`counted_qty=$${args.length}`);
    }
    if (b.rack_scanned != null) { args.push(String(b.rack_scanned).trim().slice(0, 120) || null); sets.push(`rack_scanned=$${args.length}`); }
    if (!sets.length) return { ok: true };
    args.push(lineId); args.push(id);
    const r = (await query(`UPDATE stock_count_lines SET ${sets.join(', ')} WHERE id=$${args.length - 1} AND count_id=$${args.length} RETURNING id`, args)).rows[0];
    if (!r) return reply.code(404).send({ error: 'line_not_found' });
    return { ok: true };
  });

  // 라인 삭제
  app.delete('/api/stock-counts/:id/lines/:lineId', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    if (!isDirector(req)) return reply.code(403).send({ error: 'director_only', note: '\ub514\ub809\ud130 \uc2b9\uc778\uc774 \ud544\uc694\ud569\ub2c8\ub2e4.' });
    const id = Number(req.params.id); const lineId = Number(req.params.lineId);
    const sc = (await query(`SELECT status FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (sc.status !== 'draft') return reply.code(409).send({ error: 'not_draft' });
    await query(`DELETE FROM stock_count_lines WHERE id=$1 AND count_id=$2`, [lineId, id]);
    return { ok: true };
  });

  // 선택 라인 삭제 요청(담당자) — draft 만, 플래그만 세팅
  app.post('/api/stock-counts/:id/lines/delete-request', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const ids = (req.body && Array.isArray(req.body.line_ids)) ? req.body.line_ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) return reply.code(400).send({ error: 'no_lines' });
    const sc = (await query(`SELECT status FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (sc.status !== 'draft') return reply.code(409).send({ error: 'not_draft' });
    const r = await query(`UPDATE stock_count_lines SET del_requested_at=now(), del_requested_by=$3 WHERE count_id=$1 AND id = ANY($2::bigint[]) AND del_requested_at IS NULL`, [id, ids, req.ctx.perm.userId]);
    return { ok: true, requested: r.rowCount };
  });

  // 선택 라인 삭제 승인(디렉터) — 실제 삭제
  app.post('/api/stock-counts/:id/lines/delete-approve', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    if (!isDirector(req)) return reply.code(403).send({ error: 'director_only', note: '\ub514\ub809\ud130 \uc2b9\uc778\uc774 \ud544\uc694\ud569\ub2c8\ub2e4.' });
    const id = Number(req.params.id);
    const ids = (req.body && Array.isArray(req.body.line_ids)) ? req.body.line_ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) return reply.code(400).send({ error: 'no_lines' });
    const sc = (await query(`SELECT status FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (sc.status !== 'draft') return reply.code(409).send({ error: 'not_draft' });
    const r = await query(`DELETE FROM stock_count_lines WHERE count_id=$1 AND id = ANY($2::bigint[])`, [id, ids]);
    return { ok: true, deleted: r.rowCount };
  });

  // 선택 라인 삭제요청 반려(디렉터) — 플래그 해제
  app.post('/api/stock-counts/:id/lines/delete-reject', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    if (!isDirector(req)) return reply.code(403).send({ error: 'director_only', note: '\ub514\ub809\ud130 \uc2b9\uc778\uc774 \ud544\uc694\ud569\ub2c8\ub2e4.' });
    const id = Number(req.params.id);
    const ids = (req.body && Array.isArray(req.body.line_ids)) ? req.body.line_ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) return reply.code(400).send({ error: 'no_lines' });
    await query(`UPDATE stock_count_lines SET del_requested_at=NULL, del_requested_by=NULL WHERE count_id=$1 AND id = ANY($2::bigint[])`, [id, ids]);
    return { ok: true };
  });

  // 선택 라인 직접 삭제(담당자) — draft 상태에서 승인 없이 즉시 삭제
  app.post('/api/stock-counts/:id/lines/delete', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const ids = (req.body && Array.isArray(req.body.line_ids)) ? req.body.line_ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) return reply.code(400).send({ error: 'no_lines' });
    const sc = (await query(`SELECT status FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (sc.status !== 'draft') return reply.code(409).send({ error: 'not_draft', note: '제출 후에는 직접 삭제할 수 없습니다.' });
    const r = await query(`DELETE FROM stock_count_lines WHERE count_id=$1 AND id = ANY($2::bigint[])`, [id, ids]);
    return { ok: true, deleted: r.rowCount };
  });

  // 제출(대조 확정) draft → submitted
  app.post('/api/stock-counts/:id/submit', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const sc = (await query(`SELECT status FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (sc.status !== 'draft') return reply.code(409).send({ error: 'not_draft' });
    await query(`UPDATE stock_counts SET status='submitted', submitted_at=now() WHERE id=$1`, [id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `stock_count:${id}`, detail: { step: 'submit' } });
    return { ok: true };
  });

  // 세션 취소(draft만)
  app.post('/api/stock-counts/:id/cancel', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const sc = (await query(`SELECT status FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (sc.status !== 'draft') return reply.code(409).send({ error: 'not_draft' });
    await query(`UPDATE stock_counts SET status='canceled' WHERE id=$1`, [id]);
    return { ok: true };
  });

  // ===== 세션 삭제: 담당자 요청 → 디렉터 승인 =====
  // 담당자가 세션 삭제를 요청(진행중/제출됨 대상). 반영완료·이미취소는 불가.
  app.post('/api/stock-counts/:id/delete-request', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const sc = (await query(`SELECT status FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (!['draft', 'submitted'].includes(sc.status)) return reply.code(409).send({ error: 'not_deletable', note: '진행중/제출된 실사만 삭제 요청할 수 있습니다.' });
    await query(`UPDATE stock_counts SET del_requested_at=now(), del_requested_by=$2 WHERE id=$1`, [id, req.ctx.perm.userId]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `stock_count:${id}`, detail: { step: 'delete_request' } });
    return { ok: true };
  });

  // 디렉터 승인 → 세션 취소(목록에서 사라짐, 데이터는 보존)
  app.post('/api/stock-counts/:id/delete-approve', { preHandler: [authGuard] }, async (req, reply) => {
    if (!isDirector(req)) return reply.code(403).send({ error: 'director_only', note: '디렉터만 승인할 수 있습니다.' });
    const id = Number(req.params.id);
    const sc = (await query(`SELECT status, del_requested_at FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (!sc.del_requested_at) return reply.code(409).send({ error: 'not_requested', note: '삭제 요청이 없습니다.' });
    if (!['draft', 'submitted'].includes(sc.status)) return reply.code(409).send({ error: 'not_deletable' });
    await query(`UPDATE stock_counts SET status='canceled', del_requested_at=NULL, del_requested_by=NULL WHERE id=$1`, [id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `stock_count:${id}`, detail: { step: 'delete_approve' } });
    return { ok: true };
  });

  // 디렉터 반려 → 요청 해제
  app.post('/api/stock-counts/:id/delete-reject', { preHandler: [authGuard] }, async (req, reply) => {
    if (!isDirector(req)) return reply.code(403).send({ error: 'director_only', note: '디렉터만 반려할 수 있습니다.' });
    const id = Number(req.params.id);
    await query(`UPDATE stock_counts SET del_requested_at=NULL, del_requested_by=NULL WHERE id=$1`, [id]);
    return { ok: true };
  });

  // ================= 대조(reconcile) =================
  // 세션 내 항목별 실사합계 vs 시스템 재고. 5분류.
  //   match / short(실물<시스템) / over(실물>시스템) / uncounted(재고有·미실사) / unknown(미등록)
  app.get('/api/stock-counts/:id/reconcile', { preHandler: [authGuard, requirePage('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const withValue = canSeeValue(req);
    const sc = (await query(
      `SELECT sc.*, u.name AS started_by_name FROM stock_counts sc
         LEFT JOIN users u ON u.id=sc.started_by WHERE sc.id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });

    // 실사한 부품(집계) + 시스템 재고
    const parts = (await query(
      `SELECT g.product_id, g.counted, g.racks,
              p.code, p.name, p.rack_location, p.stock_qty, p.avg_cost, p.list_price,
              (SELECT STRING_AGG(DISTINCT s.syd_code, ', ') FROM product_syd_codes s
                 WHERE s.product_id=p.id AND s.syd_code IS NOT NULL AND TRIM(s.syd_code) <> '') AS syd_code,
              COALESCE((SELECT SUM(ql.reserved_qty)
                          FROM quote_lines ql JOIN quotes q ON q.id=ql.quote_id
                         WHERE ql.product_id=p.id AND q.status IN ('draft','confirmed')
                           AND (q.reserve_expires_at > now() OR q.packing_printed_at IS NOT NULL)
                           AND q.deleted_at IS NULL),0) AS reserved
         FROM (SELECT product_id, SUM(counted_qty) AS counted,
                      STRING_AGG(DISTINCT NULLIF(rack_scanned,''), ', ') AS racks
                 FROM stock_count_lines
                WHERE count_id=$1 AND item_kind='part' AND product_id IS NOT NULL
                GROUP BY product_id) g
         JOIN products p ON p.id=g.product_id`, [id])).rows;

    // 실사한 프로모(집계)
    const promos = (await query(
      `SELECT g.promo_item_id, g.counted, g.racks, pi.code, pi.name, pi.rack_location, pi.stock_qty, pi.unit_cost
         FROM (SELECT promo_item_id, SUM(counted_qty) AS counted,
                      STRING_AGG(DISTINCT NULLIF(rack_scanned,''), ', ') AS racks
                 FROM stock_count_lines
                WHERE count_id=$1 AND item_kind='promo' AND promo_item_id IS NOT NULL
                GROUP BY promo_item_id) g
         JOIN promo_items pi ON pi.id=g.promo_item_id`, [id])).rows;

    // 미등록 스캔(집계)
    const unknowns = (await query(
      `SELECT raw_code, SUM(counted_qty) AS counted,
              STRING_AGG(DISTINCT NULLIF(rack_scanned,''), ', ') AS racks
         FROM stock_count_lines
        WHERE count_id=$1 AND item_kind='unknown'
        GROUP BY raw_code ORDER BY raw_code`, [id])).rows;

    // 재고 있으나 실사되지 않은 부품(미실사) — 놓친 랙 탐지
    // 개수는 정확히 세되(요약용), 표시 행은 상위 N건만(부분 실사 중 카탈로그 전체 반환 방지)
    const UNCOUNTED_LIMIT = 300;
    const uncountedTotal = Number((await query(
      `SELECT COUNT(*)::int AS n FROM products p
        WHERE p.deleted_at IS NULL AND COALESCE(p.stock_qty,0) > 0
          AND NOT EXISTS (SELECT 1 FROM stock_count_lines l WHERE l.count_id=$1 AND l.product_id=p.id)`, [id])).rows[0].n);
    const uncounted = (await query(
      `SELECT p.id AS product_id, p.code, p.name, p.rack_location, p.stock_qty, p.avg_cost, p.list_price,
              (SELECT STRING_AGG(DISTINCT s.syd_code, ', ') FROM product_syd_codes s
                 WHERE s.product_id=p.id AND s.syd_code IS NOT NULL AND TRIM(s.syd_code) <> '') AS syd_code
         FROM products p
        WHERE p.deleted_at IS NULL AND COALESCE(p.stock_qty,0) > 0
          AND NOT EXISTS (SELECT 1 FROM stock_count_lines l
                           WHERE l.count_id=$1 AND l.product_id=p.id)
        ORDER BY p.stock_qty DESC LIMIT ${UNCOUNTED_LIMIT}`, [id])).rows;

    const rows = [];
    const S = { match: 0, short: 0, over: 0, uncounted: 0, unknown: 0 };
    let diffQty = 0, valCost = 0, valList = 0;

    for (const p of parts) {
      const sys = num(p.stock_qty); const cnt = num(p.counted); const diff = round2(cnt - sys);
      const cat = diff === 0 ? 'match' : (diff < 0 ? 'short' : 'over');
      S[cat] += 1; diffQty += diff;
      const vc = round2(diff * num(p.avg_cost)); const vl = round2(diff * num(p.list_price));
      valCost += vc; valList += vl;
      rows.push({
        kind: 'part', category: cat, product_id: Number(p.product_id), code: p.code, name: p.name || '', syd_code: p.syd_code || '',
        rack: p.racks || p.rack_location || '', rack_scanned: p.racks || '', master_rack: p.rack_location || '',
        system_qty: sys, counted_qty: cnt,
        avail_qty: Math.max(0, sys - num(p.reserved)), diff,
        ...(withValue ? { value_cost: vc, value_list: vl } : {}),
      });
    }
    for (const p of promos) {
      const sys = num(p.stock_qty); const cnt = num(p.counted); const diff = round2(cnt - sys);
      const cat = diff === 0 ? 'match' : (diff < 0 ? 'short' : 'over');
      S[cat] += 1; diffQty += diff;
      const vc = round2(diff * num(p.unit_cost));
      valCost += vc;
      rows.push({
        kind: 'promo', category: cat, promo_item_id: Number(p.promo_item_id), code: p.code, name: p.name || '',
        rack: p.racks || p.rack_location || '', rack_scanned: p.racks || '', master_rack: p.rack_location || '',
        system_qty: sys, counted_qty: cnt, avail_qty: null, diff,
        ...(withValue ? { value_cost: vc, value_list: 0 } : {}),
      });
    }
    for (const p of uncounted) {
      const sys = num(p.stock_qty);
      rows.push({
        kind: 'part', category: 'uncounted', product_id: Number(p.product_id), code: p.code, name: p.name || '', syd_code: p.syd_code || '',
        rack: p.rack_location || '', system_qty: sys, counted_qty: null, avail_qty: null, diff: null,
        ...(withValue ? { value_cost: 0, value_list: 0 } : {}),
      });
    }
    S.uncounted = uncountedTotal;   // 요약 개수는 전체(정확), 위 rows 는 상위 N건만
    for (const u of unknowns) {
      S.unknown += 1;
      rows.push({
        kind: 'unknown', category: 'unknown', code: u.raw_code, name: '(미등록 코드)',
        rack: u.racks || '', system_qty: null, counted_qty: num(u.counted), avail_qty: null, diff: null,
      });
    }

    // 정렬: 차이 큰 문제부터. cat 가중치 → |diff| 내림차순
    const catW = { short: 0, over: 1, unknown: 2, uncounted: 3, match: 4 };
    rows.sort((a, b) => {
      if (catW[a.category] !== catW[b.category]) return catW[a.category] - catW[b.category];
      return Math.abs(num(b.diff)) - Math.abs(num(a.diff));
    });

    const summary = {
      ...S, counted_items: parts.length + promos.length, diff_qty_total: round2(diffQty),
      uncounted_shown: uncounted.length, uncounted_truncated: uncountedTotal > uncounted.length,
      ...(withValue ? { value_cost_impact: round2(valCost), value_list_impact: round2(valList) } : {}),
    };
    return { count: sessRow(sc), can_apply: isDirector(req) && sc.status === 'submitted', summary, rows };
  });

  // ================= 실물로 맞추기 (디렉터) =================
  // 실사되어 차이가 난 항목만 조정. 미실사(uncounted)·미등록(unknown)은 건드리지 않음.
  async function buildAdjustPlan(id) {
    const parts = (await query(
      `SELECT g.product_id, g.counted, p.code, p.name, p.stock_qty
         FROM (SELECT product_id, SUM(counted_qty) AS counted FROM stock_count_lines
                WHERE count_id=$1 AND item_kind='part' AND product_id IS NOT NULL GROUP BY product_id) g
         JOIN products p ON p.id=g.product_id WHERE p.deleted_at IS NULL`, [id])).rows;
    const promos = (await query(
      `SELECT g.promo_item_id, g.counted, pi.code, pi.name, pi.stock_qty
         FROM (SELECT promo_item_id, SUM(counted_qty) AS counted FROM stock_count_lines
                WHERE count_id=$1 AND item_kind='promo' AND promo_item_id IS NOT NULL GROUP BY promo_item_id) g
         JOIN promo_items pi ON pi.id=g.promo_item_id WHERE pi.deleted_at IS NULL`, [id])).rows;
    const plan = [];
    for (const p of parts) {
      const before = num(p.stock_qty); const after = num(p.counted); const delta = round2(after - before);
      if (delta !== 0) plan.push({ kind: 'part', product_id: Number(p.product_id), code: p.code, name: p.name || '', before, after, delta });
    }
    for (const p of promos) {
      const before = num(p.stock_qty); const after = num(p.counted); const delta = round2(after - before);
      if (delta !== 0) plan.push({ kind: 'promo', promo_item_id: Number(p.promo_item_id), code: p.code, name: p.name || '', before, after, delta });
    }
    return plan;
  }

  // 디렉터 검토 목록: 수량 차이(delta≠0) 또는 실사랙≠마스터랙 인 항목.
  // 각 항목에 시스템/실사/차이 + 실사랙(rack_scanned) + 마스터랙(master_rack) 포함.
  async function buildReviewList(id, exec = query) {
    const run = typeof exec === 'function' ? exec : (s, p) => exec.query(s, p);
    const parts = (await run(
      `SELECT g.product_id, g.counted, g.racks, p.code, p.name, p.stock_qty, p.rack_location
         FROM (SELECT product_id, SUM(counted_qty) AS counted,
                      STRING_AGG(DISTINCT NULLIF(rack_scanned,''), ', ') AS racks
                 FROM stock_count_lines
                WHERE count_id=$1 AND item_kind='part' AND product_id IS NOT NULL GROUP BY product_id) g
         JOIN products p ON p.id=g.product_id WHERE p.deleted_at IS NULL`, [id])).rows;
    const promos = (await run(
      `SELECT g.promo_item_id, g.counted, g.racks, pi.code, pi.name, pi.stock_qty, pi.rack_location
         FROM (SELECT promo_item_id, SUM(counted_qty) AS counted,
                      STRING_AGG(DISTINCT NULLIF(rack_scanned,''), ', ') AS racks
                 FROM stock_count_lines
                WHERE count_id=$1 AND item_kind='promo' AND promo_item_id IS NOT NULL GROUP BY promo_item_id) g
         JOIN promo_items pi ON pi.id=g.promo_item_id WHERE pi.deleted_at IS NULL`, [id])).rows;
    const items = [];
    const mk = (kind, p, idKey) => {
      const before = num(p.stock_qty), after = num(p.counted), delta = round2(after - before);
      const scanned = (p.racks || '').trim(), master = (p.rack_location || '').trim();
      const rackDiff = scanned !== '' && scanned !== master;
      if (delta === 0 && !rackDiff) return null;
      const it = { kind, code: p.code, name: p.name || '', system_qty: before, counted_qty: after, delta,
        rack_scanned: scanned, master_rack: master, rack_diff: rackDiff };
      it[idKey] = Number(kind === 'part' ? p.product_id : p.promo_item_id);
      return it;
    };
    for (const p of parts) { const it = mk('part', p, 'product_id'); if (it) items.push(it); }
    for (const p of promos) { const it = mk('promo', p, 'promo_item_id'); if (it) items.push(it); }
    items.sort((a, b) => Math.abs(num(b.delta)) - Math.abs(num(a.delta)));
    return items;
  }

  // 코드별 실사 내역(드릴다운) + SYD 코드
  app.get('/api/stock-counts/:id/code-lines', { preHandler: [authGuard, requirePage('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const q = req.query || {};
    const productId = (q.product_id != null && q.product_id !== '') ? Number(q.product_id) : null;
    const promoId   = (q.promo_item_id != null && q.promo_item_id !== '') ? Number(q.promo_item_id) : null;
    const raw       = (q.raw != null && q.raw !== '') ? String(q.raw) : null;
    const sel = `l.id, l.rack_scanned, l.counted_qty, l.matched_code, l.created_at, u.name AS created_by_name`;
    let lines = [], syd = [];
    if (productId != null) {
      lines = (await query(`SELECT ${sel} FROM stock_count_lines l LEFT JOIN users u ON u.id=l.created_by
                             WHERE l.count_id=$1 AND l.product_id=$2 ORDER BY l.created_at, l.id`, [id, productId])).rows;
      syd = (await query(`SELECT syd_code FROM product_syd_codes WHERE product_id=$1 AND syd_code IS NOT NULL AND TRIM(syd_code) <> '' ORDER BY syd_code`, [productId])).rows.map((r) => r.syd_code);
    } else if (promoId != null) {
      lines = (await query(`SELECT ${sel} FROM stock_count_lines l LEFT JOIN users u ON u.id=l.created_by
                             WHERE l.count_id=$1 AND l.promo_item_id=$2 ORDER BY l.created_at, l.id`, [id, promoId])).rows;
    } else if (raw != null) {
      lines = (await query(`SELECT ${sel} FROM stock_count_lines l LEFT JOIN users u ON u.id=l.created_by
                             WHERE l.count_id=$1 AND l.item_kind='unknown' AND l.raw_code=$2 ORDER BY l.created_at, l.id`, [id, raw])).rows;
    } else {
      return reply.code(400).send({ error: 'no_key' });
    }
    return { ok: true, syd_codes: syd, lines: lines.map((l) => ({
      id: Number(l.id), rack_scanned: l.rack_scanned || '', counted_qty: num(l.counted_qty),
      matched_code: l.matched_code || '', created_at: l.created_at, created_by_name: l.created_by_name || '',
    })) };
  });

  app.post('/api/stock-counts/:id/apply/preview', { preHandler: [authGuard] }, async (req, reply) => {
    if (!isDirector(req)) return reply.code(403).send({ error: 'director_only', note: '디렉터 승인이 필요합니다.' });
    const id = Number(req.params.id);
    const sc = (await query(`SELECT status FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (sc.status !== 'submitted') return reply.code(409).send({ error: 'not_submitted', note: '제출된 실사만 적용할 수 있습니다.' });
    const items = await buildReviewList(id);
    const plan = await buildAdjustPlan(id);            // 하위호환(레거시 필드 유지)
    return { count_id: id, adjust_count: plan.length, review_count: items.length, items, plan };
  });

  // 디렉터 승인·반영. body.items 가 오면 항목별 결정(반영/보류·코멘트·랙저장)을 적용.
  //   items: [{ kind:'part'|'promo', product_id?/promo_item_id?, apply:bool, save_rack:bool, comment:string }]
  // body.items 가 없으면 레거시(차이 전부 반영).
  app.post('/api/stock-counts/:id/apply', { preHandler: [authGuard] }, async (req, reply) => {
    if (!isDirector(req)) return reply.code(403).send({ error: 'director_only', note: '디렉터 승인이 필요합니다.' });
    const id = Number(req.params.id);
    const uid = req.ctx.perm.userId;
    const body = req.body || {};
    // 디렉터 PIN 확인 — 반영은 되돌릴 수 없으므로 본인 재인증
    const pin = String(body.pin || '');
    if (!pin) return reply.code(400).send({ error: 'pin_required', note: 'PIN을 입력하세요.' });
    const me = (await query(`SELECT pin_hash FROM users WHERE id=$1 AND deleted_at IS NULL`, [uid])).rows[0];
    if (!me || !verifyPin(pin, me.pin_hash)) return reply.code(403).send({ error: 'bad_pin', note: 'PIN이 올바르지 않습니다.' });
    const hasDecisions = Array.isArray(body.items);
    const keyOf = (kind, pid, promoId) => `${kind}:${kind === 'part' ? pid : promoId}`;
    const decMap = new Map();
    if (hasDecisions) {
      for (const it of body.items) {
        const k = keyOf(it.kind, Number(it.product_id), Number(it.promo_item_id));
        const fin = (it.final_qty != null && isFinite(Number(it.final_qty))) ? Number(it.final_qty) : null;
        decMap.set(k, { apply: !!it.apply, save_rack: !!it.save_rack, comment: String(it.comment || '').trim().slice(0, 500), final: fin });
      }
    }
    const result = await withTx(async (c) => {
      const sc = (await c.query(`SELECT id, code, status FROM stock_counts WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!sc) return { error: 'not_found' };
      if (sc.status !== 'submitted') return { error: 'not_submitted' };
      const review = await buildReviewList(id, c);
      const eventNo = Number((await c.query(`SELECT nextval('stock_event_seq') AS n`)).rows[0].n);
      let applied = 0, rackSaved = 0;
      for (const it of review) {
        const k = keyOf(it.kind, it.product_id, it.promo_item_id);
        // 결정: 명시적 payload 있으면 그대로, 없으면 레거시(차이는 반영, 랙은 저장 안함)
        const dec = hasDecisions ? (decMap.get(k) || { apply: false, save_rack: false, comment: '', final: null })
                                 : { apply: it.delta !== 0, save_rack: false, comment: '', final: null };
        let didApply = false, didRack = false, appliedQty = null;
        if (it.kind === 'part') {
          if (dec.apply) {
            const cur = num((await c.query(`SELECT stock_qty FROM products WHERE id=$1 FOR UPDATE`, [it.product_id])).rows[0].stock_qty);
            const target = round2(dec.final != null && dec.final >= 0 ? dec.final : it.counted_qty);
            if (target < 0) return { error: 'would_go_negative', code: it.code };
            const delta = round2(target - cur);
            if (delta !== 0) {
              await c.query(`UPDATE products SET stock_qty=$1, updated_by=$2 WHERE id=$3`, [target, uid, it.product_id]);
              const forced = dec.final != null && round2(dec.final) !== round2(it.counted_qty);
              const note = `재고실사 ${sc.code} 실물조정` + (forced ? ' (강제조정)' : '') + (dec.comment ? ` · ${dec.comment}` : '');
              await c.query(
                `INSERT INTO stock_movements (product_id, move_type, qty, ref, note, source, moved_at, event_no, created_by)
                 VALUES ($1,'adjust',$2,$3,$4,'count', now(), $5, $6)`,
                [it.product_id, delta, `count:${id}`, note, eventNo, uid]);
              didApply = true; applied += 1; appliedQty = target;
            }
          }
          if (dec.save_rack && it.rack_scanned) {
            await c.query(`UPDATE products SET rack_location=$1, updated_by=$2 WHERE id=$3`, [it.rack_scanned, uid, it.product_id]);
            didRack = true; rackSaved += 1;
          }
        } else {
          if (dec.apply) {
            const cur = num((await c.query(`SELECT stock_qty FROM promo_items WHERE id=$1 FOR UPDATE`, [it.promo_item_id])).rows[0].stock_qty);
            const target = round2(dec.final != null && dec.final >= 0 ? dec.final : it.counted_qty);
            if (target < 0) return { error: 'would_go_negative', code: it.code };
            const delta = round2(target - cur);
            if (delta !== 0) {
              await c.query(`UPDATE promo_items SET stock_qty=$1, updated_by=$2 WHERE id=$3`, [target, uid, it.promo_item_id]);
              didApply = true; applied += 1; appliedQty = target;
            }
          }
          if (dec.save_rack && it.rack_scanned) {
            await c.query(`UPDATE promo_items SET rack_location=$1, updated_by=$2 WHERE id=$3`, [it.rack_scanned, uid, it.promo_item_id]);
            didRack = true; rackSaved += 1;
          }
        }
        // 검토 이력 기록(반영/보류·코멘트·강제조정 수량 모두 감사 저장)
        await c.query(
          `INSERT INTO stock_count_adjustments
             (count_id, item_kind, product_id, promo_item_id, code, system_qty, counted_qty, delta,
              decision, comment, rack_scanned, rack_saved, applied, applied_qty, event_no, reviewed_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [id, it.kind, it.kind === 'part' ? it.product_id : null, it.kind === 'promo' ? it.promo_item_id : null,
           it.code, it.system_qty, it.counted_qty, it.delta,
           didApply ? 'apply' : 'skip', dec.comment || null, it.rack_scanned || null, didRack, didApply, appliedQty, eventNo, uid]);
      }
      await c.query(`UPDATE stock_counts SET status='reconciled', reconciled_at=now(), reconciled_by=$1, adjust_event_no=$2 WHERE id=$3`,
        [uid, eventNo, id]);
      return { ok: true, applied, rack_saved: rackSaved, reviewed: review.length, event_no: eventNo, code: sc.code };
    });
    if (result.error) {
      const codeMap = { not_found: 404, not_submitted: 409, would_go_negative: 400 };
      return reply.code(codeMap[result.error] || 400).send(result);
    }
    await logEvent({ userId: uid, action: 'update', target: `stock_count:${id}`, detail: { step: 'apply', applied: result.applied, rack_saved: result.rack_saved, event_no: result.event_no } });
    return result;
  });

  // 반영 내역(디렉터 검토 결과·코멘트) 조회
  app.get('/api/stock-counts/:id/adjustments', { preHandler: [authGuard, requirePage('warehouse')] }, async (req) => {
    const id = Number(req.params.id);
    const rows = (await query(
      `SELECT a.*, COALESCE(p.name, pi.name) AS item_name, u.name AS reviewer
         FROM stock_count_adjustments a
         LEFT JOIN products p ON p.id = a.product_id
         LEFT JOIN promo_items pi ON pi.id = a.promo_item_id
         LEFT JOIN users u ON u.id = a.reviewed_by
        WHERE a.count_id = $1 ORDER BY a.id`, [id])).rows;
    return {
      items: rows.map((a) => ({
        code: a.code, name: a.item_name || '', kind: a.item_kind,
        system_qty: num(a.system_qty), counted_qty: num(a.counted_qty), delta: num(a.delta),
        applied_qty: a.applied_qty != null ? num(a.applied_qty) : null,
        decision: a.decision, applied: !!a.applied, comment: a.comment || '',
        rack_scanned: a.rack_scanned || '', rack_saved: !!a.rack_saved,
        reviewer: a.reviewer || '', reviewed_at: a.reviewed_at,
      })),
    };
  });

  // ================= 프로모션 품목 마스터 =================
  app.get('/api/promo-items', { preHandler: [authGuard, requirePage('warehouse')] }, async (req) => {
    const includeInactive = String(req.query.all || '') === '1';
    const rows = (await query(
      `SELECT * FROM promo_items WHERE deleted_at IS NULL ${includeInactive ? '' : 'AND active=TRUE'} ORDER BY code`, [])).rows;
    return {
      items: rows.map((r) => ({
        id: Number(r.id), code: r.code, name: r.name, barcode: r.barcode || '',
        rack_location: r.rack_location || '', stock_qty: num(r.stock_qty), unit_cost: num(r.unit_cost),
        active: !!r.active, note: r.note || '',
      })),
    };
  });

  app.post('/api/promo-items', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const b = req.body || {};
    const code = String(b.code || '').trim().toUpperCase();
    const name = String(b.name || '').trim();
    if (!code || !name) return reply.code(400).send({ error: 'code_and_name_required' });
    const dup = (await query(`SELECT id FROM promo_items WHERE UPPER(code)=$1 AND deleted_at IS NULL`, [code])).rows[0];
    if (dup) return reply.code(409).send({ error: 'duplicate_code' });
    const row = (await query(
      `INSERT INTO promo_items (code, name, barcode, rack_location, stock_qty, unit_cost, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [code, name, String(b.barcode || '').trim() || null, String(b.rack_location || '').trim() || null,
       Number(b.stock_qty) || 0, Number(b.unit_cost) || 0, String(b.note || '').trim() || null, req.ctx.perm.userId])).rows[0];
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `promo_item:${row.id}`, detail: { code } });
    return { id: Number(row.id) };
  });

  app.patch('/api/promo-items/:id', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const sets = []; const args = [];
    const add = (col, val) => { args.push(val); sets.push(`${col}=$${args.length}`); };
    if (b.name != null) add('name', String(b.name).trim());
    if (b.barcode != null) add('barcode', String(b.barcode).trim() || null);
    if (b.rack_location != null) add('rack_location', String(b.rack_location).trim() || null);
    if (b.stock_qty != null) { const q = Number(b.stock_qty); if (!isFinite(q) || q < 0) return reply.code(400).send({ error: 'bad_qty' }); add('stock_qty', q); }
    if (b.unit_cost != null) add('unit_cost', Number(b.unit_cost) || 0);
    if (b.note != null) add('note', String(b.note).trim() || null);
    if (b.active != null) add('active', !!b.active);
    if (!sets.length) return { ok: true };
    args.push(req.ctx.perm.userId); sets.push(`updated_by=$${args.length}`);
    args.push(id);
    const r = (await query(`UPDATE promo_items SET ${sets.join(', ')} WHERE id=$${args.length} AND deleted_at IS NULL RETURNING id`, args)).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `promo_item:${id}`, detail: {} });
    return { ok: true };
  });

  app.delete('/api/promo-items/:id', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const r = (await query(`UPDATE promo_items SET deleted_at=now(), updated_by=$1 WHERE id=$2 AND deleted_at IS NULL RETURNING id`, [req.ctx.perm.userId, id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `promo_item:${id}`, detail: {} });
    return { ok: true };
  });
}
