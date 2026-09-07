// 주간(월~금) 기간 계산 — 순수 함수(단위 테스트 가능)
//
// WBR 은 「주간」 비즈니스 리뷰라 매출·수금 실적은 그 주의 **월요일~금요일**로 집계한다.
// (목표/계획은 월 단위 그대로 — 2026-09-05 디렉터 확정)
// 서버·프런트가 같은 규칙을 쓰도록 정의를 여기 한 곳에 둔다.

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// 'YYYY-MM-DD' 로 파싱 가능한 실제 달력 날짜인지 (2026-02-30 같은 값 차단 · SQL 인젝션 문자열 차단)
export function isYmd(s) {
  if (typeof s !== 'string' || !YMD.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  if (Number.isNaN(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === s;   // 2026-02-30 → 03-02 로 굴러가면 거짓
}

function toDate(ymd) { return new Date(Date.parse(ymd + 'T00:00:00Z')); }
function toYmd(d) { return d.toISOString().slice(0, 10); }

// n일 이동한 날짜
export function addDays(ymd, n) {
  const d = toDate(ymd); d.setUTCDate(d.getUTCDate() + n); return toYmd(d);
}

// 두 날짜 사이 일수(포함). 2026-09-01~2026-09-05 → 5
export function daysInclusive(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1;
}

// 조회 기간 검증. 유효하면 {from,to,days}, 아니면 null.
//  · 둘 다 있어야 하고, from <= to, 최대 maxDays 일(기본 31 — 주간 리뷰라 한 달을 넘길 이유가 없다)
export function parseRange(from, to, maxDays = 31) {
  if (!isYmd(from) || !isYmd(to)) return null;
  if (from > to) return null;
  const days = daysInclusive(from, to);
  if (days > maxDays) return null;
  return { from, to, days };
}

// 직전 기간(주간이면 «전주»).
//  · 7일 이내 기간(월~금 같은 주간)은 **7일** 앞으로 민다 → 전주의 같은 요일 구간이 된다.
//    (5일만 밀면 월~금의 직전이 «수~일» 이 되어 주말이 섞이고 영업일 수가 달라진다)
//  · 그보다 긴 기간은 같은 길이만큼 앞으로 민다.
export function prevRange(range) {
  if (!range) return null;
  const shift = range.days <= 7 ? 7 : range.days;
  return { from: addDays(range.from, -shift), to: addDays(range.to, -shift) };
}

// 기준일이 속한 주의 월요일~금요일. 토·일에 열어도 **그 주**의 월~금.
//  (WBR 「나의 기록으로 초안 만들기」의 weekMonFri 와 같은 규칙)
export function mondayToFriday(todayYmd) {
  if (!isYmd(todayYmd)) return null;
  const d = toDate(todayYmd);
  const dow = d.getUTCDay();                  // 0=일 … 6=토
  const back = dow === 0 ? 6 : dow - 1;       // 일요일이면 6일 전이 월요일
  const from = addDays(todayYmd, -back);
  return { from, to: addDays(from, 4), days: 5 };
}
