// =====================================================================
// Refatrix ERP · prospectRoutes.js — 「영업 > 고객개발」 API (디렉터 요청 2026-11-24)
//
//   후보(prospects)  : 목록·지도·상세·수정·단계·배정·수동 등록(Visita no planeada)
//   가져오기         : DENUE CSV(화면에서 파싱) → 미리보기 → 반영 → 판 마감(새 판에 없는 곳 표시)
//   지역·목표        : 지역(주+municipio/CP)·담당 → 미배정 자동 배정 / 담당×월×지표 목표
//   루트             : 하루 방문 계획(최근접 순서) — 실제 방문은 체크인 상담과 연결
//   검토(Alta)       : 녹음 AI 초안 + DENUE + 저장값 병합 → 담당자 확인 → 확정 저장(prospect_crm_values)
//   고객 연결        : 기존 고객 추천(RFC·전화·상호) · 연결 요청 → 디렉터 승인 · 고객 등록용 값
//   현황판           : 목표 대비 실적 · 단계 현황 · 담당자별 표
//
//   녹음·전사·요약은 기존 「고객상담」(consultRoutes) 그대로 — 여기서는 연결만.
//   권한키는 고객상담과 같은 'pipeline'(영업활동). 가져오기·지역·목표·연결 승인은 디렉터.
// =====================================================================
import { estimateRoad } from '../roadRoute.js';
import { query, withTx } from '../db.js';
import { authGuard, requirePage, requirePageEdit } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import {
  STAGES, STAGE_KEYS, DISCARD_REASONS, SEGMENTS, METRICS, METRIC_NAMES, allocateTarget, POINT_WEIGHTS, pointsTarget, fieldPoints, planStatus, estimateRoute, stateFromCp, nameScore, nameTokens, normTxt, ROUTE_SETTINGS_DEFAULT, checkStageMove, autoAdvance, normalizeImportRow,
  territoryFor, orderStops, suggestCustomers, prefillFromProspect, mergeForReview, validateAltaValues, parseMxAddress, prefillFromCustomer, customerFillFromValues,
  missingRequired, pct, paceStatus, periodBounds, CHECKIN_WARN_M, ALTA_FORM, potentialOf, POTENTIAL_TIERS,
  STAGE_RANK_SQL, SCORE_RULES, SECTION_WEIGHTS, SCORE_BANDS, stageRank, nameSimilarity,
  inPolygon, distanceM, rankForRoute, optimizeRoute, routeMinutes, weekBounds, planDays, nextWorkDates, convexHull, pickDayRoute,
} from '../prospectCore.js';
import { pageAllowed } from '../permissions.js';
import { ALTA_FIELDS, ALTA_FIELD_MAP } from '../altaClientesForm.js';
import { moveStage, refreshCustomerStages, hasProspectCols, recomputeProspect, recomputeProspectSafe, detachConsultFromProspect, attachConsultToProspect } from '../prospectAlta.js';
import { syncConsultVisitSafe } from '../consultVisitSync.js';

const PAGE = 'pipeline';
// 디렉터 또는 고객개발 관리자(prospect_managers) — 고객개발 화면 전체 열람·수정
const isDir = (req) => req.ctx.perm.role === 'director' || req.prospectMgr === true;
const isRealDir = (req) => req.ctx.perm.role === 'director';
let mgrCache = { at: 0, set: new Set() };
async function managerSet() {
  if (Date.now() - mgrCache.at < 30000) return mgrCache.set;
  try { mgrCache = { at: Date.now(), set: new Set((await query(`SELECT user_id FROM prospect_managers`)).rows.map((r) => Number(r.user_id))) }; }
  catch (_) { mgrCache = { at: Date.now(), set: new Set() }; }   // 0338 전
  return mgrCache.set;
}
async function loadMgr(req) { req.prospectMgr = (await managerSet()).has(Number(req.ctx.perm.userId)); }
// 화면 권한: 관리자는 ERP 화면 권한(pipeline)과 상관없이 통과
const pageGuard = (needEdit) => { const g = needEdit ? requirePageEdit(PAGE) : requirePage(PAGE);
  return async (req, reply) => { if (req.prospectMgr || req.ctx.perm.role === 'director') return; return g(req, reply); }; };
const me = (req) => Number(req.ctx.perm.userId);
const int = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const txt = (v, n = 300) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, n) : null; };
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD = /^\d{4}-\d{2}$/;
function addDays(ymd, n) { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function mxToday() { return new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10); }
// 1126 · 유류비 표의 기간 — 이번 주(월~일) 또는 이번 달을 마지막으로 n 개
export function fuelPeriods(today, unit, n) {
  const d0 = new Date(today + 'T12:00:00Z'); const iso = (d) => d.toISOString().slice(0, 10); const out = [];
  if (unit === 'week') {
    const mon = new Date(d0); mon.setUTCDate(mon.getUTCDate() - ((mon.getUTCDay() + 6) % 7));
    for (let i = n - 1; i >= 0; i--) { const a = new Date(mon); a.setUTCDate(a.getUTCDate() - 7 * i); const b2 = new Date(a); b2.setUTCDate(b2.getUTCDate() + 6);
      out.push({ key: iso(a), from: iso(a), to: iso(b2), label: iso(a).slice(5).replace('-', '/') + '~' + iso(b2).slice(5).replace('-', '/') }); }
  } else {
    for (let i = n - 1; i >= 0; i--) { const a = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() - i, 1, 12)); const b2 = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + 1, 0, 12));
      out.push({ key: iso(a).slice(0, 7), from: iso(a), to: iso(b2), label: iso(a).slice(0, 7) }); }
  }
  return out;
}
// 1127 · 시작 기간부터 n 개(과거·미래 자유) — month: from='YYYY-MM' · week: from='YYYY-MM-DD'(그 주 월요일로)
export function fuelPeriodsFrom(from, unit, n) {
  if (unit === 'week') {
    const d = new Date(String(from).slice(0, 10) + 'T12:00:00Z'); if (Number.isNaN(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 7 * (n - 1));
    return fuelPeriods(d.toISOString().slice(0, 10), 'week', n);
  }
  const m = /^(\d{4})-(\d{2})$/.exec(String(from).slice(0, 7)); if (!m) return null;
  const e = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + (n - 1), 15, 12));
  return fuelPeriods(e.toISOString().slice(0, 10), 'month', n);
}
function parseJ(v) { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return null; } }

let potCols = null;
async function hasPotCols() {
  if (potCols) return true;
  try { potCols = (await query(`SELECT 1 FROM information_schema.columns WHERE table_name='prospects' AND column_name IN ('pot_tier','score') HAVING COUNT(*)=2`)).rows.length > 0; }
  catch (_) { potCols = false; }
  return potCols;
}
let planCols = false;
// 루트 추정 기준(상담 시간·연비·속도·도로 보정·연료비) — 0341 전에는 기본값 · 연료비는 저장 전까지 기본 24페소/L
let rsCache = { at: 0, v: null };
async function routeSettings() {
  if (rsCache.v && Date.now() - rsCache.at < 30000) return rsCache.v;
  let v = { ...ROUTE_SETTINGS_DEFAULT };
  try { (await query(`SELECT key, value FROM prospect_settings`)).rows.forEach((r) => { if (r.key in v) v[r.key] = Number(r.value); }); } catch (_) { /* 0341 전 */ }
  rsCache = { at: Date.now(), v }; return v;
}
let batchCols = false;
async function hasBatchCols() {
  if (batchCols) return true;
  try { batchCols = (await query(`SELECT 1 FROM information_schema.columns WHERE table_name='prospects' AND column_name='import_batch_id'`)).rows.length > 0; } catch (_) { batchCols = false; }
  return batchCols;
}
async function hasPlanCols() {
  if (planCols) return true;
  try { planCols = (await query(`SELECT 1 FROM information_schema.columns WHERE table_name='prospect_territories' AND column_name='polygon'`)).rows.length > 0
    && (await query(`SELECT to_regclass('prospect_target_shares') IS NOT NULL AS ok`)).rows[0].ok; }
  catch (_) { planCols = false; }
  return planCols;
}
// 지도 구역 다각형 정리: [[lat,lng],...] 3~400점, 좌표 범위 확인
function cleanPolygon(v) {
  if (!Array.isArray(v)) return null;
  const pts = v.map((x) => (Array.isArray(x) ? [Number(x[0]), Number(x[1])] : null))
    .filter((x) => x && Number.isFinite(x[0]) && Number.isFinite(x[1]) && Math.abs(x[0]) <= 90 && Math.abs(x[1]) <= 180)
    .map(([a, b]) => [Math.round(a * 1e6) / 1e6, Math.round(b * 1e6) / 1e6]);
  if (pts.length < 3) return null;
  const step = Math.ceil(pts.length / 400);
  return pts.filter((_, i) => i % step === 0);
}
async function excludedSet() {
  return new Set((await query(`SELECT user_id FROM prospect_excluded_users`)).rows.map((r) => Number(r.user_id)));
}
// 확정·임시 저장된 Alta 값으로 잠재성 열 갱신
async function savePotential(q, prospectId, values) {
  const p = potentialOf(values);
  await q(`UPDATE prospects SET pot_venta_total=$2, pot_venta_susp=$3, pot_compra_total=$4, pot_compra_susp=$5, pot_tier=$6 WHERE id=$1`,
    [prospectId, p.venta_total, p.venta_susp, p.compra_total, p.compra_susp, p.tier]);
  return p;
}
function directorOnly(req, reply) {
  if (!isDir(req)) { reply.code(403).send({ error: 'director_only' }); return false; }
  return true;
}
// 보이는 범위: 디렉터 전체 / 그 외 본인 담당(+ 지도에서 미배정 포함 선택)
function scopeCond(req, params, { unassigned = false } = {}) {
  if (isDir(req)) return 'TRUE';
  params.push(me(req));
  return unassigned ? `(p.owner_user_id = $${params.length} OR p.owner_user_id IS NULL)` : `p.owner_user_id = $${params.length}`;
}
async function loadProspect(req, id, { forUpdate = false, unassigned = true } = {}) {
  const params = [int(id)];
  if (!params[0]) return null;
  const cond = scopeCond(req, params, { unassigned });
  return (await query(`SELECT p.* FROM prospects p WHERE p.id=$1 AND p.deleted_at IS NULL AND ${cond}${forUpdate ? ' FOR UPDATE' : ''}`, params)).rows[0] || null;
}
function pub(p) {
  if (!p) return p;
  const o = { ...p };
  for (const k of ['id', 'territory_id', 'owner_user_id', 'customer_id', 'created_by']) if (o[k] != null) o[k] = Number(o[k]);
  return o;
}

// 주(州) 자동 판정 — 화면에서 주를 고르지 않는다(전국 지도)
//   위치: 가장 가까운 기존 후보의 주(±0.5° 안) · 구역: 구역 안 후보가 가장 많은 주 · 우편번호: 앞 두 자리
async function stateNear(lat, lng) {
  try {
    const r = (await query(`SELECT cve_ent, MAX(entidad) AS entidad FROM (SELECT cve_ent, entidad FROM prospects
        WHERE cve_ent IS NOT NULL AND deleted_at IS NULL AND lat BETWEEN $1-0.5 AND $1+0.5 AND lng BETWEEN $2-0.5 AND $2+0.5
        ORDER BY (lat-$1)*(lat-$1)+(lng-$2)*(lng-$2) LIMIT 1) x GROUP BY cve_ent`, [lat, lng])).rows[0];
    if (r) return { cve_ent: r.cve_ent, entidad: r.entidad };
  } catch (_) { /* 무시 */ }
  return { cve_ent: null, entidad: null };
}
async function territoryState({ polygon = null, cps = [] } = {}) {
  if (polygon && polygon.length >= 3) {
    const la = polygon.map((p) => Number(p[0])), ln = polygon.map((p) => Number(p[1]));
    const r = (await query(`SELECT cve_ent, COUNT(*) AS n FROM prospects WHERE cve_ent IS NOT NULL AND deleted_at IS NULL
        AND lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4 GROUP BY cve_ent ORDER BY n DESC LIMIT 1`, [Math.min(...la), Math.max(...la), Math.min(...ln), Math.max(...ln)])).rows[0];
    if (r) return r.cve_ent;
    return (await stateNear(la.reduce((a, b) => a + b, 0) / la.length, ln.reduce((a, b) => a + b, 0) / ln.length)).cve_ent;
  }
  for (const c of cps || []) { const k = stateFromCp(c); if (k) return k; }
  return null;
}

async function applyTerritories(client, { onlyIds = null, cveEnt = null, byUser = null } = {}) {
  const q = client ? client.query.bind(client) : query;
  const terrs = (await q(`SELECT * FROM prospect_territories WHERE active`)).rows;
  if (!terrs.length) return 0;
  const params = []; const conds = ['deleted_at IS NULL', 'territory_id IS NULL'];
  if (onlyIds) { params.push(onlyIds); conds.push(`id = ANY($${params.length})`); }
  if (cveEnt) { params.push(cveEnt); conds.push(`cve_ent = $${params.length}`); }
  const rows = (await q(`SELECT id, cve_ent, cp, municipio, lat, lng, owner_user_id, stage FROM prospects WHERE ${conds.join(' AND ')}`, params)).rows;
  let n = 0;
  for (const p of rows) {
    const t = territoryFor(p, terrs);
    if (!t) continue;
    n++;
    if (p.owner_user_id == null && t.owner_user_id != null) {
      await q(`UPDATE prospects SET territory_id=$2, owner_user_id=$3, assigned_at=now(), updated_at=now() WHERE id=$1`, [p.id, t.id, t.owner_user_id]);
      await q(`INSERT INTO prospect_assign_history (prospect_id, from_user, to_user, by_user) VALUES ($1,NULL,$2,$3)`, [p.id, t.owner_user_id, byUser]);
      const nx = autoAdvance(p.stage, 'asignado');
      if (nx) await moveStage(q, Number(p.id), p.stage, nx, { userId: byUser, auto: true, reason: 'territorio' });
    } else {
      await q(`UPDATE prospects SET territory_id=$2 WHERE id=$1`, [p.id, t.id]);
    }
  }
  return n;
}

async function assignMany(client, ids, ownerId, byUser) {
  const q = client.query.bind(client);
  const rows = (await q(`SELECT id, owner_user_id, stage FROM prospects WHERE id = ANY($1) AND deleted_at IS NULL FOR UPDATE`, [ids])).rows;
  let n = 0;
  for (const p of rows) {
    const from = p.owner_user_id == null ? null : Number(p.owner_user_id);
    if (from === ownerId) continue;
    await q(`UPDATE prospects SET owner_user_id=$2::bigint, assigned_at=CASE WHEN $2::bigint IS NULL THEN NULL ELSE now() END, updated_at=now() WHERE id=$1`, [p.id, ownerId]);
    await q(`INSERT INTO prospect_assign_history (prospect_id, from_user, to_user, by_user) VALUES ($1,$2,$3,$4)`, [p.id, from, ownerId, byUser]);
    if (ownerId != null) {
      const nx = autoAdvance(p.stage, 'asignado');
      if (nx) await moveStage(q, Number(p.id), p.stage, nx, { userId: byUser, auto: true, reason: 'asignación' });
    } else if (p.stage === 'asignado') {
      await moveStage(q, Number(p.id), p.stage, 'sin_asignar', { userId: byUser, auto: true, reason: 'desasignado' });
    }
    // 담당이 바뀌면 이전 담당의 오늘·이후 루트에서 아직 방문 안 한 이 후보를 뺀다
    if (from != null) await pruneRouteStops(q, [Number(p.id)], from);
    n++;
  }
  return n;
}

// 루트 정리: 방문 전(consult 없음) stop 삭제 → 순번 다시 매김 → 빈 루트 삭제. userId 없으면 모든 담당.
async function pruneRouteStops(q, prospectIds, userId = null) {
  const params = [prospectIds]; let uc = '';
  if (userId != null) { params.push(userId); uc = ' AND r.user_id=$2'; }
  const del = await q(`DELETE FROM prospect_route_stops s USING prospect_routes r
                        WHERE s.route_id=r.id AND s.prospect_id = ANY($1) AND s.consult_id IS NULL
                          AND (r.route_date IS NULL OR r.route_date >= (now() AT TIME ZONE 'America/Mexico_City')::date)${uc}
                        RETURNING s.route_id`, params);
  const rids = [...new Set(del.rows.map((r) => Number(r.route_id)))];
  if (rids.length) await tidyRoutes(q, rids);
  return del.rowCount;
}
async function tidyRoutes(q, rids) {
  await q(`UPDATE prospect_route_stops s SET seq=x.rn
             FROM (SELECT id, row_number() OVER (PARTITION BY route_id ORDER BY seq, id) AS rn FROM prospect_route_stops WHERE route_id = ANY($1)) x
            WHERE s.id=x.id`, [rids]);
  await q(`DELETE FROM prospect_routes r WHERE r.id = ANY($1) AND NOT EXISTS (SELECT 1 FROM prospect_route_stops s WHERE s.route_id=r.id)`, [rids]);
}

export default async function prospectRoutes(app) {
  const view = { preHandler: [authGuard, loadMgr, pageGuard(false)] };
  const edit = { preHandler: [authGuard, loadMgr, pageGuard(true)] };

  // 0334 전이면 503 — 화면이 「마이그레이션 필요」 안내
  app.addHook('preHandler', async (req, reply) => {
    if (!String(req.url).startsWith('/api/prospect')) return;
    if (!(await hasProspectCols())) return reply.code(503).send({ error: 'migration_0334_required' });
    if (!(await hasPotCols())) return reply.code(503).send({ error: 'migration_0336_required' });
    if (/^\/api\/prospect-(territories|targets)/.test(String(req.url)) && !(await hasPlanCols())) return reply.code(503).send({ error: 'migration_0337_required' });
    if (/^\/api\/prospects\/(import|purge)/.test(String(req.url)) && !(await hasBatchCols())) return reply.code(503).send({ error: 'migration_0340_required' });
  });

  // ── 메타 ───────────────────────────────────────────────────────────
  // 메타·진척 보드는 로그인한 모든 사용자(디렉터 요청: 진척 표는 누구나 본다). 나머지는 영업활동 권한.
  app.get('/api/prospects/meta', { preHandler: [authGuard, loadMgr] }, async (req) => {
    const canWork = isDir(req) || pageAllowed(req.ctx.perm, PAGE, req.ctx.isRegistered);
    const ex = await excludedSet();
    const users = (await query(`SELECT id, name, role FROM users WHERE deleted_at IS NULL ORDER BY name`)).rows
      .map((u) => ({ id: Number(u.id), name: u.name, role: u.role, excluded: ex.has(Number(u.id)) }));
    const states = (await query(
      `SELECT cve_ent, MAX(entidad) AS entidad, COUNT(*)::int AS n FROM prospects WHERE deleted_at IS NULL GROUP BY cve_ent ORDER BY cve_ent`)).rows;
    return { stages: STAGES, segments: SEGMENTS, discard_reasons: DISCARD_REASONS, metrics: METRICS, metric_names: METRIC_NAMES, point_weights: POINT_WEIGHTS,
      checkin_warn_m: CHECKIN_WARN_M, form: ALTA_FORM, fields: ALTA_FIELDS,
      users: isDir(req) ? users : users.filter((u) => u.id === me(req)),
      staff: (isDir(req) ? users : users.filter((u) => u.id === me(req))).filter((u) => !u.excluded),   // 담당 선택지(디렉터가 뺀 사람 제외)
      potential_tiers: POTENTIAL_TIERS, score_rules: SCORE_RULES, section_weights: SECTION_WEIGHTS, score_bands: SCORE_BANDS, route_settings: await routeSettings(),
      can_work: canWork, states,
      me: me(req), is_director: isDir(req), is_real_director: isRealDir(req), is_manager: req.prospectMgr === true, today: mxToday() };
  });

  // ── 목록 ───────────────────────────────────────────────────────────
  app.get('/api/prospects', view, async (req) => {
    const qs = req.query || {};
    const params = []; const conds = ['p.deleted_at IS NULL', scopeCond(req, params, { unassigned: qs.unassigned === '1' })];
    const add = (sql, v) => { params.push(v); conds.push(sql.replace('?', `$${params.length}`)); };
    if (qs.cve_ent) add('p.cve_ent = ?', String(qs.cve_ent));
    if (qs.stage && STAGE_KEYS.includes(qs.stage)) add('p.stage = ?', qs.stage);
    if (qs.segment && SEGMENTS.includes(qs.segment)) add('p.segment = ?', qs.segment);
    if (['A', 'B', 'C'].includes(qs.priority)) add('p.priority = ?', qs.priority);
    if (['A', 'B', 'C'].includes(qs.potential)) add('p.pot_tier = ?', qs.potential);
    else if (qs.potential === 'none') conds.push('p.pot_tier IS NULL');
    if (qs.municipio) {   // 'cve_ent|municipio' (전국 목록) 또는 municipio 이름만
      const m = String(qs.municipio); const i = m.indexOf('|');
      if (i > 0) { add('p.cve_ent = ?', m.slice(0, i)); add('p.municipio = ?', m.slice(i + 1)); } else add('p.municipio = ?', m);
    }
    if (qs.owner === 'none' && isDir(req)) conds.push('p.owner_user_id IS NULL');
    else if (int(qs.owner) && isDir(req)) add('p.owner_user_id = ?', int(qs.owner));
    if (int(qs.territory)) add('p.territory_id = ?', int(qs.territory));
    if (qs.idle === '1') conds.push(`p.stage IN ('asignado','contactado','interesado','cotizado') AND COALESCE(p.last_activity_at, p.assigned_at) < now() - INTERVAL '30 days'`);
    if (qs.q) { params.push('%' + String(qs.q).trim() + '%'); conds.push(`(p.nom_estab ILIKE $${params.length} OR p.raz_social ILIKE $${params.length} OR p.colonia ILIKE $${params.length} OR p.phone ILIKE $${params.length})`); }
    const limit = Math.min(500, int(qs.limit) || 100); const offset = Math.max(0, Number(qs.offset) || 0);
    const where = conds.join(' AND ');
    const total = (await query(`SELECT COUNT(*)::int AS n FROM prospects p WHERE ${where}`, params)).rows[0].n;
    const sort = { name: 'p.nom_estab', activity: 'p.last_activity_at DESC NULLS LAST', stage: 'p.stage_since DESC',
      potential: 'p.pot_compra_susp DESC NULLS LAST, p.priority', score: 'p.score DESC, p.info_pct DESC' }[qs.sort] || "p.priority, p.municipio, p.nom_estab";
    const rows = (await query(
      `SELECT p.id, p.nom_estab, p.raz_social, p.segment, p.priority, p.scian_code, p.per_ocu, p.address, p.colonia, p.cp,
              p.municipio, p.entidad, p.cve_ent, p.phone, p.email, p.lat, p.lng, p.stage, p.stage_since, p.owner_user_id,
              u.name AS owner_name, p.territory_id, t.name AS territory_name, p.last_activity_at, p.customer_id, p.denue_missing, p.source,
              p.pot_tier, p.pot_compra_susp::float AS pot_compra_susp, p.pot_compra_total::float AS pot_compra_total,
              p.score, p.info_pct, p.suggested_stage
         FROM prospects p LEFT JOIN users u ON u.id=p.owner_user_id LEFT JOIN prospect_territories t ON t.id=p.territory_id
        WHERE ${where} ORDER BY ${sort} LIMIT ${limit} OFFSET ${offset}`, params)).rows.map(pub);
    return { total, rows };
  });

  // 지도용 가벼운 목록(bbox 선택) — 최대 6000점
  app.get('/api/prospects/map', view, async (req) => {
    const qs = req.query || {};
    const params = []; const conds = ['p.deleted_at IS NULL', 'p.lat IS NOT NULL', scopeCond(req, params, { unassigned: true })];
    if (qs.cve_ent) { params.push(String(qs.cve_ent)); conds.push(`p.cve_ent = $${params.length}`); }
    const bb = String(qs.bbox || '').split(',').map(Number);
    if (bb.length === 4 && bb.every(Number.isFinite)) {
      params.push(bb[0], bb[1], bb[2], bb[3]);
      conds.push(`p.lng BETWEEN $${params.length - 3} AND $${params.length - 1} AND p.lat BETWEEN $${params.length - 2} AND $${params.length}`);
    }
    if (int(qs.owner) && isDir(req)) { params.push(int(qs.owner)); conds.push(`p.owner_user_id = $${params.length}`); }
    // 멀리서 볼 때(전국·여러 주): 핀 대신 격자별 숫자 묶음 — 확대하면 핀으로
    const z = Number(qs.z);
    if (Number.isFinite(z) && z <= 9) {
      const cell = Math.min(4, 90 / Math.pow(2, z));               // z5 ≈ 2.8° · z7 ≈ 0.7° · z9 ≈ 0.18°
      for (const k of ['stage', 'segment', 'priority']) {
        const v = qs[k]; if (!v) continue;
        if ((k === 'stage' && STAGE_KEYS.includes(v)) || (k === 'segment' && SEGMENTS.includes(v)) || (k === 'priority' && ['A', 'B', 'C'].includes(v))) { params.push(v); conds.push(`p.${k} = $${params.length}`); }
      }
      params.push(cell);
      const c = `$${params.length}`;
      const cl = (await query(
        `SELECT AVG(p.lat)::float AS lat, AVG(p.lng)::float AS lng, COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE p.owner_user_id IS NULL)::int AS free, MAX(p.entidad) AS ent
           FROM prospects p WHERE ${conds.join(' AND ')}
          GROUP BY floor(p.lat / ${c}), floor(p.lng / ${c})`, params)).rows;
      return { clusters: cl, rows: [], others: [], total: cl.reduce((a, x) => a + x.n, 0) };
    }
    params.push(mxToday());
    const rows = (await query(
      `SELECT p.id, p.nom_estab AS n, p.lat, p.lng, p.stage AS s, p.segment AS g, p.priority AS pr, p.owner_user_id AS o,
              (SELECT MAX(c.consult_date)::text FROM sales_consults c WHERE c.prospect_id=p.id AND c.deleted_at IS NULL) AS v,
              (SELECT COALESCE(MIN(r.route_date)::text, CASE WHEN COUNT(*)>0 THEN '날짜 미정' END) FROM prospect_route_stops rs JOIN prospect_routes r ON r.id=rs.route_id
                WHERE rs.prospect_id=p.id AND rs.consult_id IS NULL AND (r.route_date IS NULL OR r.route_date >= $${params.length}::date)) AS rd
         FROM prospects p WHERE ${conds.join(' AND ')} ORDER BY p.priority LIMIT 6000`, params)).rows
      .map((r) => ({ ...r, id: Number(r.id), o: r.o == null ? null : Number(r.o) }));
    // 담당자 화면: 다른 담당의 후보는 이름 없이 위치만(회색) — 지도에서 피해서 구역을 잡도록
    let others = [];
    if (!isDir(req) && bb.length === 4 && bb.every(Number.isFinite)) {
      others = (await query(
        `SELECT p.lat, p.lng, (EXISTS (SELECT 1 FROM sales_consults c WHERE c.prospect_id=p.id AND c.deleted_at IS NULL)) AS v
           FROM prospects p WHERE p.deleted_at IS NULL AND p.lat IS NOT NULL AND p.owner_user_id IS NOT NULL AND p.owner_user_id <> $1
            AND p.lng BETWEEN $2 AND $4 AND p.lat BETWEEN $3 AND $5 ${qs.cve_ent ? 'AND p.cve_ent = $6' : ''} LIMIT 4000`,
        [me(req), bb[0], bb[1], bb[2], bb[3], ...(qs.cve_ent ? [String(qs.cve_ent)] : [])])).rows.map((r) => [Number(r.lat), Number(r.lng), r.v ? 1 : 0]);
    }
    return { rows, others, truncated: rows.length >= 6000 };
  });

  // 🔎 고객 찾기 — 이름이 같거나 비슷한 업체(전국). 담당자는 다른 담당 후보도 위치는 보이지만 상세는 못 엶(others=true)
  app.get('/api/prospects/search', view, async (req) => {
    const q = String(req.query?.q || '').trim().slice(0, 80);
    const limit = Math.min(50, Math.max(1, int(req.query?.limit) || 20));
    return { q, rows: await prospectSearch(req, q, limit) };
  });
  async function prospectSearch(req, q, limit) {
    const toks = nameTokens(q);
    if (normTxt(q).length < 2) return [];
    const words = toks.length ? toks : [normTxt(q)];
    const params = []; const ors = [];
    for (const t of words.slice(0, 6)) {
      params.push('%' + t + '%'); ors.push(`f LIKE $${params.length}`);
      if (t.length >= 4) { params.push('%' + t.slice(0, 3) + '%'); ors.push(`f LIKE $${params.length}`); }   // 오타: 앞 세 글자
    }
    const rows = (await query(
      `SELECT * FROM (
         SELECT p.id, p.nom_estab, p.raz_social, p.municipio, p.colonia, p.entidad, p.lat, p.lng, p.stage, p.priority, p.score, p.owner_user_id,
                p.customer_id, u.name AS owner_name,
                translate(lower(COALESCE(p.nom_estab,'') || ' ' || COALESCE(p.raz_social,'')), 'áéíóúüñàèìòùâêîôûäëïöÁÉÍÓÚÜÑ', 'aeiouunaeiouaeiouaeioaeiouun') AS f
           FROM prospects p LEFT JOIN users u ON u.id = p.owner_user_id
          WHERE p.deleted_at IS NULL) x
        WHERE ${ors.join(' OR ')} LIMIT 3000`, params)).rows;
    const mine = me(req), dir = isDir(req);
    const out = rows.map((r) => ({ r, s: Math.max(nameScore(q, r.nom_estab), nameScore(q, r.raz_social) - 3) }))
      .filter((x) => x.s >= 45).sort((a, b) => b.s - a.s || String(a.r.nom_estab).localeCompare(String(b.r.nom_estab))).slice(0, limit)
      .map(({ r, s: score }) => {
        const owner = r.owner_user_id == null ? null : Number(r.owner_user_id);
        const others = !dir && owner != null && owner !== mine;
        return { id: Number(r.id), nom_estab: r.nom_estab, raz_social: others ? null : r.raz_social, municipio: r.municipio, colonia: r.colonia, entidad: r.entidad,
          lat: r.lat == null ? null : Number(r.lat), lng: r.lng == null ? null : Number(r.lng), stage: r.stage, priority: r.priority, score: r.score,
          owner_user_id: owner, owner_name: r.owner_name, customer_id: r.customer_id ? Number(r.customer_id) : null, match: score, exact: score >= 85, others };
      });
    return out;
  }

  // ── 🔎 루트에 없는 고객 찾기(오늘 루트) — ERP 고객 + 전체 후보(DENUE·수동)에서 같거나 비슷한 이름 ──
  //   ERP 고객이 이미 후보와 이어져 있으면 후보 한 줄로 합쳐 보여 준다(erp 표시). 위치는 후보 좌표, 없으면 그 고객의 지난 방문 위치.
  async function erpLastGeo(q, customerId) {
    const g = (await q(`SELECT lat, lng FROM (
        SELECT geo_lat AS lat, geo_lng AS lng, created_at FROM sales_visits WHERE customer_id=$1 AND geo_lat IS NOT NULL
        UNION ALL SELECT geo_lat, geo_lng, created_at FROM sales_consults WHERE customer_id=$1 AND geo_lat IS NOT NULL AND deleted_at IS NULL) x
       ORDER BY created_at DESC LIMIT 1`, [customerId]).catch(() => ({ rows: [] }))).rows[0];
    return g && Number.isFinite(Number(g.lat)) && Number(g.lat) !== 0 ? { lat: Number(g.lat), lng: Number(g.lng) } : null;
  }
  app.get('/api/prospect-routes/find-customer', view, async (req) => {
    const q = String(req.query?.q || '').trim().slice(0, 80);
    if (normTxt(q).length < 2) return { q, rows: [] };
    const pros = await prospectSearch(req, q, 25);
    const toks = nameTokens(q); const words = (toks.length ? toks : [normTxt(q)]).slice(0, 6);
    const params = []; const ors = [];
    for (const t of words) { params.push('%' + t + '%'); ors.push(`f LIKE $${params.length}`); if (t.length >= 4) { params.push('%' + t.slice(0, 3) + '%'); ors.push(`f LIKE $${params.length}`); } }
    let cust = [];
    try {
      cust = (await query(
        `SELECT * FROM (SELECT c.id, c.code, c.name, c.rfc, c.phone, c.owner_id, u.name AS owner_name,
                  (SELECT p.id FROM prospects p WHERE p.customer_id=c.id AND p.deleted_at IS NULL ORDER BY p.id LIMIT 1) AS prospect_id,
                  translate(lower(COALESCE(c.name,'') || ' ' || COALESCE(c.code,'') || ' ' || COALESCE(c.rfc,'')), 'áéíóúüñàèìòùâêîôûäëïöÁÉÍÓÚÜÑ', 'aeiouunaeiouaeiouaeioaeiouun') AS f
             FROM customers c LEFT JOIN users u ON u.id=c.owner_id WHERE c.deleted_at IS NULL) x
          WHERE ${ors.join(' OR ')} LIMIT 2000`, params)).rows;
    } catch (_) { cust = []; }
    const mine = me(req), dir = isDir(req);
    const byPid = new Map(pros.map((p) => [p.id, p]));
    const out = pros.map((p) => ({ kind: 'prospect', ...p }));
    for (const c of cust) {
      const score = Math.max(nameScore(q, c.name), String(c.code || '').toLowerCase() === q.toLowerCase() ? 100 : 0, c.rfc && String(c.rfc).toUpperCase() === q.toUpperCase() ? 100 : 0);
      if (score < 45) continue;
      const erp = { customer_id: Number(c.id), code: c.code, name: c.name };
      if (c.prospect_id && byPid.has(Number(c.prospect_id))) { const p = byPid.get(Number(c.prospect_id)); const o = out.find((x) => x.id === p.id); o.erp = erp; o.match = Math.max(o.match, score); continue; }
      const owner = c.owner_id == null ? null : Number(c.owner_id);
      out.push({ kind: c.prospect_id ? 'prospect' : 'customer', id: c.prospect_id ? Number(c.prospect_id) : null, nom_estab: c.name, erp, match: score, exact: score >= 85,
        owner_user_id: owner, owner_name: c.owner_name, others: !dir && owner != null && owner !== mine, phone: c.phone,
        geo: await erpLastGeo(query, Number(c.id)) });
    }
    // 같음 → ERP 고객 → 비슷함 순
    out.sort((a, b) => (b.exact - a.exact) || ((b.erp ? 1 : 0) - (a.erp ? 1 : 0)) || (b.match - a.match));
    return { q, rows: out.slice(0, 30) };
  });
  // ── ERP 고객 ↔ 고객개발 정보 교차(1127) ──
  // ERP 고객 정보(+ 웹 문의의 도시·주)
  async function customerInfo(q, cid) {
    if (!cid) return null;
    const c = (await q(`SELECT c.id, c.code, c.name, c.rfc, c.contact, c.phone, c.buyer_name, c.buyer_phone, c.ship_address, c.branch_count,
                               c.customer_type, c.owner_id, u.name AS owner_name, c.approval_status,
                               (SELECT l.ciudad FROM crm_web_leads l WHERE l.customer_id=c.id AND COALESCE(l.ciudad,'')<>'' ORDER BY l.received_at DESC LIMIT 1) AS crm_ciudad,
                               (SELECT l.estado FROM crm_web_leads l WHERE l.customer_id=c.id AND COALESCE(l.estado,'')<>'' ORDER BY l.received_at DESC LIMIT 1) AS crm_estado
                          FROM customers c LEFT JOIN users u ON u.id=c.owner_id WHERE c.id=$1 AND c.deleted_at IS NULL`, [Number(cid)])
      .catch(() => q(`SELECT c.id, c.code, c.name, c.rfc, c.contact, c.phone, c.buyer_name, c.buyer_phone, c.ship_address, c.branch_count, c.customer_type, c.owner_id,
                             u.name AS owner_name FROM customers c LEFT JOIN users u ON u.id=c.owner_id WHERE c.id=$1 AND c.deleted_at IS NULL`, [Number(cid)]))).rows[0];
    return c || null;
  }
  // 연결된 ERP 고객 → 후보 기본 정보(주소·콜로니아·CP·시·주·전화·메일) 빈 칸만 채움(사람이 넣은 값은 그대로)
  async function syncProspectFromCustomer(q, pid) {
    const p = (await q(`SELECT id, customer_id FROM prospects WHERE id=$1`, [pid])).rows[0];
    if (!p || !p.customer_id) return 0;
    const c = await customerInfo(q, p.customer_id); if (!c) return 0;
    const a = parseMxAddress(c.ship_address);
    const addr = [a.calle, a.numero].filter(Boolean).join(' ') || null;
    const email = c.contact && /@/.test(c.contact) ? c.contact : null;
    const r = await q(`UPDATE prospects SET
        address   = CASE WHEN COALESCE(address,'')=''   THEN COALESCE($2, address)   ELSE address END,
        colonia   = CASE WHEN COALESCE(colonia,'')=''   THEN COALESCE($3, colonia)   ELSE colonia END,
        cp        = CASE WHEN COALESCE(cp,'')=''        THEN COALESCE($4, cp)        ELSE cp END,
        municipio = CASE WHEN COALESCE(municipio,'')='' THEN COALESCE($5, municipio) ELSE municipio END,
        entidad   = CASE WHEN COALESCE(entidad,'')=''   THEN COALESCE($6, entidad)   ELSE entidad END,
        cve_ent   = CASE WHEN COALESCE(cve_ent,'')=''   THEN COALESCE($7, cve_ent)   ELSE cve_ent END,
        phone     = CASE WHEN COALESCE(phone,'')=''     THEN COALESCE($8, phone)     ELSE phone END,
        email     = CASE WHEN COALESCE(email,'')=''     THEN COALESCE($9, email)     ELSE email END
      WHERE id=$1 AND (COALESCE(address,'')='' OR COALESCE(colonia,'')='' OR COALESCE(cp,'')='' OR COALESCE(municipio,'')=''
                       OR COALESCE(entidad,'')='' OR COALESCE(phone,'')='' OR COALESCE(email,'')='')`,
      [pid, addr, a.colonia || null, a.cp || null, a.ciudad || c.crm_ciudad || null, a.estado || c.crm_estado || null, a.cve_ent || null,
        String(c.phone || c.buyer_phone || '').trim() || null, email]);
    return r.rowCount;
  }
  // 양식용 ERP 값(연결된 고객이 있을 때)
  async function erpPrefill(q, p) { return p && p.customer_id ? prefillFromCustomer(await customerInfo(q, p.customer_id)) : {}; }

  // ERP 고객 → 후보(없으면 만든다). 이미 있는 고객이라 고객개발 실적(첫 방문·단계·점수)에는 넣지 않는다:
  //   ERP 상태에 맞는 단계로 시작하되 그 단계 이력·점수 로그는 남기지 않음(기준선). 이후 방문은 「방문」으로만 셈.
  async function prospectForCustomer(customerId, visitorId) {
    return withTx(async (client) => {
      const q = client.query.bind(client);
      const ex = (await q(`SELECT id FROM prospects WHERE customer_id=$1 AND deleted_at IS NULL ORDER BY id LIMIT 1`, [customerId])).rows[0];
      if (ex) return Number(ex.id);
      const c = (await q(`SELECT id, name, phone, owner_id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [customerId])).rows[0];
      if (!c) return null;
      const g = await erpLastGeo(q, customerId);
      const st = g ? await stateNear(g.lat, g.lng) : { cve_ent: null, entidad: null };
      const owner = c.owner_id == null ? visitorId : Number(c.owner_id);
      const id = Number((await q(
        `INSERT INTO prospects (nom_estab, segment, priority, lat, lng, phone, cve_ent, entidad, source, customer_id, owner_user_id, assigned_at, stage, created_by)
         VALUES ($1,'refaccionaria','B',$2,$3,$4,$5,$6,'manual',$7,$8,now(),'asignado',$9) RETURNING id`,
        [c.name, g ? g.lat : null, g ? g.lng : null, c.phone, st.cve_ent, st.entidad, customerId, owner, visitorId])).rows[0].id);
      await syncProspectFromCustomer(q, id);   // 주소·콜로니아·CP·전화 등 ERP 정보로 채움
      await recomputeProspect(q, id, { userId: visitorId, reason: 'cliente ERP (ruta)' });
      await q(`DELETE FROM prospect_stage_history WHERE prospect_id=$1`, [id]);
      await q(`DELETE FROM prospect_score_log WHERE prospect_id=$1`, [id]);
      return id;
    });
  }
  // 루트에 업체 넣기 {prospect_id | customer_id, date?, user_id?, route_id?} — 맨 뒤에 붙임(순서는 「첫 방문지」로 다시 짠다)
  app.post('/api/prospect-routes/add-stop', edit, async (req, reply) => {
    const b = req.body || {};
    const uid = isDir(req) && int(b.user_id) ? int(b.user_id) : me(req);
    let pid = int(b.prospect_id);
    if (!pid && int(b.customer_id)) pid = await prospectForCustomer(int(b.customer_id), uid);
    if (!pid) return reply.code(404).send({ error: 'not_found' });
    const p = (await query(`SELECT p.id, p.nom_estab, p.owner_user_id, p.stage, u.name AS owner_name FROM prospects p LEFT JOIN users u ON u.id=p.owner_user_id WHERE p.id=$1 AND p.deleted_at IS NULL`, [pid])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    let rid = int(b.route_id);
    if (rid) { const r = await ownRoute(req, rid); if (!r) return reply.code(404).send({ error: 'route_not_found' }); }
    const date = YMD.test(String(b.date)) ? b.date : mxToday();
    const out = await withTx(async (client) => {
      const q = client.query.bind(client);
      if (!rid) rid = Number((await q(`INSERT INTO prospect_routes (user_id, route_date, created_by) VALUES ($1,$2,$3)
                                       ON CONFLICT (user_id, route_date) DO UPDATE SET updated_at=now() RETURNING id`, [uid, date, me(req)])).rows[0].id);
      const has = (await q(`SELECT 1 FROM prospect_route_stops WHERE route_id=$1 AND prospect_id=$2`, [rid, pid])).rows.length;
      if (has) return { already: true };
      const seq = Number((await q(`SELECT COALESCE(MAX(seq),0)+1 AS n FROM prospect_route_stops WHERE route_id=$1`, [rid])).rows[0].n);
      await q(`INSERT INTO prospect_route_stops (route_id, prospect_id, seq) VALUES ($1,$2,$3)`, [rid, pid, seq]);
      return { seq };
    });
    warmRoad([rid]);
    await logEvent({ userId: me(req), action: 'update', target: `prospect_routes:${rid}`, detail: { add_stop: pid, customer_id: int(b.customer_id) || null } });
    const owner = p.owner_user_id == null ? null : Number(p.owner_user_id);
    return { ok: true, route_id: rid, prospect_id: pid, nom_estab: p.nom_estab, ...out,
      others: owner != null && owner !== uid ? (p.owner_name || true) : null, erp_existing: p.stage === 'cliente_activo' };
  });
  // 첫 방문지 고르기 → 나머지는 그곳에서 가까운 순으로 다시 짠다(이미 방문한 곳은 맨 앞에 그대로, 위치 없는 곳은 맨 뒤)
  app.post('/api/prospect-routes/reorder', edit, async (req, reply) => {
    const b = req.body || {};
    let rid = int(b.route_id);
    if (rid) { if (!(await ownRoute(req, rid))) return reply.code(404).send({ error: 'route_not_found' }); }
    else {
      const uid = isDir(req) && int(b.user_id) ? int(b.user_id) : me(req);
      const r = (await query(`SELECT id FROM prospect_routes WHERE user_id=$1 AND route_date=$2`, [uid, YMD.test(String(b.date)) ? b.date : mxToday()])).rows[0];
      if (!r) return reply.code(404).send({ error: 'route_not_found' }); rid = Number(r.id);
    }
    const first = int(b.first_id);
    const st = (await query(`SELECT s.prospect_id, s.consult_id, s.seq, p.lat, p.lng FROM prospect_route_stops s JOIN prospects p ON p.id=s.prospect_id WHERE s.route_id=$1 ORDER BY s.seq`, [rid])).rows
      .map((x) => ({ id: Number(x.prospect_id), done: !!x.consult_id, lat: x.lat == null ? null : Number(x.lat), lng: x.lng == null ? null : Number(x.lng) }));
    const f = st.find((x) => x.id === first && !x.done); if (!f) return reply.code(400).send({ error: 'bad_first' });
    const done = st.filter((x) => x.done), rest = st.filter((x) => !x.done && x.id !== first);
    const geoRest = rest.filter((x) => x.lat != null), noGeo = rest.filter((x) => x.lat == null);
    const opt = f.lat != null ? optimizeRoute(geoRest, { lat: f.lat, lng: f.lng }).stops : geoRest;
    const order = done.concat([f], opt, noGeo).map((x) => x.id);
    await withTx(async (client) => {
      const q = client.query.bind(client);
      await q(`UPDATE prospect_route_stops SET seq = seq + 10000 WHERE route_id=$1`, [rid]);
      let k = 1; for (const id of order) await q(`UPDATE prospect_route_stops SET seq=$3 WHERE route_id=$1 AND prospect_id=$2`, [rid, id, k++]);
    });
    warmRoad([rid]);
    return { ok: true, route_id: rid, order };
  });

  // 🎙 빠른 녹음 → 지금 위치 근처 후보(반경 250m, 최대 5곳) — 오늘 내 루트에 있는 곳 우선.
  //   auto_id: 확실할 때만(루트 정류장 80m 안, 또는 가장 가까운 곳이 40m 안이고 두 번째와 30m 이상 차이) 화면이 바로 연결
  app.get('/api/prospects/nearby', view, async (req) => {
    const lat = Number(req.query?.lat), lng = Number(req.query?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { rows: [], auto_id: null };
    const R = 250, dLat = R / 111320, dLng = R / (111320 * Math.cos((lat * Math.PI) / 180));
    const params = [lat - dLat, lat + dLat, lng - dLng, lng + dLng, mxToday(), me(req)];
    const cond = scopeCond(req, params, { unassigned: true });
    const rows = (await query(
      `SELECT p.id, p.nom_estab, p.lat, p.lng, p.stage, p.priority, p.score, p.owner_user_id, p.colonia,
              EXISTS (SELECT 1 FROM prospect_route_stops s JOIN prospect_routes r ON r.id=s.route_id
                       WHERE s.prospect_id=p.id AND r.route_date=$5::date AND r.user_id=$6) AS on_route
         FROM prospects p
        WHERE p.deleted_at IS NULL AND p.stage <> 'descartado' AND p.lat BETWEEN $1 AND $2 AND p.lng BETWEEN $3 AND $4 AND ${cond}`, params)).rows
      .map((p) => ({ id: Number(p.id), name: p.nom_estab, stage: p.stage, priority: p.priority, score: Number(p.score) || 0, colonia: p.colonia,
        on_route: p.on_route, mine: p.owner_user_id != null && Number(p.owner_user_id) === me(req), dist: distanceM(lat, lng, p.lat, p.lng) }))
      .filter((p) => p.dist != null && p.dist <= R)
      .sort((a, b) => (a.on_route && a.dist <= 80 ? 0 : 1) - (b.on_route && b.dist <= 80 ? 0 : 1) || a.dist - b.dist)
      .slice(0, 5);
    let auto = null;
    if (rows[0] && rows[0].on_route && rows[0].dist <= 80) auto = rows[0].id;
    else if (rows[0] && rows[0].dist <= 40 && (!rows[1] || rows[1].dist - rows[0].dist >= 30)) auto = rows[0].id;
    return { rows, auto_id: auto };
  });

  // 오늘 체크인 동선(지도 실선) — 담당자별 체크인 순서
  app.get('/api/prospects/tracks', view, async (req) => {
    const date = YMD.test(String(req.query?.date)) ? req.query.date : mxToday();
    const params = [date]; let cond = 'TRUE';
    if (!isDir(req)) { params.push(me(req)); cond = `c.created_by = $2`; }
    const rows = (await query(
      `SELECT c.id, c.created_by, u.name AS user_name, c.geo_lat, c.geo_lng, c.created_at, c.prospect_id, c.company_name
         FROM sales_consults c LEFT JOIN users u ON u.id=c.created_by
        WHERE c.deleted_at IS NULL AND c.consult_date=$1 AND c.prospect_id IS NOT NULL AND c.geo_lat IS NOT NULL AND ${cond}
        ORDER BY c.created_by, c.created_at`, params)).rows;
    return { date, rows: rows.map((r) => ({ ...r, id: Number(r.id), created_by: Number(r.created_by), prospect_id: Number(r.prospect_id) })) };
  });

  // municipio 목록 — 주를 고르지 않으면 전국(주 코드·이름 함께, 같은 이름 municipio 구분)
  app.get('/api/prospects/municipios', view, async (req) => {
    const ent = req.query?.cve_ent ? String(req.query.cve_ent) : null;
    const rows = (await query(
      `SELECT cve_ent, MAX(entidad) AS entidad, municipio, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE owner_user_id IS NULL)::int AS unassigned,
              COUNT(*) FILTER (WHERE priority='A')::int AS prio_a
         FROM prospects WHERE deleted_at IS NULL AND municipio IS NOT NULL ${ent ? 'AND cve_ent=$1' : ''}
        GROUP BY cve_ent, municipio ORDER BY MAX(entidad), total DESC`, ent ? [ent] : [])).rows;
    return { cve_ent: ent, rows };
  });

  // ── 상세 ───────────────────────────────────────────────────────────
  app.get('/api/prospects/:id', view, async (req, reply) => {
    let p = await loadProspect(req, req.params.id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    // 1127 · 연결된 ERP 고객 정보로 빈 칸 채우기(볼 때마다 — 비어 있을 때만 씀)
    if (p.customer_id) { try { if (await syncProspectFromCustomer(query, Number(p.id))) p = await loadProspect(req, req.params.id); } catch (e) { req.log.warn({ err: e }, 'erp sync'); } }
    const erpInfo = p.customer_id ? await customerInfo(query, p.customer_id).catch(() => null) : null;
    const id = Number(p.id);
    const [visits, hist, crm, links] = await Promise.all([
      query(`SELECT c.id, c.consult_date, c.created_at, c.created_by, u.name AS user_name, c.contact_name, c.review_status,
                    c.checkin_dist_m, r.id AS rec_id, r.status AS rec_status, r.alta_status, r.summary_json->>'resumen' AS resumen
               FROM sales_consults c LEFT JOIN users u ON u.id=c.created_by
               LEFT JOIN LATERAL (SELECT * FROM sales_consult_recordings WHERE consult_id=c.id ORDER BY id DESC LIMIT 1) r ON TRUE
              WHERE c.prospect_id=$1 AND c.deleted_at IS NULL ORDER BY c.created_at DESC`, [id]),
      query(`SELECT h.from_stage, h.to_stage, h.reason, h.auto, h.created_at, u.name AS user_name
               FROM prospect_stage_history h LEFT JOIN users u ON u.id=h.user_id WHERE h.prospect_id=$1 ORDER BY h.created_at DESC`, [id]),
      query(`SELECT field_key, value, source, updated_at FROM prospect_crm_values WHERE prospect_id=$1`, [id]),
      query(`SELECT l.*, c.name AS customer_name, c.code AS customer_code FROM prospect_customer_links l
               JOIN customers c ON c.id=l.customer_id WHERE l.prospect_id=$1 ORDER BY l.created_at DESC`, [id]),
    ]);
    const owner = p.owner_user_id ? (await query(`SELECT name FROM users WHERE id=$1`, [p.owner_user_id])).rows[0] : null;
    // 어느 업로드 파일로 들어왔나(파일 이름 · 올린 시각, 멕시코 시간)
    let upload = null;
    try { upload = p.import_batch_id ? (await query(`SELECT b.file_name, to_char(b.created_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS at, b.edition
                                                       FROM prospect_import_batches b WHERE b.id=$1`, [p.import_batch_id])).rows[0] || null
      : (p.source === 'denue' ? { file_name: null, at: (await query(`SELECT to_char(created_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS at FROM prospects WHERE id=$1`, [p.id])).rows[0].at, edition: p.denue_edition } : null); } catch (_) { upload = null; }
    const cust = p.customer_id ? (await query(`SELECT id, code, name, approval_status FROM customers WHERE id=$1`, [p.customer_id])).rows[0] : null;
    return {
      prospect: { ...pub(p), owner_name: owner ? owner.name : null, upload }, customer: cust || null,
      erp: erpInfo ? { id: Number(erpInfo.id), code: erpInfo.code, name: erpInfo.name, rfc: erpInfo.rfc, email: erpInfo.contact, phone: erpInfo.phone,
        buyer_name: erpInfo.buyer_name, buyer_phone: erpInfo.buyer_phone, ship_address: erpInfo.ship_address, branch_count: erpInfo.branch_count,
        customer_type: erpInfo.customer_type, owner_name: erpInfo.owner_name, ciudad: erpInfo.crm_ciudad || null, estado: erpInfo.crm_estado || null } : null,
      visits: visits.rows.map((v) => ({ ...v, id: Number(v.id), created_by: Number(v.created_by), rec_id: v.rec_id ? Number(v.rec_id) : null })),
      history: hist.rows, crm: Object.fromEntries(crm.rows.map((r) => [r.field_key, r.value])),
      crm_missing: missingRequired(Object.fromEntries(crm.rows.map((r) => [r.field_key, r.value]))),
      potential: potentialOf(Object.fromEntries(crm.rows.map((r) => [r.field_key, r.value]))),
      score_log: (await query(`SELECT created_at, score, prev_score, info_pct, stage, reason FROM prospect_score_log WHERE prospect_id=$1 ORDER BY created_at`, [id])).rows,
      quotes: (await query(`SELECT q.id, q.quote_no, q.quote_date, q.status, q.guest_name, q.customer_id, u.name AS user_name,
                                   ${isDir(req) || Number(p.owner_user_id) === me(req) ? 'q.subtotal_mxn::float' : 'NULL::float'} AS subtotal_mxn
                              FROM quotes q LEFT JOIN users u ON u.id=q.created_by
                             WHERE q.status <> 'cancelled' AND (q.prospect_id=$1 OR ($2::bigint IS NOT NULL AND q.customer_id=$2))
                             ORDER BY q.quote_date DESC, q.id DESC`, [id, p.customer_id == null ? null : Number(p.customer_id)])).rows
        .map((q) => ({ ...q, id: Number(q.id) })),
      links: links.rows.map((l) => ({ ...l, id: Number(l.id), customer_id: Number(l.customer_id) })),
    };
  });

  app.patch('/api/prospects/:id', edit, async (req, reply) => {
    const p = await loadProspect(req, req.params.id, { unassigned: false });
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {}; const sets = []; const params = [Number(p.id)];
    const put = (col, v) => { params.push(v); sets.push(`${col}=$${params.length}`); };
    for (const k of ['nom_estab', 'raz_social', 'address', 'colonia', 'cp', 'phone', 'email', 'web']) if (k in b) put(k, txt(b[k], 300));
    if (isDir(req) && ['A', 'B', 'C'].includes(b.priority)) put('priority', b.priority);
    if (isDir(req) && SEGMENTS.includes(b.segment)) put('segment', b.segment);
    if (('lat' in b) && Number.isFinite(Number(b.lat)) && Number.isFinite(Number(b.lng))) { put('lat', Number(b.lat)); put('lng', Number(b.lng)); }
    if (!sets.length) return { ok: true };
    if (sets.some((s) => s.startsWith('nom_estab=')) && !txt(b.nom_estab)) return reply.code(400).send({ error: 'name_required' });
    await query(`UPDATE prospects SET ${sets.join(', ')}, updated_at=now() WHERE id=$1`, params);
    await logEvent({ userId: me(req), action: 'update', target: `prospect:${p.id}`, detail: Object.keys(b) });
    return { ok: true };
  });

  // 수동 등록 — 리스트에 없는 가게를 현장에서(Visita no planeada)
  app.post('/api/prospects', edit, async (req, reply) => {
    const b = req.body || {};
    const name = txt(b.nom_estab, 200) || '(Sin nombre — completar)';
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return reply.code(400).send({ error: 'geo_required' });
    const owner = isDir(req) && int(b.owner_user_id) ? int(b.owner_user_id) : me(req);
    const st = b.cve_ent ? { cve_ent: txt(b.cve_ent, 4), entidad: txt(b.entidad, 80) } : await stateNear(lat, lng);
    const r = (await query(
      `INSERT INTO prospects (nom_estab, segment, priority, lat, lng, address, municipio, cve_ent, entidad, phone, source,
                              owner_user_id, assigned_at, stage, created_by)
       VALUES ($1,$2,'B',$3,$4,$5,$6,$7,$8,$9,'manual',$10,now(),'asignado',$11) RETURNING id`,
      [name, SEGMENTS.includes(b.segment) ? b.segment : 'otro', lat, lng, txt(b.address), txt(b.municipio, 120),
        st.cve_ent, st.entidad, txt(b.phone, 40), owner, me(req)])).rows[0];
    const id = Number(r.id);
    await query(`INSERT INTO prospect_stage_history (prospect_id, from_stage, to_stage, user_id, reason, auto) VALUES ($1,NULL,'asignado',$2,'alta manual',TRUE)`, [id, me(req)]);
    await logEvent({ userId: me(req), action: 'create', target: `prospect:${id}`, detail: { manual: true } });
    return { id };
  });

  // ── 단계 · 배정 ────────────────────────────────────────────────────
  app.post('/api/prospects/:id/stage', edit, async (req, reply) => {
    const b = req.body || {};
    const out = await withTx(async (client) => {
      const q = client.query.bind(client);
      const params = [int(req.params.id)]; const cond = scopeCond(req, params);
      const p = (await q(`SELECT p.id, p.stage FROM prospects p WHERE p.id=$1 AND p.deleted_at IS NULL AND ${cond} FOR UPDATE`, params)).rows[0];
      if (!p) return { code: 404, error: 'not_found' };
      const chk = checkStageMove(p.stage, b.to, { isDirector: isDir(req), reason: b.reason });
      if (!chk.ok) return { code: 400, error: chk.error };
      await moveStage(q, Number(p.id), p.stage, b.to, { userId: me(req), reason: txt(b.reason, 300) });
      await q(`UPDATE prospects SET last_activity_at=now(), suggested_stage=NULL, suggestion_reason=NULL WHERE id=$1`, [p.id]);
      const sc = await recomputeProspect(q, Number(p.id), { userId: me(req), reason: 'etapa: ' + b.to });
      return { ok: true, from: p.stage, to: b.to, score: sc && sc.score };
    });
    if (out.error) return reply.code(out.code).send({ error: out.error });
    return out;
  });

  app.post('/api/prospects/assign', edit, async (req, reply) => {
    if (!directorOnly(req, reply)) return;
    const b = req.body || {};
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(int).filter(Boolean).slice(0, 5000);
    if (!ids.length) return reply.code(400).send({ error: 'no_ids' });
    const owner = b.owner_user_id == null || b.owner_user_id === '' ? null : int(b.owner_user_id);
    const n = await withTx((client) => assignMany(client, ids, owner, me(req)));
    await logEvent({ userId: me(req), action: 'update', target: 'prospects:assign', detail: { n, owner } });
    return { ok: true, updated: n };
  });

  // ── 가져오기 ───────────────────────────────────────────────────────
  // rows: 화면에서 CSV 를 파싱한 객체 배열(한 번에 최대 3000행). commit=false 면 미리보기만.
  app.post('/api/prospects/import', { ...edit, bodyLimit: 20 * 1024 * 1024 }, async (req, reply) => {
    if (!directorOnly(req, reply)) return;
    const b = req.body || {};
    const edition = /^\d{4}-\d{2}$/.test(String(b.edition)) ? b.edition : mxToday().slice(0, 7);
    const raw = (Array.isArray(b.rows) ? b.rows : []).slice(0, 3000);
    const good = []; const bad = {};
    for (const r of raw) { const n = normalizeImportRow(r); if (n.error) bad[n.error] = (bad[n.error] || 0) + 1; else good.push(n); }
    const ids = good.map((g) => g.denue_id);
    const exist = new Set((await query(`SELECT denue_id FROM prospects WHERE denue_id = ANY($1)`, [ids])).rows.map((r) => r.denue_id));
    const byState = {}; const bySeg = {};
    for (const g of good) {
      const k = `${g.cve_ent || '?'} ${g.entidad || ''}`.trim(); byState[k] = (byState[k] || 0) + 1;
      bySeg[g.segment] = (bySeg[g.segment] || 0) + 1;
    }
    const broken = good.filter((g) => [g.nom_estab, g.municipio, g.colonia, g.address].some((x) => x && /\uFFFD/.test(x))).length;
    const summary = { received: raw.length, valid: good.length, new: good.filter((g) => !exist.has(g.denue_id)).length,
      update: good.filter((g) => exist.has(g.denue_id)).length, invalid: bad, by_state: byState, by_segment: bySeg, edition, broken,
      no_state: good.filter((g) => !g.cve_ent).length };
    if (!b.commit) return summary;
    // 업로드 파일 기록 — 첫 묶음에서 만들고, 나머지 묶음은 같은 batch_id 로 들어온다
    let batchId = int(b.batch_id);
    if (batchId && !(await query(`SELECT 1 FROM prospect_import_batches WHERE id=$1`, [batchId])).rows.length) batchId = null;
    if (!batchId) batchId = Number((await query(`INSERT INTO prospect_import_batches (file_name, edition, created_by) VALUES ($1,$2,$3) RETURNING id`,
      [txt(b.file_name, 200) || 'DENUE ' + edition, edition, me(req)])).rows[0].id);
    const newIds = await withTx(async (client) => {
      const q = client.query.bind(client); const created = [];
      for (const g of good) {
        if (exist.has(g.denue_id)) {
          // 기존: DENUE 항목만 갱신(담당·단계·활동·수동 수정값은 유지) — 사람이 고친 연락처는 덮지 않는다
          await q(`UPDATE prospects SET clee=$2, raz_social=COALESCE(raz_social,$3), scian_code=$4, per_ocu=$5,
                          address=COALESCE(address,$6), colonia=COALESCE(colonia,$7), cp=COALESCE(cp,$8), lat=COALESCE(lat,$9), lng=COALESCE(lng,$10),
                          phone=COALESCE(phone,$11), email=COALESCE(email,$12), denue_edition=$13, denue_missing=FALSE, updated_at=now(),
                          -- 예전 업로드에서 스페인어 글자가 깨져 들어간 값(�, Ã…)은 새 파일 값으로 고친다
                          nom_estab = CASE WHEN nom_estab ~ '(\uFFFD|Ã|Â)' AND $14::text IS NOT NULL THEN $14 ELSE nom_estab END,
                          municipio = CASE WHEN (municipio IS NULL OR municipio ~ '(\uFFFD|Ã|Â)') AND $15::text IS NOT NULL THEN $15 ELSE municipio END,
                          colonia   = CASE WHEN colonia ~ '(\uFFFD|Ã|Â)' AND $7::text IS NOT NULL THEN $7 ELSE colonia END,
                          address   = CASE WHEN address ~ '(\uFFFD|Ã|Â)' AND $6::text IS NOT NULL THEN $6 ELSE address END,
                          entidad   = CASE WHEN (entidad IS NULL OR entidad ~ '(\uFFFD|Ã|Â)') AND $16::text IS NOT NULL THEN $16 ELSE entidad END,
                          cve_ent   = COALESCE(cve_ent, $18),
                          localidad = CASE WHEN localidad ~ '(\uFFFD|Ã|Â)' AND $17::text IS NOT NULL THEN $17 ELSE localidad END
                    WHERE denue_id=$1`,
          [g.denue_id, g.clee, g.raz_social, g.scian_code, g.per_ocu, g.address, g.colonia, g.cp, g.lat, g.lng, g.phone, g.email, edition,
            g.nom_estab, g.municipio, g.entidad, g.localidad, g.cve_ent]);
        } else {
          const r = (await q(
            `INSERT INTO prospects (denue_id, clee, nom_estab, raz_social, scian_code, segment, priority, per_ocu, address, colonia, cp,
                                    cve_ent, entidad, cve_mun, municipio, localidad, lat, lng, phone, email, web, denue_fecha_alta,
                                    denue_edition, source, created_by, import_batch_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'denue',$24,$25)
             ON CONFLICT (denue_id) DO NOTHING RETURNING id`,
            [g.denue_id, g.clee, g.nom_estab, g.raz_social, g.scian_code, g.segment, g.priority, g.per_ocu, g.address, g.colonia, g.cp,
              g.cve_ent, g.entidad, g.cve_mun, g.municipio, g.localidad, g.lat, g.lng, g.phone, g.email, g.web, g.denue_fecha_alta,
              edition, me(req), batchId])).rows[0];
          if (r) created.push(Number(r.id));
        }
      }
      if (created.length) await applyTerritories(client, { onlyIds: created, byUser: me(req) });
      const ents = [...new Set(good.map((g) => g.cve_ent).filter(Boolean))];
      await q(`UPDATE prospect_import_batches SET rows_total=rows_total+$2, created=created+$3, updated=updated+$4,
                 cve_ents=(SELECT ARRAY(SELECT DISTINCT unnest(cve_ents || $5::text[]) ORDER BY 1)) WHERE id=$1`,
        [batchId, raw.length, created.length, summary.update, ents]);
      return created;
    });
    await logEvent({ userId: me(req), action: 'create', target: 'prospects:import', detail: { ...summary, created: newIds.length, batch_id: batchId } });
    return { ...summary, committed: true, created: newIds.length, batch_id: batchId };
  });

  // 판 마감: 이번 판(edition)에 없는 그 주의 DENUE 후보 → 「폐업 가능」 표시(삭제 안 함)
  app.post('/api/prospects/import/finalize', edit, async (req, reply) => {
    if (!directorOnly(req, reply)) return;
    const b = req.body || {};
    if (!PERIOD.test(String(b.edition)) || !b.cve_ent) return reply.code(400).send({ error: 'bad_args' });
    const r = await query(`UPDATE prospects SET denue_missing=TRUE WHERE source='denue' AND cve_ent=$1 AND COALESCE(denue_edition,'') <> $2 AND deleted_at IS NULL`,
      [String(b.cve_ent), b.edition]);
    return { ok: true, marked_missing: r.rowCount };
  });

  // ── DENUE 데이터 삭제(디렉터) — 다시 올리기 전에 ───────────────────────
  //   scope=untouched : 작업 기록이 없는 후보만(미배정·배정 단계, 방문·고객정보·고객 연결·견적 없음) — 기본
  //   scope=all       : 이 주의 DENUE 후보 전부. 방문(고객상담) 기록과 견적서는 ERP에 그대로 남고 후보 연결만 끊긴다.
  //   점수 이력·단계 이력·루트·연결 요청 등 후보에 딸린 기록은 함께 지워진다(복구 불가).
  const UNTOUCHED = `p.stage IN ('sin_asignar','asignado') AND p.customer_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM sales_consults c WHERE c.prospect_id=p.id)
      AND NOT EXISTS (SELECT 1 FROM prospect_crm_values v WHERE v.prospect_id=p.id)
      AND NOT EXISTS (SELECT 1 FROM quotes q WHERE q.prospect_id=p.id)`;
  // 대상: batch=<업로드 id> → 그 파일로 들어온 후보 / batch=legacy → 파일 기록이 없는 예전 업로드(그 주) / 없으면 그 주 전체
  const purgeTarget = (src) => {
    const bt = String(src.batch || '');
    if (/^\d+$/.test(bt)) return { where: `p.source='denue' AND p.import_batch_id=$1`, params: [Number(bt)], batch: Number(bt) };
    const ent = txt(src.cve_ent, 4); if (!ent) return null;
    if (bt === 'legacy') return { where: `p.source='denue' AND p.import_batch_id IS NULL AND p.cve_ent=$1`, params: [ent], batch: 'legacy' };
    return { where: `p.source='denue' AND p.cve_ent=$1`, params: [ent], batch: null };
  };
  // 업로드 파일 목록(지금 남아 있는 후보 수 · 작업 기록 없는 수) + 파일 기록 없는 예전 업로드
  app.get('/api/prospects/import/batches', edit, async (req, reply) => {
    if (!directorOnly(req, reply)) return;
    const rows = (await query(
      `SELECT b.id, b.file_name, b.edition, b.cve_ents, b.rows_total, b.created, b.updated, b.created_at, u.name AS created_by_name,
              to_char(b.created_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS at,
              COUNT(p.id)::int AS remaining, COUNT(p.id) FILTER (WHERE ${UNTOUCHED})::int AS untouched
         FROM prospect_import_batches b LEFT JOIN users u ON u.id=b.created_by
         LEFT JOIN prospects p ON p.import_batch_id=b.id AND p.source='denue'
        GROUP BY b.id, u.name ORDER BY b.created_at DESC LIMIT 200`)).rows;
    const legacy = (await query(
      `SELECT p.cve_ent, MAX(p.entidad) AS entidad, MAX(p.denue_edition) AS edition, COUNT(*)::int AS remaining, COUNT(*) FILTER (WHERE ${UNTOUCHED})::int AS untouched,
              to_char(MIN(p.created_at) AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS first_at,
              to_char(MAX(p.created_at) AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS last_at,
              (SELECT u.name FROM users u WHERE u.id = MIN(p.created_by)) AS created_by_name
         FROM prospects p WHERE p.source='denue' AND p.import_batch_id IS NULL GROUP BY p.cve_ent ORDER BY p.cve_ent`)).rows;
    return { rows: rows.map((r) => ({ ...r, id: Number(r.id) })), legacy };
  });
  app.get('/api/prospects/purge-preview', edit, async (req, reply) => {
    if (!directorOnly(req, reply)) return;
    const tg = purgeTarget(req.query || {}); if (!tg) return reply.code(400).send({ error: 'cve_ent_required' });
    const r = (await query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE ${UNTOUCHED})::int AS untouched,
              COUNT(*) FILTER (WHERE p.owner_user_id IS NOT NULL)::int AS assigned
         FROM prospects p WHERE ${tg.where}`, tg.params)).rows[0];
    return { cve_ent: req.query?.cve_ent || null, batch: tg.batch, ...r, worked: r.total - r.untouched };
  });
  app.post('/api/prospects/purge', edit, async (req, reply) => {
    if (!directorOnly(req, reply)) return;
    const b = req.body || {};
    const tg = purgeTarget(b); if (!tg) return reply.code(400).send({ error: 'cve_ent_required' });
    const scope = b.scope === 'all' ? 'all' : 'untouched';
    if (String(b.confirm || '').trim() !== '삭제') return reply.code(400).send({ error: 'confirm_required' });
    const out = await withTx(async (client) => {
      const q = client.query.bind(client);
      const del = await q(`DELETE FROM prospects p WHERE ${tg.where} ${scope === 'untouched' ? `AND ${UNTOUCHED}` : ''} RETURNING p.id`, tg.params);
      // 비게 된 루트 정리
      await q(`DELETE FROM prospect_routes r WHERE NOT EXISTS (SELECT 1 FROM prospect_route_stops s WHERE s.route_id=r.id)`);
      const left = Number((await q(`SELECT COUNT(*)::int AS n FROM prospects p WHERE ${tg.where}`, tg.params)).rows[0].n);
      // 파일로 들어온 후보가 하나도 안 남으면 업로드 기록도 지운다
      if (typeof tg.batch === 'number' && !left) await q(`DELETE FROM prospect_import_batches WHERE id=$1`, [tg.batch]);
      return { deleted: del.rowCount, kept: left };
    });
    await logEvent({ userId: me(req), action: 'delete', target: `prospects:denue:${tg.batch || b.cve_ent}`, detail: { scope, ...out } });
    return { ok: true, scope, ...out };
  });

  // ── 지역 ───────────────────────────────────────────────────────────
  app.get('/api/prospect-territories', view, async () => {
    const rows = (await query(
      `SELECT t.*, u.name AS owner_name,
              (SELECT COUNT(*)::int FROM prospects p WHERE p.territory_id=t.id AND p.deleted_at IS NULL) AS total,
              (SELECT COUNT(*)::int FROM prospects p WHERE p.territory_id=t.id AND p.deleted_at IS NULL AND p.stage NOT IN ('sin_asignar','asignado','descartado')) AS worked
         FROM prospect_territories t LEFT JOIN users u ON u.id=t.owner_user_id ORDER BY t.cve_ent, t.name`)).rows;
    // 지도 윤곽: 지도 구역은 그대로, municipio·CP 지역은 후보 위치의 볼록 껍질
    const need = rows.filter((r) => !(Array.isArray(r.polygon) && r.polygon.length >= 3)).map((r) => Number(r.id));
    const pts = {};
    if (need.length) (await query(`SELECT territory_id, lat, lng FROM prospects WHERE territory_id = ANY($1) AND deleted_at IS NULL AND lat IS NOT NULL`, [need])).rows
      .forEach((r) => (pts[r.territory_id] = pts[r.territory_id] || []).push([Number(r.lat), Number(r.lng)]));
    return { rows: rows.map((r) => ({ ...r, id: Number(r.id), owner_user_id: r.owner_user_id == null ? null : Number(r.owner_user_id),
      outline: Array.isArray(r.polygon) && r.polygon.length >= 3 ? r.polygon : convexHull(pts[r.id] || []) })) };
  });
  // 지역 저장 — 디렉터: 누구의 지역이든(구역 그리기 또는 municipio/CP) / 담당자: 자기 지역만, 지도 구역으로만
  async function saveTerritory(req, reply, id) {
    const dir = isDir(req);
    const b = req.body || {};
    const name = txt(b.name, 120); if (!name) { reply.code(400).send({ error: 'name_required' }); return null; }
    const polygon = cleanPolygon(b.polygon);
    const mun = polygon || !dir ? [] : (Array.isArray(b.municipios) ? b.municipios : []).map((x) => txt(x, 120)).filter(Boolean);
    const cps = polygon || !dir ? [] : (Array.isArray(b.cps) ? b.cps : String(b.cps || '').split(/[\s,;]+/)).map((x) => txt(x, 10)).filter((x) => x && /^\d{5}$/.test(x));
    if (!dir && !polygon) { reply.code(400).send({ error: 'polygon_required' }); return null; }
    if (!polygon && !mun.length && !cps.length) { reply.code(400).send({ error: 'area_required' }); return null; }
    const owner = dir ? int(b.owner_user_id) : me(req);
    const ent = txt(b.cve_ent, 4) || await territoryState({ polygon, cps }) || '19';
    return withTx(async (client) => {
      const q = client.query.bind(client);
      let tid = id;
      if (tid) {
        const old = (await q(`SELECT owner_user_id FROM prospect_territories WHERE id=$1`, [tid])).rows[0];
        if (!old) return { code: 404 };
        if (!dir && Number(old.owner_user_id) !== me(req)) return { code: 403 };
        await q(`UPDATE prospect_territories SET name=$2, cve_ent=$3, municipios=$4, cps=$5, owner_user_id=$6, active=$7, polygon=$8, updated_at=now() WHERE id=$1`,
          [tid, name, ent, mun, cps, owner, b.active !== false, polygon ? JSON.stringify(polygon) : null]);
        // 지역 경계가 바뀌었을 수 있으니 이 지역 표시를 풀고 다시 판정
        await q(`UPDATE prospects SET territory_id=NULL WHERE territory_id=$1`, [tid]);
        // 담당이 바뀌면 그 지역에서 옛 담당이 들고 있던 「배정」 단계 후보를 새 담당에게(진행 중인 건은 유지)
        if (dir && b.move_owner && old.owner_user_id && owner && Number(old.owner_user_id) !== owner) {
          const ids = (await q(`SELECT id FROM prospects WHERE owner_user_id=$1 AND stage='asignado' AND deleted_at IS NULL`, [old.owner_user_id])).rows.map((r) => Number(r.id));
          if (ids.length) await assignMany(client, ids, null, me(req));
        }
      } else {
        tid = Number((await q(`INSERT INTO prospect_territories (name, cve_ent, municipios, cps, owner_user_id, created_by, polygon) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [name, ent, mun, cps, owner, me(req), polygon ? JSON.stringify(polygon) : null])).rows[0].id);
      }
      const n = await applyTerritories(client, { cveEnt: ent, byUser: me(req) });
      return { id: tid, matched: n };
    });
  }
  app.post('/api/prospect-territories', edit, async (req, reply) => {
    const r = await saveTerritory(req, reply, null); if (!r) return; return r;
  });
  app.patch('/api/prospect-territories/:id', edit, async (req, reply) => {
    const r = await saveTerritory(req, reply, int(req.params.id)); if (!r) return;
    if (r.code) return reply.code(r.code).send({ error: r.code === 403 ? 'own_territory_only' : 'not_found' });
    return r;
  });

  // 지역 이름만 바꾸기(디렉터·관리자 또는 자기 지역) — 구역·담당·후보 배정은 그대로
  app.patch('/api/prospect-territories/:id/name', edit, async (req, reply) => {
    const tid = int(req.params.id); const name = txt((req.body || {}).name, 120);
    if (!name) return reply.code(400).send({ error: 'name_required' });
    const t = (await query(`SELECT owner_user_id FROM prospect_territories WHERE id=$1`, [tid])).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (!isDir(req) && Number(t.owner_user_id) !== me(req)) return reply.code(403).send({ error: 'own_territory_only' });
    await query(`UPDATE prospect_territories SET name=$2, updated_at=now() WHERE id=$1`, [tid, name]);
    await logEvent({ userId: me(req), action: 'update', target: `prospect_territory:${tid}`, detail: { name } });
    return { ok: true, id: tid, name };
  });

  // 구역 미리보기 — 그린 구역 안 후보를 「가져올 수 있음 / 이미 내 것 / 다른 담당(선택 안 됨)」으로 나눠 보여준다
  app.post('/api/prospect-territories/preview', edit, async (req, reply) => {
    const b = req.body || {};
    const poly = cleanPolygon(b.polygon); if (!poly) return reply.code(400).send({ error: 'bad_polygon' });
    const owner = isDir(req) ? int(b.owner_user_id) : me(req);
    const exclude = int(b.territory_id);
    const lats = poly.map((p) => p[0]), lngs = poly.map((p) => p[1]);
    const rows = (await query(
      `SELECT p.id, p.lat, p.lng, p.nom_estab, p.owner_user_id, p.stage, t.owner_user_id AS t_owner, u.name AS owner_name
         FROM prospects p LEFT JOIN prospect_territories t ON t.id=p.territory_id AND t.id IS DISTINCT FROM $5
         LEFT JOIN users u ON u.id=COALESCE(p.owner_user_id, t.owner_user_id)
        WHERE p.deleted_at IS NULL AND p.lat BETWEEN $1 AND $2 AND p.lng BETWEEN $3 AND $4`,
      [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs), exclude])).rows
      .filter((p) => inPolygon(Number(p.lat), Number(p.lng), poly));
    const out = { inside: rows.length, free: 0, mine: 0, taken: 0, taken_by: {}, points: [] };
    for (const p of rows) {
      const holder = p.owner_user_id != null ? Number(p.owner_user_id) : p.t_owner != null ? Number(p.t_owner) : null;
      const st = holder == null ? 'free' : owner != null && holder === owner ? 'mine' : 'taken';
      out[st]++;
      if (st === 'taken') out.taken_by[p.owner_name || '?'] = (out.taken_by[p.owner_name || '?'] || 0) + 1;
      if (out.points.length < 3000) out.points.push({ id: Number(p.id), lat: Number(p.lat), lng: Number(p.lng), st });
    }
    out.taken_by = Object.entries(out.taken_by).map(([name, n]) => ({ name, n })).sort((a, c) => c.n - a.n);
    return out;
  });

  // 지역 삭제(디렉터 또는 자기 지역) — 후보는 남는다. release=true 면 이 지역에서 아직 「배정」 단계(방문 전)인 후보의 담당도 해제
  app.delete('/api/prospect-territories/:id', edit, async (req, reply) => {
    const tid = int(req.params.id); const release = String(req.query?.release || '') === '1';
    const own = (await query(`SELECT owner_user_id FROM prospect_territories WHERE id=$1`, [tid])).rows[0];
    if (own && !isDir(req) && Number(own.owner_user_id) !== me(req)) return reply.code(403).send({ error: 'own_territory_only' });
    const out = await withTx(async (client) => {
      const q = client.query.bind(client);
      const t = (await q(`SELECT id, name FROM prospect_territories WHERE id=$1`, [tid])).rows[0];
      if (!t) return null;
      let released = 0;
      if (release) {
        const ids = (await q(`SELECT id FROM prospects WHERE territory_id=$1 AND stage='asignado' AND deleted_at IS NULL`, [tid])).rows.map((r) => Number(r.id));
        if (ids.length) released = await assignMany(client, ids, null, me(req));
      }
      const r = await q(`UPDATE prospects SET territory_id=NULL WHERE territory_id=$1`, [tid]);
      await q(`DELETE FROM prospect_territories WHERE id=$1`, [tid]);
      return { name: t.name, detached: r.rowCount, released };
    });
    if (!out) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: me(req), action: 'delete', target: `prospect_territory:${tid}`, detail: out });
    return { ok: true, ...out };
  });

  // ── 목표 ───────────────────────────────────────────────────────────
  // 목표: 디렉터가 지표별 총 합의 목표 + 담당자별 할당률(%) → 담당자 목표 = 총 목표 × 할당률. 할당률 없으면 목표 없음.
  app.get('/api/prospect-targets', view, async (req) => {
    const period = PERIOD.test(String(req.query?.period)) ? req.query.period : mxToday().slice(0, 7);
    const params = [period]; let cond = '';
    if (!isDir(req)) { params.push(me(req)); cond = ' AND user_id=$2'; }
    const rows = (await query(`SELECT user_id, metric, target_value FROM prospect_targets WHERE period=$1${cond}`, params)).rows;
    const totals = (await query(`SELECT metric, total_value FROM prospect_target_totals WHERE period=$1`, [period])).rows;
    const shares = (await query(`SELECT user_id, share_pct FROM prospect_target_shares WHERE period=$1${cond}`, params)).rows;
    return { period,
      rows: rows.map((r) => ({ user_id: Number(r.user_id), metric: r.metric, value: Number(r.target_value) })),
      totals: Object.fromEntries(totals.map((r) => [r.metric, Number(r.total_value)])),
      shares: Object.fromEntries(shares.map((r) => [Number(r.user_id), Number(r.share_pct)])) };
  });
  app.put('/api/prospect-targets', edit, async (req, reply) => {
    if (!directorOnly(req, reply)) return;
    const b = req.body || {};
    if (!PERIOD.test(String(b.period))) return reply.code(400).send({ error: 'bad_period' });
    const totals = {}; for (const m of METRICS) { if (m === 'puntos') continue; const v = Number((b.totals || {})[m]); if (Number.isFinite(v) && v > 0) totals[m] = v; }
    const pts = pointsTarget(totals); if (pts > 0) totals.puntos = pts;   // 개발 점수 = 단계 목표에서 자동 계산
    const shares = {}; for (const [u, p] of Object.entries(b.shares || {})) { const uid = int(u); const v = Math.round(Number(p) * 100) / 100; if (uid && Number.isFinite(v) && v > 0) shares[uid] = Math.min(100, v); }
    const sum = Object.values(shares).reduce((a, c) => a + c, 0);
    if (sum > 100.001) return reply.code(400).send({ error: 'share_over_100', sum });
    let n = 0;
    await withTx(async (client) => {
      const q = client.query.bind(client);
      await q(`DELETE FROM prospect_target_totals WHERE period=$1`, [b.period]);
      await q(`DELETE FROM prospect_target_shares WHERE period=$1`, [b.period]);
      await q(`DELETE FROM prospect_targets WHERE period=$1`, [b.period]);
      for (const [m, v] of Object.entries(totals)) await q(`INSERT INTO prospect_target_totals (period, metric, total_value, updated_by) VALUES ($1,$2,$3,$4)`, [b.period, m, v, me(req)]);
      for (const [u, p] of Object.entries(shares)) await q(`INSERT INTO prospect_target_shares (period, user_id, share_pct, updated_by) VALUES ($1,$2,$3,$4)`, [b.period, u, p, me(req)]);
      // 첫 매출 금액은 할당률이 아니라 할당받은 담당자끼리 똑같이(동률) 나눈다(디렉터 2026-11-26)
      const equal = Object.fromEntries(Object.keys(shares).map((u) => [u, 100 / Object.keys(shares).length]));
      for (const [m, v] of Object.entries(totals)) {
        const alloc = allocateTarget(v, m === 'venta_nuevos' ? equal : shares, { integer: m !== 'venta_nuevos' });
        for (const [u, t] of Object.entries(alloc)) {
          if (!(t > 0)) continue;
          await q(`INSERT INTO prospect_targets (user_id, period, metric, target_value, updated_by) VALUES ($1,$2,$3,$4,$5)`, [u, b.period, m, t, me(req)]);
          n++;
        }
      }
    });
    await logEvent({ userId: me(req), action: 'update', target: `prospect_targets:${b.period}`, detail: { totals, shares } });
    return { ok: true, saved: n, share_sum: Math.round(sum * 100) / 100 };
  });

  // ── 루트 ───────────────────────────────────────────────────────────
  async function routeStops(rid, again = true) {
    const rows = await routeStopsRaw(rid);
    // 1127 · ERP 고객인데 주소가 비어 있는 정류장 → ERP 정보로 채우고 다시 읽음(한 번만)
    const need = rows.filter((x) => x.customer_id && !x.address && !x.colonia);
    if (again && need.length) { let n = 0; for (const x of need) n += await syncProspectFromCustomer(query, x.id).catch(() => 0); if (n) return routeStopsRaw(rid); }
    return rows;
  }
  async function routeStopsRaw(rid) {
    return (await query(
      `SELECT s.seq, s.consult_id, p.id, p.score, p.nom_estab, p.address, p.colonia, p.municipio, p.lat, p.lng, p.phone, p.stage, p.priority, p.segment, p.customer_id,
              c.review_status, c.created_at AS checkin_at
         FROM prospect_route_stops s JOIN prospects p ON p.id=s.prospect_id
         LEFT JOIN sales_consults c ON c.id=s.consult_id
        WHERE s.route_id=$1 AND (s.consult_id IS NOT NULL OR (p.deleted_at IS NULL AND p.stage <> 'descartado'))
        ORDER BY s.seq`, [rid])).rows.map((s) => ({ ...s, id: Number(s.id), consult_id: s.consult_id ? Number(s.consult_id) : null }));
  }
  async function routeOut(userId, date) {
    const r = (await query(`SELECT id, name FROM prospect_routes WHERE user_id=$1 AND route_date=$2`, [userId, date])).rows[0];
    if (!r) return { date, user_id: userId, stops: [] };
    const stops = await routeStops(Number(r.id));
    return { date, user_id: userId, route_id: Number(r.id), name: r.name, stops, estimate: await estimateRoad(stops, await routeSettings()) };
  }
  // 저장 직후 도로 거리 계산(응답은 기다리지 않음, 공개 서버 간격 지킴)
  function warmRoad(ids) {
    (async () => { const rs = await routeSettings(); for (const id of ids) { try { await estimateRoad(await routeStops(Number(id)), rs); } catch (_) { /* 무시 */ } } })().catch(() => {});
  }
  // ── 방문 목록(날짜 미정 루트) — 루트를 먼저 짜 두고 날짜는 본인이 고른다(디렉터 결정 2026-11-26) ──
  const WORKDAY = (ymd) => { const g = new Date(ymd + 'T12:00:00Z').getUTCDay(); return g !== 6 && g !== 0; };   // 토·일 근무 없음
  async function ownRoute(req, id) {
    const r = (await query(`SELECT r.*, u.name AS user_name FROM prospect_routes r LEFT JOIN users u ON u.id=r.user_id WHERE r.id=$1`, [int(id)])).rows[0];
    if (!r) return null;
    if (!isDir(req) && Number(r.user_id) !== me(req)) return null;
    return r;
  }
  app.get('/api/prospect-routes/plans', view, async (req) => {
    const params = []; let cond = 'TRUE';
    if (!isDir(req)) { params.push(me(req)); cond = 'r.user_id=$1'; }
    else if (int(req.query?.user)) { params.push(int(req.query.user)); cond = 'r.user_id=$1'; }
    const rows = (await query(
      `SELECT r.id, r.user_id, u.name AS user_name, r.name, r.created_at, COUNT(s.id)::int AS stops, COUNT(s.consult_id)::int AS visited
         FROM prospect_routes r JOIN prospect_route_stops s ON s.route_id=r.id LEFT JOIN users u ON u.id=r.user_id
        WHERE r.route_date IS NULL AND ${cond}
        GROUP BY r.id, u.name ORDER BY r.created_at, r.id LIMIT 200`, params)).rows;
    const pts = {};
    if (rows.length) (await query(`SELECT s.route_id, p.lat, p.lng FROM prospect_route_stops s JOIN prospects p ON p.id=s.prospect_id WHERE s.route_id = ANY($1) ORDER BY s.route_id, s.seq`,
      [rows.map((r) => Number(r.id))])).rows.forEach((x) => (pts[x.route_id] = pts[x.route_id] || []).push({ lat: Number(x.lat), lng: Number(x.lng) }));
    const rs = await routeSettings();
    return { rows: await Promise.all(rows.map(async (r) => ({ ...r, id: Number(r.id), user_id: Number(r.user_id), estimate: (({ path, ...e }) => e)(await estimateRoad(pts[r.id] || [], rs, null, { cacheOnly: true })) }))) };
  });
  app.get('/api/prospect-routes/by-id/:id', view, async (req, reply) => {
    const r = await ownRoute(req, req.params.id); if (!r) return reply.code(404).send({ error: 'not_found' });
    return { route_id: Number(r.id), user_id: Number(r.user_id), user_name: r.user_name, name: r.name,
      date: r.route_date ? String(r.route_date instanceof Date ? r.route_date.toISOString().slice(0, 10) : r.route_date).slice(0, 10) : null,
      ...(await (async () => { const st = await routeStops(Number(r.id)); return { stops: st, estimate: await estimateRoad(st, await routeSettings()) }; })()) };
  });
  // 여러 코스를 한 번에 방문 목록으로 저장 {user_id, name, days:[{prospect_ids}]}
  app.post('/api/prospect-routes/plans', edit, async (req, reply) => {
    const b = req.body || {};
    const uid = isDir(req) && int(b.user_id) ? int(b.user_id) : me(req);
    const days = (Array.isArray(b.days) ? b.days : []).slice(0, 15)
      .map((d) => [...new Set((Array.isArray(d.prospect_ids) ? d.prospect_ids : []).map(int).filter(Boolean))].slice(0, 40)).filter((d) => d.length);
    if (!days.length) return reply.code(400).send({ error: 'empty' });
    const base = txt(b.name, 80) || ('목록 ' + mxToday().slice(5).replace('-', '/'));
    const ids = await withTx(async (client) => {
      const q = client.query.bind(client); const out = [];
      for (let k = 0; k < days.length; k++) {
        const rid = Number((await q(`INSERT INTO prospect_routes (user_id, route_date, created_by, name) VALUES ($1,NULL,$2,$3) RETURNING id`,
          [uid, me(req), days.length > 1 ? `${base} · ${k + 1}/${days.length}` : base])).rows[0].id);
        let seq = 1;
        for (const pid of days[k]) await q(`INSERT INTO prospect_route_stops (route_id, prospect_id, seq) VALUES ($1,$2,$3) ON CONFLICT (route_id, prospect_id) DO NOTHING`, [rid, pid, seq++]);
        out.push(rid);
      }
      return out;
    });
    await logEvent({ userId: me(req), action: 'create', target: `prospect_route_plans:${uid}`, detail: { ids, stops: days.map((d) => d.length) } });
    warmRoad(ids);   // 목록에서 바로 도로 거리가 나오도록 뒤에서 계산
    return { ok: true, ids, user_id: uid };
  });
  // 날짜 정하기/빼기 · 이름 바꾸기 {date: 'YYYY-MM-DD' | null, name}
  //   그 날짜에 이미 루트가 있으면 합친다(뒤에 붙임). 토·일은 근무일이 아니라 거절.
  app.patch('/api/prospect-routes/by-id/:id', edit, async (req, reply) => {
    const r = await ownRoute(req, req.params.id); if (!r) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {};
    if (b.name !== undefined) await query(`UPDATE prospect_routes SET name=$2, updated_at=now() WHERE id=$1`, [r.id, txt(b.name, 80)]);
    if (b.date === undefined) return { ok: true, route_id: Number(r.id) };
    if (b.date === null) {
      await query(`UPDATE prospect_routes SET route_date=NULL, updated_at=now() WHERE id=$1`, [r.id]);
      return { ok: true, route_id: Number(r.id), date: null };
    }
    if (!YMD.test(String(b.date))) return reply.code(400).send({ error: 'bad_date' });
    if (b.date < mxToday()) return reply.code(400).send({ error: 'past_date' });
    if (!WORKDAY(b.date)) return reply.code(400).send({ error: 'not_workday' });
    const out = await withTx(async (client) => {
      const q = client.query.bind(client);
      const ex = (await q(`SELECT id FROM prospect_routes WHERE user_id=$1 AND route_date=$2 AND id<>$3 FOR UPDATE`, [r.user_id, b.date, r.id])).rows[0];
      if (!ex) { await q(`UPDATE prospect_routes SET route_date=$2, updated_at=now() WHERE id=$1`, [r.id, b.date]); return { route_id: Number(r.id), merged: false }; }
      // 합치기: 기존 루트 뒤에 이 목록의 정류장을 붙이고 목록은 지운다
      let seq = Number((await q(`SELECT COALESCE(MAX(seq),0)::int AS m FROM prospect_route_stops WHERE route_id=$1`, [ex.id])).rows[0].m) + 1;
      const st = (await q(`SELECT prospect_id, consult_id FROM prospect_route_stops WHERE route_id=$1 ORDER BY seq`, [r.id])).rows;
      for (const x of st) await q(`INSERT INTO prospect_route_stops (route_id, prospect_id, seq, consult_id) VALUES ($1,$2,$3,$4) ON CONFLICT (route_id, prospect_id) DO NOTHING`, [ex.id, x.prospect_id, seq++, x.consult_id]);
      await q(`DELETE FROM prospect_routes WHERE id=$1`, [r.id]);
      return { route_id: Number(ex.id), merged: true };
    });
    return { ok: true, date: b.date, ...out };
  });
  // 목록·루트 지우기 — 방문 전 정류장만 지우고, 체크인한 기록이 남으면 그 루트는 남긴다
  app.delete('/api/prospect-routes/by-id/:id', edit, async (req, reply) => {
    const r = await ownRoute(req, req.params.id); if (!r) return reply.code(404).send({ error: 'not_found' });
    const out = await withTx(async (client) => {
      const q = client.query.bind(client);
      const del = await q(`DELETE FROM prospect_route_stops WHERE route_id=$1 AND consult_id IS NULL`, [r.id]);
      await tidyRoutes(q, [Number(r.id)]);
      return { removed: del.rowCount };
    });
    return { ok: true, ...out };
  });
  // 🗑 루트 일괄 정리(디렉터·관리자) — 날짜가 정해진 루트를 한 번에
  //   대상: user_id(없으면 모든 담당) · from~to(없으면 오늘부터 전부) · include_plans(날짜 미정 방문 목록도)
  //   mode=delete: 방문 전 정류장을 지움(체크인한 방문 기록은 남김) / mode=unschedule: 날짜만 빼서 방문 목록으로 돌림
  function bulkWhere(b, params) {
    const conds = [];
    if (int(b.user_id)) { params.push(int(b.user_id)); conds.push(`r.user_id=$${params.length}`); }
    const from = YMD.test(String(b.from)) ? b.from : mxToday();
    const to = YMD.test(String(b.to)) ? b.to : null;
    params.push(from); let dc = `r.route_date >= $${params.length}::date`;
    if (to) { params.push(to); dc += ` AND r.route_date <= $${params.length}::date`; }
    conds.push(b.include_plans ? `((${dc}) OR r.route_date IS NULL)` : `(${dc})`);
    return conds.join(' AND ');
  }
  app.post('/api/prospect-routes/bulk-preview', edit, async (req, reply) => {
    if (!directorOnly(req, reply)) return;
    const params = []; const w = bulkWhere(req.body || {}, params);
    const r = (await query(
      `SELECT COUNT(DISTINCT r.id)::int AS routes, COUNT(DISTINCT r.id) FILTER (WHERE r.route_date IS NULL)::int AS plans,
              COUNT(s.id) FILTER (WHERE s.consult_id IS NULL)::int AS stops, COUNT(s.id) FILTER (WHERE s.consult_id IS NOT NULL)::int AS visited,
              COUNT(DISTINCT r.user_id)::int AS users, MIN(r.route_date)::text AS first, MAX(r.route_date)::text AS last
         FROM prospect_routes r LEFT JOIN prospect_route_stops s ON s.route_id=r.id WHERE ${w}`, params)).rows[0];
    return r;
  });
  app.post('/api/prospect-routes/bulk-delete', edit, async (req, reply) => {
    if (!directorOnly(req, reply)) return;
    const b = req.body || {};
    const mode = b.mode === 'unschedule' ? 'unschedule' : 'delete';
    if (String(b.confirm || '').trim() !== (mode === 'delete' ? '삭제' : '확인')) return reply.code(400).send({ error: 'confirm_required' });
    const params = []; const w = bulkWhere(b, params);
    const out = await withTx(async (client) => {
      const q = client.query.bind(client);
      const ids = (await q(`SELECT r.id FROM prospect_routes r WHERE ${w}`, params)).rows.map((x) => Number(x.id));
      if (!ids.length) return { routes: 0, stops: 0 };
      if (mode === 'unschedule') {
        // 날짜만 뺀다 — 이미 체크인한 정류장이 있는 루트는 기록이라 그대로 둔다
        const u = await q(`UPDATE prospect_routes r SET route_date=NULL, updated_at=now(),
                             name=COALESCE(r.name, '루트 ' || to_char(r.route_date,'MM/DD'))
                            WHERE r.id = ANY($1) AND r.route_date IS NOT NULL
                              AND NOT EXISTS (SELECT 1 FROM prospect_route_stops s WHERE s.route_id=r.id AND s.consult_id IS NOT NULL)`, [ids]);
        return { routes: u.rowCount, stops: 0, kept_visited: ids.length - u.rowCount };
      }
      const del = await q(`DELETE FROM prospect_route_stops WHERE route_id = ANY($1) AND consult_id IS NULL`, [ids]);
      await tidyRoutes(q, ids);
      const left = Number((await q(`SELECT COUNT(*)::int AS n FROM prospect_routes WHERE id = ANY($1)`, [ids])).rows[0].n);
      return { routes: ids.length - left, stops: del.rowCount, kept_visited: left };
    });
    await logEvent({ userId: me(req), action: 'delete', target: 'prospect_routes:bulk', detail: { mode, user_id: int(b.user_id), from: b.from, to: b.to, include_plans: !!b.include_plans, ...out } });
    return { ok: true, mode, ...out };
  });

  // 1126 · 담당별 주/월 유류비 예산 합계 — 디렉터 본인만(관리자 지정자 제외). 날짜가 있는 루트만(날짜 없는 방문 목록은 제외).
  //   GET /api/prospect-fuel?unit=week|month&n=  (n = 이번 기간 포함 몇 개, 주 8 · 월 6 기본, 최대 26)
  //   1127 · 거리는 실제 도로 주행 거리(캐시된 것) — 아직 계산 안 된 루트는 근사치로 넣고 뒤에서 도로 거리 계산
  app.get('/api/prospect-fuel', view, async (req, reply) => {
    if (!isRealDir(req)) return reply.code(403).send({ error: 'director_only' });
    const unit = req.query?.unit === 'week' ? 'week' : 'month';
    const n = Math.min(26, Math.max(1, int(req.query?.n) || (unit === 'week' ? 8 : 6)));
    // 기간: from 이 있으면 그 기간부터 n 개(미래 포함), 없으면 이번 기간이 가운데쯤 오도록(지난 2개월/3주 + 앞으로)
    const today = mxToday();
    const curKey = fuelPeriods(today, unit, 1)[0].key;
    const back = Math.min(unit === 'week' ? 3 : 2, n - 1);   // 이번 기간 앞에 둘 과거 칸 수(나머지는 앞으로)
    const defFrom = fuelPeriods(today, unit, back + 1)[0][unit === 'week' ? 'from' : 'key'];
    const periods = fuelPeriodsFrom(req.query?.from || defFrom, unit, n) || fuelPeriodsFrom(defFrom, unit, n);
    const from = periods[0].from, to = periods[periods.length - 1].to;
    // 1127 · 날짜 미정 방문 목록(지도에서 짠 루트)도 따로 셈 — 「날짜 미정」 칸
    const routes = (await query(
      `SELECT r.id, r.user_id, u.name AS user_name, to_char(r.route_date,'YYYY-MM-DD') AS d
         FROM prospect_routes r LEFT JOIN users u ON u.id=r.user_id
        WHERE r.route_date BETWEEN $1::date AND $2::date OR r.route_date IS NULL ORDER BY r.route_date NULLS LAST, r.id`, [from, to])).rows;
    const pts = {}; const vis = {};
    if (routes.length) (await query(
      `SELECT s.route_id, p.lat, p.lng, s.consult_id FROM prospect_route_stops s JOIN prospects p ON p.id=s.prospect_id
        WHERE s.route_id = ANY($1) AND (s.consult_id IS NOT NULL OR (p.deleted_at IS NULL AND p.stage <> 'descartado'))
        ORDER BY s.route_id, s.seq`, [routes.map((r) => Number(r.id))])).rows
      .forEach((x) => { (pts[x.route_id] = pts[x.route_id] || []).push({ lat: x.lat == null ? null : Number(x.lat), lng: x.lng == null ? null : Number(x.lng) }); if (x.consult_id) vis[x.route_id] = (vis[x.route_id] || 0) + 1; });
    const rs = await routeSettings();
    const zero = () => ({ routes: 0, stops: 0, visited: 0, km: 0, fuel_l: 0, fuel_cost: 0 });
    const add = (c, e, v) => { c.routes++; c.stops += e.stops; c.visited += v; c.km += e.km; c.fuel_l += e.fuel_l; c.fuel_cost += e.fuel_cost || 0; };
    const users = new Map(); const tot = Object.fromEntries(periods.map((p) => [p.key, zero()])); const all = zero(); const undT = zero();
    let approx = 0;
    for (const r of routes) {
      const st = pts[r.id] || []; if (!st.length) continue;
      const p = r.d ? periods.find((x) => r.d >= x.from && r.d <= x.to) : null; if (r.d && !p) continue;
      const e = await estimateRoad(st, rs, null, { cacheOnly: true }); if (e.source !== 'road') approx++;
      const v = vis[r.id] || 0; const uid = Number(r.user_id);
      if (!users.has(uid)) users.set(uid, { user_id: uid, name: r.user_name || ('#' + uid), cells: Object.fromEntries(periods.map((x) => [x.key, zero()])), undated: zero(), dated: zero(), total: zero() });
      const u = users.get(uid);
      if (p) { add(u.cells[p.key], e, v); add(u.dated, e, v); add(tot[p.key], e, v); } else { add(u.undated, e, v); add(undT, e, v); }
      add(u.total, e, v); add(all, e, v);
    }
    const rnd = (c) => { c.km = Math.round(c.km * 10) / 10; c.fuel_l = Math.round(c.fuel_l * 10) / 10; c.fuel_cost = Math.round(c.fuel_cost * 100) / 100; return c; };
    const out = [...users.values()].map((u) => { for (const k in u.cells) rnd(u.cells[k]); rnd(u.undated); rnd(u.dated); rnd(u.total); return u; }).sort((a, b) => b.total.fuel_cost - a.total.fuel_cost || String(a.name).localeCompare(String(b.name)));
    for (const k in tot) rnd(tot[k]);
    const datedT = zero(); for (const k in tot) { const c = tot[k]; datedT.routes += c.routes; datedT.stops += c.stops; datedT.visited += c.visited; datedT.km += c.km; datedT.fuel_l += c.fuel_l; datedT.fuel_cost += c.fuel_cost; }
    // 보이는 기간 밖에 날짜 있는 루트가 있으면 알려 줌(◀ ▶ 로 이동)
    const span = (await query(`SELECT to_char(MIN(route_date),'YYYY-MM-DD') AS a, to_char(MAX(route_date),'YYYY-MM-DD') AS b,
        COUNT(*) FILTER (WHERE route_date < $1::date)::int AS before, COUNT(*) FILTER (WHERE route_date > $2::date)::int AS after
        FROM prospect_routes WHERE route_date IS NOT NULL`, [from, to])).rows[0] || {};
    return { unit, current: curKey, from: periods[0].key, span: { first: span.a || null, last: span.b || null, before: span.before || 0, after: span.after || 0 }, periods, users: out, totals: tot, undated: rnd(undT), dated: rnd(datedT), total: rnd(all), settings: rs, priced: Number(rs.fuel_price) > 0, approx_routes: approx };
  });
  // 루트 추정 기준 — 디렉터·관리자가 목표 화면에서 입력
  app.get('/api/prospect-settings', view, async () => ({ route: await routeSettings() }));
  app.put('/api/prospect-settings', edit, async (req, reply) => {
    if (!directorOnly(req, reply)) return;
    const b = (req.body || {}).route || {};
    const lim = { visit_min: [1, 240], km_per_liter: [1, 60], speed_kmh: [5, 120], road_factor: [1, 3], fuel_price: [0, 200] };   // 1126 · fuel_price = 연료비(페소/L)
    for (const [k, [lo, hi]] of Object.entries(lim)) {
      if (b[k] == null || b[k] === '') continue;
      const v = Number(b[k]); if (!Number.isFinite(v) || v < lo || v > hi) return reply.code(400).send({ error: 'bad_value', key: k, min: lo, max: hi });
      await query(`INSERT INTO prospect_settings (key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [k, v, me(req)]);
    }
    rsCache.at = 0;
    await logEvent({ userId: me(req), action: 'update', target: 'prospect_settings', detail: b });
    return { ok: true, route: await routeSettings() };
  });

  // 🎯 목표 대비 방문 계획 — 담당자별(디렉터·관리자: 전원, 담당자: 본인)
  //   목표 = 그 달 「첫 방문」 목표 · 완료 = 그 달 첫 방문(그 사람이 처음 체크인)한 곳 중 중단(문 닫음·업종 아님 등)이 아닌 곳
  //   지워짐 = 그 달 첫 방문했지만 중단된 곳 → 목표 채우기에서 빠지므로 다시 계획해야 함
  //   계획 = 앞으로 갈 루트(오늘 이후 날짜) + 날짜 미정 방문 목록의 아직 안 간 곳(중단·첫 매출 제외)
  //   놓친 계획 = 지난 날짜 루트에 있었는데 아직 안 간 곳
  app.get('/api/prospect-routes/plan-status', view, async (req) => {
    const period = PERIOD.test(String(req.query?.period)) ? req.query.period : mxToday().slice(0, 7);
    const pb = periodBounds(period); const today = mxToday();
    const only = isDir(req) ? (int(req.query?.user) || null) : me(req);
    const uf = (col, params) => (only ? (params.push(only), ` AND ${col}=$${params.length}`) : '');
    let p1 = [period]; const tg = (await query(`SELECT user_id, target_value FROM prospect_targets WHERE period=$1 AND metric='contactados'${uf('user_id', p1)}`, p1)).rows;
    let p2 = [pb.from, pb.to];
    const first = (await query(
      `WITH f AS (SELECT DISTINCT ON (c.prospect_id) c.prospect_id, c.created_by, c.consult_date FROM sales_consults c
                   WHERE c.prospect_id IS NOT NULL AND c.deleted_at IS NULL ORDER BY c.prospect_id, c.created_at)
       SELECT f.created_by AS uid, COUNT(*) FILTER (WHERE p.stage <> 'descartado')::int AS done, COUNT(*) FILTER (WHERE p.stage = 'descartado')::int AS dropped
         FROM f JOIN prospects p ON p.id=f.prospect_id
        WHERE f.consult_date >= $1::date AND f.consult_date < $2::date${uf('f.created_by', p2)} GROUP BY 1`, p2)).rows;
    let p3 = [today];
    const plan = (await query(
      `SELECT r.user_id AS uid,
              COUNT(DISTINCT s.prospect_id) FILTER (WHERE r.route_date IS NULL OR r.route_date >= $1::date)::int AS planned,
              COUNT(DISTINCT s.prospect_id) FILTER (WHERE r.route_date IS NOT NULL AND r.route_date >= $1::date)::int AS dated,
              COUNT(DISTINCT s.prospect_id) FILTER (WHERE r.route_date IS NULL)::int AS undated,
              COUNT(DISTINCT s.prospect_id) FILTER (WHERE r.route_date < $1::date)::int AS missed,
              COUNT(DISTINCT s.prospect_id) FILTER (WHERE r.route_date >= $1::date AND r.route_date < $1::date + 7)::int AS week,
              MAX(r.route_date)::text AS last_date
         FROM prospect_routes r JOIN prospect_route_stops s ON s.route_id=r.id JOIN prospects p ON p.id=s.prospect_id
        WHERE s.consult_id IS NULL AND p.deleted_at IS NULL AND p.stage NOT IN ('descartado','cliente_activo')
          AND NOT EXISTS (SELECT 1 FROM sales_consults c WHERE c.prospect_id=p.id AND c.deleted_at IS NULL)${uf('r.user_id', p3)}
        GROUP BY 1`, p3)).rows;
    const staff = new Set(((await query(`SELECT u.id FROM users u WHERE u.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM prospect_excluded_users x WHERE x.user_id=u.id)`)).rows).map((r) => Number(r.id)));
    const names = Object.fromEntries((await query(`SELECT id, name FROM users`)).rows.map((u) => [Number(u.id), u.name]));
    const by = {};
    const U = (id) => { id = Number(id); return (by[id] = by[id] || { user_id: id, name: names[id] || '?', target: 0, done: 0, dropped: 0, planned: 0, dated: 0, undated: 0, missed: 0, week: 0, last_date: null }); };
    // 영업 역할 담당자는 목표·계획이 없어도 표에 보이게(「계획 안 함」도 보여야 하므로)
    if (!only) (await query(`SELECT id FROM users WHERE deleted_at IS NULL AND role='sales'`)).rows.forEach((r) => { if (staff.has(Number(r.id))) U(r.id); });
    tg.forEach((r) => { U(r.user_id).target = Number(r.target_value); });
    first.forEach((r) => Object.assign(U(r.uid), { done: r.done, dropped: r.dropped }));
    plan.forEach((r) => Object.assign(U(r.uid), { planned: r.planned, dated: r.dated, undated: r.undated, missed: r.missed, week: r.week, last_date: r.last_date }));
    const rows = Object.values(by).filter((u) => (only ? u.user_id === only : (staff.has(u.user_id) || u.target)))
      .map((u) => ({ ...u, ...planStatus({ ...u, period, today }) }))
      .sort((a, b) => (b.target - a.target) || a.name.localeCompare(b.name));
    if (only && !rows.length) rows.push({ user_id: only, name: names[only] || '?', dated: 0, undated: 0, week: 0, last_date: null, ...planStatus({ period, today }) });
    return { period, today, rows };
  });

  // 목록 안 정류장 바꾸기(빼기·순서) {prospect_ids}
  app.put('/api/prospect-routes/by-id/:id/stops', edit, async (req, reply) => {
    const r = await ownRoute(req, req.params.id); if (!r) return reply.code(404).send({ error: 'not_found' });
    const ids = [...new Set((Array.isArray(req.body?.prospect_ids) ? req.body.prospect_ids : []).map(int).filter(Boolean))].slice(0, 40);
    await withTx(async (client) => {
      const q = client.query.bind(client);
      const keep = new Map((await q(`SELECT prospect_id, consult_id FROM prospect_route_stops WHERE route_id=$1`, [r.id])).rows.filter((k) => k.consult_id).map((k) => [Number(k.prospect_id), Number(k.consult_id)]));
      await q(`DELETE FROM prospect_route_stops WHERE route_id=$1`, [r.id]);
      let seq = 1; for (const pid of ids) await q(`INSERT INTO prospect_route_stops (route_id, prospect_id, seq, consult_id) VALUES ($1,$2,$3,$4)`, [r.id, pid, seq++, keep.get(pid) || null]);
      await tidyRoutes(q, [Number(r.id)]);
    });
    warmRoad([r.id]);
    return { ok: true };
  });
  // 예정 루트 목록(오늘부터 30일) — 디렉터: 모든 담당 / 그 외: 본인. 「오늘 루트」 화면에서 담당자·날짜 바로 고르기용
  app.get('/api/prospect-routes/upcoming', view, async (req) => {
    const params = [mxToday()]; let cond = '';
    if (!isDir(req)) { params.push(me(req)); cond = ' AND r.user_id=$2'; }
    const rows = (await query(
      `SELECT r.user_id, u.name AS user_name, r.route_date::text AS date, COUNT(s.id)::int AS stops, COUNT(s.consult_id)::int AS visited
         FROM prospect_routes r JOIN prospect_route_stops s ON s.route_id=r.id LEFT JOIN users u ON u.id=r.user_id
        WHERE r.route_date >= $1::date AND r.route_date < $1::date + 30${cond}
        GROUP BY r.user_id, u.name, r.route_date ORDER BY r.route_date, u.name LIMIT 300`, params)).rows;
    return { rows: rows.map((r) => ({ ...r, user_id: Number(r.user_id) })) };
  });
  app.get('/api/prospect-routes', view, async (req) => {
    const date = YMD.test(String(req.query?.date)) ? req.query.date : mxToday();
    const uid = isDir(req) && int(req.query?.user) ? int(req.query.user) : me(req);
    return routeOut(uid, date);
  });
  app.put('/api/prospect-routes', edit, async (req, reply) => {
    const b = req.body || {};
    const date = YMD.test(String(b.date)) ? b.date : mxToday();
    const uid = isDir(req) && int(b.user_id) ? int(b.user_id) : me(req);
    const ids = [...new Set((Array.isArray(b.prospect_ids) ? b.prospect_ids : []).map(int).filter(Boolean))].slice(0, 40);
    const params = [ids]; const cond = isDir(req) ? 'TRUE' : (params.push(uid), `(owner_user_id=$2 OR owner_user_id IS NULL)`);
    let ps = (await query(`SELECT id, lat, lng FROM prospects WHERE id = ANY($1) AND deleted_at IS NULL AND ${cond}`, params)).rows
      .map((p) => ({ id: Number(p.id), lat: p.lat, lng: p.lng }));
    if (b.optimize !== false) {
      const start = Number.isFinite(Number(b.start_lat)) && Number.isFinite(Number(b.start_lng)) ? { lat: Number(b.start_lat), lng: Number(b.start_lng) } : null;
      ps = optimizeRoute(ps, start).stops;
    } else {
      const pos = new Map(ids.map((id, i) => [id, i])); ps.sort((a, c) => pos.get(a.id) - pos.get(c.id));
    }
    await withTx(async (client) => {
      const q = client.query.bind(client);
      const rid = Number((await q(`INSERT INTO prospect_routes (user_id, route_date, created_by) VALUES ($1,$2,$3)
                                   ON CONFLICT (user_id, route_date) DO UPDATE SET updated_at=now() RETURNING id`, [uid, date, me(req)])).rows[0].id);
      const keep = (await q(`SELECT prospect_id, consult_id FROM prospect_route_stops WHERE route_id=$1`, [rid])).rows;
      const visited = new Map(keep.filter((k) => k.consult_id).map((k) => [Number(k.prospect_id), Number(k.consult_id)]));
      await q(`DELETE FROM prospect_route_stops WHERE route_id=$1`, [rid]);
      let seq = 1;
      for (const p of ps) await q(`INSERT INTO prospect_route_stops (route_id, prospect_id, seq, consult_id) VALUES ($1,$2,$3,$4)`, [rid, p.id, seq++, visited.get(p.id) || null]);
      await tidyRoutes(q, [rid]);
    });
    return routeOut(uid, date);
  });

  // 루트 삭제 — 방문 전 stop 은 모두 지우고, 이미 체크인한 stop(방문 기록)은 남긴다. 다 지워지면 루트 자체 삭제
  app.delete('/api/prospect-routes', edit, async (req, reply) => {
    const date = YMD.test(String(req.query?.date)) ? req.query.date : mxToday();
    const uid = isDir(req) && int(req.query?.user) ? int(req.query.user) : me(req);
    const out = await withTx(async (client) => {
      const q = client.query.bind(client);
      const r = (await q(`SELECT id FROM prospect_routes WHERE user_id=$1 AND route_date=$2`, [uid, date])).rows[0];
      if (!r) return { removed: 0, kept: 0 };
      const del = await q(`DELETE FROM prospect_route_stops WHERE route_id=$1 AND consult_id IS NULL`, [r.id]);
      await tidyRoutes(q, [Number(r.id)]);
      const kept = Number((await q(`SELECT count(*)::int AS n FROM prospect_route_stops WHERE route_id=$1`, [r.id])).rows[0].n);
      return { removed: del.rowCount, kept };
    });
    await logEvent({ userId: me(req), action: 'delete', target: `prospect_route:${uid}:${date}`, detail: out });
    return { ok: true, ...out, route: await routeOut(uid, date) };
  });

  // 지역(담당 후보)으로 하루 루트 자동 만들기 — 「오늘 루트」가 비어 있을 때. 이미 루트가 있으면 건드리지 않는다(force 제외).
  //   대상: 이 담당의 후보 중 첫 매출·중단 제외, 최근 7일 방문 제외, 다른 날 루트에 이미 들어간 곳 제외
  app.post('/api/prospect-routes/auto', edit, async (req, reply) => {
    const b = req.body || {};
    const date = YMD.test(String(b.date)) ? b.date : mxToday();
    const uid = isDir(req) && int(b.user_id) ? int(b.user_id) : me(req);
    const max = Math.min(30, Math.max(1, int(b.max_stops) || 12));
    if (!WORKDAY(date)) return reply.code(400).send({ error: 'not_workday' });
    const exist = Number((await query(`SELECT COUNT(*)::int AS n FROM prospect_route_stops s JOIN prospect_routes r ON r.id=s.route_id WHERE r.user_id=$1 AND r.route_date=$2`, [uid, date])).rows[0].n);
    if (exist && !b.force) return { created: false, reason: 'route_exists', route: await routeOut(uid, date) };
    const rows = (await query(
      `SELECT p.id, p.nom_estab, p.lat, p.lng, p.priority, p.pot_tier, p.score, p.stage
         FROM prospects p
        WHERE p.deleted_at IS NULL AND p.owner_user_id=$1 AND p.lat IS NOT NULL AND p.stage NOT IN ('cliente_activo','descartado')
          AND NOT EXISTS (SELECT 1 FROM sales_consults c WHERE c.prospect_id=p.id AND c.deleted_at IS NULL AND c.created_at > now() - INTERVAL '7 days')
          AND NOT EXISTS (SELECT 1 FROM prospect_route_stops s JOIN prospect_routes r ON r.id=s.route_id
                           WHERE s.prospect_id=p.id AND s.consult_id IS NULL AND (r.route_date IS NULL OR (r.route_date >= $2::date AND r.route_date <> $3::date)))`,
      [uid, mxToday(), date])).rows.map((r) => ({ ...r, id: Number(r.id), lat: Number(r.lat), lng: Number(r.lng) }));
    const assigned = Number((await query(`SELECT COUNT(*)::int AS n FROM prospects WHERE owner_user_id=$1 AND deleted_at IS NULL`, [uid])).rows[0].n);
    if (!rows.length) return { created: false, reason: assigned ? 'nothing_left' : 'no_assigned', assigned, route: await routeOut(uid, date) };
    const start = Number.isFinite(Number(b.start_lat)) && Number.isFinite(Number(b.start_lng)) ? { lat: Number(b.start_lat), lng: Number(b.start_lng) } : null;
    const plan = pickDayRoute(rows, { max, start });
    await withTx(async (client) => {
      const q = client.query.bind(client);
      const rid = Number((await q(`INSERT INTO prospect_routes (user_id, route_date, created_by) VALUES ($1,$2,$3)
                                   ON CONFLICT (user_id, route_date) DO UPDATE SET updated_at=now() RETURNING id`, [uid, date, me(req)])).rows[0].id);
      await q(`DELETE FROM prospect_route_stops WHERE route_id=$1 AND consult_id IS NULL`, [rid]);
      let seq = Number((await q(`SELECT COALESCE(MAX(seq),0)::int AS m FROM prospect_route_stops WHERE route_id=$1`, [rid])).rows[0].m) + 1;
      for (const p of plan.stops) await q(`INSERT INTO prospect_route_stops (route_id, prospect_id, seq) VALUES ($1,$2,$3) ON CONFLICT (route_id, prospect_id) DO NOTHING`, [rid, p.id, seq++]);
    });
    await logEvent({ userId: me(req), action: 'create', target: `prospect_route:${uid}:${date}`, detail: { auto: true, stops: plan.stops.length } });
    return { created: true, stops: plan.stops.length, distance_m: plan.distance_m, minutes: plan.minutes, candidates: rows.length, assigned, route: await routeOut(uid, date) };
  });

  // 지도에서 드래그한 구역 → 방문 루트 제안(저장 안 함). 화면에서 확인·빼기 후 PUT /api/prospect-routes(optimize:false)
  // 구역(네모·자유형) → 방문 코스 제안(저장 안 함). 날짜는 정하지 않는다 — 저장하면 「방문 목록」이 되고 날짜는 본인이 고른다.
  //   빼는 곳: 다른 담당이 맡은 후보 · 다른 담당의 지역 안 후보 · 이미 누군가의 루트/방문 목록에 들어간 곳 · 최근 방문 · 첫 매출·중단
  app.post('/api/prospect-routes/suggest', edit, async (req, reply) => {
    const b = req.body || {};
    const poly = (Array.isArray(b.polygon) ? b.polygon : []).map((p) => [Number(p[0]), Number(p[1])]).filter((p) => p.every(Number.isFinite)).slice(0, 2000);
    const terrIds = [...new Set((Array.isArray(b.territory_ids) ? b.territory_ids : []).map(int).filter(Boolean))].slice(0, 50);
    if (poly.length < 3 && !terrIds.length) return reply.code(400).send({ error: 'polygon_required' });
    const uid = isDir(req) && int(b.user_id) ? int(b.user_id) : me(req);
    const max = Math.min(30, Math.max(1, int(b.max_stops) || 12));
    const multi = b.multi_day !== false;
    const maxDays = multi ? Math.min(15, Math.max(1, int(b.max_days) || 5)) : 1;
    const skipDays = b.skip_visited_days === 0 || b.skip_visited_days === false ? 0 : (int(b.skip_visited_days) || 7);
    const rows = terrIds.length ? await areaRows({ territoryIds: terrIds }) : await areaRows({ polygon: poly });
    const { cnt, cands, excluded } = classifyCands(rows, uid, { skipDays, includeUnassigned: b.include_unassigned !== false });
    // 시작 업체(지도에서 고른 핀): 그 위치에서 출발, 첫 방문지로 고정
    let start = Number.isFinite(Number(b.start_lat)) && Number.isFinite(Number(b.start_lng)) ? { lat: Number(b.start_lat), lng: Number(b.start_lng) } : null;
    const firstId = int(b.start_prospect_id) || null;
    if (firstId) { const f = cands.find((c) => c.id === firstId) || rows.find((r) => Number(r.id) === firstId); if (f) start = { lat: Number(f.lat), lng: Number(f.lng), prospect_id: firstId }; }
    const plan = planDays(cands, { max, maxDays, start, firstId: cands.some((c) => c.id === firstId) ? firstId : null });
    const rs = await routeSettings();
    const days = await Promise.all(plan.days.map(async (d, k) => { const e = await estimateRoad(d.stops, rs, k === 0 && !firstId ? start : null); return { ...d, minutes: e.total_min, estimate: e }; }));
    cnt.scheduled = days.reduce((a, d) => a + d.stops.length, 0); cnt.left = cnt.eligible - cnt.scheduled;
    const freq = {}; cands.forEach((c) => { const k = c.colonia || c.municipio; if (k) freq[k] = (freq[k] || 0) + 1; });
    const top = Object.entries(freq).sort((a, c) => c[1] - a[1])[0];
    const tn = terrIds.length ? (await query(`SELECT name FROM prospect_territories WHERE id = ANY($1) ORDER BY name`, [terrIds])).rows.map((r) => r.name) : [];
    const d0 = days[0] || { stops: [], distance_m: 0, minutes: 0 };
    return { user_id: uid, start, start_prospect_id: firstId, territory_ids: terrIds, days, counts: cnt, excluded,
      name_hint: tn.length ? tn.join(' + ') : (top ? top[0] : null), route_settings: rs,
      in_area: rows.length, stops: d0.stops, distance_m: d0.distance_m, minutes: d0.minutes };
  });
  // 후보 행: 그린 구역(polygon) 또는 지역(territory_ids) 안
  async function areaRows({ polygon = null, territoryIds = null }) {
    const sel = `SELECT p.id, p.nom_estab, p.lat, p.lng, p.priority, p.pot_tier, p.score, p.stage, p.owner_user_id, p.last_activity_at, p.colonia, p.municipio,
              p.territory_id, t.owner_user_id AS terr_owner,
              (SELECT MAX(c.created_at) FROM sales_consults c WHERE c.prospect_id=p.id AND c.deleted_at IS NULL) AS last_visit,
              (SELECT MIN(r.user_id) FROM prospect_route_stops s JOIN prospect_routes r ON r.id=s.route_id
                WHERE s.prospect_id=p.id AND s.consult_id IS NULL AND (r.route_date IS NULL OR r.route_date >= $1::date)) AS planned_by
         FROM prospects p LEFT JOIN prospect_territories t ON t.id=p.territory_id
        WHERE p.deleted_at IS NULL AND p.lat IS NOT NULL AND p.lng IS NOT NULL`;
    if (territoryIds) return (await query(sel + ` AND p.territory_id = ANY($2) LIMIT 5000`, [mxToday(), territoryIds])).rows;
    const lats = polygon.map((p) => p[0]), lngs = polygon.map((p) => p[1]);
    return (await query(sel + ` AND p.lat BETWEEN $2 AND $3 AND p.lng BETWEEN $4 AND $5`,
      [mxToday(), Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)])).rows
      .filter((r) => inPolygon(Number(r.lat), Number(r.lng), polygon));
  }
  // 방문 대상 가르기 — 빼는 이유(why): closed 첫 매출·중단 · others 다른 담당 · others_terr 다른 담당 지역 · others_planned 다른 사람 목록
  //   · unassigned_skipped 미배정 제외 · visited 최근 방문 · planned 내 목록·루트에 이미 있음
  function whyOut(r, uid, { skipDays = 7, includeUnassigned = true } = {}) {
    const owner = r.owner_user_id == null ? null : Number(r.owner_user_id);
    const tOwner = r.terr_owner == null ? null : Number(r.terr_owner);
    const pBy = r.planned_by == null ? null : Number(r.planned_by);
    if (['cliente_activo', 'descartado'].includes(r.stage)) return 'closed';
    if (owner != null && owner !== uid) return 'others';
    if (owner == null && tOwner != null && tOwner !== uid) return 'others_terr';
    if (pBy != null && pBy !== uid) return 'others_planned';
    if (owner == null && !includeUnassigned) return 'unassigned_skipped';
    if (skipDays && r.last_visit && new Date(r.last_visit).getTime() > Date.now() - skipDays * 86400000) return 'visited';
    if (pBy != null) return 'planned';
    return null;
  }
  function classifyCands(rows, uid, opts) {
    const cnt = { in_area: rows.length, others: 0, others_terr: 0, others_planned: 0, visited: 0, planned: 0, closed: 0, unassigned_skipped: 0 };
    const cands = [], excluded = [];
    for (const r of rows) {
      const why = whyOut(r, uid, opts);
      if (why) { cnt[why]++; if (why.startsWith('others') && excluded.length < 1500) excluded.push([Number(r.lat), Number(r.lng)]); continue; }
      cands.push({ ...r, id: Number(r.id), lat: Number(r.lat), lng: Number(r.lng), owner_user_id: r.owner_user_id == null ? null : Number(r.owner_user_id) });
    }
    cnt.eligible = cands.length;
    return { cnt, cands, excluded };
  }

  // ── 담당자 루트 짜기: ① 내 지역 목록 → ② 지도에서 보기 → ③ 시작 업체 고르기 → 최적 순서 제안 ──
  // 내(또는 고른 담당자의) 지역 목록 + 지역별 남은 방문 대상 수
  app.get('/api/prospect-routes/my-territories', view, async (req) => {
    const uid = isDir(req) && int(req.query?.user) ? int(req.query.user) : me(req);
    const terrs = (await query(`SELECT id, name, polygon, municipios, cps FROM prospect_territories WHERE owner_user_id=$1 AND active IS NOT FALSE ORDER BY name`, [uid])).rows;
    if (!terrs.length) return { user_id: uid, rows: [] };
    const ids = terrs.map((t) => Number(t.id));
    const rows = await areaRows({ territoryIds: ids });
    const by = {}; const pts = {};
    for (const r of rows) {
      const k = Number(r.territory_id); const o = by[k] = by[k] || { total: 0, todo: 0, planned: 0, visited: 0, closed: 0, others: 0 };
      o.total++; const w = whyOut(r, uid, { skipDays: 7 });
      if (!w) o.todo++; else if (w === 'planned') o.planned++; else if (w === 'visited') o.visited++; else if (w === 'closed') o.closed++; else o.others++;
      (pts[k] = pts[k] || []).push([Number(r.lat), Number(r.lng)]);
    }
    return { user_id: uid, rows: terrs.map((t) => ({ id: Number(t.id), name: t.name, kind: Array.isArray(t.polygon) && t.polygon.length >= 3 ? 'polygon' : (t.cps || []).length ? 'cp' : 'municipio',
      outline: Array.isArray(t.polygon) && t.polygon.length >= 3 ? t.polygon : convexHull(pts[t.id] || []),
      ...(by[t.id] || { total: 0, todo: 0, planned: 0, visited: 0, closed: 0, others: 0 }) })) };
  });
  // 고른 지역들의 후보(지도 핀) — why=null 이 방문 대상
  app.get('/api/prospect-routes/territory-cands', view, async (req, reply) => {
    const uid = isDir(req) && int(req.query?.user) ? int(req.query.user) : me(req);
    const ids = String(req.query?.ids || '').split(',').map(int).filter(Boolean).slice(0, 50);
    if (!ids.length) return { rows: [] };
    // 담당자는 자기 지역만
    if (!isDir(req)) { const own = (await query(`SELECT COUNT(*)::int AS n FROM prospect_territories WHERE id = ANY($1) AND owner_user_id=$2`, [ids, uid])).rows[0].n; if (own !== ids.length) return reply.code(403).send({ error: 'not_your_territory' }); }
    const skipDays = req.query?.skip === '0' ? 0 : 7;
    const rows = await areaRows({ territoryIds: ids });
    return { user_id: uid, rows: rows.map((r) => ({ id: Number(r.id), nom_estab: r.nom_estab, lat: Number(r.lat), lng: Number(r.lng), priority: r.priority, score: r.score,
      stage: r.stage, colonia: r.colonia, territory_id: Number(r.territory_id), why: whyOut(r, uid, { skipDays, includeUnassigned: req.query?.unas !== '0' }) })) };
  });

  // ── 검토(Alta de clientes) ─────────────────────────────────────────
  app.get('/api/prospects/reviews', view, async (req) => {
    const params = []; let cond = 'TRUE';
    if (!isDir(req)) { params.push(me(req)); cond = `c.created_by=$1`; }
    const rows = (await query(
      `SELECT c.id AS consult_id, c.consult_date, c.created_at, c.review_status, c.created_by, u.name AS user_name,
              p.id AS prospect_id, p.nom_estab, p.municipio, r.status AS rec_status, r.alta_status
         FROM sales_consults c JOIN prospects p ON p.id=c.prospect_id LEFT JOIN users u ON u.id=c.created_by
         LEFT JOIN LATERAL (SELECT status, alta_status FROM sales_consult_recordings WHERE consult_id=c.id ORDER BY id DESC LIMIT 1) r ON TRUE
        WHERE c.deleted_at IS NULL AND c.review_status IN ('por_revisar','borrador') AND ${cond}
        ORDER BY c.created_at DESC LIMIT 200`, params)).rows;
    return { rows: rows.map((r) => ({ ...r, consult_id: Number(r.consult_id), prospect_id: Number(r.prospect_id), created_by: Number(r.created_by) })) };
  });

  // 🗑 검토 대기 정리 — 담당자는 자기 것만, 디렉터·관리자는 전부
  //   mode=dismiss : 검토 대기에서만 뺀다(방문·녹음·AI 요약은 그대로, 고객상담 표에도 남음)
  //   mode=delete  : 방문 기록 자체를 지운다(고객상담 기록 삭제 + 후보 연결·루트 방문 표시 해제 → 점수 다시 계산)
  app.post('/api/prospects/reviews/delete', edit, async (req, reply) => {
    const b = req.body || {};
    const mode = b.mode === 'delete' ? 'delete' : 'dismiss';
    const ids = [...new Set((Array.isArray(b.consult_ids) ? b.consult_ids : []).map(int).filter(Boolean))].slice(0, 500);
    if (!ids.length) return reply.code(400).send({ error: 'empty' });
    const params = [ids]; let cond = '';
    if (!isDir(req)) { params.push(me(req)); cond = ' AND c.created_by=$2'; }
    const rows = (await query(`SELECT c.id, c.prospect_id FROM sales_consults c WHERE c.id = ANY($1) AND c.deleted_at IS NULL
                                 AND c.review_status IN ('por_revisar','borrador')${cond}`, params)).rows;
    let n = 0;
    for (const c of rows) {
      if (mode === 'dismiss') { await query(`UPDATE sales_consults SET review_status=NULL, reviewed_by=$2, reviewed_at=now() WHERE id=$1`, [c.id, me(req)]); n++; continue; }
      try { await detachConsultFromProspect({ consultId: Number(c.id), userId: me(req) }); } catch (_) { /* 연결이 없으면 넘어감 */ }
      await query(`UPDATE sales_consults SET deleted_at=now(), review_status=NULL WHERE id=$1`, [c.id]);
      await syncConsultVisitSafe(Number(c.id), req.log);     // 빠른 녹음의 짝 방문 기록도 함께 정리
      n++;
    }
    await logEvent({ userId: me(req), action: mode === 'delete' ? 'delete' : 'update', target: 'prospect_reviews', detail: { mode, ids: rows.map((r) => Number(r.id)) } });
    return { ok: true, mode, done: n, skipped: ids.length - n };
  });

  app.get('/api/prospects/:id/review', view, async (req, reply) => {
    const p = await loadProspect(req, req.params.id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const cid = int(req.query?.consult_id);
    let consult = null; let rec = null;
    if (cid) {
      consult = (await query(`SELECT id, consult_date, created_by, contact_name, wa_phone, review_status, checkin_dist_m FROM sales_consults
                               WHERE id=$1 AND prospect_id=$2 AND deleted_at IS NULL`, [cid, p.id])).rows[0] || null;
      if (consult) rec = (await query(`SELECT id, status, error, summary_json, alta_draft, alta_status, alta_error, duration_sec
                                         FROM sales_consult_recordings WHERE consult_id=$1 ORDER BY id DESC LIMIT 1`, [cid])).rows[0] || null;
    }
    const saved = Object.fromEntries((await query(`SELECT field_key, value FROM prospect_crm_values WHERE prospect_id=$1`, [p.id])).rows.map((r) => [r.field_key, r.value]));
    const draft = rec ? parseJ(rec.alta_draft) : null;
    const prefill = prefillFromProspect(p);
    // 상담 화면에서 이미 적은 연락처를 미리 채움(초안이 없을 때)
    if (consult && consult.contact_name && !saved['datos_generales.contacto_principal']) prefill['datos_generales.contacto_principal'] = consult.contact_name;
    if (consult && consult.wa_phone && !saved['datos_generales.telefono']) prefill['datos_generales.telefono'] = consult.wa_phone;
    const summary = rec ? parseJ(rec.summary_json) : null;
    return {
      prospect: pub(p), consult: consult ? { ...consult, id: Number(consult.id) } : null,
      recording: rec ? { id: Number(rec.id), status: rec.status, error: rec.error, alta_status: rec.alta_status, alta_error: rec.alta_error,
        duration_sec: rec.duration_sec, resumen: (draft && draft.resumen) || (summary && summary.resumen) || null,
        next_step: (draft && draft.siguiente_paso) || (summary && summary.next_step) || null,
        next_date: draft && draft.fecha_siguiente_paso, stage_suggested: draft && draft.etapa_sugerida } : null,
      fields: ALTA_FIELDS, values: mergeForReview({ prefill, saved, draft, erp: await erpPrefill(query, p) }),
    };
  });

  // ❓ 질문 항목 + 답 — 고객별로 파악할 항목(Alta 양식)과 지금까지 확보한 답(저장값 > 검토 전 AI 초안 > DENUE)
  app.get('/api/prospects/:id/questions', view, async (req, reply) => {
    const p = await loadProspect(req, req.params.id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const saved = Object.fromEntries((await query(`SELECT field_key, value FROM prospect_crm_values WHERE prospect_id=$1`, [p.id])).rows.map((r) => [r.field_key, r.value]));
    // 아직 검토(저장) 안 한 가장 최근 AI 초안
    const dr = (await query(
      `SELECT r.alta_draft FROM sales_consult_recordings r JOIN sales_consults c ON c.id=r.consult_id
        WHERE c.prospect_id=$1 AND c.deleted_at IS NULL AND r.alta_status='done' AND COALESCE(c.review_status,'por_revisar') <> 'confirmado'
        ORDER BY r.id DESC LIMIT 1`, [p.id])).rows[0];
    const values = mergeForReview({ prefill: prefillFromProspect(p), saved, draft: dr ? parseJ(dr.alta_draft) : null, erp: await erpPrefill(query, p) });
    const has = (v) => v && v.value != null && v.value !== '' && !(Array.isArray(v.value) && !v.value.length);
    for (const [k, v] of Object.entries(values)) if (v.source === 'ia' && !has(v) && v.saved != null) values[k] = { value: v.saved, source: 'guardado' };
    const scored = ALTA_FIELDS.filter((f) => f.section !== 'facturacion');
    return { prospect: { id: Number(p.id), name: p.nom_estab, stage: p.stage, score: p.score, info_pct: p.info_pct },
      fields: ALTA_FIELDS, values, points: fieldPoints(),
      counts: { total: scored.length, answered: scored.filter((f) => has(values[f.key])).length,
        saved: scored.filter((f) => has(values[f.key]) && values[f.key].source === 'guardado').length } };
  });

  // 저장: confirm=false → 임시저장(borrador), confirm=true → 필수 확인 후 확정(confirmado)
  app.post('/api/prospects/:id/crm', edit, async (req, reply) => {
    const p = await loadProspect(req, req.params.id, { unassigned: false });
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {};
    const cid = int(b.consult_id);
    const { clean, errors } = validateAltaValues(b.values || {});
    if (errors.length) return reply.code(400).send({ error: 'formato', fields: errors });
    const saved = Object.fromEntries((await query(`SELECT field_key, value FROM prospect_crm_values WHERE prospect_id=$1`, [p.id])).rows.map((r) => [r.field_key, r.value]));
    const all = { ...saved, ...clean };
    if (b.confirm) {
      const miss = missingRequired(all);
      if (miss.length) return reply.code(400).send({ error: 'faltan_obligatorios', fields: miss.map((k) => ({ key: k, label: ALTA_FIELD_MAP[k].label_es })) });
    }
    let draft = null;
    if (cid) {
      const r = (await query(`SELECT r.alta_draft FROM sales_consult_recordings r JOIN sales_consults c ON c.id=r.consult_id
                               WHERE c.id=$1 AND c.prospect_id=$2 ORDER BY r.id DESC LIMIT 1`, [cid, p.id])).rows[0];
      draft = r ? parseJ(r.alta_draft) : null;
    }
    const sources = b.sources || {};
    let changed = 0; let scoreOut = null;
    await withTx(async (client) => {
      const q = client.query.bind(client);
      for (const [k, v] of Object.entries(clean)) {
        const old = saved[k] === undefined ? null : saved[k];
        if (JSON.stringify(old) === JSON.stringify(v)) continue;
        const ai = draft && draft.campos && draft.campos[k] ? draft.campos[k].valor : null;
        if (v == null) await q(`DELETE FROM prospect_crm_values WHERE prospect_id=$1 AND field_key=$2`, [p.id, k]);
        else {
          await q(`INSERT INTO prospect_crm_values (prospect_id, field_key, value, form_version, consult_id, source, updated_by)
                   VALUES ($1,$2,$3,$4,$5,$6,$7)
                   ON CONFLICT (prospect_id, field_key) DO UPDATE SET value=EXCLUDED.value, form_version=EXCLUDED.form_version,
                     consult_id=EXCLUDED.consult_id, source=EXCLUDED.source, updated_by=EXCLUDED.updated_by, updated_at=now()`,
          [p.id, k, JSON.stringify(v), ALTA_FORM.version, cid, ['ia', 'denue', 'manual', 'guardado'].includes(sources[k]) ? sources[k] : 'manual', me(req)]);
        }
        await q(`INSERT INTO prospect_crm_log (prospect_id, field_key, old_value, new_value, ai_value, consult_id, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [p.id, k, old == null ? null : JSON.stringify(old), v == null ? null : JSON.stringify(v), ai == null ? null : JSON.stringify(ai), cid, me(req)]);
        changed++;
      }
      if (cid) {
        await q(`UPDATE sales_consults SET review_status=$2, reviewed_by=$3, reviewed_at=now() WHERE id=$1 AND prospect_id=$4`,
          [cid, b.confirm ? 'confirmado' : 'borrador', me(req), p.id]);
      }
      // 연락처 기본 항목은 후보 카드에도 반영(비어 있을 때만)
      const tel = all['datos_generales.telefono']; const mail = all['datos_generales.correo'];
      await q(`UPDATE prospects SET phone=COALESCE(phone,$2), email=COALESCE(email,$3), last_activity_at=now(), updated_at=now() WHERE id=$1`,
        [p.id, tel || null, mail || null]);
      await savePotential(q, Number(p.id), all);
      // 담당자가 고른 다음 단계(선택)
      if (b.stage && b.stage !== p.stage) {
        const chk = checkStageMove(p.stage, b.stage, { isDirector: isDir(req), reason: b.stage_reason });
        if (chk.ok) await moveStage(q, Number(p.id), p.stage, b.stage, { userId: me(req), reason: txt(b.stage_reason, 300) });
      }
      scoreOut = await recomputeProspect(q, Number(p.id), { userId: me(req), reason: b.confirm ? 'Alta confirmada' : 'Alta borrador' });
    });
    await logEvent({ userId: me(req), action: 'update', target: `prospect:${p.id}`, detail: { crm: changed, confirm: !!b.confirm, consult_id: cid } });
    return { ok: true, changed, status: b.confirm ? 'confirmado' : 'borrador', missing: missingRequired(all), potential: potentialOf(all), score: scoreOut };
  });

  // ── 기존 고객 연결 ─────────────────────────────────────────────────
  app.get('/api/prospects/:id/matches', view, async (req, reply) => {
    const p = await loadProspect(req, req.params.id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const crm = Object.fromEntries((await query(`SELECT field_key, value FROM prospect_crm_values WHERE prospect_id=$1`, [p.id])).rows.map((r) => [r.field_key, r.value]));
    const probe = { ...p, rfc: crm['facturacion.rfc'] || null, phone: crm['datos_generales.telefono'] || p.phone };
    const cust = (await query(`SELECT id, code, name, rfc, phone, buyer_phone FROM customers WHERE deleted_at IS NULL
                                 AND COALESCE(approval_status,'approved') <> 'rejected'`)).rows;
    return { rows: suggestCustomers(probe, cust) };
  });

  // 1127 · 고객개발 → ERP: ERP 고객의 빈 칸(배송지·전화·구매결정권자·이메일·지점 수)을 고객개발 정보로 채움. RFC 는 안 건드림.
  //   디렉터·관리자만 · apply=false 면 미리보기
  app.post('/api/prospects/:id/erp-fill', edit, async (req, reply) => {
    if (!directorOnly(req, reply)) return;
    const p = await loadProspect(req, req.params.id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (!p.customer_id) return reply.code(400).send({ error: 'not_linked' });
    const c = await customerInfo(query, p.customer_id); if (!c) return reply.code(404).send({ error: 'customer_not_found' });
    const saved = Object.fromEntries((await query(`SELECT field_key, value FROM prospect_crm_values WHERE prospect_id=$1`, [p.id])).rows.map((r) => [r.field_key, r.value]));
    const want = customerFillFromValues({ ...prefillFromProspect(p), ...saved });   // 저장값 우선, 없으면 DENUE·기본 정보
    const LBL = { ship_address: '배송지 주소', phone: '전화', buyer_name: '구매결정권자', buyer_phone: '구매결정권자 전화', contact: '이메일', branch_count: '지점 수' };
    const empty = (v) => v == null || String(v).trim() === '' || (typeof v === 'number' && v <= 0);
    const fields = Object.entries(want).filter(([k]) => empty(c[k])).map(([k, v]) => ({ key: k, label: LBL[k], value: v }));
    if (!req.body?.apply || !fields.length) return { customer: { id: Number(c.id), code: c.code, name: c.name }, fields, applied: false };
    const sets = fields.map((f, i) => `${f.key}=$${i + 2}`);
    await query(`UPDATE customers SET ${sets.join(', ')}, updated_by=$${fields.length + 2} WHERE id=$1`, [c.id, ...fields.map((f) => f.value), me(req)]);
    await logEvent({ userId: me(req), action: 'update', target: `customer:${c.id}`, detail: { from_prospect: Number(p.id), fill: Object.fromEntries(fields.map((f) => [f.key, f.value])) } });
    return { customer: { id: Number(c.id), code: c.code, name: c.name }, fields, applied: true };
  });

  app.post('/api/prospects/:id/link', edit, async (req, reply) => {
    const p = await loadProspect(req, req.params.id, { unassigned: false });
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {}; const cid = int(b.customer_id);
    if (!cid) return reply.code(400).send({ error: 'customer_required' });
    const c = (await query(`SELECT id, approval_status FROM customers WHERE id=$1 AND deleted_at IS NULL`, [cid])).rows[0];
    if (!c) return reply.code(404).send({ error: 'customer_not_found' });
    const method = ['alta', 'vinculo', 'sugerencia'].includes(b.method) ? b.method : 'vinculo';
    const dir = isDir(req);
    const out = await withTx(async (client) => {
      const q = client.query.bind(client);
      const lid = Number((await q(`INSERT INTO prospect_customer_links (prospect_id, customer_id, method, status, note, requested_by, decided_by, decided_at)
                                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [p.id, cid, method, dir ? 'aprobado' : 'solicitado', txt(b.note, 300), me(req), dir ? me(req) : null, dir ? new Date() : null])).rows[0].id);
      if (dir) await applyLink(q, p, cid, me(req));
      return { id: lid, status: dir ? 'aprobado' : 'solicitado' };
    });
    if (dir) await refreshCustomerStages();
    await logEvent({ userId: me(req), action: 'create', target: `prospect_link:${out.id}`, detail: { prospect_id: Number(p.id), customer_id: cid, method } });
    return out;
  });
  async function applyLink(q, p, customerId, userId) {
    await q(`UPDATE prospect_customer_links SET status='anulado' WHERE prospect_id=$1 AND status='aprobado' AND customer_id <> $2`, [p.id, customerId]);
    await q(`UPDATE prospects SET customer_id=$2, updated_at=now() WHERE id=$1`, [p.id, customerId]);
    // 이 후보의 방문(상담)도 고객 이력에 보이도록 상담에 고객 연결(비어 있는 것만)
    await q(`UPDATE sales_consults SET customer_id=$2 WHERE prospect_id=$1 AND customer_id IS NULL`, [p.id, customerId]);
    await syncProspectFromCustomer(q, Number(p.id));   // 1127 · ERP 고객 주소·연락처로 빈 칸 채움
    await recomputeProspect(q, Number(p.id), { userId, reason: 'vinculado a cliente' });
  }
  app.get('/api/prospect-links', view, async (req, reply) => {
    if (!directorOnly(req, reply)) return;
    const rows = (await query(
      `SELECT l.id, l.prospect_id, l.customer_id, l.method, l.status, l.note, l.created_at, p.nom_estab, c.name AS customer_name, c.code AS customer_code, u.name AS requested_by_name
         FROM prospect_customer_links l JOIN prospects p ON p.id=l.prospect_id JOIN customers c ON c.id=l.customer_id
         LEFT JOIN users u ON u.id=l.requested_by WHERE l.status='solicitado' ORDER BY l.created_at`)).rows;
    return { rows: rows.map((r) => ({ ...r, id: Number(r.id), prospect_id: Number(r.prospect_id), customer_id: Number(r.customer_id) })) };
  });
  app.post('/api/prospect-links/:lid/decide', edit, async (req, reply) => {
    if (!directorOnly(req, reply)) return;
    const lid = int(req.params.lid); const approve = !!(req.body && req.body.approve);
    const out = await withTx(async (client) => {
      const q = client.query.bind(client);
      const l = (await q(`SELECT * FROM prospect_customer_links WHERE id=$1 AND status='solicitado' FOR UPDATE`, [lid])).rows[0];
      if (!l) return { code: 404 };
      await q(`UPDATE prospect_customer_links SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1`, [lid, approve ? 'aprobado' : 'rechazado', me(req)]);
      if (approve) {
        const p = (await q(`SELECT * FROM prospects WHERE id=$1`, [l.prospect_id])).rows[0];
        await applyLink(q, p, Number(l.customer_id), me(req));
      }
      return { ok: true };
    });
    if (out.code) return reply.code(404).send({ error: 'not_found' });
    if (approve) await refreshCustomerStages();
    return out;
  });
  // 디렉터: 연결 해제
  app.delete('/api/prospects/:id/link', edit, async (req, reply) => {
    if (!directorOnly(req, reply)) return;
    const id = int(req.params.id);
    await query(`UPDATE prospect_customer_links SET status='anulado' WHERE prospect_id=$1 AND status='aprobado'`, [id]);
    await query(`UPDATE prospects SET customer_id=NULL, updated_at=now() WHERE id=$1`, [id]);
    await logEvent({ userId: me(req), action: 'delete', target: `prospect_link:${id}` });
    return { ok: true };
  });

  // 고객 등록(Registrar como cliente)용 값 — 양식의 erp_field 매핑
  app.get('/api/prospects/:id/customer-prefill', view, async (req, reply) => {
    const p = await loadProspect(req, req.params.id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const crm = Object.fromEntries((await query(`SELECT field_key, value FROM prospect_crm_values WHERE prospect_id=$1`, [p.id])).rows.map((r) => [r.field_key, r.value]));
    const out = {};
    for (const f of ALTA_FIELDS) if (f.erp_field && crm[f.key] != null) out[f.erp_field] = crm[f.key];
    if (!out.nombre_comercial) out.nombre_comercial = p.nom_estab;
    if (!out.telefono && p.phone) out.telefono = p.phone;
    return { prospect_id: Number(p.id), values: out, missing: missingRequired(crm) };
  });

  // ── ERP 견적서 연결 ─────────────────────────────────────────────────
  //   견적 점수는 ERP 에 견적서가 저장돼 있어야 오른다. 연결 고객 견적은 자동,
  //   게스트 견적은 (1) 담당·상호가 맞으면 자동 연결(syncGuestQuotes) (2) 여기서 직접 연결.
  app.get('/api/prospects/:id/erp-quotes', view, async (req, reply) => {
    const p = await loadProspect(req, req.params.id, { unassigned: false });
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const rows = (await query(
      `SELECT q.id, q.quote_no, q.quote_date, q.status, q.guest_name, q.subtotal_mxn::float AS subtotal_mxn, u.name AS user_name
         FROM quotes q LEFT JOIN users u ON u.id=q.created_by
        WHERE q.prospect_id IS NULL AND q.customer_id IS NULL AND q.status <> 'cancelled'
          AND q.created_at > now() - INTERVAL '60 days' ${isDir(req) ? '' : 'AND q.created_by=$1'}
        ORDER BY q.created_at DESC LIMIT 100`, isDir(req) ? [] : [me(req)])).rows;
    const sim = (g) => Math.max(nameSimilarity(g, p.nom_estab), nameSimilarity(g, p.raz_social));
    return { rows: rows.map((r) => ({ ...r, id: Number(r.id), match: Math.round(sim(r.guest_name) * 100) })).sort((a, b2) => b2.match - a.match).slice(0, 20) };
  });
  app.post('/api/prospects/:id/erp-quotes', edit, async (req, reply) => {
    const p = await loadProspect(req, req.params.id, { unassigned: false });
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const qid = int(req.body && req.body.quote_id);
    const out = await withTx(async (client) => {
      const q = client.query.bind(client);
      const r = await q(`UPDATE quotes SET prospect_id=$2 WHERE id=$1 AND prospect_id IS NULL AND status <> 'cancelled'
                           ${isDir(req) ? '' : 'AND created_by=$3'} RETURNING id`, isDir(req) ? [qid, p.id] : [qid, p.id, me(req)]);
      if (!r.rowCount) return { code: 404 };
      return recomputeProspect(q, Number(p.id), { userId: me(req), reason: 'cotización ERP vinculada' });
    });
    if (out && out.code) return reply.code(404).send({ error: 'quote_not_found' });
    await logEvent({ userId: me(req), action: 'update', target: `quote:${qid}`, detail: { prospect_id: Number(p.id) } });
    return { ok: true, ...out };
  });
  app.delete('/api/prospects/:id/erp-quotes/:qid', edit, async (req, reply) => {
    const p = await loadProspect(req, req.params.id, { unassigned: false });
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const out = await withTx(async (client) => {
      const q = client.query.bind(client);
      await q(`UPDATE quotes SET prospect_id=NULL WHERE id=$1 AND prospect_id=$2`, [int(req.params.qid), p.id]);
      return recomputeProspect(q, Number(p.id), { userId: me(req), reason: 'cotización desvinculada' });
    });
    return { ok: true, ...out };
  });

  // ── 단계 제안(AI·기록) 적용/무시 ────────────────────────────────────
  app.post('/api/prospects/:id/suggestion', edit, async (req, reply) => {
    const p = await loadProspect(req, req.params.id, { unassigned: false });
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (!p.suggested_stage) return reply.code(400).send({ error: 'no_suggestion' });
    const apply = !!(req.body && req.body.apply);
    const out = await withTx(async (client) => {
      const q = client.query.bind(client);
      const rec = (await q(`SELECT r.id FROM sales_consult_recordings r JOIN sales_consults c ON c.id=r.consult_id
                             WHERE c.prospect_id=$1 AND r.alta_status='done' ORDER BY r.id DESC LIMIT 1`, [p.id])).rows[0];
      await q(`UPDATE prospects SET suggestion_dismissed=$2, suggested_stage=NULL, suggestion_reason=NULL WHERE id=$1`,
        [p.id, rec ? `${p.suggested_stage}:${rec.id}` : null]);
      if (apply) {
        const to = p.suggested_stage;
        const chk = checkStageMove(p.stage, to, { isDirector: isDir(req), reason: p.suggestion_reason });
        if (!chk.ok) return { code: 400, error: chk.error };
        await moveStage(q, Number(p.id), p.stage, to, { userId: me(req), reason: p.suggestion_reason });
      }
      return recomputeProspect(q, Number(p.id), { userId: me(req), reason: apply ? 'sugerencia aplicada' : 'sugerencia descartada' });
    });
    if (out && out.code) return reply.code(out.code).send({ error: out.error });
    return { ok: true, ...out };
  });

  // ── 진척 보드(누구나) — 전체·영업사원별·업체별 점수와 방문 실적, 일별 누적 ──
  // ── 🔗 고객개발에 연결 안 된 방문(빠른 녹음) — 진척 보드 「첫 방문」에서 빠진 것 찾기 ──
  //   일반 🎙 녹음으로 방문했거나, 다른 담당 후보라 연결이 거절된 녹음(상담은 저장됨)이 여기에 남는다.
  //   대상: quick_rec · prospect_id 없음 · ERP 고객(customer_id) 아님 · 「고객개발 아님」 표시 안 함(reviewed_at)
  app.get('/api/prospects/unlinked-visits', { preHandler: [authGuard, loadMgr] }, async (req) => {
    const qs = req.query || {};
    const isWeek = qs.range === 'week';
    const pb = isWeek ? weekBounds(YMD.test(String(qs.week)) ? qs.week : mxToday()) : periodBounds(PERIOD.test(String(qs.period)) ? qs.period : mxToday().slice(0, 7));
    const params = [pb.from, pb.to]; let cond = '';
    if (!isDir(req)) { params.push(me(req)); cond = `AND c.created_by=$${params.length}`; }
    else if (int(qs.user)) { params.push(int(qs.user)); cond = `AND c.created_by=$${params.length}`; }
    let rows;
    try {
      rows = (await query(
        `SELECT c.id, c.consult_date::text AS consult_date, c.created_at, c.company_name, c.created_by, u.name AS user_name, c.geo_lat, c.geo_lng
           FROM sales_consults c LEFT JOIN users u ON u.id=c.created_by
          WHERE c.deleted_at IS NULL AND c.quick_rec = TRUE AND c.prospect_id IS NULL AND c.customer_id IS NULL AND c.reviewed_at IS NULL
            AND c.consult_date >= $1::date AND c.consult_date < $2::date ${cond}
          ORDER BY c.created_at DESC LIMIT 200`, params)).rows;
    } catch (_) { return { rows: [] }; }   // 0333/0334 전
    // 녹음 위치 근처 후보(400m 안 가까운 순 3곳) — 누르면 바로 연결
    for (const r of rows) {
      r.id = Number(r.id); r.created_by = Number(r.created_by);
      const lat = Number(r.geo_lat), lng = Number(r.geo_lng); r.near = [];
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
      const dLat = 400 / 111320, dLng = 400 / (111320 * Math.cos((lat * Math.PI) / 180));
      r.near = (await query(
        `SELECT p.id, p.nom_estab, p.colonia, p.stage, p.owner_user_id, u.name AS owner_name, p.lat, p.lng FROM prospects p LEFT JOIN users u ON u.id=p.owner_user_id
          WHERE p.deleted_at IS NULL AND p.lat BETWEEN $1 AND $2 AND p.lng BETWEEN $3 AND $4`,
        [lat - dLat, lat + dLat, lng - dLng, lng + dLng])).rows
        .map((p) => ({ id: Number(p.id), nom_estab: p.nom_estab, colonia: p.colonia, stage: p.stage, owner_user_id: p.owner_user_id == null ? null : Number(p.owner_user_id), owner_name: p.owner_name, dist_m: distanceM(lat, lng, Number(p.lat), Number(p.lng)) }))
        .sort((a, b) => a.dist_m - b.dist_m).slice(0, 3);
    }
    return { from: pb.from, to: pb.to, rows };
  });
  // 연결 — 방문한 사람(녹음한 사람) 기준으로 붙인다: 미배정 후보면 그 사람에게 배정 → 단계 컨택 → 첫 방문 집계
  //   다른 담당 후보면: 담당자는 거절(not_owner) · 디렉터/관리자는 force=true 로 담당을 방문한 사람에게 옮기고 연결
  app.post('/api/prospects/unlinked-visits/:id/link', edit, async (req, reply) => {
    const c = (await query(`SELECT id, created_by, prospect_id, geo_lat, geo_lng FROM sales_consults WHERE id=$1 AND deleted_at IS NULL`, [int(req.params.id)])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!isDir(req) && Number(c.created_by) !== me(req)) return reply.code(403).send({ error: 'forbidden' });
    if (c.prospect_id) return reply.code(409).send({ error: 'already_linked' });
    const pid = int(req.body?.prospect_id); if (!pid) return reply.code(400).send({ error: 'prospect_required' });
    const visitor = Number(c.created_by);
    const p = (await query(`SELECT p.id, p.owner_user_id, u.name AS owner_name FROM prospects p LEFT JOIN users u ON u.id=p.owner_user_id WHERE p.id=$1 AND p.deleted_at IS NULL`, [pid])).rows[0];
    if (!p) return reply.code(404).send({ error: 'prospect_not_found' });
    if (p.owner_user_id != null && Number(p.owner_user_id) !== visitor) {
      if (!(isDir(req) && req.body?.force === true)) return reply.code(409).send({ error: 'not_owner', owner_name: p.owner_name });
      await query(`UPDATE prospects SET owner_user_id=$2, assigned_at=now(), updated_at=now() WHERE id=$1`, [pid, visitor]);
      await query(`INSERT INTO prospect_assign_history (prospect_id, from_user, to_user, by_user) VALUES ($1,$2,$3,$4)`, [pid, p.owner_user_id, visitor, me(req)]);
    }
    const lat = c.geo_lat == null ? null : Number(c.geo_lat), lng = c.geo_lng == null ? null : Number(c.geo_lng);
    const r = await attachConsultToProspect({ consultId: Number(c.id), prospectId: pid, perm: { userId: visitor, role: 'sales' }, lat, lng });
    if (!r || r.error) return reply.code(409).send({ error: (r && r.error) || 'link_failed' });
    await syncConsultVisitSafe(Number(c.id), req.log);
    await logEvent({ userId: me(req), action: 'update', target: `consult:${c.id}`, detail: { link_prospect: pid, visitor, force: req.body?.force === true } });
    return { ok: true, ...r };
  });
  // 「고객개발 아님」(기존 고객 방문 등) — 목록에서 숨김(상담은 그대로)
  app.post('/api/prospects/unlinked-visits/:id/dismiss', edit, async (req, reply) => {
    const c = (await query(`SELECT id, created_by FROM sales_consults WHERE id=$1 AND deleted_at IS NULL AND prospect_id IS NULL`, [int(req.params.id)])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!isDir(req) && Number(c.created_by) !== me(req)) return reply.code(403).send({ error: 'forbidden' });
    await query(`UPDATE sales_consults SET reviewed_by=$2, reviewed_at=now() WHERE id=$1`, [c.id, me(req)]);
    return { ok: true };
  });

  app.get('/api/prospects/progress', { preHandler: [authGuard, loadMgr] }, async (req) => {
    await refreshCustomerStages().catch(() => {});   // ERP 견적·인보이스 반영
    const qs = req.query || {};
    const period = PERIOD.test(String(qs.period)) ? qs.period : mxToday().slice(0, 7);
    const isWeek = qs.range === 'week';
    const pb = isWeek ? weekBounds(YMD.test(String(qs.week)) ? qs.week : mxToday()) : periodBounds(period);
    const ent = qs.cve_ent ? String(qs.cve_ent) : null;
    const ep = ent ? [ent] : []; const entCond = ent ? `AND p.cve_ent=$1` : '';
    const n = ep.length;
    const users = Object.fromEntries((await query(`SELECT id, name FROM users`)).rows.map((u) => [Number(u.id), u.name]));
    const ex = await excludedSet();
    // 업체 현황
    const sum = (await query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE p.score > 0)::int AS worked,
              COALESCE(ROUND(AVG(p.score) FILTER (WHERE p.score > 0)),0)::int AS avg_worked,
              COUNT(*) FILTER (WHERE p.score >= 50)::int AS ge50, COUNT(*) FILTER (WHERE p.score >= 100)::int AS developed
         FROM prospects p WHERE p.deleted_at IS NULL ${entCond}`, ep)).rows[0];
    const bands = (await query(
      `SELECT ${SCORE_BANDS.map(([a, b2], i) => `COUNT(*) FILTER (WHERE p.score BETWEEN ${a} AND ${b2} AND p.owner_user_id IS NOT NULL)::int AS b${i}`).join(', ')}
         FROM prospects p WHERE p.deleted_at IS NULL ${entCond}`, ep)).rows[0];
    const stages = (await query(`SELECT p.stage, COUNT(*)::int AS n FROM prospects p WHERE p.deleted_at IS NULL ${entCond} GROUP BY p.stage`, ep)).rows;
    // 기간 일별: 방문(체크인) · 획득 점수 — 담당자별
    const pp = [...ep, pb.from, pb.to];
    const visits = (await query(
      `SELECT c.consult_date::text AS d, c.created_by AS uid, COUNT(*)::int AS n, COUNT(DISTINCT c.prospect_id)::int AS u
         FROM sales_consults c JOIN prospects p ON p.id=c.prospect_id
        WHERE c.deleted_at IS NULL ${entCond} AND c.consult_date >= $${n + 1}::date AND c.consult_date < $${n + 2}::date
        GROUP BY 1,2`, pp)).rows;
    const pts = (await query(
      `SELECT ((l.created_at AT TIME ZONE 'America/Mexico_City')::date)::text AS d, l.owner_user_id AS uid, SUM(l.score - l.prev_score)::int AS n
         FROM prospect_score_log l JOIN prospects p ON p.id=l.prospect_id
        WHERE TRUE ${entCond} AND l.created_at >= $${n + 1}::date AND l.created_at < $${n + 2}::date GROUP BY 1,2`, pp)).rows;
    const reach = (stage) => `
      SELECT p.owner_user_id AS uid, COUNT(*)::int AS n FROM prospects p
        JOIN LATERAL (SELECT MIN(h.created_at) AS t FROM prospect_stage_history h WHERE h.prospect_id=p.id AND ${stage === 'registro' ? `h.to_stage='registro'` : `${STAGE_RANK_SQL('h.to_stage')} >= ${stageRank(stage)}`}) f ON TRUE
       WHERE p.deleted_at IS NULL ${entCond} AND f.t >= $${n + 1}::date AND f.t < $${n + 2}::date GROUP BY 1`;
    const [rCont, rPerf, rCot, rReg, rSale] = await Promise.all(['contactado', 'perfilado', 'cotizado', 'registro', 'cliente_activo'].map((st) => query(reach(st), pp)));
    const own = (await query(
      `SELECT p.owner_user_id AS uid, COUNT(*)::int AS assigned, COUNT(*) FILTER (WHERE p.score>0)::int AS worked,
              COALESCE(ROUND(AVG(p.score) FILTER (WHERE p.score>0)),0)::int AS avg_score, COALESCE(SUM(p.score),0)::int AS score_sum,
              COUNT(*) FILTER (WHERE p.score>=50)::int AS ge50, COUNT(*) FILTER (WHERE p.score>=100)::int AS developed
         FROM prospects p WHERE p.deleted_at IS NULL AND p.owner_user_id IS NOT NULL ${entCond} GROUP BY 1`, ep)).rows;
    const tg = (await query(`SELECT user_id, metric, target_value FROM prospect_targets WHERE period=$1 AND metric IN ('contactados','puntos','perfilados','cotizaciones','nuevos_clientes')`, [period])).rows;
    const reps = {};
    const R = (uid) => { const k = Number(uid); if (!reps[k]) reps[k] = { user_id: k, name: users[k] || '?', visits: 0, visited: 0, points: 0, contactados: 0, perfilados: 0, cotizaciones: 0, registros: 0, nuevos: 0, target: {} }; return reps[k]; };
    own.forEach((o) => Object.assign(R(o.uid), { assigned: o.assigned, worked: o.worked, avg_score: o.avg_score, score_sum: o.score_sum, ge50: o.ge50, developed: o.developed }));
    visits.forEach((v) => { R(v.uid).visits += v.n; R(v.uid).visited += v.u; });
    pts.forEach((v) => { if (v.uid != null) R(v.uid).points += v.n; });
    [[rCont, 'contactados'], [rPerf, 'perfilados'], [rCot, 'cotizaciones'], [rReg, 'registros'], [rSale, 'nuevos']].forEach(([rs, k]) => rs.rows.forEach((r) => { if (r.uid != null) R(r.uid)[k] = r.n; }));
    tg.forEach((t) => { R(t.user_id).target[t.metric] = Number(t.target_value); });
    const repList = Object.values(reps).filter((r) => !ex.has(r.user_id) || r.assigned)
      .sort((a, b2) => b2.points - a.points || b2.visits - a.visits);
    repList.forEach((r, i) => { r.rank = i + 1; });
    // 일별 시계열(누적) — 전체 + 담당자별
    const days = []; for (let d = new Date(pb.from + 'T00:00:00Z'); d < new Date(pb.to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
    const series = (rows, key) => {
      const by = {}; rows.forEach((r) => { const u = r.uid == null ? 0 : Number(r.uid); (by[u] = by[u] || {})[r.d] = (by[u][r.d] || 0) + r[key]; });
      const cum = (m) => { let c = 0; return days.map((d) => (c += (m[d] || 0))); };
      const total = {}; Object.values(by).forEach((m) => Object.entries(m).forEach(([d, v]) => { total[d] = (total[d] || 0) + v; }));
      return { total: cum(total), daily: days.map((d) => total[d] || 0),
        by_user: Object.fromEntries(Object.entries(by).filter(([u]) => u !== '0').map(([u, m]) => [u, cum(m)])) };
    };
    const movers = (await query(
      `SELECT p.id, p.nom_estab, p.municipio, p.owner_user_id, p.stage, p.score, p.info_pct,
              p.score - COALESCE((SELECT l.prev_score FROM prospect_score_log l WHERE l.prospect_id=p.id AND l.created_at >= $${n + 1}::date ORDER BY l.created_at LIMIT 1), p.score) AS gain,
              (SELECT MAX(l.created_at) FROM prospect_score_log l WHERE l.prospect_id=p.id) AS last_change
         FROM prospects p WHERE p.deleted_at IS NULL ${entCond}
          AND EXISTS (SELECT 1 FROM prospect_score_log l WHERE l.prospect_id=p.id AND l.created_at >= $${n + 1}::date AND l.created_at < $${n + 2}::date)
        ORDER BY gain DESC, p.score DESC LIMIT 30`, pp)).rows
      .map((m) => ({ ...m, id: Number(m.id), owner_user_id: m.owner_user_id == null ? null : Number(m.owner_user_id), owner_name: users[Number(m.owner_user_id)] || null, mine: Number(m.owner_user_id) === me(req) }));
    // 업체별 「이전 점수(기간 시작 시점) + 이번 기간 상승」 — 진척 막대(검정=이전, 빨강=이번 기간)
    const perP = (await query(
      `SELECT p.id, p.nom_estab, p.owner_user_id, p.stage, p.score,
              COALESCE((SELECT l.score FROM prospect_score_log l WHERE l.prospect_id=p.id AND l.created_at < $${n + 1}::date ORDER BY l.created_at DESC LIMIT 1), 0) AS before
         FROM prospects p
        WHERE p.deleted_at IS NULL ${entCond} AND (p.score > 0 OR EXISTS (SELECT 1 FROM prospect_score_log l WHERE l.prospect_id=p.id AND l.created_at >= $${n + 1}::date))
        ORDER BY p.score DESC LIMIT 400`, [...ep, pb.from])).rows
      .map((r) => ({ id: Number(r.id), name: r.nom_estab, owner_user_id: r.owner_user_id == null ? null : Number(r.owner_user_id),
        owner_name: users[Number(r.owner_user_id)] || null, stage: r.stage, score: r.score,
        before: Math.min(r.before, r.score), gain: Math.max(0, r.score - r.before), mine: Number(r.owner_user_id) === me(req) }));
    return { period, range: isWeek ? 'week' : 'month', from: pb.from, to: pb.to, days, summary: sum, per_prospect: perP, bands: SCORE_BANDS.map(([a, b2], i) => ({ from: a, to: b2, n: bands['b' + i] })),
      stages: Object.fromEntries(stages.map((r) => [r.stage, r.n])), reps: repList,
      visits: series(visits, 'n'), points: series(pts, 'n'), movers, score_rules: SCORE_RULES };
  });

  // ── 담당자 명단(디렉터) — 고객개발 담당 선택지에서 뺄 사용자 ───────────
  app.get('/api/prospect-staff', view, async (req, reply) => {
    if (!directorOnly(req, reply)) return;
    const ex = await excludedSet();
    const rows = (await query(
      `SELECT u.id, u.name, u.role,
              (SELECT COUNT(*)::int FROM prospects p WHERE p.owner_user_id=u.id AND p.deleted_at IS NULL) AS assigned
         FROM users u WHERE u.deleted_at IS NULL ORDER BY u.name`)).rows;
    const mg = await managerSet();
    return { can_grant: isRealDir(req), rows: rows.map((u) => ({ id: Number(u.id), name: u.name, role: u.role, assigned: u.assigned, excluded: ex.has(Number(u.id)), manager: mg.has(Number(u.id)) })) };
  });
  // 고객개발 관리자 지정(디렉터만) — 디렉터와 같은 권한으로 고객개발 전체를 보고 고침
  app.put('/api/prospect-managers', edit, async (req, reply) => {
    if (!isRealDir(req)) return reply.code(403).send({ error: 'director_only' });
    const ids = [...new Set((Array.isArray(req.body?.user_ids) ? req.body.user_ids : []).map(int).filter(Boolean))];
    await withTx(async (client) => {
      const q = client.query.bind(client);
      await q(`DELETE FROM prospect_managers WHERE NOT (user_id = ANY($1))`, [ids]);
      for (const id of ids) await q(`INSERT INTO prospect_managers (user_id, granted_by) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING`, [id, me(req)]);
    });
    mgrCache.at = 0;
    await logEvent({ userId: me(req), action: 'update', target: 'prospect_managers', detail: { user_ids: ids } });
    return { ok: true, managers: ids.length };
  });
  app.put('/api/prospect-staff', edit, async (req, reply) => {
    if (!directorOnly(req, reply)) return;
    const ids = [...new Set((Array.isArray(req.body?.excluded_user_ids) ? req.body.excluded_user_ids : []).map(int).filter(Boolean))];
    await withTx(async (client) => {
      const q = client.query.bind(client);
      await q(`DELETE FROM prospect_excluded_users WHERE NOT (user_id = ANY($1))`, [ids]);
      for (const id of ids) await q(`INSERT INTO prospect_excluded_users (user_id, excluded_by) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING`, [id, me(req)]);
    });
    await logEvent({ userId: me(req), action: 'update', target: 'prospect_staff', detail: { excluded: ids } });
    return { ok: true, excluded: ids.length };
  });

  // ── 현황판 ─────────────────────────────────────────────────────────
  app.get('/api/prospects/dashboard', view, async (req) => {
    await refreshCustomerStages().catch(() => {});
    const qs = req.query || {};
    const period = PERIOD.test(String(qs.period)) ? qs.period : mxToday().slice(0, 7);
    const pb = periodBounds(period);
    const params = []; const conds = ['p.deleted_at IS NULL', scopeCond(req, params)];
    if (qs.cve_ent) { params.push(String(qs.cve_ent)); conds.push(`p.cve_ent=$${params.length}`); }
    const where = conds.join(' AND ');
    const stageRows = (await query(`SELECT p.stage, COUNT(*)::int AS n FROM prospects p WHERE ${where} GROUP BY p.stage`, params)).rows;
    const funnel = Object.fromEntries(STAGE_KEYS.map((k) => [k, 0]));
    stageRows.forEach((r) => { funnel[r.stage] = r.n; });
    const total = stageRows.reduce((s, r) => s + r.n, 0);
    const prioA = (await query(`SELECT COUNT(*)::int AS n FROM prospects p WHERE ${where} AND p.priority='A'`, params)).rows[0].n;
    const potRow = (await query(
      `SELECT COUNT(*) FILTER (WHERE p.pot_tier='A')::int AS a, COUNT(*) FILTER (WHERE p.pot_tier='B')::int AS b,
              COUNT(*) FILTER (WHERE p.pot_tier='C')::int AS c, COUNT(p.pot_compra_susp)::int AS measured,
              COALESCE(SUM(p.pot_compra_susp) FILTER (WHERE p.stage NOT IN ('cliente_activo','descartado')),0)::float AS open_susp,
              COALESCE(SUM(p.pot_compra_susp),0)::float AS total_susp
         FROM prospects p WHERE ${where}`, params)).rows[0];
    // 기간 실적 — 담당자별
    const pp = [...params, pb.from, pb.to]; const f = `$${pp.length - 1}`, tto = `$${pp.length}`;
    // 「그 단계 이상에 처음 도달」한 업체 수(단계를 건너뛰어도 센다)
    const firstReach = (stage) => `
      SELECT p.owner_user_id AS uid, COUNT(*)::int AS n FROM prospects p
        JOIN LATERAL (SELECT MIN(h.created_at) AS t FROM prospect_stage_history h
                       WHERE h.prospect_id=p.id AND ${STAGE_RANK_SQL('h.to_stage')} >= ${stageRank(stage)}) fr ON TRUE
       WHERE ${where} AND fr.t >= ${f}::date AND fr.t < ${tto}::date GROUP BY p.owner_user_id`;
    const [perfRows, ptsRows] = await Promise.all([
      query(firstReach('perfilado'), pp),
      query(`SELECT l.owner_user_id AS uid, COALESCE(SUM(l.score - l.prev_score),0)::int AS n FROM prospect_score_log l JOIN prospects p ON p.id=l.prospect_id
              WHERE ${where} AND l.created_at >= ${f}::date AND l.created_at < ${tto}::date GROUP BY l.owner_user_id`, pp),
    ]);
    const [visRows, conRows, cotRows, newRows, saleRows, ownerRows, reviewRows, todayRows] = await Promise.all([
      query(`SELECT c.created_by AS uid, COUNT(DISTINCT (c.prospect_id, c.consult_date))::int AS n
               FROM sales_consults c JOIN prospects p ON p.id=c.prospect_id
              WHERE ${where} AND c.deleted_at IS NULL AND c.consult_date >= ${f}::date AND c.consult_date < ${tto}::date GROUP BY c.created_by`, pp),
      query(firstReach('contactado'), pp),
      query(firstReach('cotizado'), pp),
      // 신규고객 = 이번 달 신규고객 단계 + 그 고객의 첫 게시 인보이스가 이번 달(원래 거래하던 고객은 제외)
      query(`SELECT p.owner_user_id AS uid, COUNT(DISTINCT p.id)::int AS n
               FROM prospect_stage_history h JOIN prospects p ON p.id=h.prospect_id
              WHERE ${where} AND h.to_stage='cliente_activo' AND h.created_at >= ${f}::date AND h.created_at < ${tto}::date
                AND (SELECT MIN(si.inv_date) FROM sales_invoices si WHERE si.customer_id=p.customer_id AND si.status='posted' AND si.deleted_at IS NULL) >= ${f}::date
              GROUP BY p.owner_user_id`, pp),
      // 신규고객 매출(IVA 제외) = 첫 인보이스 후 90일 이내 인보이스 중 이번 달 분
      query(`SELECT p.owner_user_id AS uid, COALESCE(SUM(si.subtotal_mxn),0)::float AS n
               FROM prospects p JOIN sales_invoices si ON si.customer_id=p.customer_id AND si.status='posted' AND si.deleted_at IS NULL
              WHERE ${where} AND p.stage='cliente_activo' AND si.inv_date >= ${f}::date AND si.inv_date < ${tto}::date
                AND si.inv_date < (SELECT MIN(s2.inv_date) FROM sales_invoices s2 WHERE s2.customer_id=p.customer_id AND s2.status='posted' AND s2.deleted_at IS NULL) + 90
              GROUP BY p.owner_user_id`, pp),
      query(`SELECT p.owner_user_id AS uid, COUNT(*)::int AS assigned,
                    COUNT(*) FILTER (WHERE p.stage NOT IN ('sin_asignar','asignado'))::int AS worked,
                    COUNT(*) FILTER (WHERE p.stage IN ('asignado','contactado','interesado','cotizado')
                                     AND COALESCE(p.last_activity_at, p.assigned_at) < now() - INTERVAL '30 days')::int AS idle
               FROM prospects p WHERE ${where} GROUP BY p.owner_user_id`, params),
      query(`SELECT c.created_by AS uid, COUNT(*)::int AS n FROM sales_consults c JOIN prospects p ON p.id=c.prospect_id
              WHERE ${where} AND c.deleted_at IS NULL AND c.review_status IN ('por_revisar','borrador') GROUP BY c.created_by`, params),
      query(`SELECT c.created_by AS uid, COUNT(*)::int AS n FROM sales_consults c JOIN prospects p ON p.id=c.prospect_id
              WHERE ${where} AND c.deleted_at IS NULL AND c.consult_date = $${params.length + 1}::date GROUP BY c.created_by`, [...params, mxToday()]),
    ]);
    const tRows = (await query(`SELECT user_id, metric, target_value FROM prospect_targets WHERE period=$1`, [period])).rows;
    const users = Object.fromEntries((await query(`SELECT id, name FROM users`)).rows.map((u) => [Number(u.id), u.name]));
    const byUser = {};
    const U = (uid) => { const k = uid == null ? 'none' : String(Number(uid)); if (!byUser[k]) byUser[k] = { user_id: uid == null ? null : Number(uid), name: uid == null ? null : users[Number(uid)] || '?', actual: {}, target: {} }; return byUser[k]; };
    const fill = (rows, key) => rows.rows.forEach((r) => { U(r.uid).actual[key] = Number(r.n) || 0; });
    fill(visRows, 'visitas'); fill(conRows, 'contactados'); fill(perfRows, 'perfilados'); fill(ptsRows, 'puntos'); fill(cotRows, 'cotizaciones'); fill(newRows, 'nuevos_clientes'); fill(saleRows, 'venta_nuevos');
    ownerRows.rows.forEach((r) => { Object.assign(U(r.uid), { assigned: r.assigned, worked: r.worked, idle: r.idle }); });
    reviewRows.rows.forEach((r) => { U(r.uid).pending_reviews = r.n; });
    todayRows.rows.forEach((r) => { U(r.uid).checkins_today = r.n; });
    const visibleUsers = isDir(req) ? null : me(req);
    tRows.forEach((r) => { if (visibleUsers == null || Number(r.user_id) === visibleUsers) U(r.user_id).target[r.metric] = Number(r.target_value); });
    const today = mxToday(); const day = today.slice(0, 7) === period ? Number(today.slice(8, 10)) : (today > period ? pb.days : 0);
    const kpi = METRICS.map((m) => {
      const actual = Object.values(byUser).reduce((s, u) => s + (u.actual[m] || 0), 0);
      const target = Object.values(byUser).reduce((s, u) => s + (u.target[m] || 0), 0);
      return { metric: m, actual, target, pct: pct(actual, target), status: paceStatus(actual, target, day, pb.days) };
    });
    const people = Object.values(byUser).map((u) => ({
      ...u, coverage: u.assigned ? Math.round((u.worked / u.assigned) * 1000) / 10 : null,
      pct: Object.fromEntries(METRICS.map((m) => [m, pct(u.actual[m] || 0, u.target[m] || 0)])),
    })).sort((a, b) => (a.user_id == null) - (b.user_id == null) || (b.assigned || 0) - (a.assigned || 0));
    const daysRow = (await query(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (h2.created_at - h1.created_at))/86400)::float AS d
         FROM prospect_stage_history h1 JOIN prospect_stage_history h2 ON h2.prospect_id=h1.prospect_id AND h2.to_stage='cliente_activo'
         JOIN prospects p ON p.id=h1.prospect_id WHERE ${where} AND h1.to_stage='contactado'`, params)).rows[0];
    return { period, day, days_in_month: pb.days, total, priority_a: prioA, funnel, kpi, people, potential: potRow,
      median_days_to_client: daysRow && daysRow.d != null ? Math.round(daysRow.d) : null };
  });
}
