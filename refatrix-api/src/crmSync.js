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

/** 전송 성공 판정 — HTTP 2xx 이면서 codigoError 가 성공코드(기본 "0")이거나 아예 없을 것. */
export function isSuccess(httpStatus, body, okCode = '0') {
  if (!(httpStatus >= 200 && httpStatus < 300)) return false;
  if (!body || typeof body !== 'object') return true;         // 본문 없음 = 2xx 만으로 성공
  const code = body.codigoError != null ? String(body.codigoError).trim()
    : (body.codigo_error != null ? String(body.codigo_error).trim() : null);
  if (code === null) return true;
  return code === String(okCode == null ? '0' : okCode);
}

/** 고객 계약 본문 — 4개 필드만. 여기서 정한 이름이 곧 계약서다. */
export function buildPayload(op, c, transactionUser) {
  const rfc = String(c.rfc || '').trim();
  if (op === 'delete') return { rfc, transactionUser };
  return {
    rfc,
    discountPercent: c.discount == null ? 0 : Number(c.discount),
    paymentDays: c.credit_days == null ? 0 : Number(c.credit_days),
    transactionUser,
  };
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
export async function enqueueCustomerSync(customerId, op, { origin, actorUserId, app } = {}) {
  try {
    if (!(await crmTableReady())) return { ok: false, reason: 'migration_required' };
    const c = (await query(
      `SELECT id, code, name, rfc, discount, credit_days, approval_status, deleted_at
         FROM customers WHERE id=$1`, [customerId])).rows[0];
    if (!c) return { ok: false, reason: 'customer_not_found' };

    const ep = await getEndpoint(CUSTOMER_KEY);
    const user = await actorName(actorUserId, ep && ep.user_field);
    const payload = buildPayload(op, c, user);
    let status = 'pending';
    let note = null;

    if (!payload.rfc) {
      // RFC 는 CRM 의 조회 키다. 없으면 보낼 수 없다.
      status = 'skipped'; note = 'rfc_missing';
    } else if (op === 'delete') {
      // 한 번도 보낸 적 없는 고객의 삭제는 CRM 에 알릴 것이 없다(반려된 신규 등록 등).
      const sent = (await query(
        `SELECT 1 FROM crm_customer_outbox WHERE customer_id=$1 AND op='upsert' AND status='sent' LIMIT 1`,
        [customerId])).rows[0];
      if (!sent) { status = 'skipped'; note = 'never_sent'; }
    }

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
  const method = String(op === 'delete' ? ep.method_delete : ep.method_upsert || 'POST').toUpperCase();
  // DELETE 는 본문을 무시하는 서버가 흔하다 → 쿼리스트링에도 rfc 를 실어 준다.
  const target = (op === 'delete' && payload && payload.rfc)
    ? url + (url.includes('?') ? '&' : '?') + 'rfc=' + encodeURIComponent(payload.rfc)
    : url;
  const headers = { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' };
  const token = activeToken(ep);   // 테스트/운영 각자의 키
  if (token) headers[ep.auth_header || 'Authorization'] = token;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), Number(ep.timeout_ms) || 10000);
  const startedAt = Date.now();
  try {
    const res = await fetch(target, {
      method, headers,
      body: method === 'GET' ? undefined : JSON.stringify(payload),
      signal: ac.signal,
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = { raw: String(text).slice(0, 1000) }; }
    return { httpStatus: res.status, body, url: target, method, ms: Date.now() - startedAt };
  } catch (e) {
    return {
      error: (e && e.name === 'AbortError') ? 'timeout' : String((e && e.message) || e).slice(0, 300),
      url: target, method, ms: Date.now() - startedAt,
    };
  } finally { clearTimeout(t); }
}

/** 대기 건을 순서대로 전송. 워커·수동 재전송·적재 직후 즉시전송이 모두 이 함수를 탄다. */
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
        const done = attempts >= MAX_ATTEMPTS;
        put('status=$?', done ? 'failed' : 'pending');
        put('attempts=$?', attempts);
        put('http_status=$?', r.httpStatus || null);
        put('codigo_error=$?', codigo);
        put('response=$?', JSON.stringify(r.body));
        put('last_error=$?', String(note).slice(0, 500));
        put(`next_attempt_at = now() + ($? || ' seconds')::interval`, String(nextDelaySec(attempts)));
      }
      if (newCols) {
        put('env=$?', ep.env || null);
        put('url=$?', r.url || null);
        put('request_method=$?', r.method || null);
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
