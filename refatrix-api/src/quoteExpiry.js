// =====================================================================
// Refatrix ERP · quoteExpiry.js  (2026-09-21 · 디렉터 지시)
//   견적 재고예약 24시간 만료의 **기산 시각** 규칙.
//
//   · 근무시간: 월~금 07:30~17:00 (멕시코 UTC-6 고정, 서머타임 없음 — businessHours.js 와 동일)
//   · 근무시간 안에 접수 → 접수 시각부터 24시간
//   · 근무시간 밖(평일 17:00 이후·07:30 이전, 주말, 멕시코 법정공휴일)에 접수
//       → **다음 근무일 07:30** 부터 24시간
//   · 만료 시각이 근무시간 밖에 걸려도 **그대로 둔다**(기산만 옮긴다 — 디렉터 확정)
//
//   법정공휴일 = 연방노동법(LFT) 제74조의 휴무일:
//     1/1 · 2월 첫째 월요일 · 3월 셋째 월요일 · 5/1 · 9/16 · 11월 셋째 월요일 · 12/25
//     · 10/1 (6년마다 대통령 취임일: 2024, 2030, 2036 …)
//   선거일(제74조 IX)은 일요일이라 목록에서 뺐다. 회사 휴무일을 더하려면
//   환경변수 QUOTE_EXTRA_HOLIDAYS="2026-12-12,2027-03-25" 처럼 넣는다(선택).
// =====================================================================
const TZ_OFFSET_MIN = -6 * 60;   // UTC-6
const OPEN_MIN = 7 * 60 + 30;    // 07:30
const CLOSE_MIN = 17 * 60;       // 17:00 (17:00 정각은 근무시간 밖)
export const RESERVE_HOURS = 24;

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

// month(1~12)의 n번째 월요일 날짜
function nthMonday(y, m, n) {
  const dow1 = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();   // 0=일
  const first = 1 + ((8 - dow1) % 7);                           // 첫 월요일
  return first + (n - 1) * 7;
}

const holidayCache = new Map();
export function mexicanHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const s = new Set([
    ymd(year, 1, 1),
    ymd(year, 2, nthMonday(year, 2, 1)),
    ymd(year, 3, nthMonday(year, 3, 3)),
    ymd(year, 5, 1),
    ymd(year, 9, 16),
    ymd(year, 11, nthMonday(year, 11, 3)),
    ymd(year, 12, 25),
  ]);
  if (year >= 2024 && (year - 2024) % 6 === 0) s.add(ymd(year, 10, 1));
  holidayCache.set(year, s);
  return s;
}

function extraHolidays() {
  const raw = String(process.env.QUOTE_EXTRA_HOLIDAYS || '');
  return new Set(raw.split(/[\s,;]+/).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)));
}

// MX 벽시계 날짜(UTC 필드에 담긴 Date)가 근무일인지
function isBizDayMx(mx, extra) {
  const dow = mx.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const key = ymd(mx.getUTCFullYear(), mx.getUTCMonth() + 1, mx.getUTCDate());
  return !mexicanHolidays(mx.getUTCFullYear()).has(key) && !extra.has(key);
}

export function isBusinessDay(dateUtc) {
  const mx = new Date(new Date(dateUtc).getTime() + TZ_OFFSET_MIN * 60000);
  return isBizDayMx(mx, extraHolidays());
}

// 24시간 카운트가 시작되는 시각(UTC Date)
export function reserveStartAt(receivedAt = new Date()) {
  const t = new Date(receivedAt);
  if (isNaN(t)) return new Date();
  const extra = extraHolidays();
  const mx = new Date(t.getTime() + TZ_OFFSET_MIN * 60000);
  const minOfDay = mx.getUTCHours() * 60 + mx.getUTCMinutes() + mx.getUTCSeconds() / 60;
  const dayStart = new Date(Date.UTC(mx.getUTCFullYear(), mx.getUTCMonth(), mx.getUTCDate()));
  const toUtc = (mxDate) => new Date(mxDate.getTime() - TZ_OFFSET_MIN * 60000);

  if (isBizDayMx(dayStart, extra)) {
    if (minOfDay >= OPEN_MIN && minOfDay < CLOSE_MIN) return t;                 // 근무시간 안
    if (minOfDay < OPEN_MIN) return toUtc(new Date(dayStart.getTime() + OPEN_MIN * 60000)); // 출근 전
  }
  // 퇴근 후·휴무일 → 다음 근무일 07:30
  let d = new Date(dayStart.getTime() + 86400000);
  for (let i = 0; i < 30 && !isBizDayMx(d, extra); i++) d = new Date(d.getTime() + 86400000);
  return toUtc(new Date(d.getTime() + OPEN_MIN * 60000));
}

// 견적 저장 시 reserve_expires_at 에 넣을 값
export function reserveExpiresAt(receivedAt = new Date()) {
  return new Date(reserveStartAt(receivedAt).getTime() + RESERVE_HOURS * 3600000);
}
