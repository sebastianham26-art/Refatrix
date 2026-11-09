// =====================================================================
// Refatrix ERP · devReqPush.js — 개발요청(고객요청 개발필요) → REFATRIX Platform 이벤트 전송 (2026-11-09)
//
//   플랫폼 「SYD 제품 카탈로그」의 0순위 = 고객요청 개발필요. ERP 개발요청 대장의 **미완료 건**을
//   SYD 코드(검토 SYD 가 있으면 그것, 없으면 경쟁사 입력코드)별로 묶어 플랫폼 RPC app_devreq_push 로 보낸다.
//
//   원천 = product_dev_requests
//     · 대상: deleted_at IS NULL · status IN ('received','reviewed','factory_requested')  (= 개발필요내용 「미완료」)
//     · 코드: COALESCE(review_syd_code, input_code) — 한 칸에 여러 코드면 「, ; / |」·줄바꿈으로 나눔(4자 미만 조각 버림,
//             devMatchSweep.devRequestKeys 와 같은 규칙) · 묶음 키 = normCode(대소문자·기호 무시)
//     · qty: 요청수량 합계(미입력 요청은 1 — 부족분 적재와 같은 「최소 1개 신호」 규칙)
//     · first_at / last_at: 요청일(=견적일) 최소·최대
//     · note: 「요청 N건 · 고객 M곳」  · customer: 보내지 않음(고객명은 플랫폼에 넘기지 않는다)
//     · 가격·매출은 보내지 않는다.
//
//   언제 보내나 — 「무엇이 바뀌었는지」를 호출자가 알 필요가 없게, **DB 현재 상태와 마지막 전송본을 비교(diff)** 한다.
//     · 이벤트: 개발요청이 생기거나·바뀌거나·해제되는 지점에서 scheduleDevReqPush() 만 부른다(5초 디바운스).
//               → 바뀐 코드만 upsert, 목록에서 빠진 코드만 delete.
//     · 기동 45초 뒤 1회 replace(전체) — 서버 재시작 = 전체 동기화.
//     · 매일 멕시코 04:00 이후 첫 점검에서 replace 1회.
//     · 10분마다 diff 점검(놓친 이벤트 줍기 — 견적 전환 시 고객 지정 등).
//     · 실패하면 마지막 전송본을 갱신하지 않는다 → 다음 점검이 같은 차이를 다시 보낸다. 견적 흐름은 절대 막지 않는다.
//
//   비밀키: 환경변수 REFATRIX_DEVREQ_KEY (Railway 변수 또는 ERP 관리 › 외부 서비스 키). 없으면 아무것도 하지 않는다.
// =====================================================================
import { query } from './db.js';
import { normCode } from './devDemand.js';
import { mxTodayStr, MX_OFFSET_MIN } from './workingHours.js';

const PF_URL = () => (process.env.PLATFORM_SUPA_URL || 'https://hvwteeecvukddmurzlfm.supabase.co').replace(/\/$/, '');
const PF_ANON = () => process.env.PLATFORM_SUPA_KEY || 'sb_publishable_-hlx1MHlTNEwyif6nePYHA_ue_r8mV0';
const KEY = () => String(process.env.REFATRIX_DEVREQ_KEY || '').trim();
export const devReqPushEnabled = () => !!KEY() && process.env.DEVREQ_PUSH_ENABLED !== '0';

const OPEN = ['received', 'reviewed', 'factory_requested'];
const SPLIT_RE = /[,;/|\n\r]+/;
const CHUNK = 500;
const DAILY_HOUR_MX = 4;

function ymd(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
// 요청일(날짜) → 플랫폼 시각 문자열. 첫 요청은 그날 00:00, 마지막 요청은 그날 23:59:59 (멕시코 시각 → UTC).
function mxIso(d, endOfDay) {
  if (!d) return undefined;
  const base = Date.parse(d + 'T00:00:00Z');
  if (!Number.isFinite(base)) return undefined;
  const ms = base - MX_OFFSET_MIN * 60000 + (endOfDay ? 86399000 : 0);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 개발요청 1건이 대표하는 코드(원문 표기) 목록. */
export function devReqCodes(r) {
  const src = String((r && (String(r.review_syd_code || '').trim() || r.input_code)) || '').trim();
  if (!src) return [];
  const parts = src.split(SPLIT_RE).map((x) => x.trim()).filter(Boolean);
  if (parts.length <= 1) return normCode(src) ? [src.toUpperCase()] : [];
  return parts.filter((p) => normCode(p).length >= 4).map((p) => p.toUpperCase());
}

/**
 * 대장 행 → 플랫폼 항목(순수 함수 · 시험용).
 *   rows: {id, input_code, review_syd_code, requested_qty, requested_at, customer_id, status, deleted_at?}
 *   반환: Map(norm → {syd, qty, first_at, last_at, note})
 */
export function buildDevReqItems(rows) {
  const g = new Map();
  for (const r of rows || []) {
    if (!r || r.deleted_at || !OPEN.includes(String(r.status || ''))) continue;
    const q = Number(r.requested_qty) > 0 ? Number(r.requested_qty) : 1;
    const d = ymd(r.requested_at);
    const seenInRow = new Set();
    for (const code of devReqCodes(r)) {
      const n = normCode(code);
      if (!n || seenInRow.has(n)) continue;
      seenInRow.add(n);
      let e = g.get(n);
      if (!e) { e = { forms: new Map(), qty: 0, reqs: 0, custs: new Set(), anon: 0, first: null, last: null }; g.set(n, e); }
      e.forms.set(code, (e.forms.get(code) || 0) + 1);
      e.qty += q; e.reqs += 1;
      if (r.customer_id != null) e.custs.add(Number(r.customer_id)); else e.anon += 1;
      if (d) { if (!e.first || d < e.first) e.first = d; if (!e.last || d > e.last) e.last = d; }
    }
  }
  const out = new Map();
  for (const [n, e] of g) {
    // 대표 표기 = 가장 많이 쓴 표기(같으면 하이픈 있는 쪽 → 사전순) — 묶음 안에서 결정적
    const syd = [...e.forms.entries()].sort((a, b) => b[1] - a[1]
      || (b[0].includes('-') - a[0].includes('-')) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0][0];
    const custN = e.custs.size;
    const note = `요청 ${e.reqs}건 · 고객 ${custN}곳${e.anon ? ` (불특정 ${e.anon}건)` : ''}`;
    const it = { syd, qty: Math.round(e.qty * 100) / 100, note };
    const fa = mxIso(e.first, false), la = mxIso(e.last, true);
    if (fa) it.first_at = fa;
    if (la) it.last_at = la;
    out.set(n, it);
  }
  return out;
}

export async function loadDevReqItems(exec = query) {
  const rows = (await exec(
    `SELECT id, input_code, review_syd_code, requested_qty, to_char(requested_at,'YYYY-MM-DD') AS requested_at,
            customer_id, status
       FROM product_dev_requests
      WHERE deleted_at IS NULL AND status IN ('received','reviewed','factory_requested')
      ORDER BY id`)).rows;
  return buildDevReqItems(rows);
}

/** 마지막 전송본(prev) 과 현재(cur) 비교 → {upserts:[item], deletes:[{syd}]} */
export function diffDevReq(prev, cur) {
  const upserts = [], deletes = [];
  for (const [n, it] of cur) {
    const p = prev.get(n);
    if (p && p.syd !== it.syd) deletes.push({ syd: p.syd });   // 대표 표기가 바뀜 → 옛 표기 해제
    if (!p || JSON.stringify(p) !== JSON.stringify(it)) upserts.push(it);
  }
  for (const [n, p] of prev) if (!cur.has(n)) deletes.push({ syd: p.syd });
  return { upserts, deletes };
}

/** 플랫폼 RPC 1회 호출. → {ok, status, body} — 예외를 던지지 않는다. */
export async function pushDevReq(mode, items) {
  if (!devReqPushEnabled()) return { ok: false, skipped: 'no_key' };
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(PF_URL() + '/rest/v1/rpc/app_devreq_push', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', apikey: PF_ANON(), Authorization: 'Bearer ' + PF_ANON() },
      body: JSON.stringify({ p_key: KEY(), p_mode: mode, p_items: items }),
    });
    const txt = await r.text().catch(() => '');
    let body = null; try { body = JSON.parse(txt); } catch (_) { body = txt.slice(0, 300); }
    if (!r.ok) console.error('[devreq push]', mode, r.status, typeof body === 'string' ? body : JSON.stringify(body).slice(0, 300));
    return { ok: r.ok && !(body && body.ok === false), status: r.status, body };
  } catch (e) {
    console.error('[devreq push]', mode, e && e.name === 'AbortError' ? 'timeout' : (e && e.message));
    return { ok: false, status: 0, error: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally { clearTimeout(t); }
}

// ── 상태(프로세스 메모리) ──
const S = {
  last: null,            // Map(norm → item) — 마지막으로 플랫폼이 받은 목록. null = 아직 전체 동기화 전
  lastReplaceDay: null,  // 'YYYY-MM-DD'(멕시코) — 일 1회 replace 가드
  running: false, again: false, timer: null,
  log: [],               // 최근 20건 {at, mode, n, ok, status, ver, total, error}
};
function note(mode, n, res) {
  const b = res && res.body && typeof res.body === 'object' ? res.body : {};
  S.log.unshift({ at: new Date().toISOString(), mode, n, ok: !!(res && res.ok), status: res ? res.status : null,
    ver: b.ver ?? null, total: b.total ?? null, error: res && !res.ok ? (res.error || res.skipped || (typeof res.body === 'string' ? res.body : b.message) || 'fail') : null });
  S.log.length = Math.min(S.log.length, 20);
}
export function devReqPushState() {
  return { enabled: devReqPushEnabled(), synced: !!S.last, last_count: S.last ? S.last.size : null,
    last_replace_day: S.lastReplaceDay, log: S.log.slice() };
}
export function _resetDevReqPush() { S.last = null; S.lastReplaceDay = null; S.log = []; S.running = false; S.again = false; if (S.timer) clearTimeout(S.timer); S.timer = null; }

/**
 * 동기화 1회. mode: 'auto'(diff, 처음이면 replace) | 'replace'(전체)
 *   → {ok, mode, sent:{upsert, delete, replace}}
 */
export async function syncDevReq({ mode = 'auto', exec = query } = {}) {
  if (!devReqPushEnabled()) return { ok: false, skipped: 'no_key' };
  const cur = await loadDevReqItems(exec);
  if (mode === 'replace' || !S.last) {
    const items = [...cur.values()];
    const res = await pushDevReq('replace', items);
    note('replace', items.length, res);
    if (res.ok) { S.last = cur; S.lastReplaceDay = mxTodayStr(new Date()); }
    return { ok: res.ok, mode: 'replace', sent: { replace: items.length }, result: res.body };
  }
  const { upserts, deletes } = diffDevReq(S.last, cur);
  let ok = true;
  // 삭제 먼저(대표 표기가 바뀐 코드가 같은 호출 안에서 지워졌다 다시 생기게)
  for (let i = 0; i < deletes.length; i += CHUNK) {
    const part = deletes.slice(i, i + CHUNK);
    const res = await pushDevReq('delete', part); note('delete', part.length, res);
    if (!res.ok) { ok = false; break; }
  }
  if (ok) for (let i = 0; i < upserts.length; i += CHUNK) {
    const part = upserts.slice(i, i + CHUNK);
    const res = await pushDevReq('upsert', part); note('upsert', part.length, res);
    if (!res.ok) { ok = false; break; }
  }
  if (ok) S.last = cur;   // 실패 시 그대로 둔다 → 다음 점검이 같은 차이를 다시 보낸다
  return { ok, mode: 'diff', sent: { upsert: upserts.length, delete: deletes.length } };
}

/** 개발요청이 바뀐 지점에서 부른다 — 응답을 기다리게 하지 않고, 연속 변경은 1회로 묶는다. */
export function scheduleDevReqPush({ delayMs = 5000 } = {}) {
  if (!devReqPushEnabled()) return;
  if (S.running) { S.again = true; return; }
  if (S.timer) clearTimeout(S.timer);
  S.timer = setTimeout(runScheduled, Math.max(0, Number(delayMs) || 0));
  if (S.timer && typeof S.timer.unref === 'function') S.timer.unref();
}
async function runScheduled(mode = 'auto') {
  S.timer = null;
  if (S.running) { S.again = true; return; }
  S.running = true;
  try { await syncDevReq({ mode }); } catch (e) { console.error('[devreq push]', e && e.message); }
  S.running = false;
  if (S.again) { S.again = false; scheduleDevReqPush({ delayMs: 1000 }); }
}

/** 키를 새로 저장했을 때 — 마지막 전송본을 버리고 곧바로 전체(replace) 전송. 응답을 기다리게 하지 않는다. */
export function resyncDevReqNow() {
  S.last = null;
  if (!devReqPushEnabled()) return false;
  if (S.timer) { clearTimeout(S.timer); S.timer = null; }
  if (S.running) { S.again = true; return true; }   // 끝난 뒤 한 번 더(S.last=null 이라 replace)
  runScheduled('replace').catch(() => {});
  return true;
}

/** 기동 시 1회 replace + 10분마다 점검(멕시코 04시 이후 그날 첫 점검은 replace). */
export function startDevReqPushWorker() {
  if (globalThis.__refatrixDevReqPush) return;
  const tick = () => {
    if (!devReqPushEnabled() || S.running) return;
    const mxNow = new Date(Date.now() + MX_OFFSET_MIN * 60000);
    const daily = mxNow.getUTCHours() >= DAILY_HOUR_MX && S.lastReplaceDay !== mxTodayStr(new Date());
    runScheduled(daily ? 'replace' : 'auto').catch(() => {});
  };
  globalThis.__refatrixDevReqPush = setInterval(tick, 600000);
  if (typeof globalThis.__refatrixDevReqPush.unref === 'function') globalThis.__refatrixDevReqPush.unref();
  const t = setTimeout(() => { if (devReqPushEnabled() && !S.running) runScheduled('replace').catch(() => {}); }, 45000);
  if (typeof t.unref === 'function') t.unref();
}
