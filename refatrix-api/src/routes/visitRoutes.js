// 영업활동 방문·동선 (build 20260715v-visitlog)
// 체크인(현재 위치 + 방문처 + 기록) → 날짜별 동선 조회 → 펜딩 후속조치 → 미등록 방문처의 고객 등록 연결.
// 가시성 규칙(현장재고조사와 동일): 본인 방문만, 디렉터는 전체(+사용자 필터).
// 고객 방문은 customer_meetings에 자동 보존(meeting_id 연결). 미등록 방문처는 link-customer로 소급 연결.
import { query, withTx } from '../db.js';
import { authGuard, requirePage, requirePageEdit } from '../middleware/authGuard.js';
import { visibleTeamIds } from '../teams.js';
import { logEvent } from '../audit.js';
import { mxTodayStr } from '../workingHours.js';

const MEET_PREFIX = '[현장방문]';           // 자동 생성 미팅 가드(수기 미팅 보호)
const PHOTO_MAX = 10;                        // 방문당 사진 최대
const PHOTO_BYTES = 8 * 1024 * 1024;         // 장당 8MB(base64 문자열 길이 기준)

// YYYY-MM-DD ± days
function shiftYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
function daysBetween(aYmd, bYmd) {           // a - b (일수)
  if (!aYmd || !bYmd) return 0;
  const [ay, am, ad] = String(aYmd).split('-').map(Number);
  const [by, bm, bd] = String(bYmd).split('-').map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
}

export default async function visitRoutes(app) {
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const str = (v) => (v == null ? null : String(v).trim() || null);

  // 방문 미팅 노트 조립: [현장방문] / 만남 / 대화 / 새로배운·파악 / 펜딩
  function buildMeetNote(v, pendings) {
    const lines = [MEET_PREFIX];
    if (v.met_person) lines.push('만남: ' + v.met_person);
    if (v.talk_note) lines.push('대화: ' + v.talk_note);
    if (v.insight_note) lines.push('새로배운/파악: ' + v.insight_note);
    if (pendings && pendings.length) lines.push('펜딩: ' + pendings.map((p) => p.content).filter(Boolean).join(' · '));
    return lines.join('\n');
  }

  // 본인 한정 조건(디렉터는 전체 + user_id 필터)
  function ownerCond(perm, params, alias = 'v') {
    if (perm.role === 'director') return null;                 // 전체 허용(핸들러에서 user 필터 별도)
    params.push(perm.userId);
    return `${alias}.created_by = $${params.length}`;
  }

  // ── 체크인용 고객 옵션(pipeline 권한 범위) ──
  app.get('/api/visits/customer-options', { preHandler: [authGuard, requirePage('pipeline')] }, async (req) => {
    const vis = visibleTeamIds(req.ctx.perm);
    const q = String(req.query.q || '').trim();
    const params = []; const conds = ['c.deleted_at IS NULL'];
    if (vis !== null) {
      if (!vis.length) return { items: [] };
      params.push(vis); conds.push(`c.team_id = ANY($${params.length})`);
    }
    if (q) { params.push(`%${q}%`); conds.push(`(c.name ILIKE $${params.length} OR c.code ILIKE $${params.length})`); }
    const rows = (await query(
      `SELECT c.id, c.code, c.name, s.name AS stage_name, t.name AS team_name
         FROM customers c
         LEFT JOIN stages s ON s.id = c.stage_id
         LEFT JOIN sales_teams t ON t.id = c.team_id
        WHERE ${conds.join(' AND ')} ORDER BY c.name LIMIT 1000`, params)).rows;
    return { items: rows.map((r) => ({ id: Number(r.id), code: r.code, name: r.name, stage_name: r.stage_name, team_name: r.team_name })) };
  });

  // ── 방문 날짜 칩(최근 30일, 날짜별 건수) + 서버 오늘(MX) ──
  app.get('/api/visits/dates', { preHandler: [authGuard, requirePage('pipeline')] }, async (req) => {
    const perm = req.ctx.perm;
    const mxToday = mxTodayStr(new Date());
    const from = shiftYmd(mxToday, -30);
    const params = [from]; const conds = ['v.deleted_at IS NULL', `v.visit_date >= $1`];
    const oc = ownerCond(perm, params); if (oc) conds.push(oc);
    if (perm.role === 'director' && req.query.user_id) { params.push(Number(req.query.user_id)); conds.push(`v.created_by = $${params.length}`); }
    const rows = (await query(
      `SELECT v.visit_date AS d, COUNT(*) AS cnt
         FROM sales_visits v WHERE ${conds.join(' AND ')}
        GROUP BY v.visit_date ORDER BY v.visit_date DESC`, params)).rows;
    return { mx_today: mxToday, items: rows.map((r) => ({ d: r.d, cnt: Number(r.cnt) })) };
  });

  // ── 선택 날짜들의 방문(동선) — 펜딩 + 사진메타 포함 ──
  app.get('/api/visits', { preHandler: [authGuard, requirePage('pipeline')] }, async (req) => {
    const perm = req.ctx.perm;
    const dates = String(req.query.dates || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 40);
    if (!dates.length) return { items: [] };
    const params = [dates]; const conds = ['v.deleted_at IS NULL', `v.visit_date = ANY($1)`];
    const oc = ownerCond(perm, params); if (oc) conds.push(oc);
    if (perm.role === 'director' && req.query.user_id) { params.push(Number(req.query.user_id)); conds.push(`v.created_by = $${params.length}`); }
    const rows = (await query(
      `SELECT v.id, v.visit_date, v.visited_at, v.customer_id, v.place_name,
              v.geo_lat, v.geo_lng, v.geo_accuracy, v.met_person, v.talk_note, v.insight_note,
              v.created_by, u.name AS by_name, c.code AS cust_code,
              (SELECT COUNT(*) FROM sales_visit_photos ph WHERE ph.visit_id = v.id) AS photo_cnt
         FROM sales_visits v
         LEFT JOIN users u ON u.id = v.created_by
         LEFT JOIN customers c ON c.id = v.customer_id
        WHERE ${conds.join(' AND ')}
        ORDER BY v.visit_date ASC, v.visited_at ASC`, params)).rows;
    const ids = rows.map((r) => Number(r.id));
    let pendByVisit = {};
    if (ids.length) {
      const pend = (await query(
        `SELECT id, visit_id, content, due_date, done FROM sales_visit_pendings
          WHERE visit_id = ANY($1) ORDER BY id`, [ids])).rows;
      pend.forEach((p) => { (pendByVisit[p.visit_id] ||= []).push({ id: Number(p.id), content: p.content, due_date: p.due_date, done: !!p.done }); });
    }
    return {
      items: rows.map((r) => ({
        id: Number(r.id), visit_date: r.visit_date, visited_at: r.visited_at,
        customer_id: r.customer_id != null ? Number(r.customer_id) : null,
        cust_code: r.cust_code || null, place_name: r.place_name,
        geo_lat: Number(r.geo_lat), geo_lng: Number(r.geo_lng),
        geo_accuracy: r.geo_accuracy != null ? Number(r.geo_accuracy) : null,
        met_person: r.met_person, talk_note: r.talk_note, insight_note: r.insight_note,
        created_by: Number(r.created_by), by_name: r.by_name,
        photo_cnt: Number(r.photo_cnt), pendings: pendByVisit[r.id] || [],
      })),
    };
  });

  // ── 방문 체크인 ──
  app.post('/api/visits', { preHandler: [authGuard, requirePageEdit('pipeline')] }, async (req, reply) => {
    const perm = req.ctx.perm; const b = req.body || {};
    const lat = num(b.geo_lat), lng = num(b.geo_lng);
    if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) {
      return reply.code(400).send({ error: 'location_required' });
    }
    const custId = b.customer_id ? Number(b.customer_id) : null;
    let placeName = str(b.place_name);
    let canMeet = false, custName = null;
    if (custId) {
      const vis = visibleTeamIds(perm); const cp = [custId]; let cc = 'id = $1 AND deleted_at IS NULL';
      if (vis !== null) { if (!vis.length) return reply.code(403).send({ error: 'forbidden_team' }); cp.push(vis); cc += ` AND team_id = ANY($2)`; }
      const c = (await query(`SELECT name FROM customers WHERE ${cc}`, cp)).rows[0];
      if (!c) return reply.code(403).send({ error: 'forbidden_team' });
      custName = c.name; placeName = c.name; canMeet = true;             // 편집권 있는 고객만 미팅 자동보존
    }
    if (!placeName) return reply.code(400).send({ error: 'place_required' });

    const pendings = Array.isArray(b.pendings) ? b.pendings
      .map((p) => ({ content: str(p.content), due_date: str(p.due_date) }))
      .filter((p) => p.content) : [];
    const photos = Array.isArray(b.photos) ? b.photos.slice(0, PHOTO_MAX) : [];

    const mxToday = mxTodayStr(new Date());
    const meetNote = buildMeetNote(b, pendings);

    const result = await withTx(async (client) => {
      const q = client.query.bind(client);
      let meetingId = null;
      if (canMeet && custId) {
        meetingId = (await q(
          `INSERT INTO customer_meetings (customer_id, meeting_date, note, created_by)
           VALUES ($1,$2,$3,$4) RETURNING id`, [custId, mxToday, meetNote, perm.userId])).rows[0].id;
      }
      const v = (await q(
        `INSERT INTO sales_visits
           (visit_date, customer_id, place_name, geo_lat, geo_lng, geo_accuracy,
            met_person, talk_note, insight_note, meeting_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [mxToday, custId, placeName, lat, lng, num(b.geo_accuracy),
         str(b.met_person), str(b.talk_note), str(b.insight_note), meetingId, perm.userId])).rows[0];
      const visitId = Number(v.id);
      for (const p of pendings) {
        await q(`INSERT INTO sales_visit_pendings (visit_id, content, due_date) VALUES ($1,$2,$3)`,
          [visitId, p.content, p.due_date]);
      }
      let phOk = 0, phFail = 0;
      for (const ph of photos) {
        const durl = String(ph.data_url || '');
        if (!durl.startsWith('data:image/') || durl.length > PHOTO_BYTES) { phFail++; continue; }
        const kind = ['card', 'store', 'other'].includes(ph.kind) ? ph.kind : 'other';
        await q(`INSERT INTO sales_visit_photos (visit_id, kind, file_name, mime, size_bytes, data_url, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [visitId, kind, str(ph.file_name), str(ph.mime), num(ph.size_bytes), durl, perm.userId]);
        phOk++;
      }
      return { visitId, meetingId, phOk, phFail };
    });

    await logEvent({ userId: perm.userId, action: 'visit_checkin', target: `visit:${result.visitId}`,
      detail: { place: placeName, customer_id: custId, pendings: pendings.length, photos: result.phOk } });
    return {
      id: result.visitId, meeting_id: result.meetingId, meeting_saved: !!result.meetingId,
      place_name: placeName, pendings, photo_ok: result.phOk, photo_fail: result.phFail,
    };
  });

  // ── 방문 사진(지연 로드) ──
  app.get('/api/visits/:id/photos', { preHandler: [authGuard, requirePage('pipeline')] }, async (req, reply) => {
    const perm = req.ctx.perm; const id = Number(req.params.id);
    const params = [id]; let cond = 'v.id = $1 AND v.deleted_at IS NULL';
    const oc = ownerCond(perm, params); if (oc) cond += ' AND ' + oc;
    const own = (await query(`SELECT 1 FROM sales_visits v WHERE ${cond}`, params)).rows[0];
    if (!own) return reply.code(404).send({ error: 'not_found' });
    const rows = (await query(
      `SELECT id, kind, file_name, mime, data_url FROM sales_visit_photos WHERE visit_id = $1 ORDER BY id`, [id])).rows;
    return { items: rows.map((r) => ({ id: Number(r.id), kind: r.kind, file_name: r.file_name, mime: r.mime, data_url: r.data_url })) };
  });

  // ── 방문 삭제(자동 생성 미팅 가드 삭제) ──
  app.delete('/api/visits/:id', { preHandler: [authGuard, requirePageEdit('pipeline')] }, async (req, reply) => {
    const perm = req.ctx.perm; const id = Number(req.params.id);
    const params = [id]; let cond = 'id = $1 AND deleted_at IS NULL';
    const oc = ownerCond(perm, params); if (oc) cond += ' AND ' + oc;
    const v = (await query(`SELECT id, meeting_id FROM sales_visits WHERE ${cond}`, params)).rows[0];
    if (!v) return reply.code(404).send({ error: 'not_found' });
    await withTx(async (client) => {
      const q = client.query.bind(client);
      await q(`UPDATE sales_visits SET deleted_at = now() WHERE id = $1`, [id]);
      if (v.meeting_id) {                                            // 자동 생성분만(프리픽스 가드)
        await q(`DELETE FROM customer_meetings WHERE id = $1 AND note LIKE $2`, [v.meeting_id, MEET_PREFIX + '%']);
      }
    });
    await logEvent({ userId: perm.userId, action: 'visit_delete', target: `visit:${id}` });
    return { ok: true };
  });

  // ── 펜딩(후속조치) 통합 목록 ──
  app.get('/api/visits/pendings', { preHandler: [authGuard, requirePage('pipeline')] }, async (req) => {
    const perm = req.ctx.perm; const mxToday = mxTodayStr(new Date());
    const params = []; const conds = ['v.deleted_at IS NULL'];
    const oc = ownerCond(perm, params); if (oc) conds.push(oc);
    if (perm.role === 'director' && req.query.user_id) { params.push(Number(req.query.user_id)); conds.push(`v.created_by = $${params.length}`); }
    const showDone = String(req.query.done) === '1';
    if (!showDone) conds.push('p.done = FALSE');
    const rows = (await query(
      `SELECT p.id, p.content, p.due_date, p.done, v.id AS visit_id, v.visit_date, v.place_name,
              v.customer_id, u.name AS by_name
         FROM sales_visit_pendings p
         JOIN sales_visits v ON v.id = p.visit_id
         LEFT JOIN users u ON u.id = v.created_by
        WHERE ${conds.join(' AND ')}
        ORDER BY p.done ASC, (p.due_date IS NULL) ASC, p.due_date ASC, p.id ASC`, params)).rows;
    return {
      mx_today: mxToday,
      items: rows.map((r) => ({
        id: Number(r.id), content: r.content, due_date: r.due_date, done: !!r.done,
        visit_id: Number(r.visit_id), visit_date: r.visit_date, place_name: r.place_name,
        customer_id: r.customer_id != null ? Number(r.customer_id) : null, by_name: r.by_name,
        overdue: (!r.done && r.due_date && daysBetween(mxToday, r.due_date) > 0) ? daysBetween(mxToday, r.due_date) : 0,
      })),
    };
  });

  // ── 펜딩 완료 토글 ──
  app.patch('/api/visits/pendings/:id', { preHandler: [authGuard, requirePageEdit('pipeline')] }, async (req, reply) => {
    const perm = req.ctx.perm; const id = Number(req.params.id);
    const done = !!(req.body || {}).done;
    // 소유 확인(본인 방문의 펜딩만, 디렉터는 전체)
    const params = [id]; let cond = 'p.id = $1';
    const oc = ownerCond(perm, params, 'v'); if (oc) cond += ' AND ' + oc;
    const row = (await query(
      `SELECT p.id FROM sales_visit_pendings p JOIN sales_visits v ON v.id = p.visit_id
        WHERE ${cond} AND v.deleted_at IS NULL`, params)).rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    await query(
      `UPDATE sales_visit_pendings SET done = $2, done_at = CASE WHEN $2 THEN now() ELSE NULL END,
              done_by = CASE WHEN $2 THEN $3 ELSE NULL END WHERE id = $1`, [id, done, perm.userId]);
    return { ok: true, done };
  });

  // ── 미등록 방문처 목록(고객 등록 대상) ──
  app.get('/api/visits/places', { preHandler: [authGuard, requirePage('pipeline')] }, async (req) => {
    const perm = req.ctx.perm;
    const params = []; const conds = ['v.deleted_at IS NULL', 'v.customer_id IS NULL'];
    const oc = ownerCond(perm, params); if (oc) conds.push(oc);
    if (perm.role === 'director' && req.query.user_id) { params.push(Number(req.query.user_id)); conds.push(`v.created_by = $${params.length}`); }
    const rows = (await query(
      `SELECT v.place_name, COUNT(*) AS cnt, MAX(v.visit_date) AS last_date
         FROM sales_visits v WHERE ${conds.join(' AND ')}
        GROUP BY v.place_name ORDER BY MAX(v.visit_date) DESC`, params)).rows;
    return { items: rows.map((r) => ({ place_name: r.place_name, cnt: Number(r.cnt), last_date: r.last_date })) };
  });

  // ── 미등록 방문처 → 기존/신규 고객 연결(방문 전건 소급 + 미팅기록 생성) ──
  //   body: { place_name, customer_id }  (신규 고객은 프런트가 먼저 POST /api/customers 로 만든 뒤 여기로 연결)
  app.post('/api/visits/link-customer', { preHandler: [authGuard, requirePageEdit('pipeline')] }, async (req, reply) => {
    const perm = req.ctx.perm; const b = req.body || {};
    const placeName = str(b.place_name); const custId = b.customer_id ? Number(b.customer_id) : null;
    if (!placeName || !custId) return reply.code(400).send({ error: 'bad_request' });
    // 대상 고객 접근권 확인
    const vis = visibleTeamIds(perm); const cp = [custId]; let cc = 'id = $1 AND deleted_at IS NULL';
    if (vis !== null) { if (!vis.length) return reply.code(403).send({ error: 'forbidden_team' }); cp.push(vis); cc += ` AND team_id = ANY($2)`; }
    const c = (await query(`SELECT name FROM customers WHERE ${cc}`, cp)).rows[0];
    if (!c) return reply.code(403).send({ error: 'forbidden_team' });

    // 연결 대상 방문(본인분; 디렉터는 동명 방문처 전원분)
    const vp = [placeName]; let vcond = 'place_name = $1 AND customer_id IS NULL AND deleted_at IS NULL';
    if (perm.role !== 'director') { vp.push(perm.userId); vcond += ` AND created_by = $2`; }

    const linked = await withTx(async (client) => {
      const q = client.query.bind(client);
      const visits = (await q(
        `SELECT id, visit_date, met_person, talk_note, insight_note, created_by FROM sales_visits WHERE ${vcond}`, vp)).rows;
      let n = 0;
      for (const v of visits) {
        const pend = (await q(`SELECT content FROM sales_visit_pendings WHERE visit_id = $1 ORDER BY id`, [v.id])).rows;
        const note = buildMeetNote(v, pend);
        const meetingId = (await q(
          `INSERT INTO customer_meetings (customer_id, meeting_date, note, created_by)
           VALUES ($1,$2,$3,$4) RETURNING id`, [custId, v.visit_date, note, v.created_by])).rows[0].id;
        await q(`UPDATE sales_visits SET customer_id = $1, place_name = $2, meeting_id = $3 WHERE id = $4`,
          [custId, c.name, meetingId, v.id]);
        n++;
      }
      return n;
    });
    await logEvent({ userId: perm.userId, action: 'visit_link_customer', target: `customer:${custId}`,
      detail: { place: placeName, visits: linked } });
    return { ok: true, linked, customer_name: c.name };
  });
}
