// =====================================================================
// Offer Sheet(재입고 오퍼) API
//   부족분으로 남았던 제품이 입고되면 고객별로 생성되는 오퍼 시트의
//   목록/상세/수동 생성/발송 기록/취소/비활성화.
//   권한: 조회 = shortage·sales 열람, 생성·발송·취소 = shortage·sales 편집,
//        비활성화·활성화 = 디렉터 또는 Maria (0183).
//
//   ⚠️ 취소(cancel)와 비활성화(disable)는 서로 다른 동작이다:
//     · 취소   — 이 시트는 무효. 담긴 부족분은 다음 스캔에서 **다시 오퍼 대상**이 된다.
//     · 비활성 — 이 오퍼는 그만한다. 담긴 부족분·견적라인은 **다시 오퍼되지 않는다**.
//               부족 기록 자체는 그대로 남는다(발주 근거). [활성화]로 되돌릴 수 있다.
// =====================================================================
import { query, withTx } from '../db.js';
import { authGuard, requirePageAny, requirePageEditAny } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { generateOfferSheets } from '../offerSheets.js';
import { waApiReady, normalizeWaNumber, sendWaTo } from '../waSend.js';

// 비활성화·활성화 실행 권한: 디렉터 또는 Maria (고객관리 Constancia 알림과 같은 판정 방식).
function canDisableOffer(perm) {
  if (!perm) return false;
  if (perm.role === 'director') return true;
  return String(perm.name || '').trim().toLowerCase().startsWith('maria');
}

export default async function offerSheetRoutes(app) {
  // ---- 목록 ----
  // GET /api/offersheets?status=ready|sent|cancelled|all (기본 all, cancelled 제외 아님 — 프런트 필터)
  app.get('/api/offersheets', { preHandler: [authGuard, requirePageAny(['shortage', 'sales'])] }, async (req) => {
    const status = String(req.query.status || 'all');
    const rows = (await query(
      `SELECT os.id, os.offer_no, os.status, os.origin, os.import_batch_id,
              os.subtotal_mxn, os.iva_mxn, os.total_mxn,
              os.created_at, os.sent_at, os.sent_channel,
              os.wa_sent_at, os.wa_status, os.wa_error, os.wa_to,
              os.disabled_at, os.disabled_note, ud.name AS disabled_by_name,
              c.id AS customer_id, c.code AS customer_code, c.name AS customer_name,
              COALESCE(NULLIF(TRIM(c.buyer_phone),''), c.phone) AS customer_phone,
              c.buyer_name, (NULLIF(TRIM(c.buyer_phone),'') IS NOT NULL) AS phone_is_buyer,
              us.name AS sent_by_name,
              (SELECT COUNT(*)             FROM offer_sheet_items oi WHERE oi.offer_sheet_id = os.id) AS item_count,
              (SELECT COALESCE(SUM(oi.offer_qty),0) FROM offer_sheet_items oi WHERE oi.offer_sheet_id = os.id) AS total_qty,
              (SELECT COUNT(*) FROM offer_sheet_replies rr WHERE rr.offer_sheet_id = os.id) AS reply_count,
              lr.reply_type AS last_reply_type, lr.created_at AS last_reply_at,
              LEFT(COALESCE(lr.note,''), 120) AS last_reply_note
         FROM offer_sheets os
         JOIN customers c ON c.id = os.customer_id
         LEFT JOIN users us ON us.id = os.sent_by
         LEFT JOIN users ud ON ud.id = os.disabled_by
         LEFT JOIN LATERAL (
           SELECT r2.reply_type, r2.created_at, r2.note
             FROM offer_sheet_replies r2
            WHERE r2.offer_sheet_id = os.id AND r2.reply_type <> 'note'
            ORDER BY r2.created_at DESC, r2.id DESC LIMIT 1
         ) lr ON true
        WHERE os.deleted_at IS NULL
          AND ($1 = 'all'
               OR ($1 = 'disabled' AND os.disabled_at IS NOT NULL)
               OR ($1 = 'active'   AND os.disabled_at IS NULL)
               OR os.status = $1)
        ORDER BY os.created_at DESC, os.id DESC
        LIMIT 300`, [status])).rows;
    // 요약: 발송대기/발송 + 회신 현황(발송된 시트 기준 — 실질 회신(note 제외) 유무·주문 전환)
    //       비활성(중단) 시트는 진행 중인 일감이 아니므로 요약 수치에서 빼고 따로 센다.
    const summary = (await query(
      `SELECT COUNT(*) FILTER (WHERE os.status='ready' AND os.disabled_at IS NULL) AS ready,
              COUNT(*) FILTER (WHERE os.status='sent'  AND os.disabled_at IS NULL) AS sent,
              COUNT(*) FILTER (WHERE os.disabled_at IS NOT NULL) AS disabled,
              COUNT(*) FILTER (WHERE os.status='sent' AND os.disabled_at IS NULL AND lr.reply_type IS NOT NULL) AS replied,
              COUNT(*) FILTER (WHERE os.status='sent' AND os.disabled_at IS NULL AND lr.reply_type IS NULL) AS no_reply,
              COUNT(*) FILTER (WHERE os.status='sent' AND os.disabled_at IS NULL AND lr.reply_type IN ('ordered','partial')) AS ordered
         FROM offer_sheets os
         LEFT JOIN LATERAL (
           SELECT r2.reply_type FROM offer_sheet_replies r2
            WHERE r2.offer_sheet_id = os.id AND r2.reply_type <> 'note'
            ORDER BY r2.created_at DESC, r2.id DESC LIMIT 1
         ) lr ON true
        WHERE os.deleted_at IS NULL`)).rows[0];
    return {
      items: rows.map((r) => ({
        id: Number(r.id), offer_no: r.offer_no, status: r.status, origin: r.origin,
        import_batch_id: r.import_batch_id != null ? Number(r.import_batch_id) : null,
        subtotal_mxn: Number(r.subtotal_mxn), iva_mxn: Number(r.iva_mxn), total_mxn: Number(r.total_mxn),
        created_at: r.created_at, sent_at: r.sent_at, sent_channel: r.sent_channel, sent_by_name: r.sent_by_name,
        wa_sent_at: r.wa_sent_at || null, wa_status: r.wa_status || null, wa_error: r.wa_error || null, wa_to: r.wa_to || null,
        customer_id: Number(r.customer_id), customer_code: r.customer_code,
        customer_name: r.customer_name, customer_phone: r.customer_phone,
        buyer_name: r.buyer_name || null, phone_is_buyer: !!r.phone_is_buyer,
        item_count: Number(r.item_count), total_qty: Number(r.total_qty),
        reply_count: Number(r.reply_count) || 0,
        last_reply_type: r.last_reply_type || null,
        last_reply_at: r.last_reply_at || null,
        last_reply_note: r.last_reply_note || null,
        disabled: !!r.disabled_at, disabled_at: r.disabled_at || null,
        disabled_by_name: r.disabled_by_name || null, disabled_note: r.disabled_note || null,
      })),
      summary: {
        ready: Number(summary.ready) || 0, sent: Number(summary.sent) || 0,
        replied: Number(summary.replied) || 0, no_reply: Number(summary.no_reply) || 0,
        ordered: Number(summary.ordered) || 0, disabled: Number(summary.disabled) || 0,
      },
      // 화면에서 [🚫 비활성화]/[↩ 활성화] 버튼 노출 여부(디렉터·Maria)
      perm: { can_disable: canDisableOffer(req.ctx.perm) },
      wa: { api_ready: waApiReady(), template: process.env.OFFERSHEET_WA_TEMPLATE || process.env.WHATSAPP_TEMPLATE || null },
    };
  });

  // ---- 상세 (PDF·WhatsApp 문구 작성용 데이터 전부) ----
  app.get('/api/offersheets/:id', { preHandler: [authGuard, requirePageAny(['shortage', 'sales'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    const os = (await query(
      `SELECT os.*, c.code AS customer_code, c.name AS customer_name,
              COALESCE(NULLIF(TRIM(c.buyer_phone),''), c.phone) AS customer_phone,
              c.buyer_name, (NULLIF(TRIM(c.buyer_phone),'') IS NOT NULL) AS phone_is_buyer,
              c.contact AS customer_contact, c.rfc AS customer_rfc,
              us.name AS sent_by_name, ud.name AS disabled_by_name, ib.batch_no AS import_batch_no
         FROM offer_sheets os
         JOIN customers c ON c.id = os.customer_id
         LEFT JOIN users us ON us.id = os.sent_by
         LEFT JOIN users ud ON ud.id = os.disabled_by
         LEFT JOIN import_batches ib ON ib.id = os.import_batch_id
        WHERE os.id = $1 AND os.deleted_at IS NULL`, [id])).rows[0];
    if (!os) return reply.code(404).send({ error: 'not_found' });
    // 라인: 부족 기록 1건=1행이지만, 화면·PDF용으로 제품별 합산본도 함께 내려준다.
    const items = (await query(
      `SELECT oi.id, oi.shortage_id, oi.quote_id, oi.quote_line_id, oi.product_id, oi.offer_qty, oi.list_price, oi.discount_rate,
              oi.unit_price, oi.line_subtotal, oi.line_iva, oi.line_total, oi.occurred_at::text AS occurred_at,
              p.code AS ctr_code, p.scode AS syd_codes, p.name AS product_name, p.app AS app_text, p.stock_qty,
              qt.quote_no AS quote_no
         FROM offer_sheet_items oi
         JOIN products p ON p.id = oi.product_id
         LEFT JOIN quotes qt ON qt.id = oi.quote_id
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
          first_occurred: it.occurred_at, shortage_ids: [], sources: [],
        };
      }
      const g = grouped[k];
      g.offer_qty += Number(it.offer_qty);
      g.line_subtotal += Number(it.line_subtotal);
      g.line_iva += Number(it.line_iva);
      g.line_total += Number(it.line_total);
      if (it.occurred_at && (!g.first_occurred || it.occurred_at < g.first_occurred)) g.first_occurred = it.occurred_at;
      if (it.shortage_id != null) g.shortage_ids.push(Number(it.shortage_id));
      // 출처 라벨: 견적 라인(전환·만료 전) vs 부족 기록(전환확정·매출·만료)
      const src = it.quote_line_id != null ? ('견적' + (it.quote_no ? ' ' + it.quote_no : '')) : '부족기록';
      if (!g.sources.includes(src)) g.sources.push(src);
    }
    return {
      sheet: {
        id: Number(os.id), offer_no: os.offer_no, status: os.status, origin: os.origin,
        import_batch_id: os.import_batch_id != null ? Number(os.import_batch_id) : null,
        import_batch_no: os.import_batch_no,
        subtotal_mxn: Number(os.subtotal_mxn), iva_mxn: Number(os.iva_mxn), total_mxn: Number(os.total_mxn),
        created_at: os.created_at, sent_at: os.sent_at, sent_channel: os.sent_channel, sent_by_name: os.sent_by_name,
        wa_sent_at: os.wa_sent_at || null, wa_status: os.wa_status || null, wa_error: os.wa_error || null,
        wa_to: os.wa_to || null, wa_message_id: os.wa_message_id || null,
        note: os.note,
        customer_id: Number(os.customer_id), customer_code: os.customer_code, customer_name: os.customer_name,
        customer_phone: os.customer_phone, customer_contact: os.customer_contact, customer_rfc: os.customer_rfc,
        buyer_name: os.buyer_name || null, phone_is_buyer: !!os.phone_is_buyer,
        disabled: !!os.disabled_at, disabled_at: os.disabled_at || null,
        disabled_by_name: os.disabled_by_name || null, disabled_note: os.disabled_note || null,
      },
      perm: { can_disable: canDisableOffer(req.ctx.perm) },
      items: items.map((r) => ({
        ...r, product_id: Number(r.product_id),
        shortage_id: r.shortage_id != null ? Number(r.shortage_id) : null,
        quote_id: r.quote_id != null ? Number(r.quote_id) : null,
        quote_line_id: r.quote_line_id != null ? Number(r.quote_line_id) : null,
        offer_qty: Number(r.offer_qty), list_price: Number(r.list_price), discount_rate: Number(r.discount_rate),
        unit_price: Number(r.unit_price), line_subtotal: Number(r.line_subtotal),
        line_iva: Number(r.line_iva), line_total: Number(r.line_total), stock_qty: Number(r.stock_qty),
      })),
      lines: Object.values(grouped),
      // 고객 회신 원장(최신순) — 화면에서 타임라인으로 표시
      replies: (await query(
        `SELECT r.id, r.reply_type, r.note, r.created_at, u.name AS created_by_name
           FROM offer_sheet_replies r LEFT JOIN users u ON u.id=r.created_by
          WHERE r.offer_sheet_id=$1 ORDER BY r.created_at DESC, r.id DESC`, [id])).rows.map((r) => ({
        id: Number(r.id), reply_type: r.reply_type, note: r.note, created_at: r.created_at,
        created_by_name: r.created_by_name || null,
      })),
    };
  });

  // ---- 고객 회신 기록 추가 ----
  //   body: { reply_type: ordered|partial|considering|declined|no_answer|note, note? }
  //   ordered=주문함 / partial=일부 주문 / considering=검토중 / declined=거절 / no_answer=무응답 / note=단순 메모
  const REPLY_TYPES = ['ordered', 'partial', 'considering', 'declined', 'no_answer', 'note'];
  app.post('/api/offersheets/:id/replies', { preHandler: [authGuard, requirePageEditAny(['shortage', 'sales'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    const type = String(req.body?.reply_type || 'note');
    const note = String(req.body?.note || '').trim().slice(0, 2000) || null;
    if (!REPLY_TYPES.includes(type)) return reply.code(400).send({ error: 'bad_reply_type' });
    if (type === 'note' && !note) return reply.code(400).send({ error: 'note_required', note: '메모 유형은 내용이 필요합니다.' });
    const os = (await query(`SELECT id, status, disabled_at FROM offer_sheets WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!os) return reply.code(404).send({ error: 'not_found' });
    if (os.disabled_at) return reply.code(409).send({ error: 'disabled_sheet', note: '비활성(중단)된 오퍼시트입니다. 회신을 기록하려면 먼저 [↩ 활성화]하세요.' });
    const r = (await query(
      `INSERT INTO offer_sheet_replies (offer_sheet_id, reply_type, note, created_by)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at`, [id, type, note, req.ctx.perm.userId])).rows[0];
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `offer_sheet_reply:${r.id}`, detail: { sheet: id, reply_type: type } });
    return { ok: true, id: Number(r.id), created_at: r.created_at };
  });

  // ---- 회신 기록 삭제(디렉터 — 오기입 정정) ----
  app.delete('/api/offersheets/replies/:replyId', { preHandler: [authGuard, requirePageEditAny(['shortage', 'sales'])] }, async (req, reply) => {
    if (req.ctx.perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const rid = Number(req.params.replyId);
    const r = await query(`DELETE FROM offer_sheet_replies WHERE id=$1 RETURNING offer_sheet_id`, [rid]);
    if (!r.rows.length) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `offer_sheet_reply:${rid}`, detail: { sheet: Number(r.rows[0].offer_sheet_id) } });
    return { ok: true };
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

  // ---- WhatsApp API 자동발송 (버튼 한 번 → 고객 번호로 직접 발송 + 추적 기록) ----
  //   ① 텍스트(오퍼 문구 전체) → ② 실패 시 OFFERSHEET_WA_TEMPLATE(없으면 WHATSAPP_TEMPLATE)
  //      {{1}} 한 줄 헤드라인 폴백(고객이 24h 창 밖일 때).
  //   성공: status=sent + sent_*(기존 추적) + wa_*(API 원장) 기록. 재발송 허용(ready/sent).
  app.post('/api/offersheets/:id/wa-send', { preHandler: [authGuard, requirePageEditAny(['shortage', 'sales'])] }, async (req, reply) => {
    if (!waApiReady()) {
      return reply.code(503).send({ error: 'wa_not_configured', note: 'Railway 환경변수 WHATSAPP_TOKEN · WHATSAPP_PHONE_ID 를 설정해야 자동발송을 사용할 수 있습니다. (설정 가이드: 화면의 「자동발송 설정 방법」 참고)' });
    }
    const id = Number(req.params.id);
    const os = (await query(
      `SELECT os.*, c.name AS customer_name,
              COALESCE(NULLIF(TRIM(c.buyer_phone),''), c.phone) AS customer_phone,
              c.buyer_name, c.contact AS customer_contact
         FROM offer_sheets os JOIN customers c ON c.id = os.customer_id
        WHERE os.id = $1 AND os.deleted_at IS NULL`, [id])).rows[0];
    if (!os) return reply.code(404).send({ error: 'not_found' });
    if (os.status === 'cancelled') return reply.code(409).send({ error: 'cancelled_sheet' });
    if (os.disabled_at) return reply.code(409).send({ error: 'disabled_sheet', note: '비활성(중단)된 오퍼시트는 발송할 수 없습니다. 보내려면 먼저 [↩ 활성화]하세요.' });
    const to = normalizeWaNumber(req.body && req.body.to ? req.body.to : os.customer_phone);
    if (!to) return reply.code(400).send({ error: 'no_phone', note: '고객 전화번호가 없거나 형식이 올바르지 않습니다. 고객관리에서 번호를 확인하세요.' });

    // 제품별 합산 라인(상세와 동일 기준)
    const lines = (await query(
      `SELECT p.code AS ctr_code, p.name AS product_name, SUM(oi.offer_qty) AS qty,
              MAX(oi.unit_price) AS unit_price
         FROM offer_sheet_items oi JOIN products p ON p.id = oi.product_id
        WHERE oi.offer_sheet_id = $1
        GROUP BY p.code, p.name ORDER BY p.code`, [id])).rows;
    let emisor = 'CTR';
    try { emisor = (await query(`SELECT emisor FROM company_settings WHERE id=1`)).rows[0]?.emisor || 'CTR'; } catch (_) {}
    const fmtm = (n) => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const itemsTxt = lines.map((l) => `• ${l.ctr_code || ''} — ${l.product_name || ''} × ${Number(l.qty) || 0}  (${fmtm(l.unit_price)} c/u)`).join('\n');
    const greetName = os.buyer_name || os.customer_contact; // 구매결정권자 이름 우선
    const text = `Hola${greetName ? ' ' + greetName : ''}, le saludamos de parte de ${emisor}. 🎉\n\n`
      + `¡Buenas noticias! Los productos que solicitó y que estaban agotados YA ESTÁN DISPONIBLES en nuestro almacén:\n\n`
      + itemsTxt
      + `\n\nSubtotal: ${fmtm(os.subtotal_mxn)} · IVA: ${fmtm(os.iva_mxn)} · *Total: ${fmtm(os.total_mxn)} MXN*`
      + `\n\nOferta ${os.offer_no || ''} — sujeto a existencia disponible. ¡Le recomendamos confirmar su pedido pronto, gracias!`;
    const headline = `${emisor}: ${lines.length} producto(s) que solicitó ya están disponibles. Oferta ${os.offer_no || ''}, total ${fmtm(os.total_mxn)} MXN. Responda este mensaje para recibir el detalle.`;

    const res = await sendWaTo({ to, text, headline, templateName: process.env.OFFERSHEET_WA_TEMPLATE || null });
    if (res.ok) {
      await query(
        `UPDATE offer_sheets
            SET status = CASE WHEN status='ready' THEN 'sent' ELSE status END,
                sent_at = COALESCE(sent_at, now()), sent_by = COALESCE(sent_by, $2), sent_channel = 'whatsapp_api',
                wa_sent_at = now(), wa_status = $3, wa_error = NULL, wa_to = $4, wa_message_id = $5, updated_at = now()
          WHERE id = $1`, [id, req.ctx.perm.userId, 'sent_' + res.mode, to, res.message_id || null]);
      await logEvent({ userId: req.ctx.perm.userId, action: 'export', target: `offer_sheet:${id}`, detail: { wa_send: true, mode: res.mode, to: to.slice(0, 3) + '****' } });
      return { ok: true, mode: res.mode, to_masked: to.slice(0, 3) + '****' + to.slice(-4), status: os.status === 'ready' ? 'sent' : os.status };
    }
    await query(
      `UPDATE offer_sheets SET wa_status='failed', wa_error=$2, wa_to=$3, updated_at=now() WHERE id=$1`,
      [id, String(res.error || '').slice(0, 400), to]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'export', target: `offer_sheet:${id}`, detail: { wa_send: false, error: String(res.error || '').slice(0, 120) }, result: 'denied' });
    return reply.code(502).send({ error: 'send_failed', detail: res.error });
  });

  // ---- 발송 완료 기록 (수동 — WhatsApp 으로 보낸 뒤 확인 처리) ----
  app.post('/api/offersheets/:id/mark-sent', { preHandler: [authGuard, requirePageEditAny(['shortage', 'sales'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    const channel = String(req.body?.channel || 'whatsapp').slice(0, 30);
    const r = await query(
      `UPDATE offer_sheets SET status='sent', sent_at=now(), sent_by=$1, sent_channel=$2
        WHERE id=$3 AND status='ready' AND deleted_at IS NULL AND disabled_at IS NULL RETURNING id`,
      [req.ctx.perm.userId, channel, id]);
    if (!r.rows[0]) return reply.code(409).send({ error: 'not_ready', note: '발송 대기(ready)이면서 활성 상태인 시트만 발송 처리할 수 있습니다.' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `offer_sheet:${id}`, detail: { sent: true, channel } });
    return { ok: true, status: 'sent' };
  });

  // ---- 취소 (시트에 담긴 부족분은 다음 스캔에서 재생성 대상으로 복귀) ----
  app.post('/api/offersheets/:id/cancel', { preHandler: [authGuard, requirePageEditAny(['shortage', 'sales'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    const r = await query(
      `UPDATE offer_sheets SET status='cancelled'
        WHERE id=$1 AND status IN ('ready','sent') AND deleted_at IS NULL AND disabled_at IS NULL RETURNING id, status`,
      [id]);
    if (!r.rows[0]) return reply.code(409).send({ error: 'not_cancellable' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `offer_sheet:${id}`, detail: { cancelled: true } });
    return { ok: true, status: 'cancelled' };
  });

  // ---- 비활성화 (오퍼 중단 — 이 시트의 부족분은 다시 오퍼되지 않음) ----
  //   · 부족 기록(stock_shortages)은 손대지 않는다 — 발주 근거로 그대로 남는다.
  //   · 취소와 달리 재생성 대상으로 복귀하지 않는다(취소된 시트도 비활성화 가능).
  //   · 권한: 디렉터 또는 Maria.
  app.post('/api/offersheets/:id/disable', { preHandler: [authGuard, requirePageEditAny(['shortage', 'sales'])] }, async (req, reply) => {
    if (!canDisableOffer(req.ctx.perm)) {
      return reply.code(403).send({ error: 'not_allowed', note: '오퍼 비활성화는 디렉터 또는 Maria 만 할 수 있습니다.' });
    }
    const id = Number(req.params.id);
    const note = String(req.body?.note || '').trim().slice(0, 500) || null;
    const r = await query(
      `UPDATE offer_sheets SET disabled_at=now(), disabled_by=$2, disabled_note=$3
        WHERE id=$1 AND deleted_at IS NULL AND disabled_at IS NULL RETURNING id, status`,
      [id, req.ctx.perm.userId, note]);
    if (!r.rows[0]) return reply.code(409).send({ error: 'not_disableable', note: '이미 비활성 상태이거나 없는 시트입니다.' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `offer_sheet:${id}`, detail: { disabled: true, note } });
    return { ok: true, disabled: true, status: r.rows[0].status };
  });

  // ---- 활성화 (비활성 해제 — 원래 상태(ready/sent/cancelled) 그대로 복귀) ----
  app.post('/api/offersheets/:id/enable', { preHandler: [authGuard, requirePageEditAny(['shortage', 'sales'])] }, async (req, reply) => {
    if (!canDisableOffer(req.ctx.perm)) {
      return reply.code(403).send({ error: 'not_allowed', note: '오퍼 활성화는 디렉터 또는 Maria 만 할 수 있습니다.' });
    }
    const id = Number(req.params.id);
    const r = await query(
      `UPDATE offer_sheets SET disabled_at=NULL, disabled_by=NULL, disabled_note=NULL
        WHERE id=$1 AND deleted_at IS NULL AND disabled_at IS NOT NULL RETURNING id, status`,
      [id]);
    if (!r.rows[0]) return reply.code(409).send({ error: 'not_disabled', note: '비활성 상태의 시트만 활성화할 수 있습니다.' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `offer_sheet:${id}`, detail: { disabled: false } });
    return { ok: true, disabled: false, status: r.rows[0].status };
  });
}
