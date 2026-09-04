// 외부 연동 등록부 — 연동 1건 = integration_endpoints 의 1행.
//
//   URL(테스트/운영) · 메서드 · 인증 · 성공코드 · 계약서를 DB 에 두고 관리자 화면에서 고친다.
//   0200 의 환경변수(CRM_SYNC_*)는 **되돌아갈 자리**로만 남는다:
//   테이블이 없거나(마이그레이션 전) 그 키의 행이 없으면 환경변수 설정으로 동작한다.
import { query } from './db.js';
import { config } from './config.js';

export const CUSTOMER_KEY = 'customer_commercial';

let tableReady = null;
const cache = new Map();          // key → { at, ep }
const CACHE_MS = 15000;           // 화면에서 고친 값이 15초 안에 반영된다

export async function endpointsReady() {
  if (tableReady !== null) return tableReady;
  try {
    const r = await query(`SELECT to_regclass('public.integration_endpoints') AS t`);
    tableReady = !!(r.rows[0] && r.rows[0].t);
  } catch (_) { tableReady = false; }
  return tableReady;
}

export function invalidateEndpointCache(key) {
  if (key) cache.delete(key); else cache.clear();
}

/** 환경변수로 만든 대체 설정 — 마이그레이션 전에도 고객 전송이 죽지 않게. */
function fallbackEndpoint(key) {
  if (key !== CUSTOMER_KEY) return null;
  return {
    key, category: 'customer', label: '고객 상거래정보', description: null,
    enabled: !!config.crm.enabled, env: 'test',
    url_test: config.crm.url, url_prod: null,
    method_upsert: config.crm.methodUpsert, method_delete: config.crm.methodDelete,
    auth_header: config.crm.tokenHeader, auth_token: config.crm.token,
    ok_code: config.crm.okCode, user_field: config.crm.userField,
    timeout_ms: config.crm.timeoutMs, contract: {}, source: 'env',
  };
}

export function activeUrl(ep) {
  if (!ep) return '';
  return String((ep.env === 'prod' ? ep.url_prod : ep.url_test) || '').trim();
}

/** 전송에 쓸 설정. 못 찾으면 null. */
export async function getEndpoint(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ep;
  let ep = null;
  if (await endpointsReady()) {
    try {
      const r = (await query(`SELECT * FROM integration_endpoints WHERE key=$1`, [key])).rows[0];
      if (r) ep = { ...r, timeout_ms: Number(r.timeout_ms), source: 'db' };
    } catch (_) { /* 조회 실패 시 환경변수로 */ }
  }
  if (!ep) ep = fallbackEndpoint(key);
  cache.set(key, { at: Date.now(), ep });
  return ep;
}

export async function listEndpoints() {
  if (!(await endpointsReady())) {
    const f = fallbackEndpoint(CUSTOMER_KEY);
    return f ? [f] : [];
  }
  const rows = (await query(
    `SELECT * FROM integration_endpoints ORDER BY sort_order, id`)).rows;
  return rows.map((r) => ({ ...r, timeout_ms: Number(r.timeout_ms), source: 'db' }));
}

/** 화면으로 내려보낼 형태 — 토큰은 절대 값으로 내리지 않는다. */
export function publicEndpoint(ep) {
  if (!ep) return null;
  const url = activeUrl(ep);
  return {
    key: ep.key, category: ep.category, label: ep.label, description: ep.description,
    enabled: !!ep.enabled, env: ep.env,
    url_test: ep.url_test || '', url_prod: ep.url_prod || '',
    active_url: url,
    active_host: url ? url.replace(/^https?:\/\//, '').split('/')[0] : null,
    secure: /^https:/i.test(url),
    method_upsert: ep.method_upsert, method_delete: ep.method_delete,
    auth_header: ep.auth_header, has_token: !!ep.auth_token,
    ok_code: ep.ok_code, user_field: ep.user_field, timeout_ms: Number(ep.timeout_ms),
    contract: ep.contract || {},
    sort_order: ep.sort_order == null ? 100 : Number(ep.sort_order),
    source: ep.source || 'db',
    updated_at: ep.updated_at || null,
  };
}

const EDITABLE = ['category', 'label', 'description', 'enabled', 'env', 'url_test', 'url_prod',
  'method_upsert', 'method_delete', 'auth_header', 'ok_code', 'user_field', 'timeout_ms',
  'contract', 'sort_order'];
const METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'GET'];

export function validatePatch(p) {
  if (p.env != null && !['test', 'prod'].includes(String(p.env))) return 'env_invalid';
  for (const m of ['method_upsert', 'method_delete']) {
    if (p[m] != null && !METHODS.includes(String(p[m]).toUpperCase())) return 'method_invalid';
  }
  if (p.user_field != null && !['login_id', 'name', 'role'].includes(String(p.user_field))) return 'user_field_invalid';
  if (p.timeout_ms != null) {
    const n = Number(p.timeout_ms);
    if (!Number.isFinite(n) || n < 1000 || n > 60000) return 'timeout_invalid';
  }
  for (const f of ['url_test', 'url_prod']) {
    const v = p[f] == null ? '' : String(p[f]).trim();
    if (v && !/^https?:\/\//i.test(v)) return 'url_invalid';
  }
  // 운영으로 전환하려면 운영 URL 이 있어야 한다. 빈 주소로 켜 두면 전송이 조용히 멈춘다.
  if (String(p.env) === 'prod' && p.url_prod != null && !String(p.url_prod).trim()) return 'url_prod_required';
  return null;
}

/**
 * 설정 저장 + 변경 이력. auth_token 은 별도 취급:
 *   undefined = 그대로, '' = 지움, 값 = 교체. 이력에는 값 대신 '(변경됨)' 만 남긴다.
 */
export async function saveEndpoint(key, patch, userId) {
  const cur = (await query(`SELECT * FROM integration_endpoints WHERE key=$1`, [key])).rows[0];
  if (!cur) return { error: 'not_found' };
  const bad = validatePatch(patch);
  if (bad) return { error: bad };

  const sets = [];
  const params = [];
  const changes = {};
  for (const f of EDITABLE) {
    if (patch[f] === undefined) continue;
    let v = patch[f];
    if (f === 'enabled') v = !!v;
    else if (f === 'timeout_ms' || f === 'sort_order') v = Number(v);
    else if (f === 'method_upsert' || f === 'method_delete') v = String(v).toUpperCase();
    else if (f === 'contract') v = typeof v === 'string' ? v : JSON.stringify(v);
    else if (v != null) v = String(v);
    const before = f === 'contract' ? JSON.stringify(cur[f] || {}) : cur[f];
    const after = f === 'contract' ? v : v;
    if (String(before ?? '') === String(after ?? '')) continue;
    params.push(v);
    sets.push(`${f}=$${params.length}${f === 'contract' ? '::jsonb' : ''}`);
    changes[f] = f === 'contract'
      ? { old: '(계약서)', new: '(계약서 수정됨)' }
      : { old: cur[f] === null ? null : String(cur[f]), new: v === null ? null : String(v) };
  }
  if (patch.auth_token !== undefined) {
    const t = String(patch.auth_token);
    params.push(t === '' ? null : t);
    sets.push(`auth_token=$${params.length}`);
    changes.auth_token = { old: cur.auth_token ? '(설정됨)' : null, new: t === '' ? null : '(변경됨)' };
  }
  if (!sets.length) return { ok: true, unchanged: true };

  params.push(userId || null);
  sets.push(`updated_by=$${params.length}`);
  sets.push('updated_at=now()');
  params.push(key);
  await query(`UPDATE integration_endpoints SET ${sets.join(', ')} WHERE key=$${params.length}`, params);
  try {
    await query(
      `INSERT INTO integration_endpoint_changes (endpoint_id, changed_by, changes) VALUES ($1,$2,$3)`,
      [cur.id, userId || null, JSON.stringify(changes)]);
  } catch (_) { /* 이력 실패가 저장을 되돌리지는 않는다 */ }
  invalidateEndpointCache(key);
  return { ok: true, changes };
}

export async function createEndpoint(body, userId) {
  const key = String(body.key || '').trim();
  if (!/^[a-z0-9_]{3,40}$/.test(key)) return { error: 'key_invalid', note: '영문 소문자·숫자·밑줄 3~40자' };
  const dup = (await query(`SELECT 1 FROM integration_endpoints WHERE key=$1`, [key])).rows[0];
  if (dup) return { error: 'key_taken' };
  const bad = validatePatch(body);
  if (bad) return { error: bad };
  const r = (await query(
    `INSERT INTO integration_endpoints (key, category, label, description, env, url_test, url_prod, contract, sort_order, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING *`,
    [key, String(body.category || 'other'), String(body.label || key), body.description || null,
     ['test', 'prod'].includes(body.env) ? body.env : 'test',
     body.url_test || null, body.url_prod || null,
     JSON.stringify(body.contract || { fields: [], sample_request: '', sample_response: '', raw: '', notes: '' }),
     Number(body.sort_order || 100), userId || null])).rows[0];
  invalidateEndpointCache();
  return { ok: true, endpoint: r };
}
