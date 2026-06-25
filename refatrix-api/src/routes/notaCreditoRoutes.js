import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { validateReceiptDataUrl } from '../ar.js';

const IVA = 0.16;
function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
// 총액(IVA 포함)에서 base/iva 분리
function splitIva(total) {
  const t = r2(total);
  const base = r2(t / (1 + IVA));
  return { total: t, base, iva: r2(t - base) };
}
// 인보이스 미수 잔액(IVA 포함 MXN) — 모든 배분(현금+NC) 차감
async function outstandingOf(c, invoiceId) {
  const r = (await c.query(
    `SELECT s.total_mxn - COALESCE(pa.paid,0) AS outstanding, s.customer_id, s.deleted_at, s.status
       FROM sales_invoices s
       LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations
                   WHERE invoice_id=$1 GROUP BY invoice_id) pa ON pa.invoice_id=s.id
      WHERE s.id=$1`, [invoiceId])).rows[0];
  if (!r) return null;
  return { outstanding: r2(Number(r.outstanding)), customer_id: Number(r.customer_id),
           deleted: !!r.deleted_at, posted: r.status === 'posted' };
}

export default async function notaCreditoRoutes(app) {
  // ── 목록 (NC 전용 화면 + 분류 조회) ──────────────────────────────
  // status=draft|approved|applied|void|all(기본 all), invoice_id?, q?(고객/concepto/SAT)
  app.get('/api/nc', { preHandler: [authGuard, requirePage('settlement')] }, async (req) => {
    const q = req.query || {};
    const args = [];
    const where = [];
    if (q.status && q.status !== 'all') { args.push(String(q.status)); where.push(`n.status=$${args.length}`); }
    if (q.invoice_id) { args.push(Number(q.invoice_id)); where.push(`n.invoice_id=$${args.length}`); }
    if (q.q) { args.push('%' + String(q.q).trim() + '%'); where.push(`(c.name ILIKE $${args.length} OR n.concepto ILIKE $${args.length} OR s.sat_no ILIKE $${args.length})`); }
    const rows = (await query(
      `SELECT n.id, n.invoice_id, n.customer_id, n.concepto, n.rate_pct,
              n.total_mxn, n.base_mxn, n.iva_mxn, n.status, n.cfdi_uuid,
              n.created_at, n.approved_at, n.applied_at, n.voided_at,
              c.name AS customer_name, s.sat_no, s.total_mxn AS invoice_total,
              (SELECT id FROM nota_credito_docs d WHERE d.nc_id=n.id ORDER BY d.id DESC LIMIT 1) AS doc_id,
              cu.name AS created_by_name, au.name AS approved_by_name
         FROM notas_credito n
         JOIN customers c ON c.id=n.customer_id
         JOIN sales_invoices s ON s.id=n.invoice_id
         LEFT JOIN users cu ON cu.id=n.created_by
         LEFT JOIN users au ON au.id=n.approved_by
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT 500`, args)).rows;
    return { items: rows.map((r) => ({
      ...r,
      total_mxn: Number(r.total_mxn), base_mxn: Number(r.base_mxn), iva_mxn: Number(r.iva_mxn),
      rate_pct: r.rate_pct == null ? null : Number(r.rate_pct),
      invoice_total: Number(r.invoice_total),
      has_doc: !!r.doc_id,
    })) };
  });

  // ── 상세 ─────────────────────────────────────────────────────────
  app.get('/api/nc/:id', { preHandler: [authGuard, requirePage('settlement')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const r = (await query(
      `SELECT n.*, c.name AS customer_name, c.rfc AS customer_rfc,
              s.sat_no, s.inv_date, s.due_date, s.total_mxn AS invoice_total,
              (SELECT id FROM nota_credito_docs d WHERE d.nc_id=n.id ORDER BY d.id DESC LIMIT 1) AS doc_id
         FROM notas_credito n
         JOIN customers c ON c.id=n.customer_id
         JOIN sales_invoices s ON s.id=n.invoice_id
        WHERE n.id=$1`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    const os = await outstandingOf({ query }, Number(r.invoice_id));
    return {
      ...r,
      total_mxn: Number(r.total_mxn), base_mxn: Number(r.base_mxn), iva_mxn: Number(r.iva_mxn),
      rate_pct: r.rate_pct == null ? null : Number(r.rate_pct),
      invoice_total: Number(r.invoice_total),
      has_doc: !!r.doc_id,
      invoice_outstanding: os ? os.outstanding : null,
    };
  });

  // ── 발기(초안 생성) — 오픈 인보이스에서 ────────────────────────────
  // body: { invoice_id, concepto, rate_pct? , total_mxn? }  (rate 또는 total 중 하나)
  app.post('/api/nc', { preHandler: [authGuard, requirePage('settlement')] }, async (req, reply) => {
    const b = req.body || {};
    const invoiceId = Number(b.invoice_id);
    const concepto = String(b.concepto || '').trim();
    if (!invoiceId || !concepto) return reply.code(400).send({ error: 'missing_fields' });
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const inv = (await c.query(
        `SELECT id, customer_id, total_mxn, deleted_at, status FROM sales_invoices WHERE id=$1`, [invoiceId])).rows[0];
      if (!inv || inv.deleted_at || inv.status !== 'posted') return { error: 'invalid_invoice' };
      const os = await outstandingOf(c, invoiceId);
      // 금액 결정: total 직접입력 우선, 없으면 rate_pct × 인보이스 총액(IVA 포함)
      let rate = (b.rate_pct == null || b.rate_pct === '') ? null : Number(b.rate_pct);
      let total;
      if (b.total_mxn != null && b.total_mxn !== '') {
        total = r2(b.total_mxn);
      } else if (rate != null && rate > 0) {
        total = r2(Number(inv.total_mxn) * rate / 100);
      } else {
        return { error: 'need_rate_or_total' };
      }
      if (!(total > 0)) return { error: 'bad_amount' };
      // 잔액 캡: NC 금액은 현재 미수 잔액을 넘을 수 없음
      if (total > os.outstanding + 0.01) return { error: 'exceeds_outstanding', outstanding: os.outstanding };
      const s = splitIva(total);
      const row = (await c.query(
        `INSERT INTO notas_credito (invoice_id, customer_id, concepto, rate_pct, total_mxn, base_mxn, iva_mxn, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8) RETURNING id`,
        [invoiceId, inv.customer_id, concepto, rate, s.total, s.base, s.iva, userId])).rows[0];
      return { id: row.id, total: s.total, base: s.base, iva: s.iva };
    });
    if (out.error) return reply.code(out.error === 'exceeds_outstanding' ? 409 : 400).send(out);
    await logEvent({ userId, action: 'create', target: `nota_credito:${out.id}`, detail: { invoiceId, total: out.total } });
    return out;
  });

  // ── 서명 증빙 업로드 ──────────────────────────────────────────────
  app.post('/api/nc/:id/doc', { preHandler: [authGuard, requirePage('settlement')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    if (!b.doc) return reply.code(400).send({ error: 'missing_doc' });
    const rv = validateReceiptDataUrl(b.doc);   // image/* 또는 application/pdf 허용
    if (!rv.ok) return reply.code(400).send({ error: 'invalid_doc', detail: rv.error });
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const nc = (await c.query(`SELECT id, status FROM notas_credito WHERE id=$1`, [id])).rows[0];
      if (!nc) return { error: 'not_found' };
      if (nc.status === 'void') return { error: 'voided' };
      await c.query(
        `INSERT INTO nota_credito_docs (nc_id, file_name, mime_type, file_data, uploaded_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, b.doc_name || null, rv.mime, b.doc, userId]);
      return { id };
    });
    if (out.error) return reply.code(out.error === 'not_found' ? 404 : 400).send(out);
    await logEvent({ userId, action: 'upload', target: `nota_credito:${id}`, detail: { doc: true } });
    return { ok: true };
  });

  // 증빙 파일 보기
  app.get('/api/nc/:id/doc/file', { preHandler: [authGuard, requirePage('settlement')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const r = (await query(
      `SELECT file_data, mime_type, file_name FROM nota_credito_docs WHERE nc_id=$1 ORDER BY id DESC LIMIT 1`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'no_doc' });
    return { file_data: r.file_data, mime_type: r.mime_type, file_name: r.file_name };
  });

  // ── 승인 (디렉터 전용) — 서명 증빙이 있어야 승인 가능 ───────────────
  app.post('/api/nc/:id/approve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const nc = (await c.query(`SELECT id, status FROM notas_credito WHERE id=$1`, [id])).rows[0];
      if (!nc) return { error: 'not_found' };
      if (nc.status === 'applied') return { error: 'already_applied' };
      if (nc.status === 'void') return { error: 'voided' };
      const doc = (await c.query(`SELECT id FROM nota_credito_docs WHERE nc_id=$1 LIMIT 1`, [id])).rows[0];
      if (!doc) return { error: 'no_signed_doc' };
      await c.query(`UPDATE notas_credito SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1`, [id, userId]);
      return { id };
    });
    if (out.error) return reply.code(out.error === 'not_found' ? 404 : 409).send(out);
    await logEvent({ userId, action: 'approve', target: `nota_credito:${id}` });
    return { ok: true, status: 'approved' };
  });

  // ── 적용 (비현금 반제) — settlement 권한. 승인된 건만, 잔액 이내 ────
  app.post('/api/nc/:id/apply', { preHandler: [authGuard, requirePage('settlement')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const nc = (await c.query(`SELECT * FROM notas_credito WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!nc) return { error: 'not_found' };
      if (nc.status === 'applied') return { error: 'already_applied' };
      if (nc.status === 'void') return { error: 'voided' };
      if (nc.status !== 'approved') return { error: 'not_approved' };
      const os = await outstandingOf(c, Number(nc.invoice_id));
      const total = Number(nc.total_mxn);
      if (total > os.outstanding + 0.01) return { error: 'exceeds_outstanding', outstanding: os.outstanding };
      // 비현금 배분: payment_id NULL, txn_id NULL, kind='nota_credito' → 4010 거래 미생성
      await c.query(
        `INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount, txn_id, kind, nc_id)
         VALUES (NULL,$1,$2,NULL,'nota_credito',$3)`,
        [Number(nc.invoice_id), total, id]);
      await c.query(`UPDATE notas_credito SET status='applied', applied_at=now() WHERE id=$1`, [id]);
      const after = await outstandingOf(c, Number(nc.invoice_id));
      return { id, applied: total, invoice_outstanding: after.outstanding, paid_full: after.outstanding <= 0.005 };
    });
    if (out.error) return reply.code(out.error === 'not_found' ? 404 : 409).send(out);
    await logEvent({ userId, action: 'apply', target: `nota_credito:${id}`, detail: { applied: out.applied } });
    return out;
  });

  // ── 취소 (디렉터) — 적용된 NC면 배분 제거하여 인보이스 잔액 복원 ────
  app.post('/api/nc/:id/void', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const nc = (await c.query(`SELECT id, invoice_id, status FROM notas_credito WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!nc) return { error: 'not_found' };
      if (nc.status === 'void') return { error: 'already_void' };
      // 적용된 경우: 비현금 배분 제거 → 잔액 복원(완납이었으면 다시 미수로)
      await c.query(`DELETE FROM sales_payment_allocations WHERE nc_id=$1`, [id]);
      await c.query(`UPDATE notas_credito SET status='void', voided_by=$2, voided_at=now() WHERE id=$1`, [id, userId]);
      const after = await outstandingOf(c, Number(nc.invoice_id));
      return { id, invoice_outstanding: after.outstanding };
    });
    if (out.error) return reply.code(out.error === 'not_found' ? 404 : 409).send(out);
    await logEvent({ userId, action: 'void', target: `nota_credito:${id}` });
    return { ok: true, ...out };
  });

  // ── 완전 삭제 (디렉터) — 기록·증빙까지 제거. 적용된 NC면 배분 제거하여 잔액 복원 ──
  app.delete('/api/nc/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const nc = (await c.query(`SELECT id, invoice_id FROM notas_credito WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!nc) return { error: 'not_found' };
      // 적용된 비현금 배분 제거 → 인보이스 잔액 복원
      await c.query(`DELETE FROM sales_payment_allocations WHERE nc_id=$1`, [id]);
      // 증빙 문서(nota_credito_docs는 ON DELETE CASCADE) + NC 헤더 삭제
      await c.query(`DELETE FROM notas_credito WHERE id=$1`, [id]);
      const after = await outstandingOf(c, Number(nc.invoice_id));
      return { id, invoice_outstanding: after.outstanding };
    });
    if (out.error) return reply.code(404).send(out);
    await logEvent({ userId, action: 'delete', target: `nota_credito:${id}` });
    return { ok: true, ...out };
  });
}
