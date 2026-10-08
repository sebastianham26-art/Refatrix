// =====================================================================
// Refatrix ERP · workplan.js — 직원 업무일지 (0263, 2026-10-08)
//   아침 「오늘 할 일」(체크리스트) → 마감 전 「오늘 한 일」(완료·일부·못함 + 메모 + 계획 외 한 일)
//   · 전 직원 공유(팀 업무) · 못 한 일은 다음 근무일로 자동 이월
//   · 디렉터 WhatsApp 아침(계획)/저녁(실적) 요약 이미지 · 미작성 직원 WhatsApp 알림
//   시각은 전부 멕시코 고정 UTC-6(workingHours.MX_OFFSET_MIN — 다른 스케줄러와 같은 규칙).
// =====================================================================
import { query, withTx } from './db.js';
import { MX_OFFSET_MIN } from './workingHours.js';
import { waApiReady, normalizeWaNumber, sendWaText, sendWaTo, uploadWaMedia, sendWaImage, sendWaImageTemplate } from './waSend.js';
import { windowState } from './waWebhook.js';
import { esc, fit, textWidth, svgToPng } from './treasuryImage.js';

export const MAX_ITEMS = 30;
export const MAX_TITLE = 300;
export const MAX_NOTE = 500;
export const MAX_EXTRA = 4000;
export const MAX_ATTEMPTS = 5;
export const SEND_WINDOW_MIN = 180;      // 설정 시각부터 3시간 안에서만 자동 발송(서버 재시작 따라잡기, 밤 발송 방지)
export const CARRY_LOOKBACK_DAYS = 14;   // 이월 원본을 찾는 범위
export const CARRY_WARN = 3;             // 같은 일이 3번째 이월되면 ⚠
export const STATUSES = ['done', 'partial', 'missed'];
export const KINDS = ['remind_plan', 'remind_done', 'sum_plan', 'sum_done'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isYmd = (s) => DATE_RE.test(String(s || '')) && !isNaN(Date.parse(String(s) + 'T00:00:00Z'))
  && new Date(String(s) + 'T00:00:00Z').toISOString().slice(0, 10) === String(s);
export const isHm = (s) => HM_RE.test(String(s || ''));
export const hmToMin = (s) => { const m = HM_RE.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
export function addDays(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export const dowOf = (ymd) => new Date(ymd + 'T00:00:00Z').getUTCDay();   // 0=일
const ts = (d) => (d == null ? null : (d instanceof Date ? d.toISOString() : String(d)));

// 멕시코 현재 — WORKPLAN_FAKE_NOW(ISO)는 테스트 전용
export function mxClock(nowMs = (process.env.WORKPLAN_FAKE_NOW ? Date.parse(process.env.WORKPLAN_FAKE_NOW) : Date.now())) {
  const m = new Date(nowMs + MX_OFFSET_MIN * 60000);
  return { ymd: m.toISOString().slice(0, 10), min: m.getUTCHours() * 60 + m.getUTCMinutes(), dow: m.getUTCDay(), ms: nowMs };
}
export const mxHm = (d) => { if (!d) return null; const m = new Date(new Date(d).getTime() + MX_OFFSET_MIN * 60000); return m.toISOString().slice(11, 16); };

// ───────────────────────── 설정 ─────────────────────────
export const DEFAULT_SETTINGS = Object.freeze({
  plan_deadline: '10:00', done_deadline: '18:00', workdays: [1, 2, 3, 4, 5, 6],
  remind_enabled: true, remind_plan_at: '09:30', remind_done_at: '17:30',
  remind_template: null, remind_template_lang: 'es_MX',
  summary_enabled: true, summary_plan_at: '10:15', summary_done_at: '18:15', summary_user_ids: [],
});
export function parseWorkdays(s) {
  const set = new Set(String(s == null ? '' : s).split(',').map((x) => String(x).trim()).filter((x) => x !== '').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6));
  return [...set].sort((a, b) => a - b);
}
export function rowToSettings(r) {
  if (!r) return { ...DEFAULT_SETTINGS, workdays: [...DEFAULT_SETTINGS.workdays], summary_user_ids: [] };
  return {
    plan_deadline: r.plan_deadline, done_deadline: r.done_deadline, workdays: parseWorkdays(r.workdays),
    remind_enabled: !!r.remind_enabled, remind_plan_at: r.remind_plan_at, remind_done_at: r.remind_done_at,
    remind_template: r.remind_template || null, remind_template_lang: r.remind_template_lang || 'es_MX',
    summary_enabled: !!r.summary_enabled, summary_plan_at: r.summary_plan_at, summary_done_at: r.summary_done_at,
    summary_user_ids: (r.summary_user_ids || []).map(Number),
    updated_at: ts(r.updated_at),
  };
}
export async function loadSettings(q = query) {
  return rowToSettings((await q(`SELECT * FROM workplan_settings WHERE id=1`)).rows[0]);
}
// 입력 검증 → { ok, value | error }
export function cleanSettingsInput(b, cur = DEFAULT_SETTINGS) {
  const o = { ...cur };
  const hmKeys = ['plan_deadline', 'done_deadline', 'remind_plan_at', 'remind_done_at', 'summary_plan_at', 'summary_done_at'];
  for (const k of hmKeys) {
    if (b[k] === undefined) continue;
    if (!isHm(b[k])) return { ok: false, error: 'bad_time', field: k };
    o[k] = b[k];
  }
  if (hmToMin(o.plan_deadline) >= hmToMin(o.done_deadline)) return { ok: false, error: 'deadline_order', message: '할 일 마감은 한 일 마감보다 빨라야 합니다.' };
  if (b.workdays !== undefined) {
    const w = Array.isArray(b.workdays) ? parseWorkdays(b.workdays.join(',')) : parseWorkdays(b.workdays);
    if (!w.length) return { ok: false, error: 'no_workdays', message: '근무일을 하루 이상 고르세요.' };
    o.workdays = w;
  }
  for (const k of ['remind_enabled', 'summary_enabled']) if (b[k] !== undefined) o[k] = !!b[k];
  if (b.remind_template !== undefined) {
    const t = String(b.remind_template || '').trim();
    if (t && !/^[a-z0-9_]{1,512}$/.test(t)) return { ok: false, error: 'bad_template', message: '템플릿 이름은 영문 소문자·숫자·밑줄만 가능합니다.' };
    o.remind_template = t || null;
  }
  if (b.remind_template_lang !== undefined) {
    const l = String(b.remind_template_lang || '').trim() || 'es_MX';
    if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(l)) return { ok: false, error: 'bad_lang' };
    o.remind_template_lang = l;
  }
  if (b.summary_user_ids !== undefined) {
    if (!Array.isArray(b.summary_user_ids)) return { ok: false, error: 'bad_recipients' };
    o.summary_user_ids = [...new Set(b.summary_user_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  }
  return { ok: true, value: o };
}
export async function saveSettings(v, userId, q = query) {
  await q(`INSERT INTO workplan_settings (id, plan_deadline, done_deadline, workdays, remind_enabled, remind_plan_at, remind_done_at,
             remind_template, remind_template_lang, summary_enabled, summary_plan_at, summary_done_at, summary_user_ids, updated_at, updated_by)
           VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::bigint[], now(), $13)
           ON CONFLICT (id) DO UPDATE SET plan_deadline=EXCLUDED.plan_deadline, done_deadline=EXCLUDED.done_deadline,
             workdays=EXCLUDED.workdays, remind_enabled=EXCLUDED.remind_enabled, remind_plan_at=EXCLUDED.remind_plan_at,
             remind_done_at=EXCLUDED.remind_done_at, remind_template=EXCLUDED.remind_template,
             remind_template_lang=EXCLUDED.remind_template_lang, summary_enabled=EXCLUDED.summary_enabled,
             summary_plan_at=EXCLUDED.summary_plan_at, summary_done_at=EXCLUDED.summary_done_at,
             summary_user_ids=EXCLUDED.summary_user_ids, updated_at=now(), updated_by=EXCLUDED.updated_by`,
  [v.plan_deadline, v.done_deadline, v.workdays.join(','), v.remind_enabled, v.remind_plan_at, v.remind_done_at,
    v.remind_template, v.remind_template_lang, v.summary_enabled, v.summary_plan_at, v.summary_done_at, v.summary_user_ids, userId || null]);
  return loadSettings(q);
}
export const isWorkday = (s, ymd) => (s.workdays || []).includes(dowOf(ymd));

// 지연 판정: 지난 날짜는 무조건 지연, 오늘은 마감 시각 이후, 미래는 아님
export function isLate(date, deadlineHm, clock) {
  if (date < clock.ymd) return true;
  if (date > clock.ymd) return false;
  return clock.min >= hmToMin(deadlineHm);
}

// ───────────────────────── 대상 직원 ─────────────────────────
export async function loadTargets(q = query) {
  return (await q(`SELECT id, name, role, lang, wa_phone FROM users
                    WHERE deleted_at IS NULL AND role <> 'director' AND workplan_enabled = true
                    ORDER BY name, id`)).rows.map((r) => ({ ...r, id: Number(r.id) }));
}
export async function isTarget(userId, q = query) {
  const r = (await q(`SELECT role, workplan_enabled, deleted_at FROM users WHERE id=$1`, [userId])).rows[0];
  return !!(r && !r.deleted_at && r.role !== 'director' && r.workplan_enabled);
}

// ───────────────────────── 하루 읽기 ─────────────────────────
const ITEM_COLS = `i.id, i.user_id, to_char(i.work_date,'YYYY-MM-DD') AS work_date, i.title, i.sort, i.carried_from,
  i.carry_count, i.added_late, i.status, i.note, i.created_at, i.updated_at`;
const DAY_COLS = `d.user_id, to_char(d.work_date,'YYYY-MM-DD') AS work_date, d.plan_saved_at, d.plan_late,
  d.done_saved_at, d.done_late, d.extra_done, d.updated_at`;
export const itemOut = (r) => ({
  id: Number(r.id), title: r.title, sort: Number(r.sort), status: r.status, note: r.note || '',
  carried: r.carried_from != null, carry_count: Number(r.carry_count) || 0, added_late: !!r.added_late,
});
export const dayOut = (d) => ({
  plan_saved_at: ts(d && d.plan_saved_at), plan_late: !!(d && d.plan_late), plan_hm: mxHm(d && d.plan_saved_at),
  done_saved_at: ts(d && d.done_saved_at), done_late: !!(d && d.done_late), done_hm: mxHm(d && d.done_saved_at),
  extra_done: (d && d.extra_done) || '',
});

// 상태·완료율(일부 = 0.5)
export function summarize(day, items) {
  const c = { total: items.length, done: 0, partial: 0, missed: 0, open: 0 };
  for (const it of items) c[it.status] = (c[it.status] || 0) + 1;
  const plan = !!(day && day.plan_saved_at), done = !!(day && day.done_saved_at);
  const score = c.done + c.partial * 0.5;
  // 주의: done = 완료 항목 수(count). 작성 여부는 plan_written / done_written.
  return { ...c, score, rate: c.total ? Math.round((score / c.total) * 100) : null, plan_written: plan, done_written: done,
    state: done ? 'done' : (plan ? 'plan' : 'none') };
}

export async function loadDay(userId, date, q = query) {
  const day = (await q(`SELECT ${DAY_COLS} FROM workplan_days d WHERE d.user_id=$1 AND d.work_date=$2`, [userId, date])).rows[0] || null;
  const items = (await q(`SELECT ${ITEM_COLS} FROM workplan_items i
                          WHERE i.user_id=$1 AND i.work_date=$2 AND i.deleted_at IS NULL ORDER BY i.sort, i.id`, [userId, date])).rows.map(itemOut);
  const d = dayOut(day);
  return { date, day: d, items, sum: summarize(day, items) };
}

// ───────────────────────── 이월 ─────────────────────────
//   직전 기록일(14일 안)의 완료되지 않은 항목(open/partial/missed)을 date 로 복사. 같은 항목은 한 번만.
export async function ensureCarry(userId, date, q = query) {
  const prev = (await q(`SELECT to_char(max(work_date),'YYYY-MM-DD') AS d FROM workplan_items
                          WHERE user_id=$1 AND work_date < $2 AND work_date >= $3 AND deleted_at IS NULL`,
  [userId, date, addDays(date, -CARRY_LOOKBACK_DAYS)])).rows[0];
  if (!prev || !prev.d) return 0;
  const r = await q(`INSERT INTO workplan_items (user_id, work_date, title, sort, carried_from, carry_count)
      SELECT s.user_id, $2::date, s.title,
             COALESCE((SELECT max(sort) FROM workplan_items x WHERE x.user_id=$1 AND x.work_date=$2::date), -1) + row_number() OVER (ORDER BY s.sort, s.id),
             s.id, s.carry_count + 1
        FROM workplan_items s
       WHERE s.user_id=$1 AND s.work_date=$3::date AND s.deleted_at IS NULL AND s.status IN ('open','partial','missed')
    ON CONFLICT (carried_from) WHERE carried_from IS NOT NULL DO NOTHING`, [userId, date, prev.d]);
  return r.rowCount || 0;
}

// ───────────────────────── 저장 ─────────────────────────
export class WpError extends Error { constructor(code, status = 400, message = null) { super(message || code); this.code = code; this.status = status; } }

export function cleanPlanItems(raw) {
  if (!Array.isArray(raw)) throw new WpError('bad_items');
  const out = [];
  for (const x of raw) {
    const title = String((x && x.title) || '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    if (title.length > MAX_TITLE) throw new WpError('title_too_long', 400, `항목은 ${MAX_TITLE}자까지 쓸 수 있습니다.`);
    const id = x && x.id != null ? Number(x.id) : null;
    out.push({ id: Number.isInteger(id) && id > 0 ? id : null, title });
  }
  if (out.length > MAX_ITEMS) throw new WpError('too_many', 400, `하루 ${MAX_ITEMS}개까지 적을 수 있습니다.`);
  return out;
}

// 「오늘 할 일」 저장 — 목록 전체 교체(없어진 항목은 소프트 삭제)
export async function savePlan({ userId, date, items, clock, settings }) {
  if (!isYmd(date)) throw new WpError('bad_date');
  const list = cleanPlanItems(items);
  return withTx(async (c) => {
    const q = c.query.bind(c);
    const day = (await q(`SELECT plan_saved_at FROM workplan_days WHERE user_id=$1 AND work_date=$2 FOR UPDATE`, [userId, date])).rows[0];
    const saved = !!(day && day.plan_saved_at);
    if (saved && date < clock.ymd) throw new WpError('locked', 403, '지난 날짜의 할 일은 수정할 수 없습니다.');
    if (!saved && !list.length) throw new WpError('empty', 400, '할 일을 한 개 이상 적으세요.');
    const cur = (await q(`SELECT id FROM workplan_items WHERE user_id=$1 AND work_date=$2 AND deleted_at IS NULL`, [userId, date])).rows.map((r) => Number(r.id));
    const curSet = new Set(cur);
    const keep = new Set();
    const lateAdd = saved && isLate(date, settings.plan_deadline, clock);
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (it.id && curSet.has(it.id) && !keep.has(it.id)) {
        keep.add(it.id);
        await q(`UPDATE workplan_items SET title=$1, sort=$2, updated_at=now() WHERE id=$3`, [it.title, i, it.id]);
      } else {
        const r = await q(`INSERT INTO workplan_items (user_id, work_date, title, sort, added_late) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [userId, date, it.title, i, lateAdd]);
        keep.add(Number(r.rows[0].id));
      }
    }
    const drop = cur.filter((id) => !keep.has(id));
    if (drop.length) await q(`UPDATE workplan_items SET deleted_at=now(), updated_at=now() WHERE id = ANY($1::bigint[])`, [drop]);
    await q(`INSERT INTO workplan_days (user_id, work_date, plan_saved_at, plan_late) VALUES ($1,$2, $4::timestamptz, $3)
             ON CONFLICT (user_id, work_date) DO UPDATE SET
               plan_saved_at=COALESCE(workplan_days.plan_saved_at, EXCLUDED.plan_saved_at),
               plan_late=CASE WHEN workplan_days.plan_saved_at IS NULL THEN EXCLUDED.plan_late ELSE workplan_days.plan_late END,
               updated_at=now()`, [userId, date, isLate(date, settings.plan_deadline, clock), new Date(clock.ms).toISOString()]);
    return { first: !saved, removed: drop.length };
  });
}

// 「오늘 한 일」 저장 — 항목별 상태·메모 + 계획 외 한 일. 표시 안 한 항목은 「못함」.
export async function saveDone({ userId, date, items, extra_done, clock, settings }) {
  if (!isYmd(date)) throw new WpError('bad_date');
  if (date > clock.ymd) throw new WpError('future', 400, '아직 오지 않은 날짜의 한 일은 쓸 수 없습니다.');
  const extra = String(extra_done == null ? '' : extra_done).trim();
  if (extra.length > MAX_EXTRA) throw new WpError('too_long', 400, `계획 외 한 일은 ${MAX_EXTRA}자까지입니다.`);
  const marks = new Map();
  for (const x of (Array.isArray(items) ? items : [])) {
    const id = Number(x && x.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const st = String((x && x.status) || '');
    if (!STATUSES.includes(st)) throw new WpError('bad_status');
    const note = String((x && x.note) || '').trim();
    if (note.length > MAX_NOTE) throw new WpError('note_too_long', 400, `메모는 ${MAX_NOTE}자까지입니다.`);
    marks.set(id, { status: st, note });
  }
  return withTx(async (c) => {
    const q = c.query.bind(c);
    const day = (await q(`SELECT done_saved_at FROM workplan_days WHERE user_id=$1 AND work_date=$2 FOR UPDATE`, [userId, date])).rows[0];
    const saved = !!(day && day.done_saved_at);
    if (saved && date < clock.ymd) throw new WpError('locked', 403, '지난 날짜의 한 일은 수정할 수 없습니다.');
    const cur = (await q(`SELECT id FROM workplan_items WHERE user_id=$1 AND work_date=$2 AND deleted_at IS NULL`, [userId, date])).rows.map((r) => Number(r.id));
    if (!cur.length && !extra) throw new WpError('empty', 400, '한 일을 표시하거나 적으세요.');
    const doneIds = [];
    for (const id of cur) {
      const m = marks.get(id) || { status: 'missed', note: null };
      await q(`UPDATE workplan_items SET status=$1, note=COALESCE($2, note), updated_at=now() WHERE id=$3`, [m.status, m.note, id]);
      if (m.status === 'done') doneIds.push(id);
    }
    // 늦게 「완료」로 고친 항목이 이미 다음 날로 이월돼 있으면(아직 손대지 않은 것만) 거둬들인다
    if (doneIds.length) {
      await q(`UPDATE workplan_items SET deleted_at=now(), updated_at=now()
                WHERE carried_from = ANY($1::bigint[]) AND status='open' AND deleted_at IS NULL`, [doneIds]);
    }
    await q(`INSERT INTO workplan_days (user_id, work_date, done_saved_at, done_late, extra_done) VALUES ($1,$2, $5::timestamptz, $3, $4)
             ON CONFLICT (user_id, work_date) DO UPDATE SET
               done_saved_at=COALESCE(workplan_days.done_saved_at, EXCLUDED.done_saved_at),
               done_late=CASE WHEN workplan_days.done_saved_at IS NULL THEN EXCLUDED.done_late ELSE workplan_days.done_late END,
               extra_done=EXCLUDED.extra_done, updated_at=now()`, [userId, date, isLate(date, settings.done_deadline, clock), extra, new Date(clock.ms).toISOString()]);
    return { first: !saved };
  });
}

// ───────────────────────── 팀 · 달력 표식 ─────────────────────────
export async function loadTeam(date, q = query) {
  const targets = await loadTargets(q);
  if (!targets.length) return [];
  const ids = targets.map((t) => t.id);
  const days = (await q(`SELECT ${DAY_COLS} FROM workplan_days d WHERE d.work_date=$1 AND d.user_id = ANY($2::bigint[])`, [date, ids])).rows;
  const items = (await q(`SELECT ${ITEM_COLS} FROM workplan_items i
                          WHERE i.work_date=$1 AND i.user_id = ANY($2::bigint[]) AND i.deleted_at IS NULL ORDER BY i.sort, i.id`, [date, ids])).rows;
  const dm = new Map(days.map((d) => [Number(d.user_id), d]));
  const im = new Map();
  for (const r of items) { const k = Number(r.user_id); if (!im.has(k)) im.set(k, []); im.get(k).push(itemOut(r)); }
  return targets.map((t) => {
    const raw = dm.get(t.id) || null; const its = im.get(t.id) || [];
    return { user_id: t.id, name: t.name, role: t.role, lang: t.lang, wa_phone: t.wa_phone, day: dayOut(raw), items: its, sum: summarize(raw, its) };
  });
}
export function teamKpi(team) {
  const n = team.length;
  const planN = team.filter((m) => m.sum.plan_written).length;
  const doneN = team.filter((m) => m.sum.done_written).length;
  const tot = team.reduce((a, m) => a + (m.sum.done_written ? m.sum.total : 0), 0);
  const sc = team.reduce((a, m) => a + (m.sum.done_written ? m.sum.score : 0), 0);
  return { members: n, plan_written: planN, done_written: doneN, rate: tot ? Math.round((sc / tot) * 100) : null,
    plan_missing: team.filter((m) => !m.sum.plan_written).map((m) => m.name),
    done_missing: team.filter((m) => !m.sum.done_written).map((m) => m.name) };
}
export async function loadMarks(userId, from, to, q = query) {
  const days = (await q(`SELECT to_char(work_date,'YYYY-MM-DD') AS d, plan_saved_at, done_saved_at FROM workplan_days
                          WHERE user_id=$1 AND work_date BETWEEN $2 AND $3`, [userId, from, to])).rows;
  const cnt = (await q(`SELECT to_char(work_date,'YYYY-MM-DD') AS d, count(*)::int AS total,
                               sum(CASE WHEN status='done' THEN 1 ELSE 0 END)::int AS done,
                               sum(CASE WHEN status='partial' THEN 1 ELSE 0 END)::int AS partial
                          FROM workplan_items WHERE user_id=$1 AND work_date BETWEEN $2 AND $3 AND deleted_at IS NULL
                         GROUP BY work_date`, [userId, from, to])).rows;
  const out = {};
  for (const r of cnt) out[r.d] = { total: r.total, done: r.done, partial: r.partial, plan: false, done_saved: false };
  for (const r of days) {
    const o = out[r.d] || (out[r.d] = { total: 0, done: 0, partial: 0 });
    o.plan = !!r.plan_saved_at; o.done_saved = !!r.done_saved_at;
  }
  return out;
}

// ───────────────────────── 문구 ─────────────────────────
const DOW = { ko: ['일', '월', '화', '수', '목', '금', '토'], es: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'] };
const DOW_LONG_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
export function dayLabel(ymd, lang = 'ko') {
  const [, m, d] = ymd.split('-').map(Number);
  return lang === 'es' ? `${d}/${m} (${DOW.es[dowOf(ymd)]})` : `${m}/${d}(${DOW.ko[dowOf(ymd)]})`;
}
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';

// 직원 알림(미작성자) — 직원 언어(users.lang)로
export function reminderText(kind, user, date, s) {
  const es = user.lang !== 'ko';
  const nm = firstName(user.name);
  const [, m, d] = date.split('-').map(Number);
  if (kind === 'remind_plan') {
    return es
      ? `Hola ${nm} 👋 Aún no registras tus pendientes de hoy (${DOW_LONG_ES[dowOf(date)]} ${d}/${m}). Por favor captúralos antes de las ${s.plan_deadline} en el ERP → Calendario.`
      : `${nm}님, 오늘(${m}/${d}) 할 일이 아직 없습니다. ${s.plan_deadline}까지 ERP 일정 화면에서 적어 주세요.`;
  }
  return es
    ? `Hola ${nm}, recuerda registrar lo que hiciste hoy (${d}/${m}) antes de las ${s.done_deadline} en el ERP → Calendario. ¡Gracias!`
    : `${nm}님, 오늘(${m}/${d}) 한 일을 ${s.done_deadline}까지 ERP 일정 화면에서 적어 주세요.`;
}
// 템플릿 변수 4개: {{1}} 이름 · {{2}} 무엇 · {{3}} 날짜 · {{4}} 마감시각 (Meta: 줄바꿈 금지)
export function reminderParams(kind, user, date, s) {
  const es = user.lang !== 'ko';
  const [, m, d] = date.split('-').map(Number);
  return [firstName(user.name) || '-',
    kind === 'remind_plan' ? (es ? 'tus pendientes' : '할 일') : (es ? 'lo que hiciste' : '한 일'),
    es ? `${d}/${m}` : `${m}/${d}`,
    kind === 'remind_plan' ? s.plan_deadline : s.done_deadline];
}

const L = {
  ko: { plan: '🌅 오늘 할 일', done: '🌙 오늘 한 일', base: '기준', written: '작성', missing: '미작성', rate: '완료율',
    late: '지연', carry: '이월', none: '미작성', both: '계획·실적 모두 미작성', planOnly: '계획만 작성', noItems: '(항목 없음)',
    extra: '+', nextDay: '→내일', partial: '일부', missed: '못함', added: '추가', warnCarry: '회 이월' },
  es: { plan: '🌅 Pendientes de hoy', done: '🌙 Lo hecho hoy', base: 'corte', written: 'registrados', missing: 'sin registro', rate: 'cumplimiento',
    late: 'tarde', carry: 'arrastre', none: 'sin registro', both: 'sin plan ni reporte', planOnly: 'solo plan', noItems: '(sin pendientes)',
    extra: '+', nextDay: '→mañana', partial: 'parcial', missed: 'no hecho', added: 'agregado', warnCarry: 'x arrastrado' },
};
const lg = (lang) => (lang === 'es' ? L.es : L.ko);

// 요약 행(이미지·텍스트 공용) — 사람당 { name, status, statusTone, lines[] }
export function summaryRows(kind, team, lang = 'ko') {
  const t = lg(lang);
  return team.map((m) => {
    if (kind === 'sum_plan') {
      if (!m.sum.plan_written) {
        const carried = m.items.filter((i) => i.carried);
        return { name: m.name, status: t.none, tone: 'bad', lines: carried.length ? [`(${t.carry} ${carried.length}: ${carried.map((i) => i.title).join(' · ')})`] : [] };
      }
      const lines = m.items.map((i) => i.title + (i.carried ? ` (${t.carry}${i.carry_count >= CARRY_WARN ? ` ⚠${i.carry_count}${t.warnCarry}` : ''})` : '') + (i.added_late ? ` (${t.added})` : ''));
      return { name: m.name, status: (m.day.plan_hm || '') + (m.day.plan_late ? ` ${t.late}` : ''), tone: m.day.plan_late ? 'warn' : 'ok', lines: lines.length ? lines : [t.noItems] };
    }
    // sum_done
    if (!m.sum.done_written) {
      return { name: m.name, status: m.sum.plan_written ? t.planOnly : t.both, tone: 'bad',
        lines: m.sum.plan_written ? m.items.map((i) => '· ' + i.title) : [] };
    }
    const s = m.sum;
    const head = `${s.score % 1 ? s.score.toFixed(1) : s.score}/${s.total}` + (s.total && s.score === s.total ? ' ✅' : '') + (m.day.done_late ? ` · ${t.late}` : '');
    const lines = [];
    for (const i of m.items) {
      if (i.status === 'done') continue;
      const mark = i.status === 'partial' ? `◐ ${t.partial}` : `✗ ${t.missed}`;
      lines.push(`${mark}: ${i.title}${i.note ? ` — ${i.note}` : ''}${i.carry_count + 1 >= CARRY_WARN ? ` ⚠` : ''}`);
    }
    if (m.day.extra_done) lines.push(`${t.extra} ${m.day.extra_done.replace(/\s*\n+\s*/g, ' · ')}`);
    return { name: m.name, status: head, tone: s.rate === 100 ? 'ok' : (s.rate >= 50 ? 'warn' : 'bad'), lines };
  });
}
export function summaryHeadline(kind, date, team, lang = 'ko', hm = null) {
  const t = lg(lang); const k = teamKpi(team);
  if (kind === 'sum_plan') {
    return `${t.plan} · ${dayLabel(date, lang)}${hm ? ` ${hm} ${t.base}` : ''} · ${t.written} ${k.plan_written}/${k.members}`
      + (k.plan_missing.length ? ` · ${t.missing} ${k.plan_missing.join(', ')}` : '');
  }
  return `${t.done} · ${dayLabel(date, lang)}${hm ? ` ${hm} ${t.base}` : ''} · ${t.written} ${k.done_written}/${k.members}`
    + (k.rate != null ? ` · ${t.rate} ${k.rate}%` : '') + (k.done_missing.length ? ` · ${t.missing} ${k.done_missing.join(', ')}` : '');
}
export function summaryText(kind, date, team, lang = 'ko', hm = null) {
  const rows = summaryRows(kind, team, lang);
  const out = [`*${summaryHeadline(kind, date, team, lang, hm)}*`, ''];
  for (const r of rows) {
    out.push(`*${r.name}* — ${r.status}`);
    for (const l of r.lines) out.push(`  ${l}`);
  }
  let s = out.join('\n');
  if (s.length > 3800) s = s.slice(0, 3800) + '\n…';
  return s;
}

// 요약 이미지(SVG) — 일일 자금과 같은 톤(브랜드 녹색 머리줄 + 표)
const C = { brand: '#143D34', sub: '#CFE0D8', ink: '#1C1B19', muted: '#6F6A60', line: '#E6E1D6', zebra: '#FAF8F3',
  ok: '#0F6E56', okBg: '#E4F0EB', warn: '#8A6512', warnBg: '#FBF6EA', bad: '#B23A2E', badBg: '#F6E7E4' };
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;
const fam = (s) => (HANGUL.test(String(s)) ? 'IBM Plex Sans KR' : 'IBM Plex Sans');
const T = (x, y, s, o = {}) => `<text x="${x}" y="${y}" font-family="${fam(s)}" font-size="${o.size || 13}"${o.bold ? ' font-weight="600"' : ''} fill="${o.fill || C.ink}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}>${esc(s)}</text>`;
const Rc = (x, y, w, h, fill, rx = 0) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${rx ? ` rx="${rx}"` : ''}/>`;
// 폭에 맞춰 줄바꿈(단어 단위, 너무 긴 단어는 글자 단위)
export function wrapText(s, size, maxW) {
  const words = String(s || '').split(/(\s+)/);
  const lines = []; let cur = '';
  for (const w of words) {
    if (textWidth(cur + w, size) <= maxW) { cur += w; continue; }
    if (cur.trim()) lines.push(cur.trim());
    cur = w.trim() ? w : '';
    while (textWidth(cur, size) > maxW) {
      let cut = ''; for (const ch of cur) { if (textWidth(cut + ch, size) > maxW) break; cut += ch; }
      lines.push(cut); cur = cur.slice(cut.length);
    }
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.length ? lines : [''];
}
// 이미지 폰트(IBM Plex)에 없는 그림문자는 글자로 바꾸거나 뺀다(□ 깨짐 방지). WhatsApp 텍스트·캡션은 그대로.
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;
export function imgSafe(s, lang = 'ko') {
  return String(s == null ? '' : s)
    .replace(/\s*⚠(\d*)[^\s)]*/g, (_, n) => (lang === 'es' ? ' (arrastre repetido)' : ' (반복 이월)'))
    .replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim();
}
export function summarySvg(kind, date, team, lang = 'ko', hm = null, { maxLinesPerPerson = 8 } = {}) {
  const t = lg(lang); const k = teamKpi(team);
  const W = 760, NW = 150, SW = 150, PAD = 12, FS = 13, LH = 19;
  const BW = W - NW - SW - PAD * 2;
  const rows = summaryRows(kind, team, lang).map((r) => {
    let lines = [];
    for (const l0 of r.lines) {
      const miss = l0.startsWith('✗');                       // 못함 줄은 기호 대신 빨간 글씨
      for (const w of wrapText(imgSafe(miss ? l0.slice(1) : l0, lang), FS, BW)) lines.push({ s: w, miss });
    }
    if (lines.length > maxLinesPerPerson) lines = [...lines.slice(0, maxLinesPerPerson - 1), { s: '…', miss: false }];
    return { ...r, status: imgSafe(r.status, lang), wl: lines.length ? lines : [{ s: '', miss: false }] };
  });
  const parts = [];
  const title = kind === 'sum_plan' ? t.plan : t.done;
  parts.push(Rc(0, 0, W, 58, C.brand));
  parts.push(T(PAD + 4, 26, imgSafe(`${title} · ${dayLabel(date, lang)}`, lang), { size: 18, bold: true, fill: '#FFFFFF' }));
  const sub = kind === 'sum_plan'
    ? `${hm ? `${hm} ${t.base} · ` : ''}${t.written} ${k.plan_written}/${k.members}${k.plan_missing.length ? ` · ${t.missing} ${k.plan_missing.join(', ')}` : ''}`
    : `${hm ? `${hm} ${t.base} · ` : ''}${t.written} ${k.done_written}/${k.members}${k.rate != null ? ` · ${t.rate} ${k.rate}%` : ''}${k.done_missing.length ? ` · ${t.missing} ${k.done_missing.join(', ')}` : ''}`;
  parts.push(T(PAD + 4, 46, fit(sub, 12, W - PAD * 2), { size: 12, fill: C.sub }));
  let y = 58;
  if (!rows.length) { parts.push(T(PAD + 4, y + 28, lang === 'es' ? 'Sin personal asignado' : '대상 직원 없음', { fill: C.muted })); y += 44; }
  rows.forEach((r, i) => {
    const h = Math.max(1, r.wl.length) * LH + 14;
    if (i % 2) parts.push(Rc(0, y, W, h, C.zebra));
    parts.push(`<line x1="0" y1="${y + h}" x2="${W}" y2="${y + h}" stroke="${C.line}" stroke-width="1"/>`);
    parts.push(T(PAD, y + 22, fit(r.name, 14, NW - 10), { size: 14, bold: true, fill: C.brand }));
    const tone = r.tone === 'ok' ? [C.ok, C.okBg] : (r.tone === 'warn' ? [C.warn, C.warnBg] : [C.bad, C.badBg]);
    const st = fit(r.status || '—', 12, SW - 24);
    const sw = Math.min(SW - 12, textWidth(st, 12) + 16);
    parts.push(Rc(NW, y + 8, sw, 20, tone[1], 10));
    parts.push(T(NW + 8, y + 22, st, { size: 12, bold: true, fill: tone[0] }));
    r.wl.forEach((l, j) => parts.push(T(NW + SW, y + 22 + j * LH, l.s, { size: FS, fill: l.miss ? C.bad : C.ink })));
    y += h;
  });
  const H = y + 26;
  parts.push(T(PAD, H - 9, 'Refatrix ERP · 일정 › 팀 업무', { size: 10.5, fill: C.muted }));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${Rc(0, 0, W, H, '#FFFFFF')}${parts.join('')}</svg>`;
}

// ───────────────────────── WhatsApp 발송 ─────────────────────────
// 변수 여러 개짜리 템플릿(직원 알림). waSend 의 callGraph 와 같은 규칙(번호 52 정규화·30초 타임아웃).
export async function sendTemplateParams({ to, name, lang = 'es_MX', params = [] }) {
  if (!waApiReady()) return { ok: false, error: 'wa_not_configured' };
  if (!name) return { ok: false, error: 'no_template' };
  const n = normalizeWaNumber(to);
  if (!n) return { ok: false, error: 'bad_number' };
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const resp = await fetch(`https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || 'v20.0'}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: n, type: 'template',
        template: { name, language: { code: lang || 'es_MX' },
          components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p == null ? '-' : p).replace(/[\n\t]+/g, ' ').slice(0, 200) || '-' })) }] } }),
      signal: ctrl.signal });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) { const e = (data && data.error) || {}; return { ok: false, code: e.code || resp.status, error: (e.message || ('http_' + resp.status)).slice(0, 300) }; }
    return { ok: true, message_id: (data.messages && data.messages[0] && data.messages[0].id) || null };
  } catch (e) { return { ok: false, error: e && e.name === 'AbortError' ? 'timeout' : 'network' }; }
  finally { clearTimeout(timer); }
}
export const DEFAULT_DEPS = {
  ready: waApiReady, text: (to, body) => sendWaText(body, to), template: sendTemplateParams, textOrTemplate: sendWaTo,
  upload: uploadWaMedia, image: sendWaImage, imageTemplate: sendWaImageTemplate, windowState: (p, q) => windowState(p, q), png: svgToPng,
};
export const maskPhone = (p) => { const s = String(p || ''); return s ? s.slice(0, 3) + '****' + s.slice(-4) : null; };

async function ledgerPrev(kind, date, uid, q) {
  return (await q(`SELECT sent_at, attempts FROM workplan_wa_sends WHERE kind=$1 AND work_date=$2 AND user_id=$3`, [kind, date, uid])).rows[0] || null;
}
async function ledgerWrite(kind, date, uid, phone, res, q) {
  const status = res.ok ? (res.mode ? `sent_${res.mode}` : 'sent') : 'failed';
  await q(`INSERT INTO workplan_wa_sends (kind, work_date, user_id, to_masked, status, message_id, error, attempts, sent_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,1, CASE WHEN $8 THEN now() ELSE NULL END, now())
           ON CONFLICT (kind, work_date, user_id) DO UPDATE SET to_masked=EXCLUDED.to_masked, status=EXCLUDED.status,
             message_id=COALESCE(EXCLUDED.message_id, workplan_wa_sends.message_id), error=EXCLUDED.error,
             attempts=workplan_wa_sends.attempts+1,
             sent_at=CASE WHEN $8 THEN now() ELSE workplan_wa_sends.sent_at END, updated_at=now()`,
  [kind, date, uid, maskPhone(phone), status, res.message_id || null, res.ok ? (res.note || null) : (res.error || 'error'), !!res.ok]);
  return status;
}

// 미작성 직원 1명에게 알림: 24시간 창 안이면 자유 문장, 밖(또는 실패)이면 승인 템플릿
export async function sendReminder({ kind, date, user, settings, force = false, deps = DEFAULT_DEPS }, q = query) {
  const uid = Number(user.id);
  const phone = normalizeWaNumber(user.wa_phone);
  if (!phone) return { user_id: uid, skipped: 'no_phone' };
  const prev = await ledgerPrev(kind, date, uid, q);
  if (!force && prev && prev.sent_at) return { user_id: uid, skipped: 'already_sent' };
  if (!force && prev && Number(prev.attempts) >= MAX_ATTEMPTS) return { user_id: uid, skipped: 'max_attempts' };
  const win = await deps.windowState(phone, q);
  const tpl = settings.remind_template;
  const viaTpl = () => deps.template({ to: phone, name: tpl, lang: settings.remind_template_lang, params: reminderParams(kind, user, date, settings) });
  let res;
  if (win && win.open === false && tpl) {
    const r = await viaTpl();
    res = r.ok ? { ...r, mode: 'template', note: 'window_closed' } : r;
  } else {
    const r = await deps.text(phone, reminderText(kind, user, date, settings));
    if (r.ok) res = { ...r, mode: 'text' };
    else if (tpl) { const r2 = await viaTpl(); res = r2.ok ? { ...r2, mode: 'template', note: `text: ${r.error}` } : { ok: false, error: `text: ${r.error} / template: ${r2.error}` }; }
    else res = { ok: false, error: `text: ${r.error}` + (win && win.open === false ? ' (24시간 창 밖 — 알림 템플릿을 설정하세요)' : '') };
  }
  const status = await ledgerWrite(kind, date, uid, phone, res, q);
  return { user_id: uid, ok: !!res.ok, status, error: res.ok ? null : res.error };
}

// 요약 받는 사람: 설정의 사용자(휴대폰 있는 사람) · 비었으면 DAILY_SUMMARY_WA_TO(디렉터 번호, user_id 0)
export async function summaryRecipients(settings, q = query) {
  const ids = settings.summary_user_ids || [];
  if (ids.length) {
    const rows = (await q(`SELECT id, name, lang, wa_phone FROM users WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL ORDER BY id`, [ids])).rows;
    return rows.map((r) => ({ id: Number(r.id), name: r.name, lang: r.lang === 'es' ? 'es' : 'ko', phone: normalizeWaNumber(r.wa_phone) }));
  }
  const env = normalizeWaNumber(process.env.DAILY_SUMMARY_WA_TO);
  return env ? [{ id: 0, name: 'DAILY_SUMMARY_WA_TO', lang: 'ko', phone: env }] : [];
}

// 요약 1건(받는 사람 전원) — 이미지(언어별 1회 업로드) → 실패 시 텍스트(→ 기존 1변수 템플릿 폴백)
export async function sendSummary({ kind, date, settings, force = false, hm = null, deps = DEFAULT_DEPS }, q = query) {
  const rcpts = await summaryRecipients(settings, q);
  if (!rcpts.length) return { skipped: 'no_recipients', results: [] };
  const team = await loadTeam(date, q);
  const cache = {}; const results = [];
  const imgTpl = process.env.WORKPLAN_WA_IMAGE_TEMPLATE || process.env.TREASURY_WA_IMAGE_TEMPLATE || null;
  for (const r of rcpts) {
    if (!r.phone) { results.push({ user_id: r.id, skipped: 'no_phone' }); continue; }
    const prev = await ledgerPrev(kind, date, r.id, q);
    if (!force && prev && prev.sent_at) { results.push({ user_id: r.id, skipped: 'already_sent' }); continue; }
    if (!force && prev && Number(prev.attempts) >= MAX_ATTEMPTS) { results.push({ user_id: r.id, skipped: 'max_attempts' }); continue; }
    const lang = r.lang;
    if (!cache[lang]) {
      const svg = summarySvg(kind, date, team, lang, hm);
      cache[lang] = { headline: summaryHeadline(kind, date, team, lang, hm), text: summaryText(kind, date, team, lang, hm),
        png: process.env.WORKPLAN_WA_FORMAT === 'text' ? null : await deps.png(svg), media: null };
    }
    const c = cache[lang];
    const win = await deps.windowState(r.phone, q);
    let res = null, imgErr = null;
    if (c.png) {
      if (!c.media) { const up = await deps.upload(c.png, { mime: 'image/png', filename: `refatrix_${kind}_${date}_${lang}.png` }); if (up.ok) c.media = up.id; else imgErr = `upload: ${up.error}`; }
      if (c.media) {
        if (win && win.open === false && imgTpl) {
          const t0 = await deps.imageTemplate({ to: r.phone, mediaId: c.media, param: c.headline, name: imgTpl });
          if (t0.ok) res = { ...t0, mode: 'image_template', note: 'window_closed' }; else imgErr = `image_template: ${t0.error}`;
        }
        if (!res) {
          const r1 = await deps.image({ to: r.phone, mediaId: c.media, caption: c.headline });
          if (r1.ok) res = { ...r1, mode: 'image' };
          else if (imgTpl) { const r2 = await deps.imageTemplate({ to: r.phone, mediaId: c.media, param: c.headline, name: imgTpl }); if (r2.ok) res = { ...r2, mode: 'image_template', note: `image: ${r1.error}` }; else imgErr = `image: ${r1.error} / image_template: ${r2.error}`; }
          else imgErr = `image: ${r1.error}`;
        }
      }
    }
    if (!res) {
      const t = await deps.textOrTemplate({ to: r.phone, text: c.text, headline: c.headline, windowOpen: win ? win.open : null });
      res = t.ok ? { ...t, note: imgErr || t.text_error || null } : { ...t, error: imgErr ? `${imgErr} / ${t.error}` : t.error };
    }
    const status = await ledgerWrite(kind, date, r.id, r.phone, res, q);
    results.push({ user_id: r.id, ok: !!res.ok, status, error: res.ok ? null : res.error });
  }
  return { results };
}

// ───────────────────────── 스케줄러 ─────────────────────────
export const dueAt = (clock, hm) => { const m = hmToMin(hm); return m != null && clock.min >= m && clock.min < m + SEND_WINDOW_MIN; };

export async function runWorkplanJob({ nowMs, deps = DEFAULT_DEPS, q = query } = {}) {
  if (process.env.WORKPLAN_WA_ENABLED === '0') return { skipped: 'disabled' };
  const clock = mxClock(nowMs);
  let s;
  try { s = await loadSettings(q); } catch (e) { if (e && (e.code === '42P01' || e.code === '42703')) return { skipped: 'migration_required' }; throw e; }
  if (!isWorkday(s, clock.ymd)) return { skipped: 'not_workday', date: clock.ymd };
  if (!deps.ready()) return { skipped: 'wa_not_configured', date: clock.ymd };
  const out = { date: clock.ymd, remind_plan: [], remind_done: [], sum_plan: null, sum_done: null };
  const need = (s.remind_enabled && (dueAt(clock, s.remind_plan_at) || dueAt(clock, s.remind_done_at)))
    || (s.summary_enabled && (dueAt(clock, s.summary_plan_at) || dueAt(clock, s.summary_done_at)));
  if (!need) return { ...out, skipped: 'not_due' };
  const targets = await loadTargets(q);
  for (const t of targets) await ensureCarry(t.id, clock.ymd, q);   // 미작성자의 이월 항목도 요약에 보이게
  const team = await loadTeam(clock.ymd, q);
  const byId = new Map(team.map((m) => [m.user_id, m]));
  if (s.remind_enabled) {
    for (const kind of ['remind_plan', 'remind_done']) {
      if (!dueAt(clock, kind === 'remind_plan' ? s.remind_plan_at : s.remind_done_at)) continue;
      for (const t of targets) {
        const m = byId.get(t.id);
        if (kind === 'remind_plan' ? m.sum.plan_written : m.sum.done_written) continue;
        out[kind].push(await sendReminder({ kind, date: clock.ymd, user: t, settings: s, deps }, q));
      }
    }
  }
  if (s.summary_enabled) {
    if (dueAt(clock, s.summary_plan_at)) out.sum_plan = await sendSummary({ kind: 'sum_plan', date: clock.ymd, settings: s, hm: s.summary_plan_at, deps }, q);
    if (dueAt(clock, s.summary_done_at)) out.sum_done = await sendSummary({ kind: 'sum_done', date: clock.ymd, settings: s, hm: s.summary_done_at, deps }, q);
  }
  return out;
}

export function startWorkplanWorker(app) {
  if (globalThis.__refatrixWorkplanWorker) return;
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try { await runWorkplanJob({}); } catch (e) { app && app.log && app.log.warn({ err: String(e && e.message) }, '[workplan] job failed'); }
    finally { busy = false; }
  };
  // unref: 이 타이머만 남았을 때 프로세스를 붙잡지 않는다(테스트가 portalBoardRoutes 를 불러도 정상 종료)
  const iv = setInterval(() => { tick(); }, 300000); if (iv.unref) iv.unref();
  const t0 = setTimeout(() => { tick(); }, 35000); if (t0.unref) t0.unref();
  globalThis.__refatrixWorkplanWorker = iv;
}

// 다음 자동 발송 시각(설정 화면 안내용)
export function nextRuns(s, clock) {
  const list = [];
  for (let k = 0; k < 8 && list.length < 4; k++) {
    const d = addDays(clock.ymd, k);
    if (!isWorkday(s, d)) continue;
    const add = (kind, hm, on) => { if (on && (k > 0 || hmToMin(hm) > clock.min)) list.push({ kind, date: d, at: hm }); };
    add('remind_plan', s.remind_plan_at, s.remind_enabled); add('sum_plan', s.summary_plan_at, s.summary_enabled);
    add('remind_done', s.remind_done_at, s.remind_enabled); add('sum_done', s.summary_done_at, s.summary_enabled);
  }
  return list.sort((a, b) => (a.date + a.at).localeCompare(b.date + b.at)).slice(0, 4);
}
