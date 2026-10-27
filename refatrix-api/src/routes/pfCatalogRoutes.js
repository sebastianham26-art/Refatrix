// =====================================================================
// Refatrix ERP · pfCatalogRoutes.js — REFATRIX Platform 「제품 카탈로그 점검」 (0302 · 2026-10-27)
//   화면: REFATRIX Platform 의 catalog.html (원본 refatrix-api/templates/catalog_platform.html)
//
//   POST   /api/pf-catalog/login {token, name, user_key}   플랫폼 세션 → 1시간 토큰(typ pf_cat · ERP API 는 전부 401)
//   GET    /api/pf-catalog/summary                         상태별 건수(미검토 · 작성중 · 확인완료 · 재확인)
//   GET    /api/pf-catalog/items?q=&status=&active=&sort=&limit=&offset=
//   GET    /api/pf-catalog/items/:id                       1건 + ERP 변경 이력 + 확인 이력 + 나눠 넣기 미리보기
//   POST   /api/pf-catalog/preview {scode, app, oe}        입력 중 미리보기(저장하지 않음)
//   PUT    /api/pf-catalog/items/:id/draft {fields, note}  수정안 저장(ERP 는 아직 그대로)
//   DELETE /api/pf-catalog/items/:id/draft                 수정안 버리기
//   POST   /api/pf-catalog/items/:id/confirm {fields?, resolve?, note?}
//          → ERP 제품 마스터 즉시 반영(승인 없음) · 제품 이력 「CTR 확인(Platform)」 · CRM 즉시 전송 예약
//          → 그사이 ERP 에서 같은 칸이 바뀌었으면 409 conflict(아무것도 바꾸지 않음 · 입력은 수정안으로 보존)
//
//   신원: 플랫폼 세션을 ERP 서버가 플랫폼 RPC app_log 로 직접 확인한다(설문 · 마케팅 이미지와 같은 방식).
//   가격 · 재고는 이 라우트들이 읽지도 쓰지도 않는다.
// =====================================================================
import geoip from 'geoip-lite';
import { logEvent } from '../audit.js';
import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { platformApi } from '../surveyViewer.js';
import { scheduleDevMatchSweep } from '../devMatchSweep.js';
import { pushProductsSoon } from '../productSync.js';
import {
  pfCatalogReady, listItems, summary, getItem, saveDraft, discardDraft, confirmItem,
  previewDerived, normValue, PF_FIELDS, exportItems, logExport, listExports, EXPORT_MAX,
  options, markReviewed, listBulkBatches,
} from '../pfCatalog.js';

// 접속 IP — 사설 · 로컬 주소는 위치를 알 수 없으니 비운다(presenceRoutes 와 같은 규칙).
function publicIp(req) {
  let ip = String(req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (!ip || ip === '::1' || ip === '127.0.0.1') return null;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip) || /^(fc|fd)/i.test(ip)) return null;
  return ip;
}
const num = (v, lim) => { const n = Number(v); return Number.isFinite(n) && Math.abs(n) <= lim ? n : null; };

const PF_TYP = 'pf_cat';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n) || null;
const idOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

/** 보낸 칸만 골라낸다 — 모르는 칸·가격·재고는 여기서 버린다. */
function pickFields(b) {
  const src = b && typeof b === 'object' ? b : {};
  const out = {};
  for (const f of PF_FIELDS) if (src[f] !== undefined) out[f] = src[f] == null ? '' : String(src[f]).slice(0, 8000);
  return out;
}
/** 화면이 열 때 받은 ERP 값 — 「그사이 바뀌었는지」 판단의 기준. */
function pickLoaded(b) {
  if (!b || typeof b !== 'object') return null;
  const out = {};
  for (const f of PF_FIELDS) if (b[f] !== undefined) out[f] = b[f] == null ? null : String(b[f]).slice(0, 8000);
  return out;
}
const pickRev = (v) => (v === undefined || v === null ? undefined : String(v).slice(0, 64));
function pickResolve(b) {
  const out = {};
  if (!b || typeof b !== 'object') return out;
  for (const f of PF_FIELDS) if (b[f] === 'mine' || b[f] === 'erp') out[f] = b[f];
  return out;
}

export default async function pfCatalogRoutes(app) {
  async function guard(req, reply) {
    try { await req.jwtVerify(); } catch { return reply.code(401).send({ error: 'unauthorized' }); }
    const u = req.user || {};
    if (u.typ !== PF_TYP || !u.uk) return reply.code(401).send({ error: 'unauthorized' });
    if (!(await pfCatalogReady())) return reply.code(503).send({ error: 'migration_required' });
    req.pf = { key: String(u.uk), name: String(u.name || 'REFATRIX Platform'), pt: u.pt ? String(u.pt) : null };
    reply.header('cache-control', 'no-store');
  }
  const G = { preHandler: [guard] };

  /** 플랫폼 활동 로그(비트코라)에 남긴다 — 응답을 기다리게 하지 않는다. */
  function pfLog(req, txt) {
    if (!req.pf || !req.pf.pt) return;
    platformApi.log(req.pf.pt, txt).catch(() => {});
  }

  app.post('/api/pf-catalog/login', async (req, reply) => {
    const b = req.body || {};
    const tok = String(b.token || '').trim();
    if (!UUID_RE.test(tok)) return reply.code(401).send({ error: 'platform_session_invalid' });
    const chk = await platformApi.log(tok, '제품 카탈로그 점검 접속 (ERP 연동)');
    if (!chk.ok) return reply.code(chk.invalid ? 401 : 502).send({ error: chk.invalid ? 'platform_session_invalid' : (chk.error || 'platform_unreachable') });
    const name = clean(b.name, 80) || 'REFATRIX Platform';
    const uk = clean(b.user_key, 80) || name;
    await logEvent({ userId: null, action: 'login', target: 'pf_catalog:' + name, result: 'ok' }).catch(() => {});
    const token = await reply.jwtSign({ sub: 'pfcat', typ: PF_TYP, uk, name, pt: tok }, { expiresIn: '1h' });
    return { token, name, ready: await pfCatalogReady() };
  });

  app.get('/api/pf-catalog/summary', G, async () => summary());

  app.get('/api/pf-catalog/items', G, async (req) => {
    const q = req.query || {};
    const r = await listItems({
      q: String(q.q || '').slice(0, 80), status: String(q.status || ''), active: String(q.active || 'all'), round: String(q.round || ''), tag: String(q.tag || ''),
      sort: String(q.sort || 'code'), limit: q.limit, offset: q.offset,
    });
    return { ...r, limit: Math.max(1, Math.min(200, parseInt(q.limit, 10) || 50)), offset: Math.min(1000000, Math.max(0, parseInt(q.offset, 10) || 0)) };
  });

  app.get('/api/pf-catalog/items/:id', G, async (req, reply) => {
    const id = idOf(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const it = await getItem(id);
    if (!it) return reply.code(404).send({ error: 'not_found' });
    return it;
  });

  app.post('/api/pf-catalog/preview', G, async (req) => {
    const f = pickFields(req.body);
    return previewDerived({ scode: normValue('scode', f.scode), app: normValue('app', f.app), oe: normValue('oe', f.oe) });
  });

  app.put('/api/pf-catalog/items/:id/draft', G, async (req, reply) => {
    const id = idOf(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const b = req.body || {};
    const r = await saveDraft(id, { fields: pickFields(b.fields), note: b.note === undefined ? undefined : b.note, pf: req.pf,
      loaded: pickLoaded(b.loaded), rev: pickRev(b.rev) });
    if (r.error === 'stale_review' || r.error === 'locked') return reply.code(409).send({ ...r, item: await getItem(id) });
    if (r.error) return reply.code(r.error === 'not_found' ? 404 : 400).send(r);
    return { ok: true, fields: r.fields, item: await getItem(id) };
  });

  app.delete('/api/pf-catalog/items/:id/draft', G, async (req, reply) => {
    const id = idOf(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    await discardDraft(id);
    const it = await getItem(id);
    if (!it) return reply.code(404).send({ error: 'not_found' });
    return { ok: true, item: it };
  });

  // ── 엑셀 다운로드 — 위치(GPS) · 일시 · IP 를 남기고 나서 데이터를 준다 ──
  //   body { filters:{q,status,active}, gps:{lat,lng,acc}|null, gps_status:'ok'|'denied'|'unavailable' }
  //   위치 권한을 거부하면 내려주지 않는다(플랫폼 로그인과 같은 원칙 — 위치 기록은 필수).
  //   시간 초과 · 미지원(unavailable)은 IP 로 추정한 도시만 남기고 허용한다.
  app.post('/api/pf-catalog/export', G, async (req, reply) => {
    const b = req.body || {};
    if (b.gps_status === 'denied') return reply.code(403).send({ error: 'location_required' });
    const g0 = b.gps && typeof b.gps === 'object' ? b.gps : {};
    const lat = num(g0.lat, 90); const lng = num(g0.lng, 180); const acc = num(g0.acc, 1e7);
    const hasGps = lat != null && lng != null;
    const f0 = b.filters && typeof b.filters === 'object' ? b.filters : {};
    const filters = { q: String(f0.q || '').slice(0, 80), status: String(f0.status || ''), active: f0.active === '1' ? '1' : 'all',
      round: String(f0.round || '').slice(0, 8), tag: String(f0.tag || '').slice(0, 10) };
    const data = await exportItems(filters);
    const ip = publicIp(req);
    let geo = null; if (ip) { try { geo = geoip.lookup(ip); } catch (_) { geo = null; } }
    const rec = await logExport({
      pf_user: req.pf.key, pf_user_name: req.pf.name, row_count: data.items.length, filters,
      gps_status: hasGps ? 'ok' : 'unavailable', gps_lat: hasGps ? lat : null, gps_lng: hasGps ? lng : null, gps_acc: hasGps ? acc : null,
      ip, geo_city: geo && geo.city ? geo.city : null, geo_region: geo && geo.region ? geo.region : null,
      geo_country: geo && geo.country ? geo.country : null, user_agent: String(req.headers['user-agent'] || '').slice(0, 300) || null,
    });
    pfLog(req, `제품 카탈로그 엑셀 다운로드 · ${data.items.length}건 · #${rec.id}${hasGps ? '' : ' (GPS 없음)'}`);
    await logEvent({ userId: null, action: 'export', target: 'pf_catalog_export', detail: { id: rec.id, by: req.pf.name, rows: data.items.length } }).catch(() => {});
    return { export_id: rec.id, at: rec.created_at, by: req.pf.name, max: EXPORT_MAX, ...data };
  });

  // ── 고르기 목록(제품명 · 소재) ──
  app.get('/api/pf-catalog/options', G, async () => options());

  // ── 디렉터(ERP) — CTR 코드 엑셀 일괄 「검토완료」 ──
  //   body { codes:[...], file_name }  — 화면이 엑셀을 읽어 코드만 보낸다(최대 30,000)
  app.post('/api/pf-catalog/admin/mark-reviewed', { preHandler: [authGuard, requireDirector], bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    if (!(await pfCatalogReady())) return reply.code(503).send({ error: 'migration_required' });
    const b = req.body || {};
    const codes = Array.isArray(b.codes) ? b.codes.slice(0, 30000) : [];
    if (!codes.length) return reply.code(400).send({ error: 'no_codes' });
    const uid = req.ctx && req.ctx.perm ? req.ctx.perm.userId : null;
    let uname = null;
    try { uname = (await query(`SELECT name FROM users WHERE id=$1`, [uid])).rows[0]?.name || null; } catch (_) {}
    // 0304 · 차수(1~9)와 검토일(YYYY-MM-DD) — 검토일은 내일 이후면 거절(입력 실수)
    const round = b.round == null || b.round === '' ? null : parseInt(b.round, 10);
    if (round != null && !(round >= 1 && round <= 9)) return reply.code(400).send({ error: 'bad_round' });
    const day = b.reviewed_on ? String(b.reviewed_on).slice(0, 10) : null;
    if (day && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day + 'T00:00:00Z')) || day > new Date(Date.now() + 18 * 3600e3).toISOString().slice(0, 10))) {
      return reply.code(400).send({ error: 'bad_date' });
    }
    const r = await markReviewed(codes, { userId: uid, userName: uname, fileName: b.file_name, round, reviewedOn: day });
    await logEvent({ userId: uid, action: 'update', target: 'pf_catalog_bulk_reviewed', detail: { batch: r.batch_id, marked: r.marked, codes: r.codes_in, round: r.round, reviewed_on: r.reviewed_on } }).catch(() => {});
    return r;
  });
  app.get('/api/pf-catalog/admin/bulk', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    if (!(await pfCatalogReady())) return reply.code(503).send({ error: 'migration_required' });
    reply.header('cache-control', 'no-store');
    return { items: await listBulkBatches({ limit: (req.query || {}).limit }) };
  });

  // ── 디렉터(ERP) — 다운로드 기록 보기 ──
  app.get('/api/pf-catalog/admin/exports', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    if (!(await pfCatalogReady())) return reply.code(503).send({ error: 'migration_required' });
    reply.header('cache-control', 'no-store');
    return listExports({ limit: (req.query || {}).limit, offset: (req.query || {}).offset });
  });

  app.post('/api/pf-catalog/items/:id/confirm', G, async (req, reply) => {
    const id = idOf(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const b = req.body || {};
    const r = await confirmItem(id, {
      fields: pickFields(b.fields), resolve: pickResolve(b.resolve),
      note: b.note === undefined ? undefined : b.note, pf: req.pf, loaded: pickLoaded(b.loaded), rev: pickRev(b.rev),
    });
    if (r.error === 'not_found') return reply.code(404).send(r);
    if (r.error === 'conflict' || r.error === 'stale' || r.error === 'stale_review' || r.error === 'locked') return reply.code(409).send({ ...r, item: await getItem(id) });
    if (r.error) return reply.code(400).send(r);

    const changed = Object.keys(r.applied);
    // 바뀐 것이 있을 때만 — 「그대로 맞음」 확인은 ERP 값이 그대로라 보낼 것이 없다.
    if (changed.length) {
      pushProductsSoon([r.code], { app });
      if (r.applied.scode || r.applied.oe) scheduleDevMatchSweep({});
    }
    await logEvent({ userId: null, action: 'update', target: 'pf_catalog_confirm',
      detail: { code: r.code, by: req.pf.name, fields: changed, chosen: Object.keys(r.chosen) } }).catch(() => {});
    pfLog(req, `제품 카탈로그 확인완료 · ${r.code} · ${changed.length ? `수정 ${changed.length}칸(${changed.join(', ')})` : '변경 없음'} (ERP 반영)`);
    return { ok: true, code: r.code, applied: r.applied, chosen: r.chosen, item: await getItem(id) };
  });
}
