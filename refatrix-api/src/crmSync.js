// ERP → CRM(웹 카달록) 전송 엔진.
//
//   보내는 시점: 디렉터가 ERP 에서 승인·수정·삭제를 확정하는 순간(customerRoutes 의 4개 지점).
//   보내는 곳·본문 규격: integration_endpoints 등록부(관리자 화면에서 수정) — src/integrations.js
//   기본 계약(고객): rfc · discountPercent · paymentDays · transactionUser
//                    응답 { codigoError: "0", mensaje: "…" }
//
//   설계 원칙 3가지
//   ① 승인은 절대 CRM 때문에 멈추지 않는다. 승인 트랜잭션은 ERP 안에서 끝내고,
//      전송 건은 crm_customer_outbox 에 적재한다(적재 실패도 승인을 막지 않는다).
//   ② 적재 직후 즉시 한 번 쏜다(비동기). 정상 상황에서는 "누르는 즉시 전송"이다.
//      실패하면 워커가 지수 백오프로 재시도하고, 6회까지 실패하면 failed 로 남긴다 —
//      **조용히 사라지지 않는다.** 관리자 화면에서 재전송할 수 있다.
//   ③ 연동이 꺼져 있으면 **시도 횟수를 쓰지 않고** 대기로 둔다. 나중에 켜면 밀린 건이 그대로 나간다.
import { query } from './db.js';
import { config } from './config.js';
import { getEndpoint, activeUrl, activeToken, CUSTOMER_KEY } from './integrations.js';

let tableReady = false;  // 긍정만 영구 캐시(서버 기동 후 migrate 해도 반영되게)
let lastProbe = 0;
const PROBE_MS = 30000;
let draining = false;    // 동시 드레인 방지
let timer = null;

const BACKOFF_SEC = [30, 120, 600, 1800, 7200, 21600]; // 30초 · 2분 · 10분 · 30분 · 2시간 · 6시간
export const MAX_ATTEMPTS = BACKOFF_SEC.length;

export function nextDelaySec(attempts) {
  const i = Math.max(0, Math.min(attempts - 1, BACKOFF_SEC.length - 1));
  return BACKOFF_SEC[i];
}

/** 전체 정지 스위치(사고 시 Railway 에서 1줄로 끈다). 평상시 켜고 끄기는 관리자 화면에서. */
export function globallyDisabled() {
  return String(process.env.CRM_SYNC_DISABLE_ALL || '0') === '1';
}

export async function crmTableReady() {
  if (tableReady) return true;
  if (Date.now() - lastProbe < PROBE_MS) return false;
  lastProbe = Date.now();
  try {
    const r = await query(`SELECT to_regclass('public.crm_customer_outbox') AS t`);
    tableReady = !!(r.rows[0] && r.rows[0].t);
  } catch (_) { tableReady = false; }
  return tableReady;
}

/** 재시도해도 소용없는 응답인가 — 연동 설정의 목록(쉼표 구분)과 대조한다. */
export function isPermanent(body, noRetryCodes) {
  const list = String(noRetryCodes == null ? 'ERR_CUSTOMER_NOT_FOUND' : noRetryCodes)
    .split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  if (!list.length || !body || typeof body !== 'object') return false;
  const code = body.codigoError != null ? String(body.codigoError).trim().toUpperCase() : null;
  return !!code && list.includes(code);
}

/** 전송 성공 판정 — HTTP 2xx 이면서 codigoError 가 성공코드(기본 "0")이거나 아예 없을 것. */
export function isSuccess(httpStatus, body, okCode = '0') {
  if (!(httpStatus >= 200 && httpStatus < 300)) return false;
  if (!body || typeof body !== 'object') return true;         // 본문 없음 = 2xx 만으로 성공
  const code = body.codigoError != null ? String(body.codigoError).trim()
    : (body.codigo_error != null ? String(body.codigo_error).trim() : null);
  if (code === null) return true;
  return code === String(okCode == null ? '0' : okCode);
}

// 전송 본문을 만들 때 필요한 고객 값 — create 는 신원(상호·연락처·배송지)까지 쓴다.
const CUSTOMER_COLS = `SELECT id, code, name, rfc, contact, phone, ship_address,
         discount, credit_days, approval_status, deleted_at
    FROM customers`;

/** 고객 계약 본문 — 여기서 정한 이름이 곧 계약서다. */
export function buildPayload(op, c, transactionUser, reason) {
  const rfc = String(c.rfc || '').trim();
  if (op === 'delete') return { rfc, transactionUser };
  // 반려: CRM 의 고객이 "승인 대기" 로 남지 않도록 상태와 사유를 함께 보낸다.
  if (op === 'reject') {
    return {
      rfc, transactionUser,
      estatus: 'rechazado',
      motivoRechazo: String(reason || '').trim() || 'Sin motivo especificado',
    };
  }
  // 0213 · CRM 에 **없는** 고객을 새로 만드는 창구. 상거래정보만으로는 만들 수 없으니
  //   신원(상호·연락처·ERP 코드)을 같이 보낸다. 어떤 이름을 요구하는지는 상대 개발자가
  //   확정해야 한다 — 계약서 탭의 「비고」에 확인할 항목을 적어 뒀다.
  if (op === 'create') {
    const out = {
      rfc,
      nombre: String(c.name || '').trim(),
      erpCustomerCode: String(c.code || '').trim() || undefined,
      telefono: String(c.phone || '').trim() || undefined,
      correo: String(c.contact || '').trim() || undefined,
      direccion: String(c.ship_address || '').trim() || undefined,
      discountPercent: c.discount == null ? 0 : Number(c.discount),
      paymentDays: c.credit_days == null ? 0 : Number(c.credit_days),
      estatus: crmEstatus(c.approval_status),
      transactionUser,
    };
    // 값이 없는 선택 항목은 아예 빼고 보낸다 — null 을 보내면 상대가 그 값으로 덮어쓸 수 있다.
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  }
  return {
    rfc,
    discountPercent: c.discount == null ? 0 : Number(c.discount),
    paymentDays: c.credit_days == null ? 0 : Number(c.credit_days),
    transactionUser,
    // 승인 상태를 **같이 보낸다.** 이게 없으면 ERP 에서 승인을 끝내도 CRM 쪽 고객은
    //   「Aprobación pendiente」 로 영원히 남는다(P-0001 에서 실제로 그렇게 됐다).
    //   반려(reject)는 이미 estatus 를 보내고 있었으니 이제 양쪽이 대칭이다.
    //   ⚠ 'aprobado' 를 박아 넣지 않는다 — 전체 동기화(scope=all)로 승인 대기 고객이
    //     섞여 나갈 수 있고, 그때 승인됐다고 알리면 CRM 이 잘못된 상태를 갖게 된다.
    estatus: crmEstatus(c.approval_status),
  };
}

/** ERP 승인 상태 → CRM 이 쓰는 스페인어 상태값. */
export function crmEstatus(approvalStatus) {
  const s = String(approvalStatus == null || approvalStatus === '' ? 'approved' : approvalStatus);
  if (s === 'pending') return 'pendiente';
  if (s === 'rejected') return 'rechazado';
  return 'aprobado';   // approved · 그리고 approval_status 컬럼이 없던 시절의 레거시 행
}

async function actorName(userId, userField) {
  if (!userId) return 'erp';
  try {
    const u = (await query(`SELECT login_id, name, role FROM users WHERE id=$1`, [userId])).rows[0];
    if (!u) return 'erp';
    const f = ['login_id', 'name', 'role'].includes(userField) ? userField : 'login_id';
    return String(u[f] || u.login_id || u.name || u.role || 'erp');
  } catch (_) { return 'erp'; }
}

/**
 * 전송 건 적재. 승인/수정/삭제 경로에서 호출한다.
 *   op: 'upsert' | 'delete'
 *   절대 throw 하지 않는다 — 이 함수 때문에 승인이 실패하면 안 된다.
 */
export async function enqueueCustomerSync(customerId, op, { origin, actorUserId, reason, app } = {}) {
  try {
    if (!(await crmTableReady())) return { ok: false, reason: 'migration_required' };
    const c = (await query(
      `${CUSTOMER_COLS} WHERE id=$1`, [customerId])).rows[0];
    if (!c) return { ok: false, reason: 'customer_not_found' };

    const ep = await getEndpoint(CUSTOMER_KEY);
    const user = await actorName(actorUserId, ep && ep.user_field);
    const payload = buildPayload(op, c, user, reason);
    let status = 'pending';
    let note = null;

    if (!payload.rfc) {
      // RFC 는 CRM 의 조회 키다. 없으면 보낼 수 없다.
      status = 'skipped'; note = 'rfc_missing';
    } else if (op === 'delete') {
      // 한 번도 보낸 적 없는 고객의 삭제는 CRM 에 알릴 것이 없다.
      const sent = (await query(
        `SELECT 1 FROM crm_customer_outbox WHERE customer_id=$1 AND op='upsert' AND status='sent' LIMIT 1`,
        [customerId])).rows[0];
      if (!sent) { status = 'skipped'; note = 'never_sent'; }
    }
    // 반려는 **보낸 적 없어도 보낸다** — CRM 에서 등록한 고객은 그쪽에 이미 존재하고,
    // 알리지 않으면 「승인 대기」 상태로 영원히 남는다.

    const hasReason = await outboxHasReasonCol();
    const hasNewCols = await outboxHasEndpointCols();
    const label = `${c.code || ''} ${c.name || ''}`.trim();
    const row = hasNewCols
      ? (await query(
        `INSERT INTO crm_customer_outbox
           (customer_id, entity, entity_id, entity_label, endpoint_key, op, origin, rfc, payload, status, last_error, acted_by)
         VALUES ($1,'customer',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [customerId, label || null, CUSTOMER_KEY, op, origin || 'manual', payload.rfc || null,
         JSON.stringify(payload), status, note, actorUserId || null])).rows[0]
      : (await query(
        `INSERT INTO crm_customer_outbox (customer_id, op, origin, rfc, payload, status, last_error, acted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [customerId, op, origin || 'manual', payload.rfc || null,
         JSON.stringify(payload), status, note, actorUserId || null])).rows[0];

    if (hasReason && reason) {
      try { await query(`UPDATE crm_customer_outbox SET reason=$1 WHERE id=$2`, [String(reason).slice(0, 500), row.id]); }
      catch (_) { /* 사유 기록 실패가 전송을 막지는 않는다 */ }
    }
    if (status === 'pending') scheduleDrain(app);
    return { ok: true, id: Number(row.id), status, note };
  } catch (e) {
    try { console.error('[crmSync] enqueue 실패', e && e.message); } catch (_) {}
    return { ok: false, reason: 'enqueue_failed' };
  }
}

let epColsReady = false;
let epColsProbe = 0;
async function outboxHasEndpointCols() {
  if (epColsReady) return true;
  if (Date.now() - epColsProbe < PROBE_MS) return false;
  epColsProbe = Date.now();
  try {
    const r = await query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='crm_customer_outbox' AND column_name='endpoint_key' LIMIT 1`);
    epColsReady = r.rows.length > 0;
  } catch (_) { epColsReady = false; }
  return epColsReady;
}

let reasonColReady = false;
let reasonColProbe = 0;
async function outboxHasReasonCol() {
  if (reasonColReady) return true;
  if (Date.now() - reasonColProbe < PROBE_MS) return false;
  reasonColProbe = Date.now();
  try {
    const r = await query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='crm_customer_outbox' AND column_name='reason' LIMIT 1`);
    reasonColReady = r.rows.length > 0;
  } catch (_) { reasonColReady = false; }
  return reasonColReady;
}

let authColsReady = false;
let authColsProbe = 0;
async function outboxHasAuthCols() {
  if (authColsReady) return true;
  if (Date.now() - authColsProbe < PROBE_MS) return false;
  authColsProbe = Date.now();
  try {
    const r = await query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='crm_customer_outbox' AND column_name='auth_sent' LIMIT 1`);
    authColsReady = r.rows.length > 0;
  } catch (_) { authColsReady = false; }
  return authColsReady;
}

/** 응답 직후 비동기로 한 번 밀어 준다(요청 처리를 붙잡지 않는다). */
export function scheduleDrain(app) {
  if (globallyDisabled()) return;
  setTimeout(() => { drainOutbox({ app }).catch(() => {}); }, 10);
}

/**
 * 실제 HTTP 전송. 관리자 화면의 「연결 테스트」도 이 함수를 그대로 쓴다
 * — 테스트에서 통과한 설정이 곧 실제 전송 설정이다.
 */
export async function sendPayload(ep, op, payload) {
  const url = activeUrl(ep);
  if (!url) return { error: 'url_missing' };
  // reject 는 "상태 갱신" 이므로 등록·수정과 같은 메서드를 쓴다(삭제가 아니다).
  const method = String(op === 'delete' ? ep.method_delete : ep.method_upsert || 'POST').toUpperCase();
  // DELETE 는 본문을 무시하는 서버가 흔하다 → 쿼리스트링에도 rfc 를 실어 준다.
  const target = (op === 'delete' && payload && payload.rfc)
    ? url + (url.includes('?') ? '&' : '?') + 'rfc=' + encodeURIComponent(payload.rfc)
    : url;
  const headers = { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' };
  const token = activeToken(ep);   // 테스트/운영 각자의 키
  // 키를 어디에 싣는가 — CRM 마다 다르다(헤더 / 쿼리스트링 / 본문). 0204 이전 설정은 헤더.
  const where = ['header', 'query', 'body'].includes(ep.auth_in) ? ep.auth_in : 'header';
  const param = String(ep.auth_param || 'apiKey').trim() || 'apiKey';
  const authHeader = ep.auth_header || 'Authorization';
  let sendUrl = target;
  let sendBody = payload;
  if (token) {
    if (where === 'header') headers[authHeader] = token;
    else if (where === 'query') sendUrl += (sendUrl.includes('?') ? '&' : '?') + encodeURIComponent(param) + '=' + encodeURIComponent(token);
    else sendBody = { ...payload, [param]: token };
  }
  const authInfo = {
    auth_sent: !!token,
    auth_header: token ? (where === 'header' ? authHeader : `${where}:${param}`) : null,
  };

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), Number(ep.timeout_ms) || 10000);
  const startedAt = Date.now();
  try {
    const res = await fetch(sendUrl, {
      method, headers,
      body: method === 'GET' ? undefined : JSON.stringify(sendBody),
      signal: ac.signal,
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = { raw: String(text).slice(0, 1000) }; }
    // 이력에 남기는 url 은 키를 지운 형태로(키가 이력에 남으면 안 된다)
    const safeUrl = token && where === 'query'
      ? sendUrl.replace(encodeURIComponent(token), '***') : sendUrl;
    return { httpStatus: res.status, body, url: safeUrl, method, ms: Date.now() - startedAt, ...authInfo };
  } catch (e) {
    return {
      error: (e && e.name === 'AbortError') ? 'timeout' : String((e && e.message) || e).slice(0, 300),
      url: target, method, ms: Date.now() - startedAt, ...authInfo,
    };
  } finally { clearTimeout(t); }
}

/** 대기 건을 순서대로 전송. 워커·수동 재전송·적재 직후 즉시전송이 모두 이 함수를 탄다. */
// 0213 폴백 컬럼 준비 여부 — 긍정만 영구 캐시(반쪽 배포에서도 전송이 죽지 않게).
let fbCols = false; let fbProbe = 0;
async function outboxHasFallbackCol() {
  if (fbCols) return true;
  if (Date.now() - fbProbe < PROBE_MS) return false;
  fbProbe = Date.now();
  try {
    const r = await query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='crm_customer_outbox' AND column_name='fallback_of' LIMIT 1`);
    fbCols = r.rows.length > 0;
  } catch (_) { fbCols = false; }
  return fbCols;
}

/**
 * 0213 · 「CRM 에 없는 고객」 → 등록 창구로 넘긴다.
 *
 *   상거래정보 창구(customer_commercial)는 RFC 로 **찾아서 고치는** 창구다.
 *   CRM 에 없으면 ERR_CUSTOMER_NOT_FOUND 가 오고, 예전에는 그걸 skipped 로 닫아
 *   그 고객은 영영 CRM 에 안 들어갔다. 이제 그 응답을 신호로 삼아 등록 창구로 다시 보낸다.
 *
 *   ⚠ 폴백 대상 창구가 없거나·꺼져 있거나·주소가 비어 있으면 아무 일도 하지 않는다
 *     (예전과 똑같이 skipped 로 닫힌다). 설정을 안 한 상태에서 조용히 엉뚱한 데로 쏘지 않는다.
 *   @returns {number|null} 새로 만든 전송 건 id
 */
async function enqueueFallback(row, ep, body) {
  try {
    if (!ep.fallback_key) return null;
    if (row.op !== 'upsert') return null;                      // 삭제·반려는 폴백 대상이 아니다
    if (row.fallback_of) return null;                          // 폴백의 폴백은 없다(무한 연쇄 방지)
    if (!isPermanent(body, ep.fallback_codes)) return null;    // 그 오류코드일 때만
    const target = await getEndpoint(ep.fallback_key);
    if (!target || !target.enabled || !activeUrl(target)) return null;

    const c = (await query(`${CUSTOMER_COLS} WHERE id=$1`, [row.customer_id])).rows[0];
    if (!c) return null;
    const user = await actorName(row.acted_by, target.user_field);
    const payload = buildPayload('create', c, user);
    if (!payload.rfc) return null;

    const hasCols = await outboxHasEndpointCols();
    const label = `${c.code || ''} ${c.name || ''}`.trim();
    const ins = hasCols
      ? (await query(
        `INSERT INTO crm_customer_outbox
           (customer_id, entity, entity_id, entity_label, endpoint_key, op, origin, rfc, payload,
            status, acted_by, fallback_of)
         VALUES ($1,'customer',$1,$2,$3,'upsert',$4,$5,$6,'pending',$7,$8) RETURNING id`,
        [row.customer_id, label || null, target.key, 'crm_not_found', payload.rfc,
         JSON.stringify(payload), row.acted_by || null, row.id])).rows[0]
      : (await query(
        `INSERT INTO crm_customer_outbox (customer_id, op, origin, rfc, payload, status, acted_by, fallback_of)
         VALUES ($1,'upsert',$2,$3,$4,'pending',$5,$6) RETURNING id`,
        [row.customer_id, 'crm_not_found', payload.rfc, JSON.stringify(payload),
         row.acted_by || null, row.id])).rows[0];
    return ins ? Number(ins.id) : null;
  } catch (e) {
    try { console.error('[crmSync] 폴백 적재 실패', e && e.message); } catch (_) {}
    return null;   // 폴백 실패가 원래 전송의 마무리를 막지 않는다
  }
}

export async function drainOutbox({ limit = 20, app } = {}) {
  if (draining) return { drained: 0, busy: true };
  if (globallyDisabled()) return { drained: 0, disabled: true, reason: 'kill_switch' };
  if (!(await crmTableReady())) return { drained: 0, reason: 'migration_required' };
  draining = true;
  let sent = 0, failed = 0, held = 0;
  const newCols = await outboxHasEndpointCols();
  try {
    const rows = (await query(
      `SELECT * FROM crm_customer_outbox
        WHERE status='pending' AND next_attempt_at <= now()
        ORDER BY id LIMIT $1`, [limit])).rows;
    for (const row of rows) {
      const key = row.endpoint_key || CUSTOMER_KEY;
      const ep = await getEndpoint(key);
      // 연동이 없거나 꺼져 있거나 주소가 비었으면 **시도 횟수를 쓰지 않고** 그대로 둔다.
      if (!ep || !ep.enabled || !activeUrl(ep)) {
        held++;
        continue;
      }
      const attempts = Number(row.attempts) + 1;
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      const r = await sendPayload(ep, row.op, payload);
      const okNow = !r.error && isSuccess(r.httpStatus, r.body, ep.ok_code);
      const codigo = r.body && r.body.codigoError != null ? String(r.body.codigoError) : null;
      // 전송 당시의 환경·주소·메서드도 같이 남긴다(이력에서 "어디로 보냈나"에 답하기 위해).
      const sets = [];
      const params = [];
      const put = (sql, val) => { params.push(val); sets.push(sql.replace('$?', '$' + params.length)); };

      if (okNow) {
        sent++;
        put('status=$?', 'sent');
        put('attempts=$?', attempts);
        put('http_status=$?', r.httpStatus || null);
        put('codigo_error=$?', codigo);
        put('response=$?', JSON.stringify(r.body));
        sets.push('last_error=NULL', 'sent_at=now()');
      } else {
        failed++;
        const note = r.error || (r.body && (r.body.mensaje || r.body.message)) || ('HTTP ' + r.httpStatus);
        // 재시도해도 결과가 같은 응답(예: CRM 에 없는 고객)은 즉시 닫는다 — 재시도 큐를 더럽히지 않는다.
        const permanent = !r.error && isPermanent(r.body, ep.no_retry_codes);
        // 0213 · 「CRM 에 없는 고객」이면 등록 창구로 넘긴다. 넘겼으면 이 건은 그것으로 끝이다.
        const fbId = (!r.error && await outboxHasFallbackCol())
          ? await enqueueFallback(row, ep, r.body) : null;
        const done = permanent || attempts >= MAX_ATTEMPTS;
        put('status=$?', permanent ? 'skipped' : (done ? 'failed' : 'pending'));
        put('attempts=$?', attempts);
        put('http_status=$?', r.httpStatus || null);
        put('codigo_error=$?', codigo);
        put('response=$?', JSON.stringify(r.body));
        put('last_error=$?', fbId
          ? `CRM 에 없는 고객 — 등록 창구로 넘겼습니다 (전송 #${fbId})`
          : String(note).slice(0, 500));
        put(`next_attempt_at = now() + ($? || ' seconds')::interval`, String(nextDelaySec(attempts)));
      }
      if (newCols) {
        put('env=$?', ep.env || null);
        put('url=$?', r.url || null);
        put('request_method=$?', r.method || null);
      }
      if (await outboxHasAuthCols()) {
        put('auth_sent=$?', !!r.auth_sent);
        put('auth_header=$?', r.auth_header || null);
      }
      params.push(row.id);
      await query(`UPDATE crm_customer_outbox SET ${sets.join(', ')} WHERE id=$${params.length}`, params);
    }
  } catch (e) {
    try { console.error('[crmSync] drain 실패', e && e.message); } catch (_) {}
  } finally { draining = false; }
  return { drained: sent + failed, sent, failed, held };
}

/** 서버 기동 시 1회 호출. 주기 워커 — 즉시전송이 실패한 건을 책임진다. */
export function startCrmSyncWorker(app) {
  if (timer) return;
  if (globallyDisabled()) {
    try { app?.log?.info?.('[crmSync] 전체 정지(CRM_SYNC_DISABLE_ALL=1)'); } catch (_) {}
    return;
  }
  const ms = Math.max(15, Number(config.crm.workerSec) || 60) * 1000;
  timer = setInterval(() => { drainOutbox({ app }).catch(() => {}); }, ms);
  if (timer.unref) timer.unref();
  try { app?.log?.info?.(`[crmSync] 워커 시작 — ${Math.round(ms / 1000)}초 주기 (연동 켜고 끄기는 관리자 화면)`); } catch (_) {}
}

export function crmStatus() {
  return {
    kill_switch: globallyDisabled(),
    worker_sec: Number(config.crm.workerSec) || 60,
    max_attempts: MAX_ATTEMPTS,
    backoff_sec: BACKOFF_SEC,
  };
}
