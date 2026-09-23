// ERP → CRM 오더상태 전송 (0227). 계약서: Contrato_API_Estatus_Pedido_v1.0.
//
//   CRM 화면의 오더 단계 4개 ↔ ERP 수주 SLA 단계(quoteStage.computeQuoteStage)
//     1 solicitud_nueva      ← created                (CRM 견적이 ERP 에 접수돼 견적이 생겼다)
//     2 surtiendo            ← printing               (포장작업지시서 출력 = 포장 단계 진입)
//     3 preparando_despacho  ← packed · await_sat     (포장 완료 → SAT 발행 대기)
//     4 oc_enviada           ← await_collect · collected (실제 SAT 번호 등록 → 수금 단계)
//
//   설계 원칙
//   ① 판정 규칙을 새로 만들지 않는다. 수주 SLA 와 **같은 함수**를 쓴다 — 두 벌이면 언젠가
//      「SLA 는 수금인데 CRM 은 포장중」 이 된다.
//   ② 엔진도 새로 만들지 않는다. 적재는 기존 아웃박스(crm_customer_outbox, entity='order'),
//      전송·재시도·이력·재전송은 crmSync 것을 그대로 탄다.
//   ③ 두 겹으로 잡는다. 단계가 바뀌는 지점(출력·포장완료·전환·SAT 입력·CRM 접수)에서 **즉시** 한 번,
//      그리고 90초마다 도는 **감시**가 놓친 것을 줍는다. 단계를 바꾸는 코드는 여러 곳이고
//      앞으로도 늘어난다 — 훅만 믿으면 새 경로가 생기는 날 조용히 멈춘다.
//   ④ 중복은 DB 가 막는다. (견적, 단계) 가 crm_order_status_events 의 기본키다.
//      훅과 감시가 같은 순간 같은 견적을 봐도 한 번만 나간다.
//   ⑤ 단계는 **앞으로만** 간다. 이미 보낸 단계보다 낮은 단계는 보내지 않는다.
//      중간 단계를 건너뛰었으면(예: 지시서 없이 바로 전환) **실제로 일어난 단계만** 순서대로 채운다
//      — 일어나지 않은 단계를 지어내 보내지 않는다.
//   ⑥ 연동이 꺼져 있으면 **아무것도 쌓지 않는다.** 켜는 순간 감시가 지금 단계까지 따라잡는다.
//      (꺼진 동안 쌓아 두면 켜는 날 수백 건이 한꺼번에 나가고, 대부분은 이미 지난 단계다)
//   ⑦ 절대 throw 하지 않는다 — 이 기능 때문에 포장·전환·SAT 입력이 실패하면 안 된다.
import { query, withTx } from './db.js';
import { getEndpoint, activeUrl } from './integrations.js';
import { scheduleDrain, globallyDisabled } from './crmSync.js';
import { computeQuoteStage } from './quoteStage.js';

export const ORDER_STATUS_KEY = 'order_status';

export const CRM_ORDER_STEPS = [
  { seq: 1, code: 'solicitud_nueva', text: 'Solicitud nueva', ko: '신규 요청' },
  { seq: 2, code: 'surtiendo', text: 'Surtiendo', ko: '포장중' },
  { seq: 3, code: 'preparando_despacho', text: 'Preparando despacho', ko: '출고 준비(SAT 대기)' },
  { seq: 4, code: 'oc_enviada', text: 'OC Enviada', ko: 'SAT 발행 · 수금 단계' },
];
const BY_SEQ = new Map(CRM_ORDER_STEPS.map((s) => [s.seq, s]));

/** SLA 단계 → CRM 단계 번호. 보낼 단계가 아니면 0(취소·만료·백오더·가용재고). */
export function crmSeqForStage(stageKey) {
  switch (stageKey) {
    case 'created': return 1;
    case 'printing': return 2;
    case 'packed':
    case 'await_sat': return 3;
    case 'await_collect':
    case 'collected': return 4;
    // backorder(전환됐는데 인보이스가 없음)·cancelled·expired·pricelist 는 CRM 4단계 어디에도 맞지 않는다.
    //   지어내서 보내지 않는다 — 그 견적은 마지막으로 보낸 단계에 머문다.
    default: return 0;
  }
}

function iso(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 이 견적이 **실제로 거친** CRM 단계들과 각 시각.
 *   단계 1 은 언제나(견적이 있으니까). 2 는 지시서를 출력했을 때만. 3 은 포장이 끝났거나 지금이 3 일 때.
 *   4 는 지금 단계가 4 일 때(= SAT 등록). 지금 단계보다 높은 것은 절대 넣지 않는다.
 */
export function reachedSteps(o, currentSeq) {
  const out = [];
  if (currentSeq < 1) return out;
  out.push({ seq: 1, at: o.created_at });
  if (currentSeq >= 2 && o.packing_printed_at) out.push({ seq: 2, at: o.packing_printed_at });
  // 3 은 포장이 실제로 끝났거나, 지금이 바로 3 일 때만. 포장 없이 인보이스가 곧바로
  //   실제 SAT 로 만들어진 경우(직접 매출)는 3 을 거치지 않았으므로 지어내지 않는다.
  if (currentSeq === 3 || (currentSeq > 3 && o.packed_at)) {
    out.push({ seq: 3, at: o.packed_at || o.converted_at || null });
  }
  if (currentSeq >= 4) out.push({ seq: 4, at: o.sat_entered_at || o.converted_at || null });
  // 지금 단계는 시각이 없더라도 반드시 들어간다(2 인데 출력 시각이 없는 이상한 행 방어).
  if (!out.some((s) => s.seq === currentSeq)) out.push({ seq: currentSeq, at: null });
  return out.sort((a, b) => a.seq - b.seq);
}

/** 계약서 본문 — 여기서 정한 이름이 곧 계약서다. 빈 선택 필드는 키를 뺀다. */
export function buildOrderPayload(o, seq, at, transactionUser) {
  const step = BY_SEQ.get(seq);
  const body = {
    eventoId: `ERP-${Number(o.id)}-${seq}`,
    cotizacionCrm: String(o.external_quote_no || '').trim(),
    cotizacionErp: String(o.quote_no || '').trim(),
    rfc: String(o.rfc || '').trim(),
    estatus: step.code,
    estatusTexto: step.text,
    secuencia: seq,
    fechaEstatus: iso(at) || iso(new Date()),
    folioSat: seq === 4 && o.sat_no && !String(o.sat_no).startsWith('TMP-') ? String(o.sat_no) : undefined,
    ordenCompraCliente: String(o.customer_po_no || '').trim() || undefined,
    transactionUser: String(transactionUser || 'erp'),
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

// 견적 1건의 현재 상태. 없을 수도 있는 칼럼(PO·folio·CRM 고객코드)은 to_jsonb 로 읽어
//   반쪽 배포에서도 쿼리가 죽지 않게 한다.
const ORDER_SQL = `
  SELECT q.id, q.quote_no, q.external_quote_no, q.origin, q.status, q.created_at,
         q.packing_printed_at, q.packing_due_at, q.packed_at, q.invoice_id,
         (to_jsonb(q)->>'customer_po_no') AS customer_po_no,
         c.rfc, c.code AS customer_code, c.name AS customer_name,
         si.created_at AS converted_at, si.sat_no, si.sat_entered_at,
         to_char(si.due_date,'YYYY-MM-DD') AS due_date, si.total_mxn,
         (SELECT COALESCE(SUM(spa.amount),0) FROM sales_payment_allocations spa WHERE spa.invoice_id = si.id) AS paid_sum
    FROM quotes q
    LEFT JOIN customers c ON c.id = q.customer_id
    LEFT JOIN sales_invoices si ON si.id = q.invoice_id`;

export function stageOf(o, now = new Date()) {
  return computeQuoteStage({
    status: o.status, created_at: o.created_at,
    packing_printed_at: o.packing_printed_at, packing_due_at: o.packing_due_at, packed_at: o.packed_at,
    invoice_id: o.invoice_id, converted_at: o.converted_at, sat_no: o.sat_no,
    due_date: o.due_date, total_mxn: o.total_mxn, paid_sum: o.paid_sum,
  }, now);
}

let ready = false; let probeAt = 0;
export async function orderStatusReady() {
  if (ready) return true;
  if (Date.now() - probeAt < 30000) return false;
  probeAt = Date.now();
  try {
    const r = await query(`SELECT to_regclass('public.crm_order_status_events') AS t`);
    ready = !!(r.rows[0] && r.rows[0].t);
  } catch (_) { ready = false; }
  return ready;
}

async function actorName(userId, userField) {
  if (!userId) return 'erp';
  try {
    const u = (await query(`SELECT login_id, name, role FROM users WHERE id=$1`, [userId])).rows[0];
    if (!u) return 'erp';
    const f = ['login_id', 'name', 'role'].includes(userField) ? userField : 'login_id';
    return String(u[f] || u.login_id || 'erp');
  } catch (_) { return 'erp'; }
}

/** 연동이 보낼 수 있는 상태인가(켜짐 + 주소 있음). 아니면 이유. */
export async function endpointState() {
  const ep = await getEndpoint(ORDER_STATUS_KEY);
  if (!ep) return { ok: false, reason: 'endpoint_missing' };
  if (!ep.enabled) return { ok: false, reason: 'endpoint_disabled', ep };
  if (!activeUrl(ep)) return { ok: false, reason: 'url_missing', ep };
  return { ok: true, ep };
}

/**
 * 견적 1건을 지금 상태에 맞춰 CRM 으로 보낸다(필요한 만큼만).
 *   @returns {{ok, queued:number[], seq?, reason?}}
 */
export async function syncOrderStatus(quoteId, { origin = 'hook', actorUserId = null, app = null, _ep = null } = {}) {
  try {
    const id = Number(quoteId);
    if (!id) return { ok: false, reason: 'bad_id', queued: [] };
    if (!(await orderStatusReady())) return { ok: false, reason: 'migration_required', queued: [] };
    const st = _ep ? { ok: true, ep: _ep } : await endpointState();
    if (!st.ok) return { ok: false, reason: st.reason, queued: [] };
    const ep = st.ep;

    const o = (await query(`${ORDER_SQL} WHERE q.id=$1 AND q.deleted_at IS NULL`, [id])).rows[0];
    if (!o) return { ok: false, reason: 'quote_not_found', queued: [] };
    // 웹(COT)에서 온 견적만 — CRM 은 자기가 모르는 오더의 단계를 받을 곳이 없다.
    if (!String(o.external_quote_no || '').trim()) return { ok: false, reason: 'not_crm_quote', queued: [] };

    const stage = stageOf(o);
    const seq = crmSeqForStage(stage.stage_key);
    if (!seq) return { ok: true, reason: 'no_crm_step', stage: stage.stage_key, queued: [] };

    const user = await actorName(actorUserId, ep.user_field);
    const steps = reachedSteps(o, seq);
    const label = `${o.external_quote_no}`;

    const queued = await withTx(async (c) => {
      const q = c.query.bind(c);
      // 이미 보낸 가장 높은 단계. 그보다 낮거나 같은 단계는 다시 보내지 않는다(앞으로만).
      const top = Number((await q(
        `SELECT COALESCE(MAX(seq),0) AS m FROM crm_order_status_events WHERE quote_id=$1`, [id])).rows[0].m) || 0;
      const ids = [];
      for (const s of steps) {
        if (s.seq <= top) continue;
        // 기본키가 경합을 정리한다 — 두 요청이 동시에 와도 한 번만 들어간다.
        const won = (await q(
          `INSERT INTO crm_order_status_events (quote_id, seq, status, event_at, origin)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (quote_id, seq) DO NOTHING RETURNING quote_id`,
          [id, s.seq, BY_SEQ.get(s.seq).code, s.at || null, origin])).rows[0];
        if (!won) continue;
        const payload = buildOrderPayload(o, s.seq, s.at, user);
        const ins = (await q(
          `INSERT INTO crm_customer_outbox
             (customer_id, entity, entity_id, entity_label, endpoint_key, op, origin, rfc, payload, status, acted_by)
           VALUES (NULL,'order',$1,$2,$3,'upsert',$4,$5,$6,'pending',$7) RETURNING id`,
          [id, `${label} · ${BY_SEQ.get(s.seq).text} · ${o.customer_name || ''}`.trim(),
           ORDER_STATUS_KEY, `order_${origin}`, payload.rfc || null, JSON.stringify(payload),
           actorUserId || null])).rows[0];
        await q(`UPDATE crm_order_status_events SET outbox_id=$1 WHERE quote_id=$2 AND seq=$3`,
          [ins.id, id, s.seq]);
        ids.push(Number(ins.id));
      }
      return ids;
    });
    if (queued.length) scheduleDrain(app);
    return { ok: true, seq, stage: stage.stage_key, queued };
  } catch (e) {
    try { console.error('[orderStatus] 실패', e && e.message); } catch (_) {}
    return { ok: false, reason: 'error', queued: [] };
  }
}

/**
 * 단계를 바꾼 코드가 부르는 한 줄짜리 훅. **기다리지 않는다.**
 *   트랜잭션 안에서 불려도 커밋 뒤에 읽도록 잠깐 미룬다. 그래도 못 보면 감시가 90초 안에 줍는다.
 */
export function kickOrderStatus(quoteId, { origin = 'hook', actorUserId = null, app = null, delayMs = 1500 } = {}) {
  try {
    if (!quoteId) return;
    const t = setTimeout(() => {
      syncOrderStatus(quoteId, { origin, actorUserId, app }).catch(() => {});
    }, delayMs);
    if (t && t.unref) t.unref();
  } catch (_) { /* 훅은 절대 본 작업을 방해하지 않는다 */ }
}

/** 인보이스 번호로 부를 때(SAT 입력 화면은 견적 id 를 모른다). */
export function kickOrderStatusByInvoice(invoiceId, opts = {}) {
  try {
    const id = Number(invoiceId);
    if (!id) return;
    const t = setTimeout(async () => {
      try {
        const rows = (await query(
          `SELECT id FROM quotes WHERE invoice_id=$1 AND deleted_at IS NULL AND external_quote_no IS NOT NULL`, [id])).rows;
        for (const r of rows) await syncOrderStatus(r.id, opts);
      } catch (_) {}
    }, opts.delayMs || 1500);
    if (t && t.unref) t.unref();
  } catch (_) {}
}

/**
 * 감시 — 아직 4단계에 닿지 않은 웹 견적을 훑어 놓친 단계를 보낸다.
 *   대상: 최근 120일 · 삭제 안 됨 · 보낸 최고 단계 < 4.
 *   꺼져 있으면 아무것도 하지 않는다(⑥).
 */
export async function sweepOrderStatus({ app = null, limit = 300 } = {}) {
  try {
    if (globallyDisabled()) return { skipped: 'kill_switch' };
    if (!(await orderStatusReady())) return { skipped: 'migration_required' };
    const st = await endpointState();
    if (!st.ok) return { skipped: st.reason };
    const rows = (await query(
      `SELECT q.id
         FROM quotes q
         LEFT JOIN (SELECT quote_id, MAX(seq) AS top FROM crm_order_status_events GROUP BY quote_id) e
                ON e.quote_id = q.id
        WHERE q.deleted_at IS NULL
          AND q.external_quote_no IS NOT NULL
          AND q.created_at >= now() - INTERVAL '120 days'
          AND COALESCE(e.top, 0) < 4
          AND q.status NOT IN ('cancelled','expired','delete_pending')
        ORDER BY q.id
        LIMIT $1`, [limit])).rows;
    let queued = 0;
    for (const r of rows) {
      const out = await syncOrderStatus(r.id, { origin: 'sweep', app, _ep: st.ep });
      queued += out.queued ? out.queued.length : 0;
    }
    return { scanned: rows.length, queued };
  } catch (e) {
    try { console.error('[orderStatus] 감시 실패', e && e.message); } catch (_) {}
    return { skipped: 'error' };
  }
}

let timer = null;
export function startOrderStatusWorker(app) {
  if (timer) return;
  const tick = () => { sweepOrderStatus({ app }).catch(() => {}); };
  timer = setInterval(tick, 90000);           // 90초
  if (timer.unref) timer.unref();
  setTimeout(tick, 30000);                    // 기동 30초 뒤 한 번
  try { app?.log?.info?.('[orderStatus] 오더상태 전송 감시 시작 — 90초 주기'); } catch (_) {}
}

/** 화면·테스트용: 견적 1건이 지금 CRM 에 무엇으로 보일지(보내지 않는다). */
export async function previewOrderStatus(quoteId) {
  const o = (await query(`${ORDER_SQL} WHERE q.id=$1`, [Number(quoteId)])).rows[0];
  if (!o) return null;
  const stage = stageOf(o);
  const seq = crmSeqForStage(stage.stage_key);
  const sent = (await orderStatusReady())
    ? (await query(`SELECT seq, status, event_at, outbox_id, created_at FROM crm_order_status_events
                     WHERE quote_id=$1 ORDER BY seq`, [o.id])).rows : [];
  return { quote_id: Number(o.id), quote_no: o.quote_no, external_quote_no: o.external_quote_no,
    stage: stage.stage_key, crm_seq: seq, crm_status: seq ? BY_SEQ.get(seq).code : null, sent };
}

/** 연결 테스트용 본문 — 가장 최근 웹 견적의 **지금** 단계. 없으면 null(계약서 예시로 대체). */
export async function testPayload(userName) {
  const o = (await query(
    `${ORDER_SQL} WHERE q.deleted_at IS NULL AND q.external_quote_no IS NOT NULL ORDER BY q.id DESC LIMIT 1`)).rows[0];
  if (!o) return null;
  const seq = crmSeqForStage(stageOf(o).stage_key) || 1;
  const at = reachedSteps(o, seq).find((s) => s.seq === seq);
  return { payload: buildOrderPayload(o, seq, at ? at.at : null, userName),
    quote: { id: Number(o.id), quote_no: o.quote_no, external_quote_no: o.external_quote_no } };
}
