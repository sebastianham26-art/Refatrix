// =====================================================================
// Refatrix ERP · treasuryImage.js — 일일 자금 · 월간실적 WhatsApp 이미지(PNG)
//   디렉터 요청(2026-09-30 15:13): 텍스트 요약은 보기 어려움 → 유첨 엑셀과 같은 표 모양 이미지로.
//   SVG 를 직접 그리고 @resvg/resvg-js 로 PNG 변환. 한글은 저장소에 동봉한 IBM Plex Sans KR(OFL)로 그린다
//   (Railway 컨테이너엔 한글 폰트가 없으므로 시스템 폰트를 쓰지 않는다).
//   렌더러가 없거나 실패하면 null 을 돌려주고, 호출부는 기존 텍스트 발송으로 자동 전환한다.
// =====================================================================
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = join(HERE, '..', 'assets', 'fonts');
// 라틴(악센트 á é ñ 포함)은 IBM Plex Sans, 한글은 IBM Plex Sans KR 로 자동 대체(글자 단위 폴백)
export const FONT_FILES = ['IBMPlexSans-Regular.ttf', 'IBMPlexSans-SemiBold.ttf', 'IBMPlexSansKR-Regular.ttf', 'IBMPlexSansKR-SemiBold.ttf'].map((f) => join(FONT_DIR, f));
const FAMILY = "'IBM Plex Sans', 'IBM Plex Sans KR'";
const DEFAULT_FAMILY = 'IBM Plex Sans';

const C = {
  ink: '#1C1B19', mute: '#6F6A60', line: '#BDBDBD', line2: '#E6E1D6', paper: '#F4F1EA',
  brand: '#143D34', gold: '#B8893B', bank: '#C6E0B4', bankEq: '#E2EFDA', date: '#DDEBF7',
  actual: '#6B6B6B', plan: '#1F6FD1', neg: '#E02424', today: '#FFF6CC', inc: '#0F6E56', exp: '#B23A2E',
};

// ── 문구 ──
const L = {
  ko: {
    dow: ['일', '월', '화', '수', '목', '금', '토'],
    dailyTitle: '일일 자금 요약', monthlyTitle: '월간 자금실적', asOf: (d) => `${d} 기준`,
    bank: '은행잔고', ar: 'AR 수금', ap: 'AP 지급', fx: '환율', date: '일자', close: '마감잔고', eq: 'MXN 환산', total: '합계',
    actual: '실적', today: '오늘', plan: '예정', pend: (n) => `대기 ${n}`, more: (n) => `외 ${n}건`, adj: '계좌 개설',
    legend: '회색 = 실적(실제 입출금) · 파랑 = 예정(거래목록 「예정」 그대로) · 금고·불공제 계좌 제외',
    overdue: (n, a) => `※ 지난 날짜 예정 미처리 ${n}건 · MXN ${a} — 거래목록에서 처리/삭제 필요 (잔고 예측 미포함)`,
    mtd: '이번 달 누계', inL: '수금', outL: '지급', net: '순액',
    kOpen: '월초 잔고 (MXN 환산)', kIn: '수금 합계', kOut: '지급 합계', kNet: '순액', kClose: '월말 잔고 (MXN 환산)', kCloseP: '어제 잔고 (MXN 환산)', kMin: '최저 잔고',
    cnt: (n) => `${n}건`, days: (n) => `거래일 ${n}일`, chart: '일별 마감잔고(MXN 환산) · 수금/지급', tbl: '일별 실적',
    cols: ['일자', '기초 MXN', '수금 MXN', '수금 USD', '지급 MXN', '지급 USD', '마감 MXN', '마감 USD', 'MXN 환산'],
    topIn: '주요 수금처', topOut: '계정과목별 지급', priv: '비공개', partial: '진행 중 · 어제까지 누계', month: (y, m) => `${y}년 ${m}월`,
  },
  es: {
    dow: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
    dailyTitle: 'Resumen diario de caja', monthlyTitle: 'Resultado mensual de caja', asOf: (d) => `al ${d}`,
    bank: 'Bank Account', ar: 'AR Cobros', ap: 'AP Pagos', fx: 'Tipo de cambio', date: 'Fecha', close: 'Closing Balance', eq: 'Equiv. MXN', total: 'Total',
    actual: 'real', today: 'hoy', plan: 'prog.', pend: (n) => `pend. ${n}`, more: (n) => `+${n} más`, adj: 'Alta de cuenta',
    legend: 'Gris = real (movimientos) · Azul = programado (igual a la lista de movimientos) · Sin caja ni cuentas no deducibles',
    overdue: (n, a) => `※ ${n} programado(s) de fechas pasadas sin procesar · MXN ${a} — revisar en la lista de movimientos (no incluido)`,
    mtd: 'Acumulado del mes', inL: 'Cobros', outL: 'Pagos', net: 'Neto',
    kOpen: 'Saldo inicial (equiv. MXN)', kIn: 'Cobros', kOut: 'Pagos', kNet: 'Neto', kClose: 'Saldo final (equiv. MXN)', kCloseP: 'Saldo a ayer (equiv. MXN)', kMin: 'Saldo mínimo',
    cnt: (n) => `${n} mov.`, days: (n) => `${n} días con mov.`, chart: 'Saldo diario (equiv. MXN) · cobros/pagos', tbl: 'Detalle diario',
    cols: ['Fecha', 'Inicial MXN', 'Cobros MXN', 'Cobros USD', 'Pagos MXN', 'Pagos USD', 'Final MXN', 'Final USD', 'Equiv. MXN'],
    topIn: 'Principales clientes', topOut: 'Pagos por concepto', priv: 'Privado', partial: 'En curso · acumulado a ayer',
    month: (y, m) => `${['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'][m - 1]} ${y}`,
  },
};
const lg = (lang) => (lang === 'ko' ? L.ko : L.es);

// ── 도우미 ──
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const f0 = (n) => (n == null ? '—' : Math.round(Number(n)).toLocaleString('en-US'));
const fn = (n) => (n == null || Math.round(Number(n)) === 0 ? '-' : (Number(n) < 0 ? '(' + f0(-n) + ')' : f0(n)));
const sgn = (n) => (Number(n) >= 0 ? '+' : '−') + f0(Math.abs(Number(n)));
const dowOf = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const md = (ymd) => { const [, m, d] = ymd.split('-').map(Number); return `${m}/${d}`; };
const dayLab = (ymd, lang) => `${md(ymd)} (${lg(lang).dow[dowOf(ymd)]})`;

// 글자 폭 추정(IBM Plex Sans KR) — 말줄임용
export function textWidth(s, size) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c >= 0x1100 && (c <= 0x11ff || (c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xff00 && c <= 0xffef))) w += 0.93;
    else if (/[0-9]/.test(ch)) w += 0.57;
    else if (/[A-Z]/.test(ch)) w += 0.64;
    else if (/[a-z]/.test(ch)) w += 0.53;
    else if (ch === ' ') w += 0.27;
    else if (/[.,:;'|!()\-]/.test(ch)) w += 0.3;
    else w += 0.55;
  }
  return w * size;
}
export function fit(s, size, maxW) {
  const str = String(s || '');
  if (textWidth(str, size) <= maxW) return str;
  let out = '';
  for (const ch of str) { if (textWidth(out + ch + '…', size) > maxW) break; out += ch; }
  return out + '…';
}
// 한글이 들어간 텍스트는 KR 폰트를 직접 지정(폴백 시 굵기가 사라지는 문제 방지), 나머지는 라틴 폰트(악센트 포함)
const HANGUL_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]/;
const famOf = (s) => (HANGUL_RE.test(String(s)) ? 'IBM Plex Sans KR' : 'IBM Plex Sans');
const T = (x, y, s, o = {}) => `<text x="${x}" y="${y}" font-family="${famOf(s)}" font-size="${o.size || 13}"${o.bold ? ' font-weight="600"' : ''} fill="${o.fill || C.ink}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}>${esc(s)}</text>`;
const R = (x, y, w, h, fill, o = {}) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw || 1}"` : ''}${o.rx ? ` rx="${o.rx}"` : ''}/>`;
const Ln = (x1, y1, x2, y2, stroke = C.line, sw = 1) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}"/>`;
const svgWrap = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FAMILY.replace(/"/g, '')}">${R(0, 0, w, h, '#FFFFFF')}${body}</svg>`;

// 전자결재 항목 한 줄: 번호 + 제목(남는 폭만큼) · 지급처 — 지급처가 잘리지 않도록 제목을 먼저 줄인다
export function apLine(a, size, maxW) {
  const head = `${a.no} `, tail = a.vendor ? ` · ${a.vendor}` : '';
  const title = `${a.title || ''}${a.seq ? ` (${a.seq})` : ''}`;
  const tailW = Math.min(textWidth(tail, size), maxW * 0.45);
  const titleRoom = maxW - textWidth(head, size) - tailW;
  return head + (titleRoom > size * 2 ? fit(title, size, titleRoom) : '') + (tail ? fit(tail, size, tailW + 1) : '');
}

// ═════════ 일일 — 유첨 양식 ═════════
//   cols: buildDays/projectDays 의 날짜 객체 배열(실적·오늘·예정 혼합), reportDay: 요약 대상일, sendDay: 발송일(오늘)
//   mtd: summarizeMonth(월초~reportDay) — 하단 누계 줄
export function dailyImageSvg({ cols, reportDay, sendDay, mtd = null, lang = 'es', maxItems = 7 }) {
  const t = lg(lang);
  const n = cols.length;
  const LW = 150, CW = 205, W = LW + n * CW + 2, PAD = 8;
  const RH = 22, IH = 20;
  const usd = cols.some((d) => d.items.some((i) => i.cur === 'USD') || Math.abs(d.open.USD) >= 0.5);
  const hasUsdItems = (dir) => cols.some((d) => d.items.some((i) => i.dir === dir && i.cur === 'USD'));
  const rowsFor = (dir, cur) => {
    const m = Math.max(0, ...cols.map((d) => d.items.filter((i) => i.dir === dir && i.cur === cur).length));
    return Math.max(cur === 'MXN' ? 2 : 1, Math.min(m, maxItems + (m > maxItems ? 1 : 0)));
  };
  let y = 0; const parts = [];
  // 제목
  const title = `Refatrix · ${t.dailyTitle}`;
  parts.push(R(0, 0, W, 46, C.brand), T(16, 30, title, { size: 18, bold: true, fill: '#FFFFFF' }),
    T(W - 16, 30, t.asOf(`${dayLab(sendDay, lang)} 06:00`), { size: 13, fill: '#CFE0D8', anchor: 'end' }));
  y = 46;
  const x0 = (i) => LW + i * CW;
  const isToday = (d) => d.date === sendDay;
  const colBg = (yy, h) => cols.map((d, i) => (isToday(d) ? R(x0(i), yy, CW, h, C.today) : '')).join('');
  const numRow = (label, sub, get, fill, bold) => {
    const out = [R(0, y, W, RH, fill || '#FFFFFF')];
    if (!fill) out.push(colBg(y, RH));
    if (label) out.push(T(10, y + 15, label, { size: 12, bold: true }));
    out.push(T(LW - 10, y + 15, sub, { size: 12, anchor: 'end', fill: C.mute }));
    cols.forEach((d, i) => {
      const v = get(d);
      if (v != null && v < -0.5) out.push(R(x0(i) + 1, y + 1, CW - 2, RH - 2, C.neg));
      out.push(T(x0(i) + CW - PAD, y + 15, fn(v), { size: 13, bold, anchor: 'end', fill: v < -0.5 ? '#FFFFFF' : (v == null || Math.round(v) === 0 ? '#9A9A9A' : C.ink) }));
    });
    y += RH; return out.join('');
  };
  const itemBlock = (dir, cur, rows) => {
    const h = rows * IH + 6;
    const out = [colBg(y, h)];
    out.push(T(LW - 10, y + 15, cur, { size: 12, anchor: 'end', fill: C.mute }));
    cols.forEach((d, i) => {
      const xs = d.items.filter((it) => it.dir === dir && it.cur === cur);
      const shown = xs.length > rows ? xs.slice(0, rows - 1) : xs;
      shown.forEach((it, k) => {
        const yy = y + 15 + k * IH;
        const color = (it.state || 'actual') === 'plan' ? C.plan : C.actual;
        const amt = f0(it.amount);
        const lateTxt = it.late_days ? ` +${it.late_days}d` : '';
        const room = CW - PAD * 2 - textWidth(amt, 12.5) - textWidth(lateTxt, 11) - 10;
        const nm = it.private ? t.priv : (it.appr ? apLine(it.appr, 12.5, room) : it.name);
        out.push(T(x0(i) + PAD, yy, fit(nm, 12.5, room), { size: 12.5, fill: color }));
        if (lateTxt) out.push(T(x0(i) + CW - PAD - textWidth(amt, 12.5) - 4, yy, lateTxt, { size: 11, fill: C.neg, anchor: 'end' }));
        out.push(T(x0(i) + CW - PAD, yy, amt, { size: 12.5, fill: color, anchor: 'end' }));
      });
      if (xs.length > rows) out.push(T(x0(i) + CW - PAD, y + 15 + (rows - 1) * IH, t.more(xs.length - rows + 1), { size: 11.5, fill: C.mute, anchor: 'end' }));
      for (let k = shown.length + (xs.length > rows ? 1 : 0); k < rows; k++) out.push(T(x0(i) + CW - PAD, y + 15 + k * IH, '-', { size: 12, fill: '#B8B8B8', anchor: 'end' }));
    });
    y += h; return out.join('');
  };
  const secStart = y;
  // 은행잔고(기초)
  const bankTop = y;
  parts.push(numRow(t.bank, 'MXN', (d) => d.open.MXN, C.bank, false));
  if (usd) parts.push(numRow('', 'USD', (d) => d.open.USD, C.bank, false));
  const bankBot = y;
  if (cols.some((d) => d.adj && (d.adj.MXN || d.adj.USD))) parts.push(numRow(t.adj, '', (d) => (d.adj.MXN || 0) + (d.adj.USD || 0)));
  // AR
  const arTop = y;
  parts.push(itemBlock('in', 'MXN', rowsFor('in', 'MXN')));
  parts.push(numRow('', t.total, (d) => d.in.MXN, null, true));
  if (hasUsdItems('in')) { parts.push(itemBlock('in', 'USD', rowsFor('in', 'USD'))); parts.push(numRow('', t.total, (d) => d.in.USD, null, true)); }
  const arBot = y;
  // 환율
  const fxRow = [R(0, y, W, RH, '#FAFAF7'), T(10, y + 15, t.fx, { size: 12, fill: C.mute })];
  cols.forEach((d, i) => fxRow.push(T(x0(i) + CW - PAD, y + 15, d.fx ? Number(d.fx).toFixed(2) : '', { size: 12, fill: C.mute, anchor: 'end' })));
  parts.push(fxRow.join('')); y += RH;
  // 날짜 헤더
  const DH = 32;
  const dh = [R(0, y, W, DH, C.date), T(LW / 2, y + 21, t.date, { size: 13, bold: true, anchor: 'middle' })];
  cols.forEach((d, i) => {
    const tag = d.kind === 'actual' ? [t.actual, '#E4E4E4', '#555555'] : d.kind === 'today' ? [t.today, '#FFD84D', '#3A2D00'] : [t.plan, '#DBEAFE', '#1E40AF'];
    const lab = dayLab(d.date, lang);
    const lw = textWidth(lab, 14);
    const tw = textWidth(tag[0], 11) + 10;
    const cx = x0(i) + CW / 2 - (lw + 6 + tw) / 2;
    dh.push(T(cx, y + 21, lab, { size: 14, bold: true }));
    dh.push(R(cx + lw + 6, y + 9, tw, 16, tag[1], { rx: 3 }), T(cx + lw + 6 + tw / 2, y + 21, tag[0], { size: 11, bold: true, fill: tag[2], anchor: 'middle' }));
    if (d.pending && d.pending.n) dh.push(T(x0(i) + CW - 6, y + 12, t.pend(d.pending.n), { size: 10.5, fill: '#8A5A00', anchor: 'end' }));
  });
  parts.push(dh.join('')); const dateTop = y; y += DH;
  // AP
  const apTop = y;
  parts.push(itemBlock('out', 'MXN', rowsFor('out', 'MXN')));
  parts.push(numRow('', t.total, (d) => d.out.MXN, null, true));
  if (hasUsdItems('out')) { parts.push(itemBlock('out', 'USD', rowsFor('out', 'USD'))); parts.push(numRow('', t.total, (d) => d.out.USD, null, true)); }
  const apBot = y;
  // 마감
  const closeTop = y;
  parts.push(numRow(t.close, 'MXN', (d) => d.close.MXN, C.bank, true));
  if (usd) parts.push(numRow('', 'USD', (d) => d.close.USD, C.bank, true));
  const closeBot = y;
  parts.push(numRow('', t.eq, (d) => d.close_eq, C.bankEq, true));
  const gridBot = y;
  // 그룹 라벨(세로 병합 모양)
  const grp = (top, bot, label, color) => [R(0, top, 72, bot - top, '#FFFFFF'), Ln(72, top, 72, bot), T(36, (top + bot) / 2 + 5, label, { size: 14, bold: true, anchor: 'middle', fill: color })].join('');
  parts.push(grp(arTop, arBot, 'AR', C.inc), grp(apTop, apBot, 'AP', C.exp));
  // 격자
  const grid = [];
  for (let i = 0; i <= n; i++) grid.push(Ln(x0(i), secStart, x0(i), gridBot));
  [bankBot, arBot, dateTop, dateTop + DH, apBot, closeTop].forEach((yy) => grid.push(Ln(0, yy, W, yy, '#9A9A9A')));
  grid.push(R(0.5, secStart + 0.5, W - 1, gridBot - secStart - 1, 'none', { stroke: '#333333', sw: 1.5 }));
  grid.push(Ln(0, closeTop, W, closeTop, '#333333', 1.5));
  parts.push(grid.join(''));
  void bankTop; void closeBot;
  // 하단: 누계 + 범례
  y = gridBot + 10;
  if (mtd) {
    const [yy, mm] = mtd.month.split('-').map(Number);
    parts.push(T(12, y + 16, `${t.mtd} (${t.month(yy, mm)}) — ${t.inL} MXN ${f0(mtd.in_eq)} · ${t.outL} MXN ${f0(mtd.out_eq)} · ${t.net} ${sgn(mtd.net_eq)}`, { size: 13.5, bold: true }));
    y += 24;
  }
  const od = cols.find((d) => d.overdue && d.overdue.n);
  if (od) { parts.push(T(12, y + 15, fit(t.overdue(od.overdue.n, f0(od.overdue.in_mxn + od.overdue.out_mxn)), 12.5, W - 24), { size: 12.5, bold: true, fill: '#8A5A00' })); y += 22; }
  parts.push(T(12, y + 14, fit(t.legend, 11.5, W - 24), { size: 11.5, fill: C.mute }));
  y += 26;
  void reportDay;
  return svgWrap(W, y, parts.join(''));
}

// ═════════ 월간 ═════════
export function monthlyImageSvg({ sum, days, lang = 'es', partial = false }) {
  const t = lg(lang);
  const W = 1080, M = 24;
  const parts = []; let y = 0;
  const [yy, mm] = sum.month.split('-').map(Number);
  parts.push(R(0, 0, W, 50, C.brand), T(M, 32, `Refatrix · ${t.monthlyTitle} · ${t.month(yy, mm)}`, { size: 19, bold: true, fill: '#FFFFFF' }));
  if (partial) parts.push(T(W - M, 32, t.partial, { size: 13, fill: '#CFE0D8', anchor: 'end' }));
  y = 66;
  // KPI 6개
  const pair = (o) => `MXN ${f0(o.MXN)}` + (Math.abs(o.USD) >= 0.5 ? ` · USD ${f0(o.USD)}` : '');
  const chg = sum.close_eq != null && sum.open_eq != null ? sum.close_eq - sum.open_eq : null;
  const K = [
    [t.kOpen, f0(sum.open_eq), pair(sum.open), C.ink],
    [t.kIn, f0(sum.in_eq), `${t.cnt(sum.in_n)} · ${pair(sum.in)}`, C.inc],
    [t.kOut, f0(sum.out_eq), `${t.cnt(sum.out_n)} · ${pair(sum.out)}`, C.exp],
    [t.kNet, sgn(sum.net_eq), t.days(sum.moved_days), sum.net_eq >= 0 ? C.inc : C.exp],
    [partial ? t.kCloseP : t.kClose, f0(sum.close_eq), pair(sum.close) + (chg != null ? ` · ${sgn(chg)}` : ''), C.ink],
    [t.kMin, sum.min ? f0(sum.min.close_eq) : '—', sum.min ? dayLab(sum.min.date, lang) : '', sum.min && sum.min.close_eq < 0 ? C.exp : C.ink],
  ];
  const kw = (W - M * 2 - 12 * 2) / 3, kh = 74;
  K.forEach((k, i) => {
    const kx = M + (i % 3) * (kw + 12), ky = y + Math.floor(i / 3) * (kh + 10);
    parts.push(R(kx, ky, kw, kh, '#FAF8F3', { stroke: C.line2, rx: 8 }), T(kx + 14, ky + 22, k[0], { size: 12.5, fill: C.mute }),
      T(kx + 14, ky + 50, k[1], { size: 24, bold: true, fill: k[3] }), T(kx + 14, ky + 66, fit(k[2], 11.5, kw - 28), { size: 11.5, fill: C.mute }));
  });
  y += kh * 2 + 10 + 22;
  // 차트
  parts.push(T(M, y + 4, t.chart, { size: 14, bold: true, fill: C.brand })); y += 14;
  const CH = 200, cx0 = M + 70, cx1 = W - M, cy0 = y + 8, cy1 = y + 8 + CH;
  const vals = days.filter((d) => d.close_eq != null).map((d) => d.close_eq);
  const flows = days.map((d) => Math.max(d.in_eq, d.out_eq));
  let lo = Math.min(0, ...vals), hi = Math.max(1, ...vals, ...flows);
  const padv = (hi - lo) * 0.08; hi += padv; if (lo < 0) lo -= padv;
  const nd = days.length, bw = (cx1 - cx0) / Math.max(1, nd);
  const X = (i) => cx0 + bw * i + bw / 2, Y = (v) => cy0 + (cy1 - cy0) * (1 - (v - lo) / (hi - lo));
  for (let k = 0; k <= 4; k++) { const v = lo + (hi - lo) * k / 4; parts.push(Ln(cx0, Y(v), cx1, Y(v), '#EFEBE2'), T(cx0 - 8, Y(v) + 4, f0(v), { size: 11, fill: C.mute, anchor: 'end' })); }
  const base = Y(lo > 0 ? lo : 0);
  days.forEach((d, i) => {
    const w = Math.max(2, bw * 0.3);
    if (d.in_eq > 0) parts.push(R(X(i) - w - 1, Y(d.in_eq), w, Math.max(1, base - Y(d.in_eq)), '#9FD3C1'));
    if (d.out_eq > 0) parts.push(R(X(i) + 1, Y(d.out_eq), w, Math.max(1, base - Y(d.out_eq)), '#EDB3AA'));
  });
  const pts = days.map((d, i) => (d.close_eq == null ? null : `${X(i).toFixed(1)},${Y(d.close_eq).toFixed(1)}`)).filter(Boolean);
  parts.push(`<polyline fill="none" stroke="${C.brand}" stroke-width="2.4" points="${pts.join(' ')}"/>`);
  days.forEach((d, i) => { if (d.close_eq != null) parts.push(`<circle cx="${X(i).toFixed(1)}" cy="${Y(d.close_eq).toFixed(1)}" r="2.8" fill="${d.close_eq < 0 ? C.neg : C.brand}"/>`); });
  const step = Math.ceil(nd / 16);
  days.forEach((d, i) => { if (i % step === 0 || i === nd - 1) parts.push(T(X(i), cy1 + 16, md(d.date), { size: 11, fill: C.mute, anchor: 'middle' })); });
  parts.push(R(cx1 - 250, cy0 - 2, 10, 10, '#9FD3C1'), T(cx1 - 236, cy0 + 7, t.inL, { size: 11, fill: C.mute }),
    R(cx1 - 180, cy0 - 2, 10, 10, '#EDB3AA'), T(cx1 - 166, cy0 + 7, t.outL, { size: 11, fill: C.mute }),
    Ln(cx1 - 110, cy0 + 3, cx1 - 92, cy0 + 3, C.brand, 2.4), T(cx1 - 88, cy0 + 7, t.eq, { size: 11, fill: C.mute }));
  y = cy1 + 34;
  // 일별 표
  parts.push(T(M, y + 4, t.tbl, { size: 14, bold: true, fill: C.brand })); y += 14;
  const cw = [92, 118, 118, 96, 118, 96, 118, 96, 128];
  const cxs = []; { let a = M; for (const w of cw) { cxs.push(a); a += w; } }
  const TH = 26, TR = 21;
  parts.push(R(M, y, W - M * 2, TH, C.date));
  t.cols.forEach((c, j) => parts.push(T(j === 0 ? cxs[j] + 8 : cxs[j] + cw[j] - 8, y + 17, c, { size: 12, bold: true, anchor: j === 0 ? 'start' : 'end' })));
  y += TH;
  const rowsD = days.filter((d) => d.dow !== 0 || d.moved);
  rowsD.forEach((d, r) => {
    if (r % 2 === 1) parts.push(R(M, y, W - M * 2, TR, '#FAFAF7'));
    const cells = [dayLab(d.date, lang), fn(d.open.MXN), fn(d.in.MXN), fn(d.in.USD), fn(d.out.MXN), fn(d.out.USD), fn(d.close.MXN), fn(d.close.USD), fn(d.close_eq)];
    const colr = [C.ink, C.ink, C.inc, C.inc, C.exp, C.exp, C.ink, C.ink, C.ink];
    cells.forEach((v, j) => {
      const neg = (j >= 6) && typeof v === 'string' && v.startsWith('(');
      parts.push(T(j === 0 ? cxs[j] + 8 : cxs[j] + cw[j] - 8, y + 15, v, { size: 12, anchor: j === 0 ? 'start' : 'end', fill: v === '-' ? '#B0B0B0' : (neg ? C.neg : colr[j]), bold: j >= 6 && j !== 7 ? false : false }));
    });
    y += TR;
  });
  parts.push(R(M, y, W - M * 2, TH, C.bank));
  const tot = [t.total, fn(sum.open.MXN), fn(sum.in.MXN), fn(sum.in.USD), fn(sum.out.MXN), fn(sum.out.USD), fn(sum.close.MXN), fn(sum.close.USD), fn(sum.close_eq)];
  tot.forEach((v, j) => parts.push(T(j === 0 ? cxs[j] + 8 : cxs[j] + cw[j] - 8, y + 17, v, { size: 12.5, bold: true, anchor: j === 0 ? 'start' : 'end' })));
  y += TH + 26;
  // 상위 목록 2열
  const colW = (W - M * 2 - 24) / 2;
  const list = (x, title, arr, total, color) => {
    const out = [T(x, y + 4, title, { size: 14, bold: true, fill: C.brand })];
    let yy = y + 18;
    const max = Math.max(1, ...arr.map((a) => a.amount_mxn));
    if (!arr.length) out.push(T(x, yy + 14, '-', { size: 12, fill: C.mute }));
    arr.slice(0, 8).forEach((a) => {
      const nm = a.name === '__private' ? t.priv : a.name;
      const pct = total ? Math.round(a.amount_mxn / total * 100) : 0;
      out.push(R(x, yy + 3, (colW - 170) * a.amount_mxn / max, 14, color));
      out.push(T(x + 6, yy + 14, fit(nm, 12, colW - 190), { size: 12 }));
      out.push(T(x + colW - 50, yy + 14, f0(a.amount_mxn), { size: 12, anchor: 'end' }), T(x + colW, yy + 14, `${pct}%`, { size: 11.5, fill: C.mute, anchor: 'end' }));
      yy += 22;
    });
    return { svg: out.join(''), h: yy - y };
  };
  const a = list(M, t.topIn, sum.top_in, sum.in_eq, '#DDF0E8');
  const b = list(M + colW + 24, t.topOut, sum.by_category_out, sum.out_eq, '#F6E1DD');
  parts.push(a.svg, b.svg);
  y += Math.max(a.h, b.h) + 16;
  parts.push(T(M, y + 6, fit(t.legend.split(' · ').slice(-1)[0], 11.5, W - M * 2), { size: 11.5, fill: C.mute }));
  y += 20;
  return svgWrap(W, y, parts.join(''));
}

// ── PNG 변환 ──
let _resvg = null, _resvgTried = false;
async function loadResvg() {
  if (_resvgTried) return _resvg;
  _resvgTried = true;
  try { const m = await import('@resvg/resvg-js'); _resvg = m.Resvg || (m.default && m.default.Resvg) || null; } catch (_) { _resvg = null; }
  return _resvg;
}
export function imageReady() { return FONT_FILES.every((f) => existsSync(f)); }
export async function svgToPng(svg, { scale = 1.5 } = {}) {
  const Resvg = await loadResvg();
  if (!Resvg || !imageReady()) return null;
  try {
    const r = new Resvg(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: DEFAULT_FAMILY }, fitTo: { mode: 'zoom', value: scale } });
    return Buffer.from(r.render().asPng());
  } catch (_) { return null; }
}
