// =====================================================================
// Refatrix ERP · workingHours.js (순수 함수 모듈)
//   포장작업지시서 "출력 → 포장완료" 기한 계산용.
//   업무시간: 매일 07:30 ~ 17:00 (= 570분/일). 6시간(=360분) 기준.
//   타임존: 멕시코 누에보레온(America/Monterrey) = UTC-6 고정(서머타임 없음).
//   v1: 주말 구분 없음(모든 날을 업무일로 취급). 주말 제외가 필요하면
//       isWorkingDay()만 교체하면 됨(아래 주석 참고).
// =====================================================================

export const MX_OFFSET_MIN = -360;        // UTC-6
export const WORK_START_MIN = 7 * 60 + 30; // 07:30 = 450
export const WORK_END_MIN = 17 * 60;       // 17:00 = 1020
const WORK_DAY_MIN = WORK_END_MIN - WORK_START_MIN; // 570

// (주말 제외가 필요할 때 사용) — 현재는 항상 true.
// d 는 "MX 로컬값을 UTC 필드로 들고 있는" Date.
function isWorkingDay(_d) {
  return true;
  // 예) 일요일 제외:  return _d.getUTCDay() !== 0;
  //     토·일 제외:  return _d.getUTCDay() !== 0 && _d.getUTCDay() !== 6;
}

// UTC Date → "MX 로컬을 UTC 필드로 표현한" Date (오프셋만큼 이동)
function toMxFields(utcDate) {
  return new Date(utcDate.getTime() + MX_OFFSET_MIN * 60000);
}
// 위에서 만든 MX-필드 Date → 실제 UTC Date 로 복원
function fromMxFields(mxDate) {
  return new Date(mxDate.getTime() - MX_OFFSET_MIN * 60000);
}
function minOfDay(mxDate) {
  return mxDate.getUTCHours() * 60 + mxDate.getUTCMinutes();
}
function setOpen(mxDate) {
  mxDate.setUTCHours(7, 30, 0, 0);
  return mxDate;
}
function nextDayOpen(mxDate) {
  mxDate.setUTCDate(mxDate.getUTCDate() + 1);
  return setOpen(mxDate);
}

// start(UTC Date) 로부터 업무시간 addMin 분을 더한 시각(UTC Date) 반환.
export function addWorkingMinutes(startUtc, addMin) {
  let t = toMxFields(startUtc instanceof Date ? startUtc : new Date(startUtc));
  // 시작 시각을 업무 창 안으로 클램프
  let md = minOfDay(t);
  if (md < WORK_START_MIN) { setOpen(t); }
  else if (md >= WORK_END_MIN) { nextDayOpen(t); }
  // (주말 제외 시) 비업무일이면 다음 업무일 오픈으로
  while (!isWorkingDay(t)) { nextDayOpen(t); }

  let remaining = Math.max(0, Number(addMin) || 0);
  let guard = 0;
  while (remaining > 0 && guard++ < 3650) {
    md = minOfDay(t);
    const leftToday = WORK_END_MIN - md;
    if (remaining <= leftToday) {
      t = new Date(t.getTime() + remaining * 60000);
      remaining = 0;
    } else {
      remaining -= leftToday;
      nextDayOpen(t);
      while (!isWorkingDay(t)) { nextDayOpen(t); }
    }
  }
  return fromMxFields(t);
}

// 포장 6시간 기한(=출력 후 업무시간 360분)
export function packingDeadline(printedAtUtc) {
  return addWorkingMinutes(printedAtUtc, WORK_DAY_MIN >= 0 ? 360 : 360);
}

// MX 로컬 기준 오늘 날짜 문자열(YYYY-MM-DD) — 외상일(due_date) 연체 판정용
export function mxTodayStr(nowUtc) {
  const m = toMxFields(nowUtc instanceof Date ? nowUtc : new Date(nowUtc || Date.now()));
  const y = m.getUTCFullYear();
  const mo = String(m.getUTCMonth() + 1).padStart(2, '0');
  const d = String(m.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}


// start~end 사이의 "업무시간 분"(07:30~17:00, UTC-6) 합계. 평균 리드타임 산출용.
export function workingMinutesBetween(startUtc, endUtc) {
  let s = new Date(startUtc instanceof Date ? startUtc : new Date(startUtc));
  let e = new Date(endUtc instanceof Date ? endUtc : new Date(endUtc));
  if (!(e > s)) return 0;
  let cur = toMxFields(s);
  const end = toMxFields(e);
  let total = 0, guard = 0;
  while (cur < end && guard++ < 3650) {
    const dayStart = new Date(cur); dayStart.setUTCHours(7, 30, 0, 0);
    const dayEnd = new Date(cur); dayEnd.setUTCHours(17, 0, 0, 0);
    const segStart = cur > dayStart ? cur : dayStart;
    const segEnd = end < dayEnd ? end : dayEnd;
    if (segEnd > segStart && isWorkingDay(cur)) total += (segEnd - segStart) / 60000;
    cur = new Date(cur); cur.setUTCDate(cur.getUTCDate() + 1); cur.setUTCHours(0, 0, 0, 0);
  }
  return Math.round(total);
}
