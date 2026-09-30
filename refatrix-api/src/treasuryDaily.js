// =====================================================================
// Refatrix ERP · treasuryDaily.js — 일일 자금(AP/AR) 스냅샷 · 월간실적 · WhatsApp 문구
//   디렉터 요청(2026-09-30): 재무의 「일일 AP/AR 요약」(은행잔고 → AR → 환율 → AP → 마감잔고
//   → MXN 환산) 양식을 ERP 가 매일 자동으로 만들어 누적하고, 월간실적(실제 입출금 누계 +
//   일별 잔고 추이)을 만들어 지정된 사람에게만 WhatsApp 으로 보낸다.
//
//   ── 숫자의 정의(= 재무/계좌 화면 잔액과 100% 같은 공식) ──
//   · 은행잔고(통화별, 계좌 통화 기준 원화폐): Σ open_balance + Σ 실적(status='actual' AND approved)
//       in:+amount / out:-amount — /api/accounts 의 balance 와 동일. 삭제 계좌·삭제 거래 제외.
//       open_date 가 있는 계좌는 그날부터 잔고에 들어간다(그 전 날짜의 기초엔 없음 → 개설일 「계좌 개설」 조정).
//   · AR(수금) = 그날 실제 입금 거래 / AP(지급) = 그날 실제 출금 거래. 승인 대기 실적은 잔고 제외, 건수만 표시.
//   · 집계 대상 계좌(0241): 불공제(non_deductible) 계좌와 금고(이름·유형에 금고/caja/efectivo/현금/cash)는
//       자동 제외. 계좌별 강제 포함/제외는 accounts.treasury_exclude(화면 📲 탭 「집계 대상 계좌」).
//       제외 계좌의 기초잔액·실적·예정·승인대기는 전부 빠진다. 계좌 미지정 예정지출·미수 인보이스는 포함.
//   · MXN 환산 = MXN + USD × 그날 환율(환율 탭, 없으면 직전 값) — 유첨 엑셀 맨 아래 줄과 같은 계산.
//   · 예정(오늘 이후): 미수 인보이스(만기일·잔여액) + 수동 예정수입 + 예정지출(비활성 고정비 제외).
//     오늘 이전의 미실현 예정은 「오늘」 칸으로 이월(현금흐름 07-05 carry-forward 규칙과 동일).
//
//   ── 스케줄 (멕시코 시간, UTC-6 고정) ──
//   · 매일 06:00 이후: 어제까지의 이번 달 스냅샷 갱신 → 일일 요약 발송(06~12시 창, 일요일 무거래는 생략)
//   · 매월 1~3일 06:00 이후: 전월 월간실적 발송(수신자별 성공 1회)
//   · 실패는 5분 간격 최대 5회 재시도. WhatsApp 미설정이어도 스냅샷 누적은 계속된다.
//   · 발송 형식(15:13 지시): 표 이미지(PNG) + 한 줄 캡션. 실패 시 이미지 헤더 템플릿(TREASURY_WA_IMAGE_TEMPLATE) → 텍스트 순으로 대체.
//     TREASURY_WA_FORMAT=text 면 예전 텍스트 방식.
//   · TREASURY_DAILY_ENABLED=0 → 전체 끄기 · TREASURY_WA_TEMPLATE → 24h 창 밖 폴백 템플릿(없으면 WHATSAPP_TEMPLATE)
// =====================================================================
import { query } from './db.js';
import { getFxRange, getRateForDate } from './fx.js';
import { AR_PAID_EPS } from './ar.js';
import { MX_OFFSET_MIN } from './workingHours.js';
import { waApiReady, sendWaTo, uploadWaMedia, sendWaImage, sendWaImageTemplate } from './waSend.js';
import { dailyImageSvg, monthlyImageSvg, svgToPng } from './treasuryImage.js';

export const CURS = ['MXN', 'USD'];
export const SEND_HOUR_MX = 6;          // 06:00 이후 발송
export const DAILY_SEND_UNTIL_MX = 12;  // 자동 일일 발송은 정오까지만(오후에 추가된 수신자에게 어제 요약이 뒤늦게 가지 않도록)
export const MONTHLY_CATCHUP_DAYS = 3;  // 1~3일 사이 월간 발송(서버 중단 대비)
export const MAX_ATTEMPTS = 5;
export const ITEM_LINES = 8;            // WA 본문에 항목 최대 줄 수(통화·방향별)
export const DEFAULT_REPORT_URL = 'https://sebastianham26-art.github.io/Refatrix/refatrix-cashdaily.html';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isYmd = (s) => DATE_RE.test(String(s || '')) && !isNaN(Date.parse(s + 'T00:00:00Z'));
export const isMonth = (s) => MONTH_RE.test(String(s || ''));

// ───────────────────────── 순수 도우미 ─────────────────────────
export function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
const zero = () => ({ MXN: 0, USD: 0 });
const cur = (c) => (String(c || '').toUpperCase() === 'USD' ? 'USD' : 'MXN');

export function addDays(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
export function dowOf(ymd) { const [y, m, d] = String(ymd).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); } // 0=일
export function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}
export function prevMonth(month) { const { from } = monthBounds(month); return addDays(from, -1).slice(0, 7); }
export function weekStart(ymd) { const w = dowOf(ymd); return addDays(ymd, -((w + 6) % 7)); } // 월요일
export function dateList(from, to) { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; }

// 멕시코 현재(UTC-6 고정 — workingHours 와 동일 규칙)
export function mxNow(nowMs = Date.now()) {
  const m = new Date(nowMs + MX_OFFSET_MIN * 60000);
  return { ymd: m.toISOString().slice(0, 10), hour: m.getUTCHours(), day: m.getUTCDate() };
}

// 환율: 기간 내 일자별 값(없는 날은 직전 값, 첫날 이전 값은 seed)
export function fxFill(rows, from, to, seed) {
  const by = new Map((rows || []).map((r) => [String(r.rate_date).slice(0, 10), Number(r.rate)]));
  const out = new Map();
  let last = Number(seed) || null;
  for (const d of dateList(from, to)) {
    if (by.has(d) && by.get(d) > 0) last = by.get(d);
    out.set(d, last);
  }
  return out;
}

// 거래 → 표시 이름. 입금: 고객(인보이스·선수금·통장입금·태그) › 송금인 메모 › 메모 › 계정과목
//                  출금: 고정비 이름(Nomina Maria 등) › 메모 › 계정과목
export function itemName(t) {
  const clean = (s) => String(s || '').replace(/^\[고정비\]\s*/, '').trim();
  if (t.direction === 'in') {
    return clean(t.customer_name) || clean(t.payer_memo) || clean(t.memo) || clean(t.category_name) || '입금';
  }
  return clean(t.rule_name) || clean(t.memo) || clean(t.category_name) || '지출';
}

function toItem(t, extra = {}) {
  return {
    id: t.id != null ? Number(t.id) : null,
    dir: t.direction === 'in' ? 'in' : 'out',
    cur: cur(t.currency),
    amount: r2(t.amount),
    amount_mxn: r2(t.amount_mxn != null ? t.amount_mxn : t.amount),
    name: itemName(t),
    category: t.category_name || null,
    account: t.account_name || null,
    sat_no: t.sat_no || null,
    private: t.is_private === true,
    ...extra,
  };
}

// ── 실적 일자별 구성 ──
//   base   : from 전날 마감 잔고(통화별)
//   opens  : 기간 안에 개설된 계좌 [{d, currency, amount}] → 그날 「계좌 개설」 조정
//   txns   : 기간 안 승인 실적 [{id, d, direction, currency, amount, amount_mxn, …이름필드}]
//   pending: 승인 대기 실적 [{d, n, amount_mxn}]
//   fx     : Map(date → rate)
export function buildDays({ from, to, base, opens = [], txns = [], pending = [], fx = new Map() }) {
  const days = [];
  let run = { MXN: r2((base && base.MXN) || 0), USD: r2((base && base.USD) || 0) };
  const cum = { in: zero(), out: zero(), in_eq: 0, out_eq: 0 };
  const byDate = new Map();
  for (const t of txns) { const d = String(t.d).slice(0, 10); if (!byDate.has(d)) byDate.set(d, []); byDate.get(d).push(t); }
  const openBy = new Map(); for (const o of opens) { const k = String(o.d).slice(0, 10); if (!openBy.has(k)) openBy.set(k, zero()); openBy.get(k)[cur(o.currency)] += Number(o.amount) || 0; }
  const pendBy = new Map(); for (const p of pending) { const k = String(p.d).slice(0, 10); const x = pendBy.get(k) || { n: 0, amount_mxn: 0 }; x.n += Number(p.n) || 0; x.amount_mxn = r2(x.amount_mxn + (Number(p.amount_mxn) || 0)); pendBy.set(k, x); }
  for (const d of dateList(from, to)) {
    const fxr = fx.get(d) || null;
    const open = { ...run };
    const adj = openBy.get(d) || zero();
    const inn = zero(), out = zero();
    let in_eq = 0, out_eq = 0;
    const items = (byDate.get(d) || []).map((t) => toItem(t));
    for (const it of items) {
      if (it.dir === 'in') { inn[it.cur] = r2(inn[it.cur] + it.amount); in_eq = r2(in_eq + it.amount_mxn); }
      else { out[it.cur] = r2(out[it.cur] + it.amount); out_eq = r2(out_eq + it.amount_mxn); }
    }
    const close = {};
    for (const c of CURS) close[c] = r2(open[c] + adj[c] + inn[c] - out[c]);
    for (const c of CURS) { cum.in[c] = r2(cum.in[c] + inn[c]); cum.out[c] = r2(cum.out[c] + out[c]); }
    cum.in_eq = r2(cum.in_eq + in_eq); cum.out_eq = r2(cum.out_eq + out_eq);
    days.push({
      date: d, dow: dowOf(d), kind: 'actual', fx: fxr,
      open, adj: { MXN: r2(adj.MXN), USD: r2(adj.USD) }, in: inn, out, close,
      in_eq, out_eq,
      open_eq: fxr ? r2(open.MXN + open.USD * fxr) : null,
      close_eq: fxr ? r2(close.MXN + close.USD * fxr) : null,
      items: items.sort((a, b) => (a.dir === b.dir ? b.amount_mxn - a.amount_mxn : (a.dir === 'in' ? -1 : 1))),
      pending: pendBy.get(d) || { n: 0, amount_mxn: 0 },
      moved: items.length > 0 || adj.MXN !== 0 || adj.USD !== 0,
      cum: { in: { ...cum.in }, out: { ...cum.out }, in_eq: cum.in_eq, out_eq: cum.out_eq },
    });
    run = close;
  }
  return days;
}

// ── 예정(오늘 이후) 일자별 구성 ──
//   startOpen: 오늘 기초(= 어제 실적 마감) · todayActual: 오늘 이미 들어온 실적 거래(목록)
//   invoices : 미수 인보이스 [{id, due, outstanding, customer_name, sat_no}] (MXN)
//   planIn/planOut: 예정 거래 [{id, d, direction, currency, amount, amount_mxn, …}]
//   오늘 이전 만기/예정은 오늘 칸으로 이월(carry=true, late_days).
export function projectDays({ today, to, startOpen, todayActual = [], invoices = [], planIn = [], planOut = [], fx = new Map() }) {
  const days = [];
  let run = { MXN: r2(startOpen.MXN || 0), USD: r2(startOpen.USD || 0) };
  const slot = (d) => (d < today ? today : d);
  const late = (d) => (d < today ? Math.round((Date.parse(today) - Date.parse(d)) / 86400000) : 0);
  const bucket = new Map();
  const push = (d, it) => { if (d > to) return; if (!bucket.has(d)) bucket.set(d, []); bucket.get(d).push(it); };
  for (const t of todayActual) push(today, toItem(t, { state: 'actual' }));
  for (const iv of invoices) {
    const out = Number(iv.outstanding) || 0;
    if (out < AR_PAID_EPS) continue;
    const d0 = String(iv.due).slice(0, 10);
    push(slot(d0), toItem({ id: iv.id, direction: 'in', currency: 'MXN', amount: out, amount_mxn: out,
      customer_name: iv.customer_name, sat_no: iv.sat_no }, { state: 'plan', src: 'inv', due: d0, late_days: late(d0) }));
  }
  for (const t of [...planIn, ...planOut]) {
    const d0 = String(t.d).slice(0, 10);
    push(slot(d0), toItem(t, { state: 'plan', src: t.recurring_rule_id ? 'fix' : (t.direction === 'in' ? 'man' : 'plan'), due: d0, late_days: late(d0) }));
  }
  for (const d of dateList(today, to)) {
    const fxr = fx.get(d) || null;
    const open = { ...run };
    const items = (bucket.get(d) || []).sort((a, b) => (a.dir === b.dir ? b.amount_mxn - a.amount_mxn : (a.dir === 'in' ? -1 : 1)));
    const inn = zero(), out = zero(); let in_eq = 0, out_eq = 0;
    for (const it of items) {
      if (it.dir === 'in') { inn[it.cur] = r2(inn[it.cur] + it.amount); in_eq = r2(in_eq + it.amount_mxn); }
      else { out[it.cur] = r2(out[it.cur] + it.amount); out_eq = r2(out_eq + it.amount_mxn); }
    }
    const close = {}; for (const c of CURS) close[c] = r2(open[c] + inn[c] - out[c]);
    days.push({ date: d, dow: dowOf(d), kind: d === today ? 'today' : 'plan', fx: fxr, open, adj: zero(), in: inn, out, close,
      in_eq, out_eq, open_eq: fxr ? r2(open.MXN + open.USD * fxr) : null, close_eq: fxr ? r2(close.MXN + close.USD * fxr) : null,
      items, pending: { n: 0, amount_mxn: 0 }, moved: items.length > 0 });
    run = close;
  }
  return days;
}

// ── 월간실적 요약 ──
//   mask=true 면 비공개(is_private) 항목을 하나(「비공개」)로 묶는다(WhatsApp 용).
export function summarizeMonth(days, { mask = false } = {}) {
  if (!days.length) return null;
  const first = days[0], last = days[days.length - 1];
  const inn = zero(), out = zero(), adj = zero();
  let in_eq = 0, out_eq = 0, pn = 0, pa = 0;
  const gIn = new Map(), gOut = new Map(), gCat = new Map();
  const add = (mp, key, name, it) => { const x = mp.get(key) || { name, amount_mxn: 0, n: 0, private: false }; x.amount_mxn = r2(x.amount_mxn + it.amount_mxn); x.n += 1; if (it.private) x.private = true; mp.set(key, x); };
  let min = null, max = null, moved = 0;
  for (const d of days) {
    for (const c of CURS) { inn[c] = r2(inn[c] + d.in[c]); out[c] = r2(out[c] + d.out[c]); adj[c] = r2(adj[c] + d.adj[c]); }
    in_eq = r2(in_eq + d.in_eq); out_eq = r2(out_eq + d.out_eq);
    pn += d.pending.n; pa = r2(pa + d.pending.amount_mxn);
    if (d.moved) moved += 1;
    if (d.close_eq != null) {
      if (!min || d.close_eq < min.close_eq) min = { date: d.date, close_eq: d.close_eq };
      if (!max || d.close_eq > max.close_eq) max = { date: d.date, close_eq: d.close_eq };
    }
    for (const it of d.items) {
      const hide = mask && it.private;
      const key = hide ? '__private' : it.name;
      if (it.dir === 'in') add(gIn, key, hide ? '__private' : it.name, it);
      else {
        add(gOut, key, hide ? '__private' : it.name, it);
        const ck = hide ? '__private' : (it.category || '기타');
        add(gCat, ck, ck, it);
      }
    }
  }
  const top = (mp, n = 10) => [...mp.values()].sort((a, b) => b.amount_mxn - a.amount_mxn).slice(0, n);
  return {
    month: first.date.slice(0, 7), from: first.date, to: last.date, days_n: days.length, moved_days: moved,
    open: { ...first.open }, open_eq: first.open_eq, close: { ...last.close }, close_eq: last.close_eq,
    fx_first: first.fx, fx_last: last.fx,
    in: inn, out, adj, in_eq, out_eq, net_eq: r2(in_eq - out_eq),
    in_n: days.reduce((s, d) => s + d.items.filter((i) => i.dir === 'in').length, 0),
    out_n: days.reduce((s, d) => s + d.items.filter((i) => i.dir === 'out').length, 0),
    top_in: top(gIn), top_out: top(gOut), by_category_out: top(gCat, 12),
    min, max, pending: { n: pn, amount_mxn: pa },
  };
}

// 스냅샷(저장본) vs 지금 원장 재계산 비교 — 사후 수정(소급 등록·삭제) 감지
export function driftOf(stored, live) {
  if (!stored || !live) return null;
  const f = (o, k) => r2((o && o[k]) || 0);
  const diff = {};
  let any = false;
  for (const k of ['close_mxn', 'close_usd', 'in_mxn', 'in_usd', 'out_mxn', 'out_usd']) {
    const dv = r2(f(live, k) - f(stored, k));
    if (Math.abs(dv) >= 0.5) { diff[k] = dv; any = true; }
  }
  return any ? diff : null;
}
export const flatOf = (d) => ({
  close_mxn: d.close.MXN, close_usd: d.close.USD, in_mxn: d.in.MXN, in_usd: d.in.USD, out_mxn: d.out.MXN, out_usd: d.out.USD,
});

// ───────────────────────── WhatsApp 문구 ─────────────────────────
const L = {
  es: {
    dow: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
    months: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
    dailyTitle: '💰 Refatrix · Resumen diario de caja', monthlyTitle: '📊 Refatrix · Resultado mensual de caja',
    open: 'Saldo inicial', close: 'Saldo final', ar: 'Cobros (AR)', ap: 'Pagos (AP)', eq: 'Equiv. MXN', fx: 'TC',
    none: 'sin movimientos', more: (n) => `…y ${n} más`, adj: 'Alta de cuenta',
    mtd: (m) => `Acumulado del mes (${m})`, inL: 'Cobros', outL: 'Pagos', net: 'Neto',
    plan: (d) => `Programado hoy (${d})`, carry: 'incl. vencidos',
    pend: (n, a) => `⚠ ${n} movimiento(s) pendiente(s) de aprobación · MXN ${a} (no incluido en saldo)`,
    priv: 'Privado', topIn: 'Principales cobros', topOut: 'Principales pagos', cat: 'Por concepto',
    change: 'Variación', minBal: 'Saldo mínimo', maxBal: 'Saldo máximo', moves: (n) => `${n} mov.`, days: (n) => `${n} días con movimiento`,
    link: 'Detalle en ERP', asOf: (d) => `Saldo al ${d}`,
  },
  ko: {
    dow: ['일', '월', '화', '수', '목', '금', '토'],
    months: ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'],
    dailyTitle: '💰 Refatrix · 일일 자금 요약', monthlyTitle: '📊 Refatrix · 월간 자금실적',
    open: '기초잔고', close: '마감잔고', ar: '수금(AR)', ap: '지급(AP)', eq: 'MXN 환산', fx: '환율',
    none: '거래 없음', more: (n) => `…외 ${n}건`, adj: '계좌 개설',
    mtd: (m) => `이번 달 누계 (${m})`, inL: '수금', outL: '지급', net: '순액',
    plan: (d) => `오늘 예정 (${d})`, carry: '연체 이월 포함',
    pend: (n, a) => `⚠ 승인 대기 ${n}건 · MXN ${a} (잔고 미반영)`,
    priv: '비공개', topIn: '주요 수금처', topOut: '주요 지급', cat: '계정과목별',
    change: '증감', minBal: '최저 잔고', maxBal: '최고 잔고', moves: (n) => `${n}건`, days: (n) => `거래일 ${n}일`,
    link: 'ERP 상세', asOf: (d) => `${d} 잔고`,
  },
};
const lg = (lang) => (lang === 'ko' ? L.ko : L.es);
export const fmt0 = (n) => (n == null ? '—' : Math.round(Number(n)).toLocaleString('en-US'));
const sgn = (n) => (Number(n) >= 0 ? '+' : '−') + fmt0(Math.abs(Number(n)));
function dayLabel(ymd, lang) {
  const t = lg(lang); const [, m, d] = ymd.split('-').map(Number);
  return lang === 'ko' ? `${m}/${d}(${t.dow[dowOf(ymd)]})` : `${t.dow[dowOf(ymd)]} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}
function monthLabel(month, lang) { const [y, m] = month.split('-').map(Number); return lang === 'ko' ? `${y}년 ${m}월` : `${lg(lang).months[m - 1]} ${y}`; }
const pair = (o) => `MXN ${fmt0(o.MXN)}` + (Math.abs(o.USD) >= 0.5 ? ` · USD ${fmt0(o.USD)}` : '');
const dispName = (it, lang, mask = true) => ((mask && it.private) || it.name === '__private' ? lg(lang).priv : it.name);

function itemLines(items, lang, n = ITEM_LINES) {
  const out = items.slice(0, n).map((it) => `• ${dispName(it, lang)}${it.sat_no && !it.private ? ` (${it.sat_no})` : ''} ${it.cur === 'USD' ? 'USD ' : ''}${fmt0(it.amount)}${it.late_days ? ` ⏰${it.late_days}d` : ''}`);
  if (items.length > n) out.push(lg(lang).more(items.length - n));
  return out;
}

// 일일 요약 — day: buildDays 의 한 날 · mtd: summarizeMonth(월초~그날) · plan: projectDays 의 발송일(오늘) 1칸(선택)
export function buildDailyText(day, { mtd = null, plan = null, lang = 'es' } = {}) {
  const t = lg(lang);
  const ins = day.items.filter((i) => i.dir === 'in'), outs = day.items.filter((i) => i.dir === 'out');
  const L1 = [`*${t.dailyTitle}*`, `*${dayLabel(day.date, lang)} ${day.date.slice(0, 4)}*`, ''];
  L1.push(`*${t.open}*  ${pair(day.open)}`);
  if (day.adj.MXN || day.adj.USD) L1.push(`${t.adj}  ${pair(day.adj)}`);
  L1.push(`*${t.ar}*  ${ins.length ? pair(day.in) : t.none}`);
  L1.push(...itemLines(ins, lang));
  L1.push(`*${t.ap}*  ${outs.length ? pair(day.out) : t.none}`);
  L1.push(...itemLines(outs, lang));
  L1.push(`*${t.close}*  ${pair(day.close)}`);
  if (day.close_eq != null) L1.push(`${t.eq} *${fmt0(day.close_eq)}* (${t.fx} ${Number(day.fx).toFixed(2)} · ${sgn(r2(day.close_eq - day.open_eq))})`);
  if (day.pending && day.pending.n) L1.push(t.pend(day.pending.n, fmt0(day.pending.amount_mxn)));
  if (mtd) {
    L1.push('', `*${t.mtd(monthLabel(mtd.month, lang))}*`);
    L1.push(`${t.inL} MXN ${fmt0(mtd.in_eq)} · ${t.outL} MXN ${fmt0(mtd.out_eq)} · ${t.net} ${sgn(mtd.net_eq)}`);
  }
  if (plan && plan.items && plan.items.some((i) => i.state === 'plan')) {
    const pi = plan.items.filter((i) => i.state === 'plan' && i.dir === 'in');
    const po = plan.items.filter((i) => i.state === 'plan' && i.dir === 'out');
    const s = (xs) => r2(xs.reduce((a, b) => a + b.amount_mxn, 0));
    const hasCarry = [...pi, ...po].some((i) => i.late_days);
    L1.push('', `*${t.plan(dayLabel(plan.date, lang))}*${hasCarry ? ` · ${t.carry}` : ''}`);
    L1.push(`${t.inL} ${pi.length} · MXN ${fmt0(s(pi))}  |  ${t.outL} ${po.length} · MXN ${fmt0(s(po))}`);
    L1.push(...itemLines([...pi, ...po].sort((a, b) => b.amount_mxn - a.amount_mxn), lang, 5).map((x) => x));
  }
  return clip(L1.join('\n'));
}

export function buildDailyHeadline(day, lang = 'es') {
  const t = lg(lang);
  return `[${t.dailyTitle.replace(/^\S+\s/, '')}] ${dayLabel(day.date, lang)} — ${t.ar} ${fmt0(day.in_eq)} · ${t.ap} ${fmt0(day.out_eq)} · ${t.close} ${pair(day.close)}`
    + (day.close_eq != null ? ` · ${t.eq} ${fmt0(day.close_eq)}` : '');
}

export function buildMonthlyText(sum, { lang = 'es', link = null } = {}) {
  const t = lg(lang);
  const ml = monthLabel(sum.month, lang);
  const dl = (d) => dayLabel(d, lang);
  const L1 = [`*${t.monthlyTitle}*`, `*${ml}*`, ''];
  L1.push(`*${t.asOf(dl(sum.from))}* (${t.open})  ${pair(sum.open)}${sum.open_eq != null ? `  ≈ ${fmt0(sum.open_eq)}` : ''}`);
  L1.push(`*${t.asOf(dl(sum.to))}* (${t.close})  ${pair(sum.close)}${sum.close_eq != null ? `  ≈ ${fmt0(sum.close_eq)}` : ''}`);
  if (sum.open_eq != null && sum.close_eq != null) L1.push(`${t.change} ${t.eq} *${sgn(r2(sum.close_eq - sum.open_eq))}*`);
  if (sum.adj.MXN || sum.adj.USD) L1.push(`${t.adj}  ${pair(sum.adj)}`);
  L1.push('');
  L1.push(`*${t.inL}*  ${pair(sum.in)}  (${t.eq} ${fmt0(sum.in_eq)} · ${t.moves(sum.in_n)})`);
  L1.push(`*${t.outL}*  ${pair(sum.out)}  (${t.eq} ${fmt0(sum.out_eq)} · ${t.moves(sum.out_n)})`);
  L1.push(`*${t.net}*  ${sgn(sum.net_eq)} · ${t.days(sum.moved_days)}`);
  const tops = (arr, n) => arr.slice(0, n).map((x) => `• ${x.name === '__private' ? t.priv : x.name} ${fmt0(x.amount_mxn)}${x.n > 1 ? ` (${t.moves(x.n)})` : ''}`);
  if (sum.top_in.length) L1.push('', `*${t.topIn}*`, ...tops(sum.top_in, 5));
  if (sum.by_category_out.length) L1.push('', `*${t.cat} (${t.outL})*`, ...tops(sum.by_category_out, 6));
  if (sum.min) L1.push('', `${t.minBal}: ${dl(sum.min.date)} ${t.eq} ${fmt0(sum.min.close_eq)}` + (sum.max ? ` · ${t.maxBal}: ${dl(sum.max.date)} ${fmt0(sum.max.close_eq)}` : ''));
  if (sum.pending && sum.pending.n) L1.push(t.pend(sum.pending.n, fmt0(sum.pending.amount_mxn)));
  if (link) L1.push('', `${t.link}: ${link}`);
  return clip(L1.join('\n'));
}
export function buildMonthlyHeadline(sum, lang = 'es') {
  const t = lg(lang);
  return `[${t.monthlyTitle.replace(/^\S+\s/, '')}] ${monthLabel(sum.month, lang)} — ${t.inL} ${fmt0(sum.in_eq)} · ${t.outL} ${fmt0(sum.out_eq)} · ${t.net} ${sgn(sum.net_eq)} · ${t.close} ${pair(sum.close)}`;
}
function clip(s, max = 3800) { return s.length > max ? s.slice(0, max) + '\n…' : s; }

// ───────────────────────── 집계 대상 계좌 ─────────────────────────
export const CASH_BOX_RE = /금고|caja|efectivo|현금|cash/i;
// a: { non_deductible, name, type, treasury_exclude } → { included, reason: manual_in|manual_out|non_deductible|cash_box|auto }
export function accountScopeOf(a) {
  if (a.treasury_exclude === true) return { included: false, reason: 'manual_out' };
  if (a.treasury_exclude === false) return { included: true, reason: 'manual_in' };
  if (a.non_deductible === true) return { included: false, reason: 'non_deductible' };
  if (CASH_BOX_RE.test(`${a.name || ''} ${a.type || ''}`)) return { included: false, reason: 'cash_box' };
  return { included: true, reason: 'auto' };
}
export async function loadAccountScope(q = query) {
  const rows = (await q(`SELECT id, name, type, currency, non_deductible, disabled, treasury_exclude
                           FROM accounts WHERE deleted_at IS NULL ORDER BY id`)).rows;
  const accounts = rows.map((a) => ({ id: Number(a.id), name: a.name, type: a.type || null, currency: a.currency,
    non_deductible: a.non_deductible === true, disabled: a.disabled === true,
    treasury_exclude: a.treasury_exclude === true ? true : a.treasury_exclude === false ? false : null,
    ...accountScopeOf(a) }));
  return { accounts, ids: accounts.filter((a) => a.included).map((a) => a.id) };
}

// ───────────────────────── DB 적재 ─────────────────────────
const TXN_NAME_JOINS = `
  LEFT JOIN categories cat ON cat.code=t.category_code
  LEFT JOIN recurring_rules rr ON rr.id=t.recurring_rule_id
  LEFT JOIN sales_invoices si ON si.id=t.sales_invoice_id
  LEFT JOIN customers c ON c.id=si.customer_id
  LEFT JOIN sales_payments sp ON sp.advance_txn_id=t.id
  LEFT JOIN customers cadv ON cadv.id=sp.customer_id
  LEFT JOIN bank_deposits_pending bd ON bd.txn_id=t.id
  LEFT JOIN customers cbd ON cbd.id=bd.customer_id
  LEFT JOIN customers ctag ON ctag.id=t.customer_id`;
const TXN_NAME_COLS = `t.id, t.direction, t.amount, t.amount_mxn, t.is_private, t.memo, t.recurring_rule_id,
  a.name AS account_name, cat.name AS category_name, rr.name AS rule_name, si.sat_no,
  COALESCE(c.name, cadv.name, cbd.name, ctag.name) AS customer_name, bd.payer_memo`;

// 기간 실적 입력 적재(한 번의 조회 묶음)
export async function loadActualInputs(from, to, q = query, scopeIds = null) {
  const ids = scopeIds || (await loadAccountScope(q)).ids;
  const [openRows, preRows, opens, txns, pend] = await Promise.all([
    q(`SELECT a.currency, COALESCE(SUM(a.open_balance),0) AS s FROM accounts a
        WHERE a.deleted_at IS NULL AND a.id = ANY($2) AND (a.open_date IS NULL OR a.open_date < $1) GROUP BY a.currency`, [from, ids]),
    q(`SELECT a.currency, COALESCE(SUM(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount END),0) AS s
         FROM transactions t JOIN accounts a ON a.id=t.account_id
        WHERE t.status='actual' AND t.approved=true AND t.deleted_at IS NULL AND a.deleted_at IS NULL AND a.id = ANY($2) AND t.txn_date < $1
        GROUP BY a.currency`, [from, ids]),
    q(`SELECT a.currency, to_char(a.open_date,'YYYY-MM-DD') AS d, a.open_balance AS amount FROM accounts a
        WHERE a.deleted_at IS NULL AND a.id = ANY($3) AND a.open_date >= $1 AND a.open_date <= $2`, [from, to, ids]),
    q(`SELECT ${TXN_NAME_COLS}, a.currency, to_char(t.txn_date,'YYYY-MM-DD') AS d
         FROM transactions t JOIN accounts a ON a.id=t.account_id ${TXN_NAME_JOINS}
        WHERE t.status='actual' AND t.approved=true AND t.deleted_at IS NULL AND a.deleted_at IS NULL AND a.id = ANY($3)
          AND t.txn_date >= $1 AND t.txn_date <= $2
        ORDER BY t.txn_date, t.id`, [from, to, ids]),
    q(`SELECT to_char(t.txn_date,'YYYY-MM-DD') AS d, COUNT(*) AS n, COALESCE(SUM(t.amount_mxn),0) AS amount_mxn
         FROM transactions t
        WHERE t.status='actual' AND t.approved=false AND t.deleted_at IS NULL AND t.txn_date >= $1 AND t.txn_date <= $2
          AND (t.account_id IS NULL OR t.account_id = ANY($3))
        GROUP BY t.txn_date`, [from, to, ids]),
  ]);
  const base = zero();
  for (const r of openRows.rows) base[cur(r.currency)] += Number(r.s) || 0;
  for (const r of preRows.rows) base[cur(r.currency)] += Number(r.s) || 0;
  base.MXN = r2(base.MXN); base.USD = r2(base.USD);
  // 사후 동일 이름 거래가 여러 조인에 걸려 중복될 수 있어 id 기준 1건만
  const seen = new Set();
  const tx = [];
  for (const r of txns.rows) { const id = Number(r.id); if (seen.has(id)) continue; seen.add(id); tx.push({ ...r, amount: Number(r.amount), amount_mxn: Number(r.amount_mxn) }); }
  return { base, opens: opens.rows.map((o) => ({ ...o, amount: Number(o.amount) })), txns: tx,
    pending: pend.rows.map((p) => ({ d: p.d, n: Number(p.n), amount_mxn: Number(p.amount_mxn) })) };
}

export async function loadFx(from, to) {
  const seed = await getRateForDate(from);
  const rows = await getFxRange(from, to, 'MXN');
  return fxFill(rows, from, to, seed);
}

export async function computeActualDays(from, to, q = query) {
  const [inp, fx] = await Promise.all([loadActualInputs(from, to, q), loadFx(from, to)]);
  return buildDays({ from, to, ...inp, fx });
}

// 예정 입력: 오늘~to (오늘 이전 미실현은 이월)
export async function loadPlanInputs(today, to, q = query, scopeIds = null) {
  const ids = scopeIds || (await loadAccountScope(q)).ids;
  const [inv, plan, act] = await Promise.all([
    q(`SELECT x.* FROM (
         SELECT si.id, c.name AS customer_name, si.sat_no, to_char(si.due_date,'YYYY-MM-DD') AS due,
                (si.total_mxn - COALESCE(pa.paid,0)) AS outstanding
           FROM sales_invoices si JOIN customers c ON c.id=si.customer_id
           LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) pa ON pa.invoice_id=si.id
          WHERE si.status='posted' AND si.deleted_at IS NULL AND si.due_date IS NOT NULL AND si.due_date <= $1
       ) x WHERE x.outstanding >= $2`, [to, AR_PAID_EPS]),
    q(`SELECT ${TXN_NAME_COLS}, COALESCE(a.currency, t.currency) AS currency,
              to_char(COALESCE(t.plan_date, t.txn_date),'YYYY-MM-DD') AS d, t.sales_invoice_id
         FROM transactions t LEFT JOIN accounts a ON a.id=t.account_id ${TXN_NAME_JOINS}
        WHERE t.status='plan' AND t.deleted_at IS NULL AND COALESCE(t.plan_date, t.txn_date) <= $1
          AND (t.account_id IS NULL OR t.account_id = ANY($2))
          AND NOT (t.direction='in' AND t.sales_invoice_id IS NOT NULL)
          AND (t.recurring_rule_id IS NULL OR t.recurring_rule_id IN
               (SELECT r.id FROM recurring_rules r WHERE r.active=true AND r.deleted_at IS NULL))`, [to, ids]),
    q(`SELECT ${TXN_NAME_COLS}, a.currency, to_char(t.txn_date,'YYYY-MM-DD') AS d
         FROM transactions t JOIN accounts a ON a.id=t.account_id ${TXN_NAME_JOINS}
        WHERE t.status='actual' AND t.approved=true AND t.deleted_at IS NULL AND a.deleted_at IS NULL AND a.id = ANY($2) AND t.txn_date=$1`, [today, ids]),
  ]);
  const num = (r) => ({ ...r, amount: Number(r.amount), amount_mxn: Number(r.amount_mxn) });
  const uniq = (rows) => { const s = new Set(); return rows.filter((r) => { const k = Number(r.id); if (s.has(k)) return false; s.add(k); return true; }); };
  const planRows = uniq(plan.rows).map(num);
  return {
    invoices: inv.rows.map((r) => ({ ...r, outstanding: Number(r.outstanding) })),
    planIn: planRows.filter((r) => r.direction === 'in'),
    planOut: planRows.filter((r) => r.direction === 'out'),
    todayActual: uniq(act.rows).map(num),
  };
}

// 오늘~to 예정 일자 (기초 = 어제 실적 마감)
export async function computePlanDays(today, to, q = query) {
  const yday = addDays(today, -1);
  const [prev, plan, fx] = await Promise.all([
    computeActualDays(yday, yday, q), loadPlanInputs(today, to, q), loadFx(today, to),
  ]);
  return projectDays({ today, to, startOpen: prev[0].close, ...plan, fx });
}

// 주간 보기(유첨 양식): 월~일 — 과거는 실적, 오늘부터 예정. 일요일은 화면에서 거래가 있을 때만 표시
//   (일요일 거래를 빼면 토요일 마감 ≠ 다음 월요일 기초가 되므로 서버는 7일을 모두 준다)
export async function computeWeek(anyDate, today, q = query) {
  const from = weekStart(anyDate), to = addDays(from, 6);
  const actualTo = to < today ? to : addDays(today, -1);
  const actual = actualTo >= from ? await computeActualDays(from, actualTo, q) : [];
  let plan = [];
  if (to >= today) {
    plan = await computePlanDays(today, to, q);
    plan = plan.filter((d) => d.date >= from);
  }
  return { from, to, today, days: [...actual, ...plan] };
}

// 스냅샷 저장(최초본 first_data 는 보존)
export async function upsertSnapshots(days, q = query) {
  for (const d of days) {
    const data = JSON.stringify({ ...d, cum: d.cum });
    await q(
      `INSERT INTO treasury_daily_snapshots
         (snap_date, fx_rate, open_mxn, open_usd, in_mxn, in_usd, out_mxn, out_usd, close_mxn, close_usd, data, first_data, first_at, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$11::jsonb,now(),now())
       ON CONFLICT (snap_date) DO UPDATE SET
         fx_rate=EXCLUDED.fx_rate, open_mxn=EXCLUDED.open_mxn, open_usd=EXCLUDED.open_usd,
         in_mxn=EXCLUDED.in_mxn, in_usd=EXCLUDED.in_usd, out_mxn=EXCLUDED.out_mxn, out_usd=EXCLUDED.out_usd,
         close_mxn=EXCLUDED.close_mxn, close_usd=EXCLUDED.close_usd, data=EXCLUDED.data, computed_at=now()`,
      [d.date, d.fx, d.open.MXN, d.open.USD, d.in.MXN, d.in.USD, d.out.MXN, d.out.USD, d.close.MXN, d.close.USD, data]);
  }
  return days.length;
}

export async function loadSnapshotMeta(from, to, q = query) {
  const rows = (await q(
    `SELECT to_char(snap_date,'YYYY-MM-DD') AS d, first_data, first_at, computed_at
       FROM treasury_daily_snapshots WHERE snap_date >= $1 AND snap_date <= $2`, [from, to])).rows;
  const m = new Map();
  for (const r of rows) {
    const f = r.first_data && typeof r.first_data === 'string' ? JSON.parse(r.first_data) : r.first_data;
    m.set(r.d, { first: f ? flatOf(f) : null, first_at: r.first_at, computed_at: r.computed_at });
  }
  return m;
}

// ───────────────────────── 수신자 · 발송 ─────────────────────────
export async function activeRecipients(kind, q = query) {
  const col = kind === 'monthly' ? 'get_monthly' : 'get_daily';
  return (await q(`SELECT id, name, phone, lang FROM treasury_wa_recipients
                    WHERE active=true AND deleted_at IS NULL AND ${col}=true ORDER BY id`)).rows;
}
export const maskPhone = (p) => { const s = String(p || ''); return s ? s.slice(0, 3) + '****' + s.slice(-4) : null; };

export function reportUrl() { return process.env.TREASURY_REPORT_URL || DEFAULT_REPORT_URL; }

// 1명 발송 + 원장 기록. force=false 면 성공 이력·시도 상한을 지킨다.
export const DEFAULT_IMG_API = { upload: uploadWaMedia, image: sendWaImage, imageTemplate: sendWaImageTemplate };
export const imageFormatOn = () => process.env.TREASURY_WA_FORMAT !== 'text';

// 이미지 경로: ① 업로드(언어별 1회, mediaCache) → ② image 메시지(캡션) → ③ 이미지 헤더 템플릿. 모두 실패하면 null(→ 텍스트).
async function tryImage({ rcpt, png, headline, cacheKey, mediaCache, imgApi }) {
  if (!png) return null;
  let mid = mediaCache[cacheKey];
  if (!mid) {
    const up = await imgApi.upload(png, { mime: 'image/png', filename: `refatrix_${cacheKey}.png` });
    if (!up.ok) return { ok: false, error: `upload: ${up.error}` };
    mid = mediaCache[cacheKey] = up.id;
  }
  const r1 = await imgApi.image({ to: rcpt.phone, mediaId: mid, caption: headline });
  if (r1.ok) return { ok: true, mode: 'image', message_id: r1.message_id };
  const tpl = process.env.TREASURY_WA_IMAGE_TEMPLATE;
  if (tpl) {
    const r2 = await imgApi.imageTemplate({ to: rcpt.phone, mediaId: mid, param: headline, name: tpl });
    if (r2.ok) return { ok: true, mode: 'image_template', message_id: r2.message_id, text_error: r1.error };
    return { ok: false, error: `image: ${r1.error} / image_template: ${r2.error}` };
  }
  return { ok: false, error: `image: ${r1.error}` };
}

export async function sendOne({ kind, period, rcpt, text, headline, png = null, cacheKey = null, mediaCache = {}, force = false, sender = sendWaTo, imgApi = DEFAULT_IMG_API }, q = query) {
  const prev = (await q(`SELECT sent_at, attempts FROM treasury_wa_sends WHERE kind=$1 AND period=$2 AND recipient_id=$3`,
    [kind, period, rcpt.id])).rows[0];
  if (!force && prev && prev.sent_at) return { skipped: 'already_sent', recipient_id: Number(rcpt.id) };
  if (!force && prev && Number(prev.attempts) >= MAX_ATTEMPTS) return { skipped: 'max_attempts', recipient_id: Number(rcpt.id) };
  let res = png ? await tryImage({ rcpt, png, headline, cacheKey: cacheKey || `${kind}_${period}`, mediaCache, imgApi }) : null;
  let imgErr = null;
  if (!res || !res.ok) {
    imgErr = res ? res.error : null;
    res = await sender({ to: rcpt.phone, text, headline, templateName: process.env.TREASURY_WA_TEMPLATE || null });
    if (res.ok && imgErr) res.text_error = imgErr;
    if (!res.ok && imgErr) res.error = `${imgErr} / ${res.error}`;
  }
  const MODE = { image: 'sent_image', image_template: 'sent_image_template', template: 'sent_template', text: 'sent_text' };
  const status = res.ok ? (MODE[res.mode] || 'sent_text') : 'failed';
  await q(
    `INSERT INTO treasury_wa_sends (kind, period, recipient_id, to_masked, status, message_id, error, attempts, sent_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1, CASE WHEN $8 THEN now() ELSE NULL END, now())
     ON CONFLICT (kind, period, recipient_id) DO UPDATE SET
       to_masked=EXCLUDED.to_masked, status=EXCLUDED.status,
       message_id=COALESCE(EXCLUDED.message_id, treasury_wa_sends.message_id),
       error=EXCLUDED.error, attempts=treasury_wa_sends.attempts+1,
       sent_at=CASE WHEN $8 THEN now() ELSE treasury_wa_sends.sent_at END, updated_at=now()`,
    [kind, period, rcpt.id, maskPhone(rcpt.phone), status, res.message_id || null, res.ok ? (res.text_error || null) : (res.error || 'error'), !!res.ok]);
  return { recipient_id: Number(rcpt.id), ok: !!res.ok, status, error: res.ok ? null : res.error };
}

// 일일 발송 본문 준비(언어별)
//   이미지 열(유첨 양식): 발송일이 요약일 다음날이면 [최근 실적 2일 + 오늘 + 예정 3일], 아니면(과거 재발송) 최근 실적 6일.
//   일요일은 거래가 있을 때만 열로 쓴다.
export const IMG_ACTUAL_COLS = 2, IMG_PLAN_COLS = 4;
export async function prepareDaily(dateStr, sendDay, q = query) {
  const { from } = monthBounds(dateStr.slice(0, 7));
  const winFrom = addDays(dateStr, -9);
  const all = await computeActualDays(winFrom < from ? winFrom : from, dateStr, q);
  const days = all.filter((d) => d.date >= from);
  const day = days[days.length - 1];
  const mtd = summarizeMonth(days, { mask: true });
  const keep = (d) => d.dow !== 0 || d.moved;
  let plan = null, planDays = [];
  if (sendDay && sendDay > dateStr) {
    try { planDays = await computePlanDays(sendDay, addDays(sendDay, 7), q); plan = planDays[0] || null; } catch (_) { planDays = []; plan = null; }
  }
  const actualCols = all.filter(keep);
  const cols = (sendDay === addDays(dateStr, 1) && planDays.length)
    ? [...actualCols.slice(-IMG_ACTUAL_COLS), ...planDays.filter(keep).slice(0, IMG_PLAN_COLS)]
    : actualCols.slice(-(IMG_ACTUAL_COLS + IMG_PLAN_COLS));
  const build = (lang) => ({ text: buildDailyText(day, { mtd, plan, lang }), headline: buildDailyHeadline(day, lang),
    svg: dailyImageSvg({ cols, reportDay: dateStr, sendDay: sendDay || addDays(dateStr, 1), mtd, lang }) });
  return { days, day, mtd, plan, cols, build };
}
export async function prepareMonthly(month, today, q = query) {
  const { from, to } = monthBounds(month);
  const last = to < today ? to : addDays(today, -1);
  const days = await computeActualDays(from, last, q);
  const sum = summarizeMonth(days, { mask: true });
  const partial = last < to;
  const build = (lang) => ({ text: buildMonthlyText(sum, { lang, link: reportUrl() }), headline: buildMonthlyHeadline(sum, lang),
    svg: monthlyImageSvg({ sum, days, lang, partial }) });
  return { days, sum, partial, build };
}

// 언어별로 문구·PNG 를 한 번만 만들고, 업로드한 미디어 id 도 언어별로 재사용
export async function sendReport({ kind, period, recipients, prepared, force = false, sender, imgApi }, q = query) {
  const cache = {};
  const mediaCache = {};
  const results = [];
  for (const r of recipients) {
    const lang = r.lang === 'ko' ? 'ko' : 'es';
    if (!cache[lang]) {
      const b = prepared.build(lang);
      const png = imageFormatOn() ? await svgToPng(b.svg) : null;
      cache[lang] = { text: b.text, headline: b.headline, png, cacheKey: `${kind}_${period}_${lang}` };
    }
    const opt = { kind, period, rcpt: r, ...cache[lang], mediaCache, force };
    if (sender) opt.sender = sender;
    if (imgApi) opt.imgApi = imgApi;
    results.push(await sendOne(opt, q));
  }
  return results;
}

// ── 스케줄 1회 실행 (5분마다 호출) ──
export async function runTreasuryJob({ nowMs = Date.now(), sender, imgApi, q = query } = {}) {
  if (process.env.TREASURY_DAILY_ENABLED === '0') return { skipped: 'disabled' };
  const now = mxNow(nowMs);
  if (now.hour < SEND_HOUR_MX) return { skipped: 'early' };
  const yday = addDays(now.ymd, -1);
  const out = { yday, snapshots: 0, daily: [], monthly: [] };
  // 1) 스냅샷: 어제가 속한 달의 1일~어제 (원장 사후 수정도 반영, 최초본은 보존)
  const days = await computeActualDays(monthBounds(yday.slice(0, 7)).from, yday, q);
  out.snapshots = await upsertSnapshots(days, q);
  const canSend = waApiReady() || !!sender;
  if (!canSend) return { ...out, wa: 'not_configured' };
  // 2) 일일 발송 (06~12시, 일요일 무거래 생략)
  const day = days[days.length - 1];
  if (now.hour < DAILY_SEND_UNTIL_MX && !(day.dow === 0 && !day.moved)) {
    const rc = await activeRecipients('daily', q);
    if (rc.length) {
      const prepared = await prepareDaily(yday, now.ymd, q);
      out.daily = await sendReport({ kind: 'daily', period: yday, recipients: rc, prepared, sender, imgApi }, q);
    }
  }
  // 3) 월간 발송 (1~3일)
  if (now.day <= MONTHLY_CATCHUP_DAYS) {
    const pm = prevMonth(now.ymd.slice(0, 7));
    const rc = await activeRecipients('monthly', q);
    if (rc.length) {
      if (pm !== yday.slice(0, 7)) await upsertSnapshots(await computeActualDays(monthBounds(pm).from, monthBounds(pm).to, q), q);
      const prepared = await prepareMonthly(pm, now.ymd, q);
      out.monthly = await sendReport({ kind: 'monthly', period: pm, recipients: rc, prepared, sender, imgApi }, q);
    }
  }
  return out;
}

export function startTreasuryWorker(app) {
  if (globalThis.__refatrixTreasuryWorker) return;
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try { await runTreasuryJob({}); } catch (e) { app && app.log && app.log.warn({ err: String(e && e.message) }, '[treasury] job failed'); }
    finally { busy = false; }
  };
  globalThis.__refatrixTreasuryWorker = setInterval(() => { tick(); }, 300000);
  setTimeout(() => { tick(); }, 25000);
}
