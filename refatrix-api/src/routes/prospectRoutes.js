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
  STAGES, STAGE_KEYS, DISCARD_REASONS, SEGMENTS, METRICS, checkStageMove, autoAdvance, normalizeImportRow,
  territoryFor, orderStops, suggestCustomers, prefillFromProspect, mergeForReview, validateAltaValues,
  missingRequired, pct, paceStatus, periodBounds, CHECKIN_WARN_M, ALTA_FORM, potentialOf, POTENTIAL_TIERS,
  STAGE_RANK_SQL, SCORE_RULES, SECTION_WEIGHTS, SCORE_BANDS, stageRank, nameSimilarity,
} from '../prospectCore.js';
import { pageAllowed } from '../permissions.js';
import { ALTA_FIELDS, ALTA_FIELD_MAP } from '../altaClientesForm.js';
import { moveStage, refreshCustomerStages, hasProspectCols, recomputeProspect, recomputeProspectSafe } from '../prospectAlta.js';

const PAGE = 'pipeline';
const isDir = (req) => req.ctx.perm.role === 'director';
const me = (req) => Number(req.ctx.perm.userId);
const int = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const txt = (v, n = 300) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, n) : null; };
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD = /^\d{4}-\d{2}$/;
function mxToday() { return new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10); }
function parseJ(v) { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return null; } }

let potCols = null;
async function hasPotCols() {
  if (potCols) return true;
  try { potCols = (await query(`SELECT 1 FROM information_schema.columns WHERE table_name='prospects' AND column_name IN ('pot_tier','score') HAVING COUNT(*)=2`)).rows.length > 0; }
  catch (_) { potCols = false; }
  return potCols;
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
  const rows = (await q(`SELECT id, cve_ent, cp, municipio, owner_user_id, stage FROM prospects WHERE ${conds.join(' AND ')}`, params)).rows;
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
    await q(`UPDATE prospects SET owner_user_id=$2, assigned_at=CASE WHEN $2 IS NULL THEN NULL ELSE now() END, updated_at=now() WHERE id=$1`, [p.id, ownerId]);
    await q(`INSERT INTO prospect_assign_history (prospect_id, from_user, to_user, by_user) VALUES ($1,$2,$3,$4)`, [p.id, from, ownerId, byUser]);
    if (ownerId != null) {
      const nx = autoAdvance(p.stage, 'asignado');
      if (nx) await moveStage(q, Number(p.id), p.stage, nx, { userId: byUser, auto: true, reason: 'asignación' });
    } else if (p.stage === 'asignado') {
      await moveStage(q, Number(p.id), p.stage, 'sin_asignar', { userId: byUser, auto: true, reason: 'desasignado' });
    }
    n++;
  }
  return n;
}

export default async function prospectRoutes(app) {
  const view = { preHandler: [authGuard, requirePage(PAGE)] };
  const edit = { preHandler: [authGuard, requirePageEdit(PAGE)] };

  // 0334 전이면 503 — 화면이 「마이그레이션 필요」 안내
  app.addHook('preHandler', async (req, reply) => {
    if (!String(req.url).startsWith('/api/prospect')) return;
    if (!(await hasProspectCols())) return reply.code(503).send({ error: 'migration_0334_required' });
    if (!(await hasPotCols())) return reply.code(503).send({ error: 'migration_0336_required' });
  });

  // ── 메타 ───────────────────────────────────────────────────────────
  // 메타·진척 보드는 로그인한 모든 사용자(디렉터 요청: 진척 표는 누구나 본다). 나머지는 영업활동 권한.
  app.get('/api/prospects/meta', { preHandler: [authGuard] }, async (req) => {
    const canWork = pageAllowed(req.ctx.perm, PAGE, req.ctx.isRegistered);
    const ex = await excludedSet();
    const users = (await query(`SELECT id, name, role FROM users WHERE deleted_at IS NULL ORDER BY name`)).rows
      .map((u) => ({ id: Number(u.id), name: u.name, role: u.role, excluded: ex.has(Number(u.id)) }));
    const states = (await query(
      `SELECT cve_ent, MAX(entidad) AS entidad, COUNT(*)::int AS n FROM prospects WHERE deleted_at IS NULL GROUP BY cve_ent ORDER BY cve_ent`)).rows;
    return { stages: STAGES, segments: SEGMENTS, discard_reasons: DISCARD_REASONS, metrics: METRICS,
      checkin_warn_m: CHECKIN_WARN_M, form: ALTA_FORM, fields: ALTA_FIELDS,
      users: isDir(req) ? users : users.filter((u) => u.id === me(req)),
      staff: (isDir(req) ? users : users.filter((u) => u.id === me(req))).filter((u) => !u.excluded),   // 담당 선택지(디렉터가 뺀 사람 제외)
      potential_tiers: POTENTIAL_TIERS, score_rules: SCORE_RULES, section_weights: SECTION_WEIGHTS, score_bands: SCORE_BANDS,
      can_work: canWork, states,
      me: me(req), is_director: isDir(req), today: mxToday() };
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
    const rows = (await query(
      `SELECT p.id, p.nom_estab AS n, p.lat, p.lng, p.stage AS s, p.segment AS g, p.priority AS pr, p.owner_user_id AS o
         FROM prospects p WHERE ${conds.join(' AND ')} ORDER BY p.priority LIMIT 6000`, params)).rows
      .map((r) => ({ ...r, id: Number(r.id), o: r.o == null ? null : Number(r.o) }));
    return { rows, truncated: rows.length >= 6000 };
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

  // ── 지역 ───────────────────────────────────────────────────────────
  app.get('/api/prospect-territories', view, async () => {
    const rows = (await query(
      `SELECT t.*, u.name AS owner_name,
              (SELECT COUNT(*)::int FROM prospects p WHERE p.territory_id=t.id AND p.deleted_at IS NULL) AS total,
              (SELECT COUNT(*)::int FROM prospects p WHERE p.territory_id=t.id AND p.deleted_at IS NULL AND p.stage NOT IN ('sin_asignar','asignado','descartado')) AS worked
         FROM prospect_territories t LEFT JOIN users u ON u.id=t.owner_user_id ORDER BY t.cve_ent, t.name`)).rows;
    return { rows: rows.map((r) => ({ ...r, id: Number(r.id), owner_user_id: r.owner_user_id == null ? null : Number(r.owner_user_id) })) };
  });
  async function saveTerritory(req, reply, id) {
    if (!directorOnly(req, reply)) return null;
    const b = req.body || {};
    const name = txt(b.name, 120); if (!name) { reply.code(400).send({ error: 'name_required' }); return null; }
    const mun = (Array.isArray(b.municipios) ? b.municipios : []).map((x) => txt(x, 120)).filter(Boolean);
    const cps = (Array.isArray(b.cps) ? b.cps : String(b.cps || '').split(/[\s,;]+/)).map((x) => txt(x, 10)).filter((x) => x && /^\d{5}$/.test(x));
    const owner = int(b.owner_user_id);
    return withTx(async (client) => {
      const q = client.query.bind(client);
      let tid = id;
      if (tid) {
        const old = (await q(`SELECT owner_user_id FROM prospect_territories WHERE id=$1`, [tid])).rows[0];
        if (!old) return { code: 404 };
        await q(`UPDATE prospect_territories SET name=$2, cve_ent=$3, municipios=$4, cps=$5, owner_user_id=$6, active=$7, updated_at=now() WHERE id=$1`,
          [tid, name, txt(b.cve_ent, 4) || '19', mun, cps, owner, b.active !== false]);
        // 지역 경계가 바뀌었을 수 있으니 이 지역 표시를 풀고 다시 판정
        await q(`UPDATE prospects SET territory_id=NULL WHERE territory_id=$1`, [tid]);
        // 담당이 바뀌면 그 지역에서 옛 담당이 들고 있던 「배정」 단계 후보를 새 담당에게(진행 중인 건은 유지)
        if (b.move_owner && old.owner_user_id && owner && Number(old.owner_user_id) !== owner) {
          const ids = (await q(`SELECT id FROM prospects WHERE owner_user_id=$1 AND stage='asignado' AND deleted_at IS NULL`, [old.owner_user_id])).rows.map((r) => Number(r.id));
          if (ids.length) await assignMany(client, ids, null, me(req));
        }
      } else {
        tid = Number((await q(`INSERT INTO prospect_territories (name, cve_ent, municipios, cps, owner_user_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [name, txt(b.cve_ent, 4) || '19', mun, cps, owner, me(req)])).rows[0].id);
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
    if (r.code) return reply.code(r.code).send({ error: 'not_found' });
    return r;
  });

  // ── 목표 ───────────────────────────────────────────────────────────
  app.get('/api/prospect-targets', view, async (req) => {
    const period = PERIOD.test(String(req.query?.period)) ? req.query.period : mxToday().slice(0, 7);
    const params = [period]; let cond = '';
    if (!isDir(req)) { params.push(me(req)); cond = ' AND user_id=$2'; }
    const rows = (await query(`SELECT user_id, metric, target_value FROM prospect_targets WHERE period=$1${cond}`, params)).rows;
    return { period, rows: rows.map((r) => ({ user_id: Number(r.user_id), metric: r.metric, value: Number(r.target_value) })) };
  });
  app.put('/api/prospect-targets', edit, async (req, reply) => {
    if (!directorOnly(req, reply)) return;
    const b = req.body || {};
    if (!PERIOD.test(String(b.period))) return reply.code(400).send({ error: 'bad_period' });
    let n = 0;
    for (const r of (Array.isArray(b.rows) ? b.rows : []).slice(0, 500)) {
      const uid = int(r.user_id); const v = Number(r.value);
      if (!uid || !METRICS.includes(r.metric) || !Number.isFinite(v) || v < 0) continue;
      await query(`INSERT INTO prospect_targets (user_id, period, metric, target_value, updated_by) VALUES ($1,$2,$3,$4,$5)
                   ON CONFLICT (user_id, period, metric) DO UPDATE SET target_value=EXCLUDED.target_value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [uid, b.period, r.metric, v, me(req)]);
      n++;
    }
    return { ok: true, saved: n };
  });

  // ── 루트 ───────────────────────────────────────────────────────────
  async function routeOut(userId, date) {
    const r = (await query(`SELECT id FROM prospect_routes WHERE user_id=$1 AND route_date=$2`, [userId, date])).rows[0];
    if (!r) return { date, user_id: userId, stops: [] };
    const stops = (await query(
      `SELECT s.seq, s.consult_id, p.id, p.score, p.nom_estab, p.address, p.colonia, p.municipio, p.lat, p.lng, p.phone, p.stage, p.priority, p.segment,
              c.review_status, c.created_at AS checkin_at
         FROM prospect_route_stops s JOIN prospects p ON p.id=s.prospect_id
         LEFT JOIN sales_consults c ON c.id=s.consult_id
        WHERE s.route_id=$1 ORDER BY s.seq`, [r.id])).rows;
    return { date, user_id: userId, route_id: Number(r.id),
      stops: stops.map((s) => ({ ...s, id: Number(s.id), consult_id: s.consult_id ? Number(s.consult_id) : null })) };
  }
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
      ps = orderStops(ps, start);
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
    });
    return routeOut(uid, date);
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
  app.get('/api/prospects/progress', { preHandler: [authGuard] }, async (req) => {
    await refreshCustomerStages().catch(() => {});   // ERP 견적·인보이스 반영
    const qs = req.query || {};
    const period = PERIOD.test(String(qs.period)) ? qs.period : mxToday().slice(0, 7);
    const pb = periodBounds(period);
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
        JOIN LATERAL (SELECT MIN(h.created_at) AS t FROM prospect_stage_history h WHERE h.prospect_id=p.id AND ${STAGE_RANK_SQL('h.to_stage')} >= ${stageRank(stage)}) f ON TRUE
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
    return { period, days, summary: sum, bands: SCORE_BANDS.map(([a, b2], i) => ({ from: a, to: b2, n: bands['b' + i] })),
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
    return { rows: rows.map((u) => ({ id: Number(u.id), name: u.name, role: u.role, assigned: u.assigned, excluded: ex.has(Number(u.id)) })) };
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
