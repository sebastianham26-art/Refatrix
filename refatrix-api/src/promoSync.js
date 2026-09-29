// ERP → CRM 프로모션 배너 연동 (0237).
//
//   흐름
//     ERP 에서 프로모션(설명·할인·기간·배너)을 등록하고 「저장하고 전송」
//       → 고른 전송 창구(integration_endpoints, category='promotion') 마다 아웃박스에 1건씩 적재
//       → 기존 전송 엔진(crmSync.pumpOutbox)이 즉시 보내고, 실패하면 같은 규칙으로 재시도한다
//       → CRM 은 fechaInicio~fechaFin 동안 배너로 보여 준다
//
//   설계 원칙
//   ① 창구 1개 = CRM 1곳. 여러 고객사에 보내려면 창구를 여러 개 등록하면 된다.
//      주소·키·환경(테스트/운영)·재시도·이력은 창구마다 따로 — 한 곳이 죽어도 나머지는 나간다.
//   ② 새 엔진을 만들지 않는다. 아웃박스에 entity='promo' 로 쌓을 뿐이다.
//   ③ 배너 이미지는 **주소로** 보낸다(본문에 base64 를 싣지 않는다). 주소에 내용 해시가 들어가므로
//      이미지를 바꾸면 주소가 바뀌고, CRM 이나 브라우저의 캐시에 옛 그림이 남지 않는다.
//   ④ 같은 프로모션·같은 창구에 **대기 중인 옛 버전**이 있으면 새 버전을 쌓을 때 건너뜀으로 닫는다
//      (옛 본문이 새 본문 뒤늦게 도착해 되돌리는 사고를 막는다). CRM 쪽에서도 version 으로 거른다.
//   ⑤ 종료일이 지나면(멕시코 날짜) 자동으로 「finalizada」 를 보내 내린다 — CRM 이 날짜를
//      안 지켜도 배너가 남지 않게. 프로모션마다 끌 수 있다(auto_withdraw).
import { createHash } from 'node:crypto';
import { query } from './db.js';
import { getEndpoint } from './integrations.js';
import { scheduleDrain } from './crmSync.js';

export const PROMO_ENTITY = 'promo';
export const PROMO_CATEGORY = 'promotion';
export const PROMO_TYPES = ['porcentaje', 'monto', 'otro'];
export const BANNER_MIMES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
export const BANNER_MAX_BYTES = 5 * 1024 * 1024;   // 5MB — base64 로 받아도 서버 bodyLimit(12MB) 안쪽
export const MX_TZ = 'America/Mexico_City';

// ── 준비 여부(반쪽 배포에서도 서버가 죽지 않게). 긍정만 영구 캐시 ─────────────────
let ready = false; let probeAt = 0;
export async function promoReady() {
  if (ready) return true;
  if (Date.now() - probeAt < 30000) return false;
  probeAt = Date.now();
  try {
    const r = await query(`SELECT to_regclass('public.crm_promotions') AS t`);
    ready = !!(r.rows[0] && r.rows[0].t);
  } catch (_) { ready = false; }
  return ready;
}

// ── 순수 규칙 ────────────────────────────────────────────────────────────────
export function promoCode(id) { return 'PR-' + String(Number(id) || 0).padStart(6, '0'); }

/** ERP 가 CRM 에 알려 줄 자기 공개 주소. Railway 변수 PUBLIC_API_URL 로 바꿀 수 있다. */
export function publicBase() {
  const v = String(process.env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '');
  return v || 'https://refatrix-production.up.railway.app';
}

export function bannerFile(p) {
  if (!p || !p.image_sha || !p.image_mime) return null;
  const ext = BANNER_MIMES[String(p.image_mime).toLowerCase()] || 'img';
  return `${Number(p.id)}-${String(p.image_sha).slice(0, 16)}.${ext}`;
}

export function bannerUrl(p, base = publicBase()) {
  const f = bannerFile(p);
  return f ? `${base}/api/public/promo-banners/${f}` : '';
}

/** 공개 주소의 파일 이름을 풀어낸다. 모양이 틀리면 null. */
export function parseBannerFile(name) {
  const m = String(name || '').match(/^(\d{1,12})-([0-9a-f]{16})\.(png|jpg|webp|gif|img)$/);
  return m ? { id: Number(m[1]), sha16: m[2], ext: m[3] } : null;
}

export function sha256Hex(buf) { return createHash('sha256').update(buf).digest('hex'); }

/**
 * data URL 검사. { ok, mime, buf } 또는 { ok:false, error }.
 *   배너는 사람이 보는 그림이다 — PDF·SVG 는 받지 않는다(SVG 는 스크립트를 품을 수 있다).
 */
export function decodeBannerDataUrl(dataUrl, maxBytes = BANNER_MAX_BYTES) {
  if (typeof dataUrl !== 'string' || !dataUrl) return { ok: false, error: 'image_empty' };
  const m = dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) return { ok: false, error: 'image_bad_format' };
  const mime = m[1].toLowerCase().trim().replace('image/jpg', 'image/jpeg');
  if (!BANNER_MIMES[mime]) return { ok: false, error: 'image_bad_mime' };
  const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (!buf.length) return { ok: false, error: 'image_empty' };
  if (buf.length > maxBytes) return { ok: false, error: 'image_too_large' };
  const dim = imageSize(buf);
  if (!dim) return { ok: false, error: 'image_unreadable' };
  // 확장자가 거짓말하는 파일(예: 이름만 .png 인 jpeg)은 **실제 형식**으로 기록한다.
  return { ok: true, mime: dim.mime || mime, buf, width: dim.width, height: dim.height };
}

/**
 * 이미지 가로·세로를 파일 머리에서 읽는다(외부 라이브러리 없이).
 *   PNG · JPEG · GIF · WEBP(VP8 / VP8L / VP8X). 못 읽으면 null.
 */
export function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF
  if (buf.toString('ascii', 0, 3) === 'GIF') {
    return { mime: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // WEBP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8X' && buf.length >= 30) {
      return { mime: 'image/webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
    if (fmt === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { mime: 'image/webp', width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
    }
    if (fmt === 'VP8 ' && buf.length >= 30) {
      return { mime: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    return null;
  }
  // JPEG — SOF 표지를 찾아 내려간다
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xff) { i++; continue; }
      const len = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { mime: 'image/jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/** 배너가 창구 규격과 맞는가. 규격이 비어 있으면 검사하지 않는다(ok). */
export function sizeCheck(img, ep) {
  const w = Number(ep && ep.banner_w) || 0;
  const h = Number(ep && ep.banner_h) || 0;
  if (!w || !h) return { ok: true, required: null };
  if (!img || !img.image_w || !img.image_h) return { ok: false, required: { w, h }, actual: null };
  const ok = Number(img.image_w) === w && Number(img.image_h) === h;
  return { ok, required: { w, h }, actual: { w: Number(img.image_w), h: Number(img.image_h) } };
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
function validYmd(s) {
  if (!YMD.test(String(s || ''))) return false;
  const d = new Date(String(s) + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === String(s);
}

/**
 * 입력 검사. 저장(draft) 기준과 전송(publish) 기준이 다르다:
 *   전송하려면 배너 이미지와 대상 창구가 있어야 한다.
 */
export function validatePromo(b, { publish = false, hasImage = false } = {}) {
  const title = String(b.title == null ? '' : b.title).trim();
  if (!title) return 'title_required';
  if (title.length > 120) return 'title_too_long';
  if (b.description != null && String(b.description).length > 4000) return 'description_too_long';
  const type = String(b.promo_type || 'porcentaje');
  if (!PROMO_TYPES.includes(type)) return 'type_invalid';
  if (type !== 'otro') {
    const v = Number(b.discount_value);
    if (b.discount_value === '' || b.discount_value == null || !Number.isFinite(v) || v <= 0) return 'value_required';
    if (type === 'porcentaje' && v > 100) return 'value_pct_range';
  }
  if (!validYmd(b.start_date) || !validYmd(b.end_date)) return 'date_invalid';
  if (String(b.end_date) < String(b.start_date)) return 'date_order';
  const link = String(b.link_url == null ? '' : b.link_url).trim();
  if (link && (!/^https?:\/\//i.test(link) || /\s/.test(link))) return 'link_invalid';
  if (b.priority != null && b.priority !== '') {
    const p = Number(b.priority);
    if (!Number.isInteger(p) || p < 0 || p > 9999) return 'priority_invalid';
  }
  if (publish) {
    if (!hasImage) return 'image_required';
    if (!Array.isArray(b.targets) || !b.targets.length) return 'targets_required';
  }
  return null;
}

/** 지금 멕시코 날짜 기준 상태. */
export function promoPhase(p, todayYmd) {
  if (!p) return 'draft';
  if (p.status === 'cancelled') return 'cancelled';
  if (p.status !== 'published') return 'draft';
  const s = ymdOf(p.start_date); const e = ymdOf(p.end_date);
  if (todayYmd < s) return 'scheduled';
  if (todayYmd > e) return 'ended';
  return 'active';
}

export function ymdOf(v) {
  if (v == null) return '';
  if (v instanceof Date) {
    // node-pg 는 DATE 를 **로컬 자정** Date 로 준다 — toISOString 을 쓰면 하루 밀린다.
    const y = v.getFullYear(); const m = String(v.getMonth() + 1).padStart(2, '0'); const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

/** 평평한 이름 바꾸기 — 창구의 field_map({우리이름: 상대이름}). 빈 값이면 그 필드를 뺀다. */
export function applyFlatMap(obj, map) {
  if (!map || typeof map !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (Object.prototype.hasOwnProperty.call(map, k)) {
      const to = map[k] == null ? '' : String(map[k]).trim();
      if (!to) continue;                 // 빈 이름 = 보내지 않는다
      out[to] = v;
    } else out[k] = v;
  }
  return out;
}

/**
 * 전송 본문. 실제 전송 · 미리보기 · 연결 테스트가 **모두 이 함수**를 쓴다
 * (시험만 다른 모양이면 「테스트는 되는데 실전은 안 되는」 상황이 생긴다).
 *   op: 'upsert' → estatus 'activa' · 'delete' → 'cancelada' 또는 'finalizada'
 */
export function buildPromoPayload(p, { op = 'upsert', user = 'erp', base = publicBase(), map = null, reason = null } = {}) {
  const id = promoCode(p.id);
  if (op === 'delete') {
    const body = {
      promocionId: id,
      version: Number(p.version) || 0,
      estatus: reason === 'finalizada' ? 'finalizada' : 'cancelada',
      transactionUser: String(user || 'erp'),
    };
    return applyFlatMap(body, map);
  }
  const type = PROMO_TYPES.includes(p.promo_type) ? p.promo_type : 'otro';
  const body = {
    promocionId: id,
    version: Number(p.version) || 0,
    estatus: 'activa',
    titulo: String(p.title || ''),
    descripcion: String(p.description || ''),
    tipoPromocion: type,
    valorDescuento: type === 'otro' || p.discount_value == null ? null : Number(p.discount_value),
    condiciones: String(p.conditions || ''),
    fechaInicio: ymdOf(p.start_date),
    fechaFin: ymdOf(p.end_date),
    zonaHoraria: MX_TZ,
    bannerUrl: bannerUrl(p, base),
    bannerAncho: p.image_w == null ? null : Number(p.image_w),
    bannerAlto: p.image_h == null ? null : Number(p.image_h),
    bannerTipo: p.image_mime || null,
    enlace: String(p.link_url || ''),
    prioridad: p.priority == null ? 100 : Number(p.priority),
    transactionUser: String(user || 'erp'),
  };
  return applyFlatMap(body, map);
}

// ── DB ─────────────────────────────────────────────────────────────────────
export const PROMO_COLS = `p.id, p.title, p.description, p.promo_type, p.discount_value, p.conditions,
  to_char(p.start_date,'YYYY-MM-DD') AS start_date, to_char(p.end_date,'YYYY-MM-DD') AS end_date,
  p.link_url, p.priority, p.auto_withdraw, p.status, p.version,
  p.image_mime, p.image_name, p.image_bytes, p.image_w, p.image_h, p.image_sha,
  p.published_at, p.cancelled_at, p.withdrawn_at, p.created_at, p.updated_at, p.created_by, p.updated_by`;

export async function mxToday(q = query) {
  const r = await q(`SELECT to_char((now() AT TIME ZONE '${MX_TZ}')::date,'YYYY-MM-DD') AS d`);
  return r.rows[0].d;
}

export async function getPromo(id, q = query) {
  return (await q(`SELECT ${PROMO_COLS} FROM crm_promotions p WHERE p.id=$1 AND p.deleted_at IS NULL`, [Number(id)])).rows[0] || null;
}

export async function promoTargets(id, q = query) {
  return (await q(`SELECT endpoint_key FROM crm_promotion_targets WHERE promotion_id=$1 ORDER BY endpoint_key`,
    [Number(id)])).rows.map((r) => r.endpoint_key);
}

/** 프로모션 창구 목록(전송용만). */
export async function listPromoEndpoints(q = query) {
  const rows = (await q(
    `SELECT * FROM integration_endpoints
      WHERE category=$1 AND COALESCE(direction,'out')='out'
      ORDER BY sort_order, id`, [PROMO_CATEGORY])).rows;
  return rows;
}

/** 이 프로모션이 **실제로 한 번이라도 나간(또는 나가려고 대기 중인)** 창구들 — 내리기 대상. */
export async function deliveredKeys(id, q = query) {
  return (await q(
    `SELECT DISTINCT endpoint_key FROM crm_customer_outbox
      WHERE entity=$1 AND entity_id=$2 AND op='upsert' AND status IN ('sent','pending','failed')`,
    [PROMO_ENTITY, Number(id)])).rows.map((r) => r.endpoint_key);
}

async function actorLabel(userId, userField, q = query) {
  if (!userId) return 'erp';
  try {
    const u = (await q(`SELECT login_id, name, role FROM users WHERE id=$1`, [Number(userId)])).rows[0];
    const f = ['login_id', 'name', 'role'].includes(userField) ? userField : 'login_id';
    return String((u && u[f]) || 'erp');
  } catch (_) { return 'erp'; }
}

/**
 * 창구마다 1건씩 아웃박스에 쌓는다. 같은 프로모션·같은 창구의 **대기 중인 옛 건**은 건너뜀으로 닫는다.
 *   @returns {{queued:number[], skipped_old:number, missing:string[]}}
 */
export async function enqueuePromo(p, keys, op, { origin = 'promo_publish', actorUserId = null, reason = null, q = query } = {}) {
  const queued = []; const missing = []; let skippedOld = 0;
  const label = `${promoCode(p.id)} ${String(p.title || '').slice(0, 80)}`.trim();
  for (const key of [...new Set(keys || [])]) {
    const ep = await getEndpoint(key);
    if (!ep || ep.category !== PROMO_CATEGORY || ep.direction === 'in') { missing.push(key); continue; }
    const user = await actorLabel(actorUserId, ep.user_field, q);
    const payload = buildPromoPayload(p, { op, user, map: ep.field_map || null, reason });
    const old = await q(
      `UPDATE crm_customer_outbox
          SET status='skipped', last_error='새 버전으로 대체되어 보내지 않음'
        WHERE entity=$1 AND entity_id=$2 AND endpoint_key=$3 AND status='pending'`,
      [PROMO_ENTITY, Number(p.id), key]);
    skippedOld += old.rowCount || 0;
    const ins = (await q(
      `INSERT INTO crm_customer_outbox
         (customer_id, entity, entity_id, entity_label, endpoint_key, op, origin, rfc, payload, status, acted_by)
       VALUES (NULL,$1,$2,$3,$4,$5,$6,NULL,$7,'pending',$8) RETURNING id`,
      [PROMO_ENTITY, Number(p.id), label, key, op, origin, JSON.stringify(payload), actorUserId || null])).rows[0];
    queued.push(Number(ins.id));
  }
  return { queued, skipped_old: skippedOld, missing };
}

/**
 * 전송(발행). version 을 올리고, 고른 창구로 upsert, **빠진 창구**에는 내리기(delete)를 보낸다.
 */
export async function publishPromo(id, { actorUserId, app, origin = 'promo_publish' } = {}) {
  await query(
    `UPDATE crm_promotions SET status='published', version=version+1,
            published_at=COALESCE(published_at, now()), cancelled_at=NULL, withdrawn_at=NULL,
            updated_by=$2, updated_at=now()
      WHERE id=$1 AND deleted_at IS NULL`, [Number(id), actorUserId || null]);
  const p = await getPromo(id);
  if (!p) return { error: 'not_found' };
  const keys = await promoTargets(id);
  const up = await enqueuePromo(p, keys, 'upsert', { origin, actorUserId });
  const removed = (await deliveredKeys(id)).filter((k) => !keys.includes(k));
  const down = removed.length
    ? await enqueuePromo(p, removed, 'delete', { origin: 'promo_target_removed', actorUserId, reason: 'cancelada' })
    : { queued: [], skipped_old: 0, missing: [] };
  if (app !== null) scheduleDrain(app);
  return { ok: true, version: Number(p.version), sent_to: keys, removed_from: removed,
           queued: up.queued.length + down.queued.length, missing: up.missing, replaced: up.skipped_old + down.skipped_old };
}

/** 취소 — 나간 적 있는 창구 전부에 내리기를 보낸다. */
export async function cancelPromo(id, { actorUserId, app, reason = 'cancelada', origin = 'promo_cancel' } = {}) {
  const p0 = await getPromo(id);
  if (!p0) return { error: 'not_found' };
  if (reason === 'cancelada') {
    await query(
      `UPDATE crm_promotions SET status='cancelled', version=version+1, cancelled_at=now(), updated_by=$2, updated_at=now()
        WHERE id=$1`, [Number(id), actorUserId || null]);
  } else {
    await query(`UPDATE crm_promotions SET version=version+1, withdrawn_at=now() WHERE id=$1`, [Number(id)]);
  }
  const p = await getPromo(id);
  const keys = await deliveredKeys(id);
  const r = keys.length ? await enqueuePromo(p, keys, 'delete', { origin, actorUserId, reason })
    : { queued: [], skipped_old: 0, missing: [] };
  if (keys.length && app !== null) scheduleDrain(app);
  return { ok: true, withdrawn_from: keys, queued: r.queued.length, replaced: r.skipped_old };
}

/** 창구별 최근 전송 상태(화면의 「어디까지 나갔나」). */
export async function deliveries(id, q = query) {
  const rows = (await q(
    `SELECT DISTINCT ON (o.endpoint_key)
            o.endpoint_key, o.id, o.op, o.status, o.attempts, o.http_status, o.codigo_error, o.last_error,
            o.created_at, o.sent_at, o.env, o.payload->>'version' AS version
       FROM crm_customer_outbox o
      WHERE o.entity=$1 AND o.entity_id=$2 AND o.status <> 'skipped'
      ORDER BY o.endpoint_key, o.id DESC`, [PROMO_ENTITY, Number(id)])).rows;
  return rows.map((r) => ({
    endpoint_key: r.endpoint_key, outbox_id: Number(r.id), op: r.op, status: r.status,
    attempts: Number(r.attempts), http_status: r.http_status == null ? null : Number(r.http_status),
    codigo_error: r.codigo_error, last_error: r.last_error, created_at: r.created_at, sent_at: r.sent_at,
    env: r.env, version: r.version == null ? null : Number(r.version),
  }));
}

/**
 * 종료 후 자동 내리기 — 종료일이 지난(멕시코 날짜) 발행 건을 한 번만 내린다.
 *   조건을 UPDATE … RETURNING 으로 잠그므로 워커가 겹쳐 돌아도 두 번 나가지 않는다.
 */
export async function sweepEndedPromos({ app } = {}) {
  if (!(await promoReady())) return { ready: false };
  const due = (await query(
    `UPDATE crm_promotions SET withdrawn_at=now()
      WHERE status='published' AND auto_withdraw AND withdrawn_at IS NULL AND deleted_at IS NULL
        AND end_date < (now() AT TIME ZONE '${MX_TZ}')::date
      RETURNING id`)).rows.map((r) => Number(r.id));
  let queued = 0;
  for (const id of due) {
    try {
      const r = await cancelPromo(id, { app: null, reason: 'finalizada', origin: 'promo_auto_end' });
      queued += r.queued || 0;
    } catch (e) { try { console.error('[promoSync] 자동 내리기 실패', id, e && e.message); } catch (_) {} }
  }
  if (queued) scheduleDrain(app);
  return { ready: true, ended: due.length, queued };
}

let timer = null;
export function startPromoWorker(app) {
  if (timer) return;
  const ms = 10 * 60 * 1000;
  const tick = () => { sweepEndedPromos({ app }).catch(() => {}); };
  timer = setInterval(tick, ms);
  if (timer.unref) timer.unref();
  setTimeout(tick, 20000).unref?.();
  try { app?.log?.info?.('[promoSync] 종료 프로모션 자동 내리기 감시 — 10분 주기'); } catch (_) {}
}

