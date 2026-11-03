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

// ===== 자동전개 제외 판단 (2026-07-30) — 순수 함수 =====
// "이미 회차가 존재하는가?"를 period 하나에만 의존하지 않는다(구버전 생성분·수정 흐름에서
// recurring_period가 비거나 형식이 다르면 생성된 회차가 자동전개로 이중 표시되는 사고 방지).
//  sets: { periods:Set('ruleId|period'), months:Set('ruleId|YYYY-MM'), dates:Set('ruleId|YYYY-MM-DD') }
//        — months/dates 는 그 규칙 거래의 유효일(plan_date||txn_date) 기준(삭제분 포함).
//  판단: ① period 일치 → 존재. ② 월반복: 같은 달에 그 규칙 거래가 하나라도 있으면 존재
//        (월 1회 규칙이므로 충분). ③ 주반복: 같은 날짜 거래가 있으면 존재.
export function occurrenceExists(sets, rule, occ) {
  if (sets.periods.has(`${rule.id}|${occ.period}`)) return true;
  if (rule.freq === 'week') return sets.dates.has(`${rule.id}|${String(occ.date).slice(0, 10)}`);
  return sets.months.has(`${rule.id}|${String(occ.date).slice(0, 7)}`);
}

// ===== 자동전개 시그니처 중복 판단 (2026-07-30) — 순수 함수 =====
// occurrenceExists는 "같은 규칙"의 회차만 본다. 그런데 실무에서는
//  ① 같은 고정비가 규칙 2개로 중복 등록(하나만 생성됨 → 미생성 규칙이 자동전개로 이중 표시)
//  ② 회차를 규칙과 연결 없이 거래등록으로 수동 등록
// 인 경우 규칙 단위로는 못 잡는다 → 그 달의 '살아있는' 거래 전체에서
// 방향·계정과목·통화·금액이 같은 거래(계좌 일치 또는 계좌미지정 거래)가 이미 있으면 전개하지 않는다.
// (이중 집계 방지 우선 — 진짜 별개 지출이 우연히 겹치면 전개가 억제될 수 있으나,
//  실제 예정 거래 자체는 그대로 집계되므로 최소 1회는 반드시 잡힌다. [생성]하면 정확해짐.)
//  sigs: Set('dir|cat|cur|amt2|YYYY-MM|accId')  — amt2=금액 소수2자리 고정, accId=''이면 계좌미지정
export function sigKey(direction, categoryCode, currency, amount, month, accountId) {
  return `${direction}|${categoryCode || ''}|${currency || 'MXN'}|${Number(amount).toFixed(2)}|${month}|${accountId == null || accountId === '' ? '' : Number(accountId)}`;
}
export function occurrenceDuplicated(sigs, rule, occ) {
  const m = String(occ.date).slice(0, 7);
  if (sigs.has(sigKey(rule.direction, rule.category_code, rule.currency, rule.amount, m, rule.account_id))) return true;
  // 계좌미지정으로 수동 등록된 같은 지출과도 매칭
  return sigs.has(sigKey(rule.direction, rule.category_code, rule.currency, rule.amount, m, null));
}

// ===== 지난달 미처리 고정비 예정 숨김 (2026-11-03 디렉터 결정) — 순수 함수 =====
// 증상: 9·10월 SUA·임차료를 전자결재로 지급했는데 고정비 회차(예정)는 그대로 남아,
//      「지난 예정은 오늘로 이월」 규칙 때문에 오늘 날짜에 이번 달 회차와 겹쳐 같은 고정비가 한 달에 2~3건 보였다.
// 규칙: 고정비 회차 예정(plan)의 유효월이 '이번 달 이전'이고, 그 고정비 규칙이 '이번 달에도 돌고 있으면'
//      (활성 · 시작월 ≤ 이번 달 · 종료월 없음/≥ 이번 달) 그 예정은 이번 달 회차로 대체된 것으로 보고 자금계획에서 뺀다.
//      → 같은 고정비는 이번 달에 한 건만. 규칙이 끝난(종료월 지난) 고정비의 미처리분은 진짜 미지급일 수 있어 그대로 이월.
//      데이터는 건드리지 않는다(표시·집계에서만 제외). 실적(actual)은 항상 그대로.
// rule: { id, active, deleted_at?, start_date:'YYYY-MM-DD', end_month:'YYYY-MM'|null }
export function ruleRunsInMonth(rule, ym) {
  if (!rule || rule.active === false || rule.deleted_at) return false;
  const s = String(rule.start_date || '').slice(0, 7);
  if (s && s > ym) return false;
  if (rule.end_month && String(rule.end_month) < ym) return false;
  return true;
}
// t: { status, recurring_rule_id, plan_date?, txn_date }  running: Set(ruleId:number)  thisMonth:'YYYY-MM'
export function isSupersededRecurringPlan(t, running, thisMonth) {
  if (!t || t.status !== 'plan' || t.projected || t.recurring_rule_id == null) return false;
  const eff = String(t.plan_date || t.txn_date || '').slice(0, 7);
  if (!eff || eff >= thisMonth) return false;
  return running.has(Number(t.recurring_rule_id));
}
export function runningRuleIds(rules, ym) {
  return new Set((rules || []).filter((r) => ruleRunsInMonth(r, ym)).map((r) => Number(r.id)));
}

export { ymd, parseYMD, clampDay };
