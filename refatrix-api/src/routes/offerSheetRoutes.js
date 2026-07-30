// =====================================================================
// Offer Sheet(재입고 오퍼) API
//   부족분으로 남았던 제품이 입고되면 고객별로 생성되는 오퍼 시트의
//   목록/상세/수동 생성/발송 기록/취소.
//   권한: 조회 = shortage·sales 열람, 생성·발송·취소 = shortage·sales 편집.
// =====================================================================
import { query, withTx } from '../db.js';
import { authGuard, requirePageAny, requirePageEditAny } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { generateOfferSheets } from '../offerSheets.js';

export default async function offerSheetRoutes(app) {
  // ---- 목록 ----
  // GET /api/offersheets?status=ready|sent|cancelled|all (기본 all, cancelled 제외 아님 — 프런트 필터)
  app.get('/api/offersheets', { preHandler: [authGuard, requirePageAny(['shortage', 'sales'])] }, async (req) => {
    const status = String(req.query.status || 'all');
    const rows = (await query(
      `SELECT os.id, os.offer_no, os.status, os.origin, os.import_batch_id,
              os.subtotal_mxn, os.iva_mxn, os.total_mxn,
              os.created_at, os.sent_at, os.sent_channel,
              c.id AS customer_id, c.code AS customer_code, c.name AS customer_name, c.phone AS customer_phone,
              us.name AS sent_by_name,
              (SELECT COUNT(*)             FROM offer_sheet_items oi WHERE oi.offer_sheet_id = os.id) AS item_count,
              (SELECT COALESCE(SUM(oi.offer_qty),0) FROM offer_sheet_items oi WHERE oi.offer_sheet_id = os.id) AS total_qty
         FROM offer_sheets os
         JOIN customers c ON c.id = os.customer_id
         LEFT JOIN users us ON us.id = os.sent_by
        WHERE os.deleted_at IS NULL
          AND ($1 = 'all' OR os.status = $1)
        ORDER BY os.created_at DESC, os.id DESC
        LIMIT 300`, [status])).rows;
    const summary = (await query(
      `SELECT COUNT(*) FILTER (WHERE status='ready') AS ready,
              COUNT(*) FILTER (WHERE status='sent')  AS sent
         FROM offer_sheets WHERE deleted_at IS NULL`)).rows[0];
    return {
      items: rows.map((r) => ({
        id: Number(r.id), offer_no: r.offer_no, status: r.status, origin: r.origin,
        import_batch_id: r.import_batch_id != null ? Number(r.import_batch_id) : null,
        subtotal_mxn: Number(r.subtotal_mxn), iva_mxn: Number(r.iva_mxn), total_mxn: Number(r.total_mxn),
        created_at: r.created_at, sent_at: r.sent_at, sent_channel: r.sent_channel, sent_by_name: r.sent_by_name,
        customer_id: Number(r.customer_id), customer_code: r.customer_code,
        customer_name: r.customer_name, customer_phone: r.customer_phone,
        item_count: Number(r.item_count), total_qty: Number(r.total_qty),
      })),
      summary: { ready: Number(summary.ready) || 0, sent: Number(summary.sent) || 0 },
    };
  });

  // ---- 상세 (PDF·WhatsApp 문구 작성용 데이터 전부) ----
  app.get('/api/offersheets/:id', { preHandler: [authGuard, requirePageAny(['shortage', 'sales'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    const os = (await query(
      `SELECT os.*, c.code AS customer_code, c.name AS customer_name, c.phone AS customer_phone,
              c.contact AS customer_contact, c.rfc AS customer_rfc,
              us.name AS sent_by_name, ib.batch_no AS import_batch_no
         FROM offer_sheets os
         JOIN customers c ON c.id = os.customer_id
         LEFT JOIN users us ON us.id = os.sent_by
         LEFT JOIN import_batches ib ON ib.id = os.import_batch_id
        WHERE os.id = $1 AND os.deleted_at IS NULL`, [id])).rows[0];
    if (!os) return reply.code(404).send({ error: 'not_found' });
    // 라인: 부족 기록 1건=1행이지만, 화면·PDF용으로 제품별 합산본도 함께 내려준다.
    const items = (await query(
      `SELECT oi.id, oi.shortage_id, oi.product_id, oi.offer_qty, oi.list_price, oi.discount_rate,
              oi.unit_price, oi.line_subtotal, oi.line_iva, oi.line_total, oi.occurred_at::text AS occurred_at,
              p.code AS ctr_code, p.scode AS syd_codes, p.name AS product_name, p.app AS app_text, p.stock_qty
         FROM offer_sheet_items oi
         JOIN products p ON p.id = oi.product_id
        WHERE oi.offer_sheet_id = $1
        ORDER BY p.code, oi.occurred_at, oi.id`, [id])).rows;
    const grouped = {};
    for (const it of items) {
      const k = Number(it.product_id);
      if (!grouped[k]) {
        grouped[k] = {
          product_id: k, ctr_code: it.ctr_code, syd_codes: it.syd_codes, product_name: it.product_name,
          app_text: it.app_text, stock_qty: Number(it.stock_qty),
          offer_qty: 0, list_price: Number(it.list_price), discount_rate: Number(it.discount_rate),
          unit_price: Number(it.unit_price), line_subtotal: 0, line_iva: 0, line_total: 0,
          first_occurred: it.occurred_at, shortage_ids: [],
        };
      }
      const g = grouped[k];
      g.offer_qty += Number(it.offer_qty);
      g.line_subtotal += Number(it.line_subtotal);
      g.line_iva += Number(it.line_iva);
      g.line_total += Number(it.line_total);
      if (it.occurred_at && (!g.first_occurred || it.occurred_at < g.first_occurred)) g.first_occurred = it.occurred_at;
      g.shortage_ids.push(Number(it.shortage_id));
    }
    return {
      sheet: {
        id: Number(os.id), offer_no: os.offer_no, status: os.status, origin: os.origin,
        import_batch_id: os.import_batch_id != null ? Number(os.import_batch_id) : null,
        import_batch_no: os.import_batch_no,
        subtotal_mxn: Number(os.subtotal_mxn), iva_mxn: Number(os.iva_mxn), total_mxn: Number(os.total_mxn),
        created_at: os.created_at, sent_at: os.sent_at, sent_channel: os.sent_channel, sent_by_name: os.sent_by_name,
        note: os.note,
        customer_id: Number(os.customer_id), customer_code: os.customer_code, customer_name: os.customer_name,
        customer_phone: os.customer_phone, customer_contact: os.customer_contact, customer_rfc: os.customer_rfc,
      },
      items: items.map((r) => ({
        ...r, product_id: Number(r.product_id), shortage_id: Number(r.shortage_id),
        offer_qty: Number(r.offer_qty), list_price: Number(r.list_price), discount_rate: Number(r.discount_rate),
        unit_price: Number(r.unit_price), line_subtotal: Number(r.line_subtotal),
        line_iva: Number(r.line_iva), line_total: Number(r.line_total), stock_qty: Number(r.stock_qty),
      })),
      lines: Object.values(grouped),
    };
  });

  // ---- 수동 스캔·생성 ----
  // 전체 미해소 부족분 중 "지금 재고 있는" SKU를 스캔해 고객별 시트 생성.
  // (입고 승인 훅이 놓친 경우·재고이동으로 입고된 경우·취소 후 재생성용)
  app.post('/api/offersheets/generate', { preHandler: [authGuard, requirePageEditAny(['shortage', 'sales'])] }, async (req) => {
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => generateOfferSheets(c.query.bind(c), { origin: 'manual', userId }));
    if (out.sheets > 0) {
      await logEvent({ userId, action: 'create', target: 'offer_sheets', detail: { manual: true, sheets: out.sheets, items: out.items } });
    }
    return { ok: true, ...out };
  });

  // ---- 발송 완료 기록 (수동 — WhatsApp 으로 보낸 뒤 확인 처리) ----
  app.post('/api/offersheets/:id/mark-sent', { preHandler: [authGuard, requirePageEditAny(['shortage', 'sales'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    const channel = String(req.body?.channel || 'whatsapp').slice(0, 30);
    const r = await query(
      `UPDATE offer_sheets SET status='sent', sent_at=now(), sent_by=$1, sent_channel=$2
        WHERE id=$3 AND status='ready' AND deleted_at IS NULL RETURNING id`,
      [req.ctx.perm.userId, channel, id]);
    if (!r.rows[0]) return reply.code(409).send({ error: 'not_ready', note: '발송 대기(ready) 상태의 시트만 발송 처리할 수 있습니다.' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `offer_sheet:${id}`, detail: { sent: true, channel } });
    return { ok: true, status: 'sent' };
  });

  // ---- 취소 (시트에 담긴 부족분은 다음 스캔에서 재생성 대상으로 복귀) ----
  app.post('/api/offersheets/:id/cancel', { preHandler: [authGuard, requirePageEditAny(['shortage', 'sales'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    const r = await query(
      `UPDATE offer_sheets SET status='cancelled' WHERE id=$1 AND status IN ('ready','sent') AND deleted_at IS NULL RETURNING id, status`,
      [id]);
    if (!r.rows[0]) return reply.code(409).send({ error: 'not_cancellable' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `offer_sheet:${id}`, detail: { cancelled: true } });
    return { ok: true, status: 'cancelled' };
  });
}
