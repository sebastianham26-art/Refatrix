// =====================================================================
// Refatrix ERP · exhibitionRoutes.js — 「영업 > 고객상담 > 🎪 전시회」 (디렉터 요청 2026-08-26)
//
//   RUJAC 같은 전시회의 3일치 미팅을 시간표(day × 1시간 슬롯)로 운영한다.
//   ① 전시회 마스터  : 이름·장소·시작일·일수·시간대. is_active 한 건이 화면 기본값.
//   ② 미팅 계획      : 칸(day_no × slot_hour)에 고객·담당자·정량목표(견적/수주)·정성목표를 건다.
//   ③ 즉석 미팅      : 계획 없이 진행된 미팅은 그 시간 칸을 눌러 is_walkin=TRUE 로 바로 기록.
//   ④ 미팅 기록      : /consult 로 sales_consults 1건을 만들어 연결 → 기존 녹음·AI요약 파이프라인 재사용.
//   ⑤ 정성목표 판단  : /evaluate 가 녹음 요약·전사문을 근거로 달성/부분/미달을 판단(한국어).
//
//   ── 가시성 ──
//   전시회 시간표는 팀 공용이다("한눈에 보기"가 목적). pipeline 권한이 있으면 전원 같은 보드를 본다.
//   단, 연결된 상담을 디렉터가 🔒 감춘 경우 그 요약·전사문은 감춘 사람에게만 보인다(고객상담 규칙 준수).
//
//   ── 환경변수 ── 새로 추가할 것 없음(ANTHROPIC_API_KEY 재사용).
//   ※ 고객상담(sales_consults) · 방문(sales_visits) 경로는 한 줄도 바꾸지 않는다.
// =====================================================================
import { query } from '../db.js';
import { authGuard, requirePage, requirePageEdit } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { mxTodayStr, MX_OFFSET_MIN } from '../workingHours.js';
import { consultAiApi, aiReady } from './consultRoutes.js';
import {
  clip, num, dayAxis, hourAxis, ownerColorMap, meetingTotals, ownerTotals,
  buildQualEvalPrompt, parseQualEvalJson, summaryToText, normQual, normKind,
  OWNER_UNSET, BOOTH_COLOR,
} from '../exhibitionAi.js';

const PAGE = 'pipeline';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MEET_MAX = 600;                 // 전시회 1건의 미팅 상한(방어)
const STATUSES = ['planned', 'done', 'cancelled', 'noshow'];

function d10(v) { if (!v) return null; if (v instanceof Date) return v.toISOString().slice(0, 10); return String(v).slice(0, 10); }
function txt(v, n) { const s = clip(v, n); return s || null; }
function intIn(v, lo, hi) { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; }
function idOf(v) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; }
function money(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}
export function shiftYmd(ymd, days) {
  const p = String(ymd).split('-').map(Number);
  const t = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  t.setUTCDate(t.getUTCDate() + Number(days || 0));
  return t.toISOString().slice(0, 10);
}

// 멕시코 현지 시각(UTC-6) — "지금 이 시간 칸" 강조용
export function mxNowParts(nowUtc = new Date()) {
  const t = new Date(nowUtc.getTime() + MX_OFFSET_MIN * 60000);
  return { date: t.toISOString().slice(0, 10), hour: t.getUTCHours(), minute: t.getUTCMinutes() };
}

// ── 담당자 후보(색상 배정 기준이 되는 고정 집합) ─────────────────────
export async function ownerOptions() {
  const rows = (await query(
    `SELECT id, name, login_id, role FROM users
      WHERE deleted_at IS NULL AND COALESCE(role,'') <> 'viewer'
      ORDER BY name ASC, id ASC`)).rows;
  return rows.map((r) => ({ id: Number(r.id), name: r.name, login_id: r.login_id, role: r.role }));
}

// ── 전시회 1건 ───────────────────────────────────────────────────────
export async function getExhibition(idOrActive) {
  if (String(idOrActive) === 'active') {
    const a = (await query(
      `SELECT * FROM exhibitions WHERE deleted_at IS NULL AND is_active = TRUE
        ORDER BY start_date DESC, id DESC LIMIT 1`)).rows[0];
    if (a) return a;
    return (await query(
      `SELECT * FROM exhibitions WHERE deleted_at IS NULL ORDER BY start_date DESC, id DESC LIMIT 1`)).rows[0] || null;
  }
  const id = idOf(idOrActive);
  if (!id) return null;
  return (await query(`SELECT * FROM exhibitions WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0] || null;
}

function expoOut(e) {
  return {
    id: Number(e.id), name: e.name, venue: e.venue || null,
    start_date: d10(e.start_date), day_count: Number(e.day_count),
    start_hour: Number(e.start_hour), end_hour: Number(e.end_hour),
    currency: e.currency || 'MXN', is_active: !!e.is_active, note: e.note || null,
    created_by: Number(e.created_by),
  };
}

// ── 보드(시간표) 조립 ────────────────────────────────────────────────
export async function buildBoard(perm, e) {
  const exhibition = expoOut(e);
  const days = dayAxis(exhibition.start_date, exhibition.day_count);
  const hours = hourAxis(exhibition.start_hour, exhibition.end_hour);

  const rows = (await query(
    `SELECT m.*, u.name AS owner_name, u.login_id AS owner_login,
            c.private_by AS consult_private_by
       FROM exhibition_meetings m
       LEFT JOIN users u ON u.id = m.owner_user_id
       LEFT JOIN sales_consults c ON c.id = m.consult_id
      WHERE m.exhibition_id = $1 AND m.deleted_at IS NULL
      ORDER BY m.day_no ASC, m.slot_hour ASC, m.id ASC
      LIMIT ${MEET_MAX}`, [exhibition.id])).rows;

  // 연결된 상담의 녹음 상태·요약(감춘 상담은 감춘 사람에게만)
  const consultIds = rows.map((r) => idOf(r.consult_id)).filter(Boolean);
  const recByConsult = {};
  if (consultIds.length) {
    const recs = (await query(
      `SELECT consult_id, id, status, duration_sec, summary_json FROM sales_consult_recordings
        WHERE consult_id = ANY($1) ORDER BY id ASC`, [consultIds])).rows;
    for (const r of recs) {
      const cid = Number(r.consult_id);
      const cur = recByConsult[cid] || {};
      cur.rec_status = r.status;
      cur.duration_sec = r.duration_sec != null ? Number(r.duration_sec) : cur.duration_sec;
      if (r.status === 'done' && r.summary_json) {
        cur.rec_id = Number(r.id);
        try { cur.summary = typeof r.summary_json === 'string' ? JSON.parse(r.summary_json) : r.summary_json; } catch (_) {}
      }
      recByConsult[cid] = cur;
    }
  }

  const me = Number(perm.userId);
  const meetings = rows.map((r) => {
    const cid = idOf(r.consult_id);
    const hidden = r.consult_private_by != null && Number(r.consult_private_by) !== me;
    const rec = (!hidden && cid && recByConsult[cid]) ? recByConsult[cid] : {};
    let qe = null;
    if (r.qual_eval_json) { try { qe = typeof r.qual_eval_json === 'string' ? JSON.parse(r.qual_eval_json) : r.qual_eval_json; } catch (_) {} }
    return {
      id: Number(r.id),
      day_no: Number(r.day_no), slot_hour: Number(r.slot_hour),
      meet_date: d10(r.meet_date) || (days[Number(r.day_no) - 1] || {}).date || null,
      owner_user_id: r.owner_user_id != null ? Number(r.owner_user_id) : null,
      owner_name: r.owner_name || null, owner_login: r.owner_login || null,
      customer_id: r.customer_id != null ? Number(r.customer_id) : null,
      company_name: r.company_name, contact_name: r.contact_name || null,
      wa_phone: r.wa_phone || null, email: r.email || null,
      goal_note: r.goal_note || null, memo: r.memo || null,
      target_quote: num(r.target_quote), target_order: num(r.target_order),
      actual_quote: r.actual_quote == null ? null : num(r.actual_quote),
      actual_order: r.actual_order == null ? null : num(r.actual_order),
      kind: normKind(r.kind),
      status: r.status, is_walkin: !!r.is_walkin,
      is_confirmed: !!r.is_confirmed, confirmed_at: r.confirmed_at || null,
      consult_id: cid, consult_hidden: hidden,
      rec_status: rec.rec_status || null, rec_id: rec.rec_id || null,
      duration_sec: rec.duration_sec != null ? rec.duration_sec : null,
      has_ai: !!rec.summary, summary: rec.summary || null,
      qual_result: r.qual_result || null, qual_eval: r.qual_eval || null,
      qual_eval_json: qe, qual_eval_at: r.qual_eval_at || null,
      created_by: Number(r.created_by),
    };
  });

  const owners = await ownerOptions();
  const cmap = ownerColorMap(owners.map((o) => o.id));
  const ownersOut = owners.map((o) => {
    const c = cmap[o.id] || {};
    return { ...o, bg: c.bg || OWNER_UNSET[0], fg: c.fg || OWNER_UNSET[1], border: c.border || OWNER_UNSET[2] };
  });

  const nowP = mxNowParts(new Date());
  const dayIdx = days.findIndex((d) => d.date === nowP.date);
  const now = dayIdx >= 0 ? { day_no: dayIdx + 1, hour: nowP.hour, date: nowP.date } : { day_no: null, hour: nowP.hour, date: nowP.date };

  return {
    exhibition, days, hours, owners: ownersOut, meetings,
    totals: meetingTotals(meetings), owner_totals: ownerTotals(meetings),
    unset_color: { bg: OWNER_UNSET[0], fg: OWNER_UNSET[1], border: OWNER_UNSET[2] },
    booth_color: { bg: BOOTH_COLOR[0], fg: BOOTH_COLOR[1], border: BOOTH_COLOR[2] },
    mx_today: mxTodayStr(new Date()), now,
    is_director: perm.role === 'director', me,
    ai_ready: aiReady(),
  };
}

// ── 미팅 1건 조회(전시회 정보 포함) ──────────────────────────────────
async function getMeeting(mid) {
  const id = idOf(mid);
  if (!id) return null;
  return (await query(
    `SELECT m.*, e.name AS expo_name, e.venue, e.currency, e.start_date, e.day_count, e.deleted_at AS expo_deleted
       FROM exhibition_meetings m JOIN exhibitions e ON e.id = m.exhibition_id
      WHERE m.id = $1 AND m.deleted_at IS NULL`, [id])).rows[0] || null;
}

// =====================================================================
// 라우트
// =====================================================================
export default async function exhibitionRoutes(app) {
  // ── 담당자 후보(색상 포함) — 전원 조회 가능 ──
  app.get('/api/exhibitions/owner-options', { preHandler: [authGuard, requirePage(PAGE)] }, async () => {
    const owners = await ownerOptions();
    const cmap = ownerColorMap(owners.map((o) => o.id));
    return {
      items: owners.map((o) => {
        const c = cmap[o.id] || {};
        return { ...o, bg: c.bg || OWNER_UNSET[0], fg: c.fg || OWNER_UNSET[1], border: c.border || OWNER_UNSET[2] };
      }),
    };
  });

  // ── 전시회 목록 ──
  app.get('/api/exhibitions', { preHandler: [authGuard, requirePage(PAGE)] }, async () => {
    const rows = (await query(
      `SELECT * FROM exhibitions WHERE deleted_at IS NULL ORDER BY is_active DESC, start_date DESC, id DESC LIMIT 200`)).rows;
    const items = rows.map(expoOut);
    const active = items.find((x) => x.is_active) || items[0] || null;
    return { items, active_id: active ? active.id : null };
  });

  // ── 전시회 등록(디렉터 전용 — 팀 공용 시간표라서) ──
  app.post('/api/exhibitions', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const perm = req.ctx.perm;
    if (perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const b = req.body || {};
    const name = txt(b.name, 120);
    if (!name) return reply.code(400).send({ error: 'name_required' });
    if (!DATE_RE.test(String(b.start_date))) return reply.code(400).send({ error: 'bad_date' });
    const dayCount = intIn(b.day_count, 1, 10) || 3;
    const sh = intIn(b.start_hour, 0, 23); const eh = intIn(b.end_hour, 1, 24);
    const startHour = sh == null ? 8 : sh;
    const endHour = eh == null ? 18 : eh;
    if (endHour <= startHour) return reply.code(400).send({ error: 'bad_hours' });
    const active = b.is_active === undefined ? true : !!b.is_active;
    if (active) await query(`UPDATE exhibitions SET is_active = FALSE WHERE is_active = TRUE`);
    const r = (await query(
      `INSERT INTO exhibitions (name, venue, start_date, day_count, start_hour, end_hour, currency, is_active, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [name, txt(b.venue, 200), String(b.start_date), dayCount, startHour, endHour,
        txt(b.currency, 8) || 'MXN', active, txt(b.note, 2000), perm.userId])).rows[0];
    await logEvent({ userId: perm.userId, action: 'create', target: `exhibition:${r.id}`, detail: { name, start: String(b.start_date), dayCount } });
    return { id: Number(r.id) };
  });

  // ── 전시회 수정 ──
  app.patch('/api/exhibitions/:id', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const perm = req.ctx.perm;
    if (perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const e = await getExhibition(req.params.id);
    if (!e) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {};
    const sets = []; const params = [Number(e.id)];
    const put = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (b.name !== undefined) { const v = txt(b.name, 120); if (!v) return reply.code(400).send({ error: 'name_required' }); put('name', v); }
    if (b.venue !== undefined) put('venue', txt(b.venue, 200));
    if (b.note !== undefined) put('note', txt(b.note, 2000));
    if (b.currency !== undefined) put('currency', txt(b.currency, 8) || 'MXN');
    if (b.start_date !== undefined) {
      if (!DATE_RE.test(String(b.start_date))) return reply.code(400).send({ error: 'bad_date' });
      put('start_date', String(b.start_date));
    }
    if (b.day_count !== undefined) { const v = intIn(b.day_count, 1, 10); if (!v) return reply.code(400).send({ error: 'bad_days' }); put('day_count', v); }
    const nsh = b.start_hour !== undefined ? intIn(b.start_hour, 0, 23) : Number(e.start_hour);
    const neh = b.end_hour !== undefined ? intIn(b.end_hour, 1, 24) : Number(e.end_hour);
    if (nsh == null || neh == null || neh <= nsh) return reply.code(400).send({ error: 'bad_hours' });
    if (b.start_hour !== undefined) put('start_hour', nsh);
    if (b.end_hour !== undefined) put('end_hour', neh);
    if (b.is_active !== undefined) {
      if (b.is_active) await query(`UPDATE exhibitions SET is_active = FALSE WHERE is_active = TRUE AND id <> $1`, [Number(e.id)]);
      put('is_active', !!b.is_active);
    }
    if (!sets.length) return { ok: true, id: Number(e.id), unchanged: true };
    sets.push('updated_at = now()');
    await query(`UPDATE exhibitions SET ${sets.join(', ')} WHERE id = $1`, params);
    // 시작일이 바뀌면 미팅의 날짜 스냅샷도 따라간다
    if (b.start_date !== undefined) {
      const ms = (await query(`SELECT id, day_no FROM exhibition_meetings WHERE exhibition_id=$1 AND deleted_at IS NULL`, [Number(e.id)])).rows;
      for (const m of ms) {
        await query(`UPDATE exhibition_meetings SET meet_date=$2 WHERE id=$1`,
          [Number(m.id), shiftYmd(String(b.start_date), Number(m.day_no) - 1)]);
      }
    }
    await logEvent({ userId: perm.userId, action: 'update', target: `exhibition:${e.id}` });
    return { ok: true, id: Number(e.id) };
  });

  // ── 전시회 삭제(소프트) ──
  app.delete('/api/exhibitions/:id', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const perm = req.ctx.perm;
    if (perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const e = await getExhibition(req.params.id);
    if (!e) return reply.code(404).send({ error: 'not_found' });
    await query(`UPDATE exhibitions SET deleted_at = now(), is_active = FALSE WHERE id = $1`, [Number(e.id)]);
    await logEvent({ userId: perm.userId, action: 'delete', target: `exhibition:${e.id}` });
    return { ok: true, id: Number(e.id) };
  });

  // ── 보드(시간표) ── :id 에 'active' 를 주면 진행 중인 전시회 ──
  app.get('/api/exhibitions/:id/board', { preHandler: [authGuard, requirePage(PAGE)] }, async (req, reply) => {
    const e = await getExhibition(req.params.id);
    if (!e) return reply.code(404).send({ error: 'no_exhibition' });
    return buildBoard(req.ctx.perm, e);
  });

  // ── 미팅 등록(계획 또는 즉석) ──
  app.post('/api/exhibitions/:id/meetings', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const e = await getExhibition(req.params.id);
    if (!e) return reply.code(404).send({ error: 'no_exhibition' });
    const b = req.body || {};
    const company = txt(b.company_name, 200);
    if (!company) return reply.code(400).send({ error: 'company_required' });
    const dayNo = intIn(b.day_no, 1, Number(e.day_count));
    if (!dayNo) return reply.code(400).send({ error: 'bad_day' });
    const hour = intIn(b.slot_hour, Number(e.start_hour), Number(e.end_hour) - 1);
    if (hour == null) return reply.code(400).send({ error: 'bad_hour' });
    const status = STATUSES.includes(b.status) ? b.status : (b.is_walkin ? 'done' : 'planned');
    const kind = normKind(b.kind);
    // 부스 직접 방문은 「고객이 확정한 약속」이라는 개념이 없다.
    const confirmed = kind === 'meeting' && !!b.is_confirmed;
    const confAt = confirmed ? new Date().toISOString() : null;
    const confBy = confirmed ? Number(perm.userId) : null;
    let r;
    try {
      r = (await query(
        `INSERT INTO exhibition_meetings
           (exhibition_id, day_no, slot_hour, meet_date, owner_user_id, customer_id, company_name,
            contact_name, wa_phone, email, goal_note, target_quote, target_order, memo, status, is_walkin,
            kind, is_confirmed, confirmed_at, confirmed_by, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
        [Number(e.id), dayNo, hour, shiftYmd(d10(e.start_date), dayNo - 1),
          idOf(b.owner_user_id) || Number(perm.userId), idOf(b.customer_id), company,
          txt(b.contact_name, 200), txt(b.wa_phone, 40), txt(b.email, 200), txt(b.goal_note, 2000),
          money(b.target_quote) || 0, money(b.target_order) || 0, txt(b.memo, 4000),
          status, !!b.is_walkin, kind, confirmed, confAt, confBy, perm.userId])).rows[0];
    } catch (err) {
      // 0186 마이그레이션 전이면 컬럼이 없다 — 500 대신 무엇을 해야 하는지 알려준다
      if (err && (err.code === '42703' || err.code === '42P01')) {
        return reply.code(503).send({ error: 'migration_required', migration: '0186' });
      }
      throw err;
    }
    await logEvent({ userId: perm.userId, action: 'create', target: `expo_meeting:${r.id}`,
      detail: { exhibition_id: Number(e.id), day_no: dayNo, slot_hour: hour, company, kind, walkin: !!b.is_walkin } });
    return { id: Number(r.id), day_no: dayNo, slot_hour: hour, company_name: company, kind };
  });

  // ── 미팅 수정(칸 이동 · 목표 · 달성 · 간단 내용 · 상태) ──
  app.patch('/api/exhibitions/meetings/:mid', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const m = await getMeeting(req.params.mid);
    if (!m || m.expo_deleted) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {};
    const sets = []; const params = [Number(m.id)];
    const put = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (b.company_name !== undefined) { const v = txt(b.company_name, 200); if (!v) return reply.code(400).send({ error: 'company_required' }); put('company_name', v); }
    if (b.contact_name !== undefined) put('contact_name', txt(b.contact_name, 200));
    if (b.wa_phone !== undefined) put('wa_phone', txt(b.wa_phone, 40));
    if (b.email !== undefined) put('email', txt(b.email, 200));
    if (b.goal_note !== undefined) put('goal_note', txt(b.goal_note, 2000));
    if (b.memo !== undefined) put('memo', txt(b.memo, 4000));
    if (b.customer_id !== undefined) put('customer_id', idOf(b.customer_id));
    if (b.owner_user_id !== undefined) put('owner_user_id', idOf(b.owner_user_id));
    if (b.is_walkin !== undefined) put('is_walkin', !!b.is_walkin);
    if (b.kind !== undefined) {
      const k = normKind(b.kind);
      put('kind', k);
      if (k === 'booth') { put('is_confirmed', false); put('confirmed_at', null); put('confirmed_by', null); }
    }
    if (b.is_confirmed !== undefined) {
      // 부스 방문으로 바꾸는 중이면 위에서 이미 FALSE 로 눕혔으므로 건드리지 않는다.
      const asBooth = b.kind !== undefined && normKind(b.kind) === 'booth';
      if (!asBooth) {
        const v = !!b.is_confirmed;
        put('is_confirmed', v);
        put('confirmed_at', v ? new Date().toISOString() : null);
        put('confirmed_by', v ? Number(perm.userId) : null);
      }
    }
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) return reply.code(400).send({ error: 'bad_status' });
      put('status', b.status);
    }
    for (const f of ['target_quote', 'target_order']) {
      if (b[f] !== undefined) { const v = money(b[f]); if (v == null) return reply.code(400).send({ error: 'bad_amount' }); put(f, v); }
    }
    for (const f of ['actual_quote', 'actual_order']) {
      if (b[f] !== undefined) {
        if (b[f] === null || b[f] === '') put(f, null);
        else { const v = money(b[f]); if (v == null) return reply.code(400).send({ error: 'bad_amount' }); put(f, v); }
      }
    }
    // 칸 이동 — day_no/slot_hour 중 하나만 와도 나머지는 현재 값 유지
    if (b.day_no !== undefined || b.slot_hour !== undefined) {
      const dayNo = b.day_no !== undefined ? intIn(b.day_no, 1, Number(m.day_count)) : Number(m.day_no);
      if (!dayNo) return reply.code(400).send({ error: 'bad_day' });
      const hour = b.slot_hour !== undefined ? intIn(b.slot_hour, 0, 23) : Number(m.slot_hour);
      if (hour == null) return reply.code(400).send({ error: 'bad_hour' });
      put('day_no', dayNo); put('slot_hour', hour);
      put('meet_date', shiftYmd(d10(m.start_date), dayNo - 1));
    }
    if (!sets.length) return { ok: true, id: Number(m.id), unchanged: true };
    sets.push('updated_at = now()');
    try {
      await query(`UPDATE exhibition_meetings SET ${sets.join(', ')} WHERE id = $1`, params);
    } catch (err) {
      if (err && (err.code === '42703' || err.code === '42P01')) {
        return reply.code(503).send({ error: 'migration_required', migration: '0186' });
      }
      throw err;
    }
    // 상담이 연결돼 있으면 업체·연락처 스냅샷을 같이 맞춘다(표에서 따로 놀지 않도록)
    if (m.consult_id && (b.company_name !== undefined || b.contact_name !== undefined)) {
      await query(
        `UPDATE sales_consults SET company_name = COALESCE($2, company_name), contact_name = COALESCE($3, contact_name), updated_at = now()
          WHERE id = $1`,
        [Number(m.consult_id), b.company_name !== undefined ? txt(b.company_name, 200) : null,
          b.contact_name !== undefined ? txt(b.contact_name, 200) : null]);
    }
    await logEvent({ userId: perm.userId, action: 'update', target: `expo_meeting:${m.id}` });
    return { ok: true, id: Number(m.id) };
  });

  // ── 미팅 삭제(소프트) — 작성자 또는 디렉터 ──
  app.delete('/api/exhibitions/meetings/:mid', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const m = await getMeeting(req.params.mid);
    if (!m) return reply.code(404).send({ error: 'not_found' });
    if (perm.role !== 'director' && Number(m.created_by) !== Number(perm.userId)) {
      return reply.code(403).send({ error: 'not_owner' });
    }
    await query(`UPDATE exhibition_meetings SET deleted_at = now() WHERE id = $1`, [Number(m.id)]);
    await logEvent({ userId: perm.userId, action: 'delete', target: `expo_meeting:${m.id}` });
    return { ok: true, id: Number(m.id) };
  });

  // ── 미팅 기록 시작: 연결된 고객상담 1건 확보(없으면 생성) ──
  //    반환한 consult_id 로 기존 /api/consults/:id/recordings 흐름을 그대로 쓴다.
  app.post('/api/exhibitions/meetings/:mid/consult', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const m = await getMeeting(req.params.mid);
    if (!m || m.expo_deleted) return reply.code(404).send({ error: 'not_found' });
    if (m.consult_id) {
      const ok = (await query(`SELECT id FROM sales_consults WHERE id=$1 AND deleted_at IS NULL`, [Number(m.consult_id)])).rows[0];
      if (ok) return { consult_id: Number(m.consult_id), created: false, company_name: m.company_name };
    }
    const place = [m.expo_name, m.venue].filter(Boolean).join(' · ');
    const note = [
      m.goal_note ? `[정성목표] ${m.goal_note}` : null,
      (num(m.target_quote) || num(m.target_order))
        ? `[정량목표] 견적 ${num(m.target_quote).toLocaleString('en-US')} ${m.currency || 'MXN'} · 수주 ${num(m.target_order).toLocaleString('en-US')} ${m.currency || 'MXN'}`
        : null,
      m.memo || null,
    ].filter(Boolean).join('\n');
    const r = (await query(
      `INSERT INTO sales_consults
         (consult_date, company_name, customer_id, contact_name, wa_phone, email, place_label, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [d10(m.meet_date) || mxTodayStr(new Date()), m.company_name, idOf(m.customer_id),
        m.contact_name, m.wa_phone, m.email, clip(place, 300) || null, clip(note, 4000) || null,
        idOf(m.owner_user_id) || Number(perm.userId)])).rows[0];
    const cid = Number(r.id);
    await query(`UPDATE exhibition_meetings SET consult_id=$2, updated_at=now() WHERE id=$1`, [Number(m.id), cid]);
    await logEvent({ userId: perm.userId, action: 'create', target: `consult:${cid}`, detail: { expo_meeting: Number(m.id) } });
    return { consult_id: cid, created: true, company_name: m.company_name };
  });

  // ── 정성목표 달성 판단(녹음 AI 요약 근거) ──
  app.post('/api/exhibitions/meetings/:mid/evaluate', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const m = await getMeeting(req.params.mid);
    if (!m || m.expo_deleted) return reply.code(404).send({ error: 'not_found' });
    if (!m.goal_note || !String(m.goal_note).trim()) return reply.code(409).send({ error: 'no_goal' });
    if (!m.consult_id) return reply.code(409).send({ error: 'no_recording' });

    const c = (await query(
      `SELECT id, private_by FROM sales_consults WHERE id=$1 AND deleted_at IS NULL`, [Number(m.consult_id)])).rows[0];
    if (!c) return reply.code(409).send({ error: 'no_recording' });
    if (c.private_by != null && Number(c.private_by) !== Number(perm.userId)) {
      return reply.code(403).send({ error: 'hidden_by_other' });
    }
    const rec = (await query(
      `SELECT id, transcript, summary_json FROM sales_consult_recordings
        WHERE consult_id=$1 AND status='done' AND summary_json IS NOT NULL ORDER BY id DESC LIMIT 1`,
      [Number(m.consult_id)])).rows[0];
    if (!rec) return reply.code(409).send({ error: 'no_summary' });
    if (!aiReady()) return reply.code(503).send({ error: 'no_anthropic_key' });

    let summary = null;
    try { summary = typeof rec.summary_json === 'string' ? JSON.parse(rec.summary_json) : rec.summary_json; } catch (_) {}

    const owner = m.owner_user_id
      ? (await query(`SELECT name FROM users WHERE id=$1`, [Number(m.owner_user_id)])).rows[0] : null;

    const out = await consultAiApi.summarize(buildQualEvalPrompt({
      exhibition_name: m.expo_name, venue: m.venue, currency: m.currency || 'MXN',
      meet_date: d10(m.meet_date), slot_hour: Number(m.slot_hour),
      company_name: m.company_name, contact_name: m.contact_name,
      owner_name: owner ? owner.name : null,
      target_quote: num(m.target_quote), target_order: num(m.target_order),
      goal_note: m.goal_note, memo: m.memo,
      summary_text: summaryToText(summary), transcript: rec.transcript,
    }), 1400);
    if (!out.ok) return reply.code(502).send({ error: out.error || 'ai_error' });
    const ev = parseQualEvalJson(out.text);
    if (!ev) return reply.code(502).send({ error: 'ai_parse' });

    await query(
      `UPDATE exhibition_meetings
          SET qual_result=$2, qual_eval=$3, qual_eval_json=$4, qual_eval_at=now(), updated_at=now()
        WHERE id=$1`,
      [Number(m.id), ev.result, ev.reason || null, JSON.stringify(ev)]);
    await logEvent({ userId: perm.userId, action: 'update', target: `expo_meeting:${m.id}`, detail: { qual: ev.result } });
    return { ok: true, id: Number(m.id), evaluation: ev };
  });

  // ── 정성목표 판단 수동 보정(AI 판단을 사람이 덮어쓰기) ──
  app.post('/api/exhibitions/meetings/:mid/qual', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const m = await getMeeting(req.params.mid);
    if (!m) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {};
    const v = b.result === null || b.result === '' ? null : normQual(b.result);
    if (b.result != null && b.result !== '' && !v) return reply.code(400).send({ error: 'bad_result' });
    await query(
      `UPDATE exhibition_meetings SET qual_result=$2, qual_eval=$3, qual_eval_at=now(), updated_at=now() WHERE id=$1`,
      [Number(m.id), v, txt(b.reason, 1200)]);
    await logEvent({ userId: perm.userId, action: 'update', target: `expo_meeting:${m.id}`, detail: { qual_manual: v } });
    return { ok: true, id: Number(m.id), qual_result: v };
  });
}
