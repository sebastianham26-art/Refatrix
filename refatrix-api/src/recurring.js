// 고정비 반복 규칙 → 발생일 목록 전개 (순수 함수)
// 규칙: { freq:'month'|'week', start_date:'YYYY-MM-DD', day_of_month?:1-31, weekday?:0-6(일~토), end_month?:'YYYY-MM'|null }
// 지평(horizon): 오늘부터 N개월 뒤까지. 멱등 생성을 위해 'period' 키를 함께 반환.

function ymd(d) {
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0'), day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseYMD(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }

// 해당 연·월의 말일(28~31) 고려해 일자를 클램프
function clampDay(year, month0, day) {
  const last = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  return Math.min(day, last);
}

// 지평 끝 날짜: 오늘 기준 +months개월
export function horizonEnd(today, months) {
  const d = parseYMD(today);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()));
}

// 월 반복: 시작월부터 매월 day_of_month. period='YYYY-MM'
function expandMonthly(rule, startD, endD) {
  const out = [];
  const day = rule.day_of_month || startD.getUTCDate();
  let y = startD.getUTCFullYear(), m = startD.getUTCMonth();
  // 시작 지점: 시작일이 속한 달부터
  while (true) {
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

export { ymd, parseYMD, clampDay };
