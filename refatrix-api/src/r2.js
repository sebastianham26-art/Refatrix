// =====================================================================
// 2026-10-23 · Cloudflare R2 쓰기(S3 호환 PUT · AWS Signature V4) — SDK 없이 node:crypto 만
//   환경변수(Railway): R2_ACCOUNT_ID · R2_ACCESS_KEY_ID · R2_SECRET_ACCESS_KEY · R2_BUCKET · R2_PUBLIC_BASE
//   지금 쓰는 곳: VIO 프로모션 키트 사진 products/K0001/K0001_1.webp (키트 코드 폴더만 — 기존 제품 사진은 안 건드림)
// =====================================================================
import crypto from 'node:crypto';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
// S3 경로 인코딩: / 는 그대로, 나머지 RFC 3986
const encPath = (p) => String(p).split('/').map((x) => encodeURIComponent(x).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');

export function r2Config(env = process.env) {
  const c = {
    account: String(env.R2_ACCOUNT_ID || '').trim(), key: String(env.R2_ACCESS_KEY_ID || '').trim(),
    secret: String(env.R2_SECRET_ACCESS_KEY || '').trim(), bucket: String(env.R2_BUCKET || '').trim(),
    publicBase: String(env.R2_PUBLIC_BASE || 'https://pub-d34920cb200c42ce91c5cbda135f16d6.r2.dev').trim().replace(/\/+$/, ''),
    endpoint: String(env.R2_ENDPOINT || '').trim().replace(/\/+$/, ''),   // 시험용(없으면 계정 주소)
  };
  c.ready = !!(c.account && c.key && c.secret && c.bucket);
  c.missing = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter((k, i) => ![c.account, c.key, c.secret, c.bucket][i]);
  return c;
}

/**
 * AWS SigV4 서명 — { method, host, path, query?, headers{소문자 키}, payloadHash, amzDate(YYYYMMDDTHHMMSSZ), region, service, key, secret }
 * → { authorization, signature, canonicalRequest, stringToSign }
 */
export function sigV4({ method, host, path, query = '', headers = {}, payloadHash, amzDate, region = 'auto', service = 's3', key, secret }) {
  const h = { ...headers, host };
  const names = Object.keys(h).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const canonicalHeaders = names.map((k) => k + ':' + lower[k] + '\n').join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kSign = hmac(hmac(hmac(hmac('AWS4' + secret, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSign).update(stringToSign).digest('hex');
  return { authorization: `AWS4-HMAC-SHA256 Credential=${key}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, signature, canonicalRequest, stringToSign };
}

/** R2 에 올린다 → { ok, key, url, status } (설정 없으면 { ok:false, error:'r2_not_configured', missing }) */
export async function r2Put(objectKey, body, { contentType = 'application/octet-stream', cacheControl = 'public, max-age=300', env = process.env, fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  const c = r2Config(env);
  if (!c.ready) return { ok: false, error: 'r2_not_configured', missing: c.missing };
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const base = c.endpoint || `https://${c.account}.r2.cloudflarestorage.com`;
  const u = new URL(base);
  const path = (u.pathname.replace(/\/+$/, '') || '') + '/' + encPath(c.bucket) + '/' + encPath(objectKey);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const payloadHash = sha256(buf);
  const headers = { 'content-type': contentType, 'cache-control': cacheControl, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const { authorization } = sigV4({ method: 'PUT', host: u.host, path, headers, payloadHash, amzDate, key: c.key, secret: c.secret });
  let res;
  try {
    res = await fetchImpl(u.origin + path, { method: 'PUT', headers: { ...headers, authorization, 'content-length': String(buf.length) }, body: buf, signal: AbortSignal.timeout(20000) });
  } catch (e) { return { ok: false, error: 'r2_unreachable', detail: String(e && e.message || e).slice(0, 200) }; }
  if (!res.ok) { let t = ''; try { t = (await res.text()).slice(0, 300); } catch (_) {} return { ok: false, error: 'r2_put_failed', status: res.status, detail: t }; }
  return { ok: true, key: objectKey, url: c.publicBase + '/' + encPath(objectKey), status: res.status };
}
