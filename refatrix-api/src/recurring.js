// 고정비 반복 규칙 → 발생일 목록 전개 (순수 함수)
// 규칙: { freq:'month'|'week', start_date:'YYYY-MM-DD', day_of_month?:1-31, weekday?:0-6(일~토), end_month?:'YYYY-MM'|null }
// 지평(horizon): 오늘부터 N개월 뒤까지. 멱등 생성을 위해 'period' 키를 함께 반환.

function ymd(d) {
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0'), day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseYMD(s) {
  if (s instanceof Date) { return isNaN(s.getTime()) ? null : new Date(Date.UTC(s.getFullYear(), s.getMonth(), s.getDate())); }
  const mm = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!mm) return null;
  const d = new Date(Date.UTC(Number(mm[1]), Number(mm[2]) - 1, Number(mm[3])));
  return isNaN(d.getTime()) ? null : d;
}
// 무한루프 백스톱: 월 단위 루프 최대 반복(50년치). 정상 사용에선 도달 불가.
const MAX_ITER = 600;

// 해당 연·월의 말일(28~31) 고려해 일자를 클램프
function clampDay(year, month0, day) {
  const last = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  return Math.min(day, last);
}

// 지평 끝 날짜: 오늘 기준 +months개월
export function horizonEnd(today, months) {
  const d = parseYMD(today);
  if (!d) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()));
}

// 월 반복: 시작월부터 매월 day_of_month. period='YYYY-MM'
function expandMonthly(rule, startD, endD) {
  const out = [];
  const day = rule.day_of_month || startD.getUTCDate();
  let y = startD.getUTCFullYear(), m = startD.getUTCMonth();
  // 시작 지점: 시작일이 속한 달부터 (MAX_ITER: 잘못된 날짜로 인한 무한루프 방지)
  for (let i = 0; i < MAX_ITER; i++) {
    const occDay = clampDay(y, m, day);
    const occ = new Date(Date.UTC(y, m, occDay));
    if (occ > endD) break;
    if (occ >= startD) {
      out.push({ date: ymd(occ), period: `${y}-${String(m + 1).padStart(2, '0')}` });
    }
    m += 1; if (m > 11) { m = 0; y += 1; }
  }
  return out;
}

// 주 반복: 시작일 이후 첫 weekday부터 매주. period='YYYY-Www'(ISO 주 비슷하게 날짜 자체로 구분)
function expandWeekly(rule, startD, endD) {
  const out = [];
  const wday = rule.weekday == null ? startD.getUTCDay() : rule.weekday;
  // 시작일 또는 그 이후의 첫 해당 요일
  let cur = new Date(startD.getTime());
  const diff = (wday - cur.getUTCDay() + 7) % 7;
  cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), cur.getUTCDate() + diff));
  while (cur <= endD) {
    out.push({ date: ymd(cur), period: `W${ymd(cur)}` });
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), cur.getUTCDate() + 7));
  }
  return out;
}

// 규칙 전개: today부터 horizonMonths까지. end_month(YYYY-MM) 있으면 그 달 말일까지로 제한.
export function expandRule(rule, today, horizonMonths) {
  const startD = parseYMD(rule.start_date);
  let endD = horizonEnd(today, horizonMonths);
  if (!startD || !endD) return [];
  if (rule.end_month) {
    const [ey, em] = rule.end_month.split('-').map(Number);
    const endMonthLast = new Date(Date.UTC(ey, em, 0)); // em월 말일
    if (endMonthLast < endD) endD = endMonthLast;
  }
  // 시작이 지평 이후면 없음
  if (startD > endD) return [];
  const occ = rule.freq === 'week' ? expandWeekly(rule, startD, endD) : expandMonthly(rule, startD, endD);
  return occ;
}

// 구간 전개: fromDate(포함) ~ toDate(포함) 사이의 발생일만. 패턴은 rule.start_date 기준.
// rule: { freq, start_date, day_of_month?, weekday?, end_month? }
export function expandBetween(rule, fromStr, toStr) {
  const startD = parseYMD(rule.start_date);
  let from = parseYMD(fromStr), to = parseYMD(toStr);
  if (!startD || !from || !to) return [];
  if (from < startD) from = startD;
  // end_month 상한
  if (rule.end_month) {
    const [ey, em] = rule.end_month.split('-').map(Number);
    const endMonthLast = new Date(Date.UTC(ey, em, 0));
    if (endMonthLast < to) to = endMonthLast;
  }
  if (from > to) return [];
  const out = [];
  if (rule.freq === 'week') {
    const wday = rule.weekday == null ? startD.getUTCDay() : rule.weekday;
    let cur = new Date(from.getTime());
    const diff = (wday - cur.getUTCDay() + 7) % 7;
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), cur.getUTCDate() + diff));
    while (cur <= to) {
      if (cur >= startD) out.push({ date: ymd(cur), period: `W${ymd(cur)}` });
      cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), cur.getUTCDate() + 7));
    }
  } else {
    const day = rule.day_of_month || startD.getUTCDate();
    let y = from.getUTCFullYear(), m = from.getUTCMonth();
    for (let i = 0; i < MAX_ITER; i++) {
      const occ = new Date(Date.UTC(y, m, clampDay(y, m, day)));
      if (occ > to) break;
      if (occ >= from && occ >= startD) out.push({ date: ymd(occ), period: `${y}-${String(m + 1).padStart(2, '0')}` });
      m += 1; if (m > 11) { m = 0; y += 1; }
    }
  }
  return out;
}

export { ymd, parseYMD, clampDay };
