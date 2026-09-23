// 웹카달록 견적요청 — 수신 · 팝업 알림 · 담당자 지정 (0220)
//
//   왜 만들었나
//     CRM 은 여태 ERP **화면용 API**(`POST /api/quotes`)를 직원 계정으로 호출했다.
//     그 API 는 `customer_id` 숫자를 그대로 믿기 때문에, CRM 의 5번이 ERP 의 5번과 다른
//     회사라는 사실이 드러나는 순간 **남의 고객에 견적이 붙는다.** 실제로 그랬다(NAJAR).
//     게다가 거절되면 아무 기록도 안 남아서 「보냈는데 없다」를 추측으로만 다뤘다.
//
//   그래서 이 창구에서 바꾼 네 가지
//     1) 고객은 **RFC 또는 CRM 고객코드**로만 찾는다. 숫자 id 는 **읽지 않는다.**
//        (읽지 않는 것이 핵심이다 — 받아 두면 언젠가 쓰이고, 그날 같은 사고가 난다)
//     2) CRM 견적번호(COT-…)를 칼럼에 넣고 UNIQUE 로 **멱등**을 만든다.
//        메모 안에만 적어 두면 중복을 막을 수단이 아예 없다.
//     3) 못 찾은 코드·판매중단 SKU 가 있어도 **접수는 한다.** 고객의 요청을 버리지 않는다.
//        대신 그 줄에 이유를 적고 **견적 확정을 잠근다** — 0원짜리 줄이 붙은 견적이
//        고객에게 나가는 것이 더 나쁘다.
//     4) 수신 1건 = 이력 1행. **거절도 남는다.**
import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { getEndpoint, INBOUND_KEY_FALLBACK, maskSecret, activeToken } from '../integrations.js';
import { writeInboundLog } from '../crmInboundLog.js';
import { mapQuote, quoteDate, badQuoteLines, folioAsQuoteNo, readInboundKey, verifyInboundKey,
         scrubPayload, errBody, keyFailNote, keyFailMensaje } from '../crmInbound.js';
import { computeQuoteTotals } from '../quotes.js';
// ⚠ 화면과 **같은 조립기**를 쓴다. 두 벌로 두면 코드 해석 규칙이 갈라진다.
import { buildLines, nextQuoteNo, assignReservations, normalizePoNo, poColumnReady } from '../quoteBuild.js';
import { reserveExpiresAt } from '../quoteExpiry.js';
import { kickOrderStatus } from '../orderStatusSync.js';   // 0227 · 접수 즉시 CRM 에 「Solicitud nueva」
import { recordQuoteDevDemand } from '../quoteDevDemand.js';   // 2026-09-21 · 포털로 온 미등록 코드도 즉시 개발요청 대장에   // 2026-09-21 · 근무시간 밖 접수 → 다음 근무일 07:30 기산

export const QUOTE_KEY = 'crm_quote_request';

async function safeLog(args) { try { await logEvent(args); } catch (_) { /* ignore */ } }
async function writeLog(rec) { return writeInboundLog({ endpoint_key: QUOTE_KEY, ...rec }); }

// 0220 준비 여부 — 긍정만 영구 캐시, 없을 때만 30초마다 재확인.
//   (Railway 는 배포 뒤 사람이 콘솔에서 migrate 를 돌린다. 재시작 없이 인식돼야 한다)
let ready = false; let probe = 0;
async function quoteColsReady() {
  if (ready) return true;
  if (Date.now() - probe < 30000) return false;
  probe = Date.now();
  try {
    const r = await query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='quotes' AND column_name='external_quote_no' LIMIT 1`);
    ready = r.rows.length > 0;
  } catch (_) { ready = false; }
  return ready;
}

/**
 * 견적번호가 **포털 번호대로 들어갔는지** 한 줄로 말해 준다.
 *
 *   디렉터 지시: CRM 견적번호는 무조건 COT 로 오고, ERP 에도 그대로 들어가야 한다.
 *   그래서 **그렇게 되지 않은 경우를 조용히 넘기지 않는다** — 수신 이력과 응답 양쪽에 남긴다.
 *   번호가 갈린 줄 모르고 지내다가 고객이 전화했을 때 못 찾는 게 최악이다.
 */
function folioNote(folio, quoteNo) {
  if (!folio) {
    return 'No vino el folio del portal (cotizacionCrm): el ERP asignó ' + quoteNo
      + '. Los dos sistemas quedan con números distintos y no podemos evitar duplicados.';
  }
  if (String(folio) !== String(quoteNo)) {
    return 'El folio "' + String(folio).slice(0, 60) + '" no se puede usar como número de cotización '
      + '(espacios, largo o caracteres no permitidos): el ERP asignó ' + quoteNo
      + '. El folio original queda guardado.';
  }
  return null;
}

const ISSUE_ES = {
  not_found: 'No encontramos ese codigo en el catalogo del ERP',
  multi_match: 'Ese codigo SYD corresponde a varios productos — hay que elegir uno',
  inactive: 'Producto descontinuado (fuera de venta)',
};

/** 고객 찾기 — **RFC 우선, 없으면 CRM 고객코드.** 숫자 id 는 절대 쓰지 않는다. */
async function findCustomer(m) {
  const rfc = String(m.rfc || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (rfc) {
    const r = (await query(
      `SELECT id, code, name, discount, COALESCE(approval_status,'approved') AS approval_status
         FROM customers WHERE deleted_at IS NULL AND rfc_norm=$1 ORDER BY id LIMIT 1`, [rfc])).rows[0];
    if (r) return { ...r, matched_by: 'rfc' };
  }
  if (m.crmCustomerCode) {
    try {
      const r = (await query(
        `SELECT id, code, name, discount, COALESCE(approval_status,'approved') AS approval_status
           FROM customers WHERE deleted_at IS NULL AND crm_customer_code=$1 ORDER BY id LIMIT 1`,
        [m.crmCustomerCode])).rows[0];
      if (r) return { ...r, matched_by: 'crm_code' };
    } catch (_) { /* 0206 전이면 그 칼럼이 없다 — RFC 로만 찾는다 */ }
  }
  return null;
}

/** 지정할 수 있는 사람 — 고객에게 전화하고 견적을 마무리할 수 있는 역할만. */
async function assignableUsers() {
  try {
    return (await query(
      `SELECT id, name, role FROM users
        WHERE deleted_at IS NULL AND role IN ('sales','ops','marketing','director')
        ORDER BY (role='sales') DESC, name`)).rows
      .map((u) => ({ id: Number(u.id), name: u.name, role: u.role }));
  } catch (_) { return []; }
}

// 0225 · PO 칼럼은 마이그레이션 전이면 없다. 팝업·목록이 그것 때문에 죽으면 안 되므로
//   조회 시점에 한 번 물어보고 없으면 NULL 을 같은 이름으로 돌려준다(모양 불변).
const selectQ = (poReady) => `
  SELECT q.id, q.quote_no, q.external_quote_no, q.quote_date, q.memo, q.status,
         ${poReady ? 'q.customer_po_no' : 'NULL::text'} AS customer_po_no,
         q.total_mxn, q.total_qty, q.sku_count, q.created_at,
         q.assigned_to, q.assigned_at,
         u.name AS assigned_to_name, ab.name AS assigned_by_name,
         c.code AS customer_code, c.name AS customer_name,
         (SELECT count(*)::int FROM quote_lines ql WHERE ql.quote_id=q.id AND ql.issue IS NOT NULL) AS issue_count
    FROM quotes q
    LEFT JOIN users u  ON u.id = q.assigned_to
    LEFT JOIN users ab ON ab.id = q.assigned_by
    LEFT JOIN customers c ON c.id = q.customer_id`;

/**
 * 팝업·미처리 목록에 들어가는 건 = **아직 포장으로 넘어가지 않은** 수신 견적.
 *
 *   디렉터 지시(2026-09-17): 팝업은 **알림일 뿐**이다. 담당을 지정하는 절차가 붙어 있으면
 *   그 절차 때문에 일이 끊기고 CRM 과의 교신이 틀어진다. 견적은 어차피 자동 저장되므로
 *   사람이 팝업에서 할 일은 「들어온 걸 아는 것」뿐이다.
 *
 *   끝나는 시점은 **포장작업으로 넘어갈 때**로 잡는다. 확정(confirmed)만으로 끄면
 *   확정해 놓고 포장을 안 건 견적이 조용히 잊힌다 — 포장지시서가 나가면 그때는 확실히
 *   사람 손을 탄 것이다.
 */
const OPEN_WHERE = `q.origin='crm' AND q.deleted_at IS NULL
  AND q.status IN ('draft','confirmed')
  AND q.packing_printed_at IS NULL
  AND q.invoice_id IS NULL`;

function qRow(r) {
  return {
    id: Number(r.id), quote_no: r.quote_no, external_quote_no: r.external_quote_no || null,
    quote_date: r.quote_date, memo: r.memo || null, status: r.status,
    total_mxn: Number(r.total_mxn) || 0, total_qty: Number(r.total_qty) || 0,
    sku_count: Number(r.sku_count) || 0, created_at: r.created_at,
    customer_code: r.customer_code || null, customer_name: r.customer_name || null,
    assigned_to: r.assigned_to ? Number(r.assigned_to) : null,
    assigned_to_name: r.assigned_to_name || null, assigned_at: r.assigned_at || null,
    assigned_by_name: r.assigned_by_name || null,
    customer_po_no: r.customer_po_no || null,     // 0225 · 고객 PO(O.C.)
    issue_count: Number(r.issue_count) || 0,
  };
}

export default async function crmQuoteRoutes(app) {
  // ════════════════════════════════════════════════════════════════════
  //  ① 수신 (공개 — 자체 API 키)
  // ════════════════════════════════════════════════════════════════════
  app.post('/api/integrations/crm/quote', async (req, reply) => {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const raw = req.body || {};
    const safe = scrubPayload(raw);          // 이력에 우리 키가 남지 않게
    const { token, where } = readInboundKey(req);
    const base = { remote_ip: ip, auth_in: where, payload: safe };

    const ep = await getEndpoint(QUOTE_KEY);
    if (!ep) {
      const body = errBody('ERR_INTERNAL', 'Endpoint de cotizaciones no configurado en el ERP (falta migración 0220).');
      await writeLog({ ...base, auth_ok: false, http_status: 503, result: 'rejected',
        codigo_error: body.codigoError, mensaje: body.mensaje });
      return reply.code(503).send(body);
    }
    // 전용 키를 발급하지 않았으면 신규고객 등록 수신과 **같은 키**를 받아 준다.
    let v = verifyInboundKey(ep, token);
    let keyEp = ep;                     // 실제로 대조한 창구(진단에 쓴다)
    if (!v.ok && v.reason === 'no_key_configured') {
      const fb = INBOUND_KEY_FALLBACK[QUOTE_KEY];
      const regEp = fb ? await getEndpoint(fb) : null;
      if (regEp) { v = verifyInboundKey(regEp, token); keyEp = regEp; v.checkedFallback = true; }
    }
    if (!v.ok) {
      const body = errBody('ERR_API_KEY', v.reason === 'no_key_configured'
        ? 'El ERP aún no tiene una API key emitida para esta integración.'
        : keyFailMensaje(token));   // 인증 방식이 틀렸으면 그걸 짚어 준다(JWT 등)
      // ⚠ 이력에는 **무엇과 대조했는지**까지 남긴다. 「키가 틀렸다」만으로는
      //   「우리 전용 키와 다르다」인지 「상대 키 자체가 틀렸다」인지 알 수 없다.
      v.expectHint = maskSecret(activeToken(keyEp) || keyEp?.auth_token_prod || keyEp?.auth_token_test);
      await writeLog({ ...base, auth_ok: false, http_status: 401, result: 'rejected',
        codigo_error: body.codigoError,
        mensaje: keyFailNote(v, token, { ownLabel: ep.label || ep.key,
          fallbackLabel: keyEp === ep ? null : (keyEp.label || keyEp.key), mask: maskSecret }) });
      return reply.code(401).send(body);
    }
    if (ep.enabled === false) {
      const body = errBody('ERR_INTERNAL', 'La recepción de cotizaciones está deshabilitada temporalmente en el ERP.');
      await writeLog({ ...base, auth_ok: true, http_status: 503, result: 'rejected',
        codigo_error: body.codigoError, mensaje: body.mensaje });
      return reply.code(503).send(body);
    }
    if (!(await quoteColsReady())) {
      const body = errBody('ERR_INTERNAL', 'El ERP aún no aplicó la migración 0220. Reintentar más tarde.');
      await writeLog({ ...base, auth_ok: true, http_status: 503, result: 'rejected',
        codigo_error: body.codigoError, mensaje: body.mensaje });
      return reply.code(503).send(body);
    }

    const m = mapQuote(raw);
    const logBase = { ...base, auth_ok: true, rfc: m.rfc || null, crm_code: m.crmQuoteNo || null };

    // ── 멱등: 같은 COT 가 다시 오면 **기존 견적을 그대로 돌려준다.**
    //    고객이 버튼을 두 번 누르거나 CRM 이 재시도해도 견적이 둘 생기면 안 된다.
    const poReady = await poColumnReady();
    const poNo = normalizePoNo(m.ordenCompraCliente);
    if (m.crmQuoteNo) {
      const dup = (await query(
        // 0221 이후로는 포털 번호가 곧 견적번호이므로 두 칸 다 본다
        //   (0221 전에 들어온 건은 external_quote_no 에만 있다).
        `SELECT id, quote_no FROM quotes
          WHERE (external_quote_no=$1 OR quote_no=$1) AND deleted_at IS NULL LIMIT 1`,
        [m.crmQuoteNo])).rows[0];
      if (dup) {
        // 0225 · 재전송에 **PO번호만 새로 붙어 오는** 경우가 실제로 있다.
        //   고객이 웹에서 견적을 먼저 띄우고, PO 를 발행한 뒤 같은 화면에서 다시 보낸다.
        //   그래서 「비어 있을 때만 채운다」 — 견적은 여전히 하나이고(멱등), 사람이 ERP 에서
        //   직접 넣어 둔 번호는 웹이 덮어쓰지 못한다(현장 입력이 늘 더 정확했다).
        let poFilled = false;
        if (poReady && poNo) {
          const r = await query(
            `UPDATE quotes SET customer_po_no=$1, updated_at=now()
              WHERE id=$2 AND COALESCE(customer_po_no,'')='' RETURNING id`, [poNo, dup.id]);
          poFilled = r.rows.length > 0;
        }
        const extra = { cotizacionErp: dup.quote_no, quoteId: Number(dup.id), lineasConProblema: [] };
        if (poFilled) extra.ordenCompraCliente = poNo;
        const body = errBody('0',
          poFilled ? 'Cotización ya recibida anteriormente. Se registró la orden de compra del cliente.'
                   : 'Cotización ya recibida anteriormente.', extra);
        await writeLog({ ...logBase, http_status: 200, result: 'updated',
          erp_code: dup.quote_no, codigo_error: '0', mensaje: body.mensaje });
        return reply.code(200).send(body);
      }
    }

    // ── 고객: RFC(또는 CRM 코드)로 찾는다. 못 찾으면 **접수하지 않고 안내한다.**
    if (!m.rfc && !m.crmCustomerCode) {
      const body = errBody('ERR_REQUIRED_FIELD',
        'Falta el RFC del cliente. Identificamos al cliente por RFC (o por el código de cliente del CRM); no aceptamos identificadores numéricos.');
      await writeLog({ ...logBase, http_status: 400, result: 'rejected',
        codigo_error: body.codigoError, mensaje: body.mensaje });
      return reply.code(400).send(body);
    }
    const cust = await findCustomer(m);
    if (!cust) {
      const body = errBody('ERR_CUSTOMER_NOT_FOUND',
        `El cliente con RFC ${m.rfc || m.crmCustomerCode} no está dado de alta en el ERP. `
        + 'Primero hay que registrarlo y que la dirección lo apruebe; después se puede cotizar.');
      await writeLog({ ...logBase, http_status: 409, result: 'rejected',
        codigo_error: body.codigoError, mensaje: body.mensaje });
      return reply.code(409).send(body);
    }
    if (cust.approval_status === 'pending') {
      const body = errBody('ERR_CUSTOMER_NOT_APPROVED',
        `El cliente ${cust.name} está pendiente de aprobación por la dirección. En cuanto se apruebe podrá cotizar.`);
      await writeLog({ ...logBase, customer_id: Number(cust.id), erp_code: cust.code,
        http_status: 409, result: 'rejected', codigo_error: body.codigoError, mensaje: body.mensaje });
      return reply.code(409).send(body);
    }

    // ── 줄: 코드·수량이 형식부터 틀렸으면 상대가 고쳐야 한다(우리가 추측하지 않는다).
    if (!m.lines.length) {
      const body = errBody('ERR_REQUIRED_FIELD', 'La cotización no trae líneas (lineas: [{codigo, cantidad}]).');
      await writeLog({ ...logBase, customer_id: Number(cust.id), erp_code: cust.code,
        http_status: 400, result: 'rejected', codigo_error: body.codigoError, mensaje: body.mensaje });
      return reply.code(400).send(body);
    }
    const bad = badQuoteLines(m.lines);
    if (bad.length) {
      const body = errBody('ERR_LINE_INVALID',
        'Hay líneas sin código o con cantidad inválida.', { lineas: bad });
      await writeLog({ ...logBase, customer_id: Number(cust.id), erp_code: cust.code,
        http_status: 400, result: 'rejected', codigo_error: body.codigoError, mensaje: body.mensaje });
      return reply.code(400).send(body);
    }

    let numberNote = null;
    try {
      const discountRate = Number(cust.discount) || 0;
      const ivaRate = 16;
      const qdate = quoteDate(m.fecha);
      const memo = ['Portal Refatrix', m.crmQuoteNo, m.solicitante ? `· ${m.solicitante}` : null,
        m.comentario ? `· ${m.comentario}` : null].filter(Boolean).join(' ');

      const result = await withTx(async (c) => {
        const year = qdate ? qdate.slice(0, 4) : String(new Date().getFullYear());
        // 0221 · 웹에서 온 견적은 **포털 번호를 그대로 견적번호로 쓴다.**
        //   고객이 전화로 「COT-2026…」 이라고 말하면 그 번호로 바로 찾을 수 있어야 한다.
        //   번호가 두 개면 통화 중에 대조표를 열어야 하고, 그때 실수가 난다.
        //   번호를 못 쓰는 경우(모양이 이상하거나 아예 없음)에만 우리 번호로 되돌아간다.
        const quoteNo = folioAsQuoteNo(m.crmQuoteNo) || await nextQuoteNo(c, year);
        numberNote = folioNote(m.crmQuoteNo, quoteNo);
        const lines = await buildLines(discountRate, ivaRate, m.lines);
        const totals = computeQuoteTotals(lines.filter((l) => l.product_id)
          .map((l) => ({ lineSubtotal: l.line_subtotal, lineIva: l.line_iva, lineTotal: l.line_total, qty: l.qty })));
        const q = (await c.query(
          `INSERT INTO quotes (quote_no, customer_id, quote_date, discount_rate, iva_rate, memo, status,
                               subtotal_mxn, iva_mxn, total_mxn, total_qty, sku_count,
                               external_quote_no, origin, reserve_expires_at${poReady ? ', customer_po_no' : ''})
           VALUES ($1,$2,COALESCE($3::date,CURRENT_DATE),$4,$5,$6,'draft',$7,$8,$9,$10,$11,$12,'crm',
                   $${poReady ? 14 : 13}::timestamptz${poReady ? ', $13' : ''}) RETURNING id, quote_no`,
          (() => {
            const a = [quoteNo, cust.id, qdate, discountRate, ivaRate, memo,
              totals.subtotal, totals.iva, totals.total, totals.totalQty, totals.skuCount,
              m.crmQuoteNo || null];
            if (poReady) a.push(poNo);
            a.push(reserveExpiresAt(new Date()));   // 2026-09-21 · 근무시간 기산
            return a;
          })())).rows[0];
        for (const l of lines) {
          await c.query(
            `INSERT INTO quote_lines (quote_id, line_no, product_id, input_code, ctr_code, syd_codes,
                                      product_name, app_text, qty, list_price, discount_rate, final_price,
                                      line_subtotal, line_iva, line_total, avail_stock, stock_flag, issue)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
            [q.id, l.line_no, l.product_id, l.input_code, l.ctr_code, l.syd_codes, l.product_name,
             l.app_text, l.qty, l.list_price, l.discount_rate, l.final_price, l.line_subtotal,
             l.line_iva, l.line_total, l.avail_stock, l.stock_flag, l.issue || null]);
        }
        await assignReservations(c, q.id);
        // 2026-09-21 · 카탈로그에 없는 코드는 받는 즉시 개발요청 대장에 적는다(화면 견적과 같은 규칙).
        await recordQuoteDevDemand(c, q.id, { userId: null });
        return { q, lines };
      });

      // 상대에게 **어느 줄이 왜 문제인지** 스페인어로 돌려준다 — 고객에게 그대로 보여 줄 수 있게.
      const problems = result.lines.filter((l) => l.issue).map((l) => ({
        codigo: l.input_code, cantidad: l.qty, motivo: l.issue,
        detalle: ISSUE_ES[l.issue] || l.issue,
      }));

      await safeLog({ userId: null, action: 'create', target: `quote:${result.q.id}`,
        detail: { origin: 'crm_quote_request', external: m.crmQuoteNo, rfc: m.rfc, customer: cust.code } });

      const extra = { cotizacionErp: result.q.quote_no, quoteId: Number(result.q.id),
        lineasConProblema: problems };
      // 0225 · 받은 PO 를 **되돌려 준다.** 개발자가 「보냈는데 들어갔나」를 응답만으로 확인할 수 있게.
      if (poReady && poNo) extra.ordenCompraCliente = poNo;
      // 번호가 포털 것과 갈렸으면 **응답에도** 적는다 — 개발자가 바로 알아채야 한다.
      if (numberNote) extra.avisoFolio = numberNote;
      const body = errBody('0',
        problems.length
          ? 'Cotización recibida. Algunas líneas requieren revisión de un asesor.'
          : 'Cotización recibida.', extra);
      await writeLog({ ...logBase, customer_id: Number(cust.id), erp_code: result.q.quote_no,
        http_status: 200, result: 'created', codigo_error: '0',
        // 수신 이력에도 남긴다 — 디렉터가 화면에서 번호가 갈린 건을 찾을 수 있게.
        mensaje: numberNote ? `${body.mensaje} ⚠ ${numberNote}` : body.mensaje });
      // 0227 · 오더상태 (전송) — 응답을 돌려준 **뒤에** 「Solicitud nueva」 를 보낸다(기다리지 않는다).
      kickOrderStatus(result.q.id, { origin: 'crm_quote_created', app });
      return reply.code(200).send(body);
    } catch (e) {
      // 같은 번호가 **동시에** 두 번 들어오면 유니크 제약이 하나를 막는다.
      //   그건 오류가 아니라 멱등이 작동한 것이다 — 이미 있는 견적을 돌려준다.
      //   (위쪽 멱등 검사는 두 요청이 나란히 달릴 때 사이를 빠져나갈 수 있다)
      if (e && e.code === '23505' && m.crmQuoteNo) {
        const dup = (await query(
          `SELECT id, quote_no FROM quotes
            WHERE (external_quote_no=$1 OR quote_no=$1) AND deleted_at IS NULL LIMIT 1`,
          [m.crmQuoteNo])).rows[0];
        if (dup) {
          const body = errBody('0', 'Cotización ya recibida anteriormente.',
            { cotizacionErp: dup.quote_no, quoteId: Number(dup.id), lineasConProblema: [] });
          await writeLog({ ...logBase, customer_id: Number(cust.id), erp_code: dup.quote_no,
            http_status: 200, result: 'updated', codigo_error: '0', mensaje: body.mensaje });
          return reply.code(200).send(body);
        }
      }
      req.log?.error({ err: e }, 'crm quote inbound failed');
      const body = errBody('ERR_INTERNAL', 'Error interno del ERP. Reintentar más tarde.');
      await writeLog({ ...logBase, customer_id: Number(cust.id), erp_code: cust.code,
        http_status: 500, result: 'rejected', codigo_error: body.codigoError,
        mensaje: String(e.message || '').slice(0, 400) });
      return reply.code(500).send(body);
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  ② 팝업 알림 — 60초 폴링 (전 화면 공통 · refatrix-nav.js)
  // ════════════════════════════════════════════════════════════════════
  //   대상이 아닌 사람에게는 **빈 배열**을 준다(403 이 아니라).
  //
  //   ⚠ 여기에는 **담당 지정이 없다.** 팝업은 알림일 뿐이고, 견적은 이미 저장돼 있다.
  //     보는 사람은 「디렉터 + 알림 대상으로 지정된 사람」이고, 모두 **같은 목록**을 본다 —
  //     누가 처리할지는 사람들이 알아서 정한다. 시스템이 그걸 중재하려다 일이 끊겼다.
  app.get('/api/portal/quote-alert', { preHandler: [authGuard] }, async (req) => {
    const empty = { count: 0, items: [] };
    if (!(await quoteColsReady())) return empty;
    const perm = req.ctx.perm;
    try {
      if (perm.role !== 'director') {
        const target = (await query(
          `SELECT 1 FROM crm_quote_notify_targets WHERE user_id=$1`, [perm.userId])).rows[0];
        if (!target) return empty;          // 알림 대상이 아니면 아무것도 뜨지 않는다
      }
      const rows = (await query(
        `${selectQ(await poColumnReady())} WHERE ${OPEN_WHERE} ORDER BY q.created_at DESC LIMIT 30`)).rows;
      return { count: rows.length, items: rows.map(qRow) };
    } catch (_) { return empty; }
  });

  // ════════════════════════════════════════════════════════════════════
  //  ③ 목록 · 담당자 지정
  // ════════════════════════════════════════════════════════════════════
  const canSee = { preHandler: [authGuard, requirePage('quote')] };
  const dirOnly = { preHandler: [authGuard, requireDirector] };

  app.get('/api/crm-quotes', canSee, async (req, reply) => {
    if (!(await quoteColsReady())) {
      return reply.code(503).send({ error: 'migration_required',
        note: '0220_crm_quote_inbound 마이그레이션이 필요합니다.' });
    }
    const status = String(req.query?.status || 'open');
    const limit = Math.min(300, Math.max(1, Number(req.query?.limit) || 100));
    const where = [`q.origin='crm'`, 'q.deleted_at IS NULL'];
    if (status === 'open') where.push(`q.status='draft'`);
    else if (status === 'unassigned') where.push(`q.status='draft' AND q.assigned_to IS NULL`);
    else if (['draft', 'confirmed', 'converted', 'cancelled', 'expired'].includes(status)) {
      where.push(`q.status='${status}'`);
    }
    const rows = (await query(
      `${selectQ(await poColumnReady())} WHERE ${where.join(' AND ')} ORDER BY q.created_at DESC LIMIT $1`, [limit])).rows;
    const sum = (await query(
      `SELECT status, count(*)::int AS n FROM quotes
        WHERE origin='crm' AND deleted_at IS NULL GROUP BY 1`)).rows;
    const summary = {};
    for (const s of sum) summary[s.status] = Number(s.n);
    return { migrated: true, summary, items: rows.map(qRow) };
  });

  /** 담당자 지정 — 디렉터만. 지정받은 사람 화면에 팝업이 뜨기 시작한다. */
  app.post('/api/crm-quotes/:id/assign', dirOnly, async (req, reply) => {
    if (!(await quoteColsReady())) return reply.code(503).send({ error: 'migration_required' });
    const id = Number(req.params.id);
    const uid = Number(req.body?.user_id || 0);
    if (!uid) return reply.code(400).send({ error: 'user_required', note: '담당할 직원을 고르세요.' });
    const u = (await query(`SELECT id, name FROM users WHERE id=$1 AND deleted_at IS NULL`, [uid])).rows[0];
    if (!u) return reply.code(404).send({ error: 'user_not_found' });
    const r = (await query(
      `UPDATE quotes SET assigned_to=$1, assigned_by=$2, assigned_at=now()
        WHERE id=$3 AND origin='crm' AND status='draft' AND deleted_at IS NULL RETURNING id`,
      [uid, req.ctx.perm.userId, id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found_or_closed' });
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `quote:${id}`,
      detail: { op: 'assign', to: uid } });
    const row = (await query(`${selectQ(await poColumnReady())} WHERE q.id=$1`, [id])).rows[0];
    return { ok: true, assigned_to_name: u.name, quote: qRow(row) };
  });

  app.post('/api/crm-quotes/:id/unassign', dirOnly, async (req, reply) => {
    if (!(await quoteColsReady())) return reply.code(503).send({ error: 'migration_required' });
    const id = Number(req.params.id);
    const r = (await query(
      `UPDATE quotes SET assigned_to=NULL, assigned_by=NULL, assigned_at=NULL
        WHERE id=$1 AND origin='crm' AND status='draft' AND deleted_at IS NULL RETURNING id`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found_or_closed' });
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `quote:${id}`, detail: { op: 'unassign' } });
    const row = (await query(`${selectQ(await poColumnReady())} WHERE q.id=$1`, [id])).rows[0];
    return { ok: true, quote: qRow(row) };
  });

  app.get('/api/crm-quotes/assignees', dirOnly, async () => ({ items: await assignableUsers() }));

  // ── 알림 대상(사람 단위) — 디렉터는 설정과 무관하게 항상 받는다.
  //   ⚠ 응답 모양을 가입 신청(/api/crm-leads/notify-targets)과 **똑같이** 맞춘다.
  //     화면이 같은 코드로 두 창구를 다루기 때문이다 — 모양이 갈리면 한쪽이 조용히 망가진다.
  app.get('/api/crm-quotes/notify-targets', dirOnly, async () => {
    const users = (await query(
      `SELECT id, name, role, login_id FROM users
        WHERE deleted_at IS NULL AND role <> 'viewer'
        ORDER BY (role='director') DESC, name`)).rows;
    let picked = [];
    if (await quoteColsReady()) {
      try { picked = (await query(`SELECT user_id FROM crm_quote_notify_targets`)).rows.map((r) => Number(r.user_id)); }
      catch (_) { picked = []; }
    }
    return {
      migrated: await quoteColsReady(),
      items: users.map((u) => ({ id: Number(u.id), name: u.name, role: u.role, login_id: u.login_id || null,
        selected: picked.includes(Number(u.id)), always: u.role === 'director' })),
    };
  });

  app.put('/api/crm-quotes/notify-targets', dirOnly, async (req, reply) => {
    if (!(await quoteColsReady())) {
      return reply.code(503).send({ error: 'migration_required',
        note: '0220_crm_quote_inbound 마이그레이션이 필요합니다.' });
    }
    const ids = Array.isArray(req.body?.user_ids)
      ? [...new Set(req.body.user_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0))] : [];
    // 존재하는 사용자만 남긴다(삭제된 사용자를 넣어 두면 조용히 아무도 못 받는다).
    const valid = ids.length
      ? (await query(`SELECT id FROM users WHERE deleted_at IS NULL AND id = ANY($1::bigint[])`, [ids]))
        .rows.map((r) => Number(r.id))
      : [];
    await withTx(async (c) => {
      await c.query(`DELETE FROM crm_quote_notify_targets`);
      for (const uid of valid) {
        await c.query(`INSERT INTO crm_quote_notify_targets (user_id, added_by) VALUES ($1,$2)
                       ON CONFLICT (user_id) DO NOTHING`, [uid, req.ctx.perm.userId]);
      }
    });
    await safeLog({ userId: req.ctx.perm.userId, action: 'permission_change', target: 'crm_quote_notify',
      detail: { user_ids: valid } });
    return { ok: true, count: valid.length,
      note: valid.length ? null : '아무도 선택하지 않았습니다 — 디렉터에게만 팝업이 뜹니다.' };
  });
}
