// =====================================================================
// Refatrix ERP · waSchedule.js — WhatsApp 자동 발송 시각(작업별) · 0262
//   디렉터 요청(2026-10-08): 「매일 멕시코 시각 오후 6시로」 + 시각을 정하는 화면.
//   모든 시각은 멕시코 현지(UTC-6 고정 — workingHours.MX_OFFSET_MIN 과 같은 규칙).
//
//   발송 판정(isDue): 지금 시각 ≥ 설정 시각 이고, 설정 시각 + WINDOW_MIN 이내(같은 날 안).
//     → 서버가 잠깐 멈춰도 그 창 안에서는 따라잡고, 창이 지나면 그날은 보내지 않는다
//       (오후에 새로 추가한 수신자에게 아침 보고가 뒤늦게 가는 일 방지 — 예전 「정오까지」 규칙의 일반화).
//   대상일(target_day): today = 그날 마감분 · yesterday = 전날분.
// =====================================================================
import { query } from './db.js';
import { MX_OFFSET_MIN } from './workingHours.js';

export const WINDOW_MIN = 360;   // 설정 시각부터 6시간(자정 넘기지 않음)
export const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
export const TARGETS = ['today', 'yesterday'];

export const JOBS = {
  treasury_daily:   { label: '일일 자금 요약', send_time: '18:00', target_day: 'today', enabled: true, skip_empty_sunday: true },
  treasury_monthly: { label: '월간 자금실적', send_time: '18:00', target_day: 'today', enabled: true, skip_empty_sunday: false },
  daily_summary:    { label: '오늘 요약(AI)', send_time: '05:00', target_day: 'yesterday', enabled: true, skip_empty_sunday: false },
};
export const isJob = (j) => Object.prototype.hasOwnProperty.call(JOBS, j);

export function mxParts(nowMs = (process.env.TREASURY_FAKE_NOW ? Date.parse(process.env.TREASURY_FAKE_NOW) : Date.now())) {
  const m = new Date(nowMs + MX_OFFSET_MIN * 60000);
  return { ymd: m.toISOString().slice(0, 10), hour: m.getUTCHours(), minute: m.getUTCMinutes(), day: m.getUTCDate(),
    minutes: m.getUTCHours() * 60 + m.getUTCMinutes() };
}
export const toMinutes = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
export function addDaysYmd(ymd, n) { const [y, m, d] = ymd.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d)); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }

// 순수 판정 — cfg: {send_time, target_day, enabled}, now: mxParts()
export function isDue(cfg, now) {
  if (!cfg || cfg.enabled === false) return false;
  const start = toMinutes(cfg.send_time);
  const end = Math.min(start + WINDOW_MIN, 24 * 60 - 1);
  return now.minutes >= start && now.minutes <= end;
}
export function targetDate(cfg, now) { return cfg.target_day === 'today' ? now.ymd : addDaysYmd(now.ymd, -1); }

// 다음 발송 예정(표시용) — 'YYYY-MM-DD HH:MM'
export function nextRun(cfg, now) {
  if (!cfg || cfg.enabled === false) return null;
  const day = now.minutes < toMinutes(cfg.send_time) ? now.ymd : addDaysYmd(now.ymd, 1);
  return `${day} ${cfg.send_time}`;
}

export function normalizeCfg(job, row) {
  const d = JOBS[job];
  const r = row || {};
  return {
    job, label: d.label,
    send_time: TIME_RE.test(String(r.send_time || '')) ? r.send_time : d.send_time,
    target_day: TARGETS.includes(r.target_day) ? r.target_day : d.target_day,
    enabled: r.enabled == null ? d.enabled : r.enabled === true,
    skip_empty_sunday: r.skip_empty_sunday == null ? d.skip_empty_sunday : r.skip_empty_sunday === true,
    updated_at: r.updated_at || null, updated_by_name: r.updated_by_name || null,
  };
}

// 30초 캐시(5분 주기 스케줄러가 매번 DB 를 치지 않도록). 저장 시 clearScheduleCache().
let _cache = { at: 0, rows: null };
export function clearScheduleCache() { _cache = { at: 0, rows: null }; }
export async function loadSchedules(q = query, { fresh = false } = {}) {
  if (!fresh && _cache.rows && Date.now() - _cache.at < 30000) return _cache.rows;
  let rows = [];
  try {
    rows = (await q(`SELECT s.job, s.send_time, s.target_day, s.enabled, s.skip_empty_sunday, s.updated_at, u.name AS updated_by_name
                       FROM wa_schedules s LEFT JOIN users u ON u.id = s.updated_by`)).rows;
  } catch (_) { rows = []; }   // 0262 전: 기본값
  const by = Object.fromEntries(rows.map((r) => [r.job, r]));
  const out = Object.fromEntries(Object.keys(JOBS).map((j) => [j, normalizeCfg(j, by[j])]));
  _cache = { at: Date.now(), rows: out };
  return out;
}
export async function loadSchedule(job, q = query) { return (await loadSchedules(q))[job]; }
