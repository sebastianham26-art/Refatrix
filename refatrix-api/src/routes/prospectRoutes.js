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
import { query, withTx } from '../db.js';
import { authGuard, requirePage, requirePageEdit } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import {
  STAGES, STAGE_KEYS, DISCARD_REASONS, SEGMENTS, METRICS, METRIC_NAMES, allocateTarget, POINT_WEIGHTS, pointsTarget, checkStageMove, autoAdvance, normalizeImportRow,
  territoryFor, orderStops, suggestCustomers, prefillFromProspect, mergeForReview, validateAltaValues,
  missingRequired, pct, paceStatus, periodBounds, CHECKIN_WARN_M, ALTA_FORM, potentialOf, POTENTIAL_TIERS,
  STAGE_RANK_SQL, SCORE_RULES, SECTION_WEIGHTS, SCORE_BANDS, stageRank, nameSimilarity,
  inPolygon, distanceM, rankForRoute, optimizeRoute, routeMinutes, weekBounds, planDays, nextWorkDates, convexHull, pickDayRoute,
} from '../prospectCore.js';
import { pageAllowed } from '../permissions.js';
import { ALTA_FIELDS, ALTA_FIELD_MAP } from '../altaClientesForm.js';
import { moveStage, refreshCustomerStages, hasProspectCols, recomputeProspect, recomputeProspectSafe } from '../prospectAlta.js';

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
function parseJ(v) { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return null; } }

let potCols = null;
async function hasPotCols() {
  if (potCols) return true;
  try { potCols = (await query(`SELECT 1 FROM information_schema.columns WHERE table_name='prospects' AND column_name IN ('pot_tier','score') HAVING COUNT(*)=2`)).rows.length > 0; }
  catch (_) { potCols = false; }
  return potCols;
}
let planCols = false;
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
      potential_tiers: POTENTIAL_TIERS, score_rules: SCORE_RULES, section_weights: SECTION_WEIGHTS, score_bands: SCORE_BANDS,
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
    if (qs.municipio) add('p.municipio = ?', String(qs.municipio));
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

  app.get('/api/prospects/municipios', view, async (req) => {
    const ent = String(req.query?.cve_ent || '19');
    const rows = (await query(
      `SELECT municipio, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE owner_user_id IS NULL)::int AS unassigned,
              COUNT(*) FILTER (WHERE priority='A')::int AS prio_a
         FROM prospects WHERE deleted_at IS NULL AND cve_ent=$1 GROUP BY municipio ORDER BY total DESC`, [ent])).rows;
    return { cve_ent: ent, rows };
  });

  // ── 상세 ───────────────────────────────────────────────────────────
  app.get('/api/prospects/:id', view, async (req, reply) => {
    const p = await loadProspect(req, req.params.id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
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
    const cust = p.customer_id ? (await query(`SELECT id, code, name, approval_status FROM customers WHERE id=$1`, [p.customer_id])).rows[0] : null;
    return {
      prospect: { ...pub(p), owner_name: owner ? owner.name : null }, customer: cust || null,
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
    const r = (await query(
      `INSERT INTO prospects (nom_estab, segment, priority, lat, lng, address, municipio, cve_ent, entidad, phone, source,
                              owner_user_id, assigned_at, stage, created_by)
       VALUES ($1,$2,'B',$3,$4,$5,$6,$7,$8,$9,'manual',$10,now(),'asignado',$11) RETURNING id`,
      [name, SEGMENTS.includes(b.segment) ? b.segment : 'otro', lat, lng, txt(b.address), txt(b.municipio, 120),
        txt(b.cve_ent, 4) || '19', txt(b.entidad, 80) || 'Nuevo León', txt(b.phone, 40), owner, me(req)])).rows[0];
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
    const summary = { received: raw.length, valid: good.length, new: good.filter((g) => !exist.has(g.denue_id)).length,
      update: good.filter((g) => exist.has(g.denue_id)).length, invalid: bad, by_state: byState, by_segment: bySeg, edition };
    if (!b.commit) return summary;
    const newIds = await withTx(async (client) => {
      const q = client.query.bind(client); const created = [];
      for (const g of good) {
        if (exist.has(g.denue_id)) {
          // 기존: DENUE 항목만 갱신(담당·단계·활동·수동 수정값은 유지) — 사람이 고친 연락처는 덮지 않는다
          await q(`UPDATE prospects SET clee=$2, raz_social=COALESCE(raz_social,$3), scian_code=$4, per_ocu=$5,
                          address=COALESCE(address,$6), colonia=COALESCE(colonia,$7), cp=COALESCE(cp,$8), lat=COALESCE(lat,$9), lng=COALESCE(lng,$10),
                          phone=COALESCE(phone,$11), email=COALESCE(email,$12), denue_edition=$13, denue_missing=FALSE, updated_at=now()
                    WHERE denue_id=$1`,
          [g.denue_id, g.clee, g.raz_social, g.scian_code, g.per_ocu, g.address, g.colonia, g.cp, g.lat, g.lng, g.phone, g.email, edition]);
        } else {
          const r = (await q(
            `INSERT INTO prospects (denue_id, clee, nom_estab, raz_social, scian_code, segment, priority, per_ocu, address, colonia, cp,
                                    cve_ent, entidad, cve_mun, municipio, localidad, lat, lng, phone, email, web, denue_fecha_alta,
                                    denue_edition, source, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'denue',$24)
             ON CONFLICT (denue_id) DO NOTHING RETURNING id`,
            [g.denue_id, g.clee, g.nom_estab, g.raz_social, g.scian_code, g.segment, g.priority, g.per_ocu, g.address, g.colonia, g.cp,
              g.cve_ent, g.entidad, g.cve_mun, g.municipio, g.localidad, g.lat, g.lng, g.phone, g.email, g.web, g.denue_fecha_alta,
              edition, me(req)])).rows[0];
          if (r) created.push(Number(r.id));
        }
      }
      if (created.length) await applyTerritories(client, { onlyIds: created, byUser: me(req) });
      return created;
    });
    await logEvent({ userId: me(req), action: 'create', target: 'prospects:import', detail: { ...summary, created: newIds.length } });
    return { ...summary, committed: true, created: newIds.length };
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
  app.get('/api/prospects/purge-preview', edit, async (req, reply) => {
    if (!directorOnly(req, reply)) return;
    const ent = txt(req.query?.cve_ent, 4); if (!ent) return reply.code(400).send({ error: 'cve_ent_required' });
    const r = (await query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE ${UNTOUCHED})::int AS untouched,
              COUNT(*) FILTER (WHERE p.owner_user_id IS NOT NULL)::int AS assigned
         FROM prospects p WHERE p.source='denue' AND p.cve_ent=$1`, [ent])).rows[0];
    return { cve_ent: ent, ...r, worked: r.total - r.untouched };
  });
  app.post('/api/prospects/purge', edit, async (req, reply) => {
    if (!directorOnly(req, reply)) return;
    const b = req.body || {};
    const ent = txt(b.cve_ent, 4); if (!ent) return reply.code(400).send({ error: 'cve_ent_required' });
    const scope = b.scope === 'all' ? 'all' : 'untouched';
    if (String(b.confirm || '').trim() !== '삭제') return reply.code(400).send({ error: 'confirm_required' });
    const out = await withTx(async (client) => {
      const q = client.query.bind(client);
      const del = await q(`DELETE FROM prospects p WHERE p.source='denue' AND p.cve_ent=$1 ${scope === 'untouched' ? `AND ${UNTOUCHED}` : ''} RETURNING p.id`, [ent]);
      // 비게 된 루트 정리
      await q(`DELETE FROM prospect_routes r WHERE NOT EXISTS (SELECT 1 FROM prospect_route_stops s WHERE s.route_id=r.id)`);
      const left = Number((await q(`SELECT COUNT(*)::int AS n FROM prospects WHERE source='denue' AND cve_ent=$1`, [ent])).rows[0].n);
      return { deleted: del.rowCount, kept: left };
    });
    await logEvent({ userId: me(req), action: 'delete', target: `prospects:denue:${ent}`, detail: { scope, ...out } });
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
    return withTx(async (client) => {
      const q = client.query.bind(client);
      let tid = id;
      if (tid) {
        const old = (await q(`SELECT owner_user_id FROM prospect_territories WHERE id=$1`, [tid])).rows[0];
        if (!old) return { code: 404 };
        if (!dir && Number(old.owner_user_id) !== me(req)) return { code: 403 };
        await q(`UPDATE prospect_territories SET name=$2, cve_ent=$3, municipios=$4, cps=$5, owner_user_id=$6, active=$7, polygon=$8, updated_at=now() WHERE id=$1`,
          [tid, name, txt(b.cve_ent, 4) || '19', mun, cps, owner, b.active !== false, polygon ? JSON.stringify(polygon) : null]);
        // 지역 경계가 바뀌었을 수 있으니 이 지역 표시를 풀고 다시 판정
        await q(`UPDATE prospects SET territory_id=NULL WHERE territory_id=$1`, [tid]);
        // 담당이 바뀌면 그 지역에서 옛 담당이 들고 있던 「배정」 단계 후보를 새 담당에게(진행 중인 건은 유지)
        if (dir && b.move_owner && old.owner_user_id && owner && Number(old.owner_user_id) !== owner) {
          const ids = (await q(`SELECT id FROM prospects WHERE owner_user_id=$1 AND stage='asignado' AND deleted_at IS NULL`, [old.owner_user_id])).rows.map((r) => Number(r.id));
          if (ids.length) await assignMany(client, ids, null, me(req));
        }
      } else {
        tid = Number((await q(`INSERT INTO prospect_territories (name, cve_ent, municipios, cps, owner_user_id, created_by, polygon) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [name, txt(b.cve_ent, 4) || '19', mun, cps, owner, me(req), polygon ? JSON.stringify(polygon) : null])).rows[0].id);
      }
      const n = await applyTerritories(client, { cveEnt: txt(b.cve_ent, 4) || '19', byUser: me(req) });
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
      for (const [m, v] of Object.entries(totals)) {
        const alloc = allocateTarget(v, shares, { integer: m !== 'venta_nuevos' });
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
  async function routeStops(rid) {
    return (await query(
      `SELECT s.seq, s.consult_id, p.id, p.score, p.nom_estab, p.address, p.colonia, p.municipio, p.lat, p.lng, p.phone, p.stage, p.priority, p.segment,
              c.review_status, c.created_at AS checkin_at
         FROM prospect_route_stops s JOIN prospects p ON p.id=s.prospect_id
         LEFT JOIN sales_consults c ON c.id=s.consult_id
        WHERE s.route_id=$1 AND (s.consult_id IS NOT NULL OR (p.deleted_at IS NULL AND p.stage <> 'descartado'))
        ORDER BY s.seq`, [rid])).rows.map((s) => ({ ...s, id: Number(s.id), consult_id: s.consult_id ? Number(s.consult_id) : null }));
  }
  async function routeOut(userId, date) {
    const r = (await query(`SELECT id, name FROM prospect_routes WHERE user_id=$1 AND route_date=$2`, [userId, date])).rows[0];
    if (!r) return { date, user_id: userId, stops: [] };
    return { date, user_id: userId, route_id: Number(r.id), name: r.name, stops: await routeStops(Number(r.id)) };
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
    return { rows: rows.map((r) => ({ ...r, id: Number(r.id), user_id: Number(r.user_id) })) };
  });
  app.get('/api/prospect-routes/by-id/:id', view, async (req, reply) => {
    const r = await ownRoute(req, req.params.id); if (!r) return reply.code(404).send({ error: 'not_found' });
    return { route_id: Number(r.id), user_id: Number(r.user_id), user_name: r.user_name, name: r.name,
      date: r.route_date ? String(r.route_date instanceof Date ? r.route_date.toISOString().slice(0, 10) : r.route_date).slice(0, 10) : null,
      stops: await routeStops(Number(r.id)) };
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
    if (poly.length < 3) return reply.code(400).send({ error: 'polygon_required' });
    const uid = isDir(req) && int(b.user_id) ? int(b.user_id) : me(req);
    const max = Math.min(30, Math.max(1, int(b.max_stops) || 12));
    const multi = b.multi_day !== false;
    const maxDays = multi ? Math.min(15, Math.max(1, int(b.max_days) || 5)) : 1;
    const skipDays = b.skip_visited_days === 0 || b.skip_visited_days === false ? 0 : (int(b.skip_visited_days) || 7);
    const lats = poly.map((p) => p[0]), lngs = poly.map((p) => p[1]);
    const rows = (await query(
      `SELECT p.id, p.nom_estab, p.lat, p.lng, p.priority, p.pot_tier, p.score, p.stage, p.owner_user_id, p.last_activity_at, p.colonia, p.municipio,
              t.owner_user_id AS terr_owner,
              (SELECT MAX(c.created_at) FROM sales_consults c WHERE c.prospect_id=p.id AND c.deleted_at IS NULL) AS last_visit,
              (SELECT MIN(r.user_id) FROM prospect_route_stops s JOIN prospect_routes r ON r.id=s.route_id
                WHERE s.prospect_id=p.id AND s.consult_id IS NULL AND (r.route_date IS NULL OR r.route_date >= $5::date)) AS planned_by
         FROM prospects p LEFT JOIN prospect_territories t ON t.id=p.territory_id
        WHERE p.deleted_at IS NULL AND p.lat BETWEEN $1 AND $2 AND p.lng BETWEEN $3 AND $4`,
      [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs), mxToday()])).rows
      .filter((r) => inPolygon(Number(r.lat), Number(r.lng), poly));
    const cnt = { in_area: rows.length, others: 0, others_terr: 0, others_planned: 0, visited: 0, planned: 0, closed: 0, unassigned_skipped: 0 };
    const since = Date.now() - skipDays * 86400000;
    const cands = [], excluded = [];
    for (const r of rows) {
      const owner = r.owner_user_id == null ? null : Number(r.owner_user_id);
      const tOwner = r.terr_owner == null ? null : Number(r.terr_owner);
      const pBy = r.planned_by == null ? null : Number(r.planned_by);
      let why = null;
      if (['cliente_activo', 'descartado'].includes(r.stage)) why = 'closed';
      else if (owner != null && owner !== uid) why = 'others';
      else if (owner == null && tOwner != null && tOwner !== uid) why = 'others_terr';
      else if (pBy != null && pBy !== uid) why = 'others_planned';
      else if (owner == null && b.include_unassigned === false) why = 'unassigned_skipped';
      else if (skipDays && r.last_visit && new Date(r.last_visit).getTime() > since) why = 'visited';
      else if (pBy != null) why = 'planned';
      if (why) { cnt[why]++; if (why.startsWith('others') && excluded.length < 1500) excluded.push([Number(r.lat), Number(r.lng)]); continue; }
      cands.push({ ...r, id: Number(r.id), lat: Number(r.lat), lng: Number(r.lng), owner_user_id: owner });
    }
    cnt.eligible = cands.length;
    const start = Number.isFinite(Number(b.start_lat)) && Number.isFinite(Number(b.start_lng)) ? { lat: Number(b.start_lat), lng: Number(b.start_lng) } : null;
    const plan = planDays(cands, { max, maxDays, start });
    const days = plan.days;
    cnt.scheduled = days.reduce((a, d) => a + d.stops.length, 0); cnt.left = cnt.eligible - cnt.scheduled;
    // 목록 이름 제안: 구역 안에서 가장 많은 colonia(없으면 municipio)
    const freq = {}; cands.forEach((c) => { const k = c.colonia || c.municipio; if (k) freq[k] = (freq[k] || 0) + 1; });
    const top = Object.entries(freq).sort((a, c) => c[1] - a[1])[0];
    const d0 = days[0] || { stops: [], distance_m: 0, minutes: 0 };
    return { user_id: uid, start, days, counts: cnt, excluded, name_hint: top ? top[0] : null,
      in_area: rows.length, stops: d0.stops, distance_m: d0.distance_m, minutes: d0.minutes };
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
      fields: ALTA_FIELDS, values: mergeForReview({ prefill, saved, draft }),
    };
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
    const tg = (await query(`SELECT user_id, metric, target_value FROM prospect_targets WHERE period=$1 AND metric IN ('visitas','puntos','perfilados','cotizaciones','nuevos_clientes')`, [period])).rows;
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
