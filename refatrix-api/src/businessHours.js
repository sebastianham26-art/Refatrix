// =====================================================================
// Refatrix ERP · businessHours.js
//   업무시간(분) 계산 — SLA 카드와 업무 프로세스 KPI가 "동일한 함수"로
//   피킹/포장 리드타임·지연을 계산하도록 공유한다.
//   · 업무시간: 월~금 07:30~17:00 (주말 제외)
//   · 타임존: 멕시코 누에보레온 UTC-6 고정(서머타임 없음)
//   주의: workingHours.js 의 workingMinutesBetween 은 주말을 제외하지 않는
//   구버전이므로, SLA/KPI 일관성을 위해 이 모듈을 단일 기준으로 사용한다.
// =====================================================================
const TZ_OFFSET_MIN = -6 * 60;     // UTC-6
const OPEN_MIN = 7 * 60 + 30;      // 07:30
const CLOSE_MIN = 17 * 60;         // 17:00

// start~end 사이의 업무분(월~금 07:30~17:00) 합계.
export function bizMinutes(start, end) {
  const s = new Date(start), e = new Date(end);
  if (isNaN(s) || isNaN(e) || e <= s) return 0;
  const toMx = (d) => new Date(d.getTime() + TZ_OFFSET_MIN * 60000); // MX 벽시계를 UTC 필드로
  let cur = toMx(s);
  const end2 = toMx(e);
  let total = 0, guard = 0;
  while (cur < end2 && guard++ < 4000) {
    const dow = cur.getUTCDay(); // 0=일 ... 6=토
    const dayStart = new Date(cur); dayStart.setUTCHours(0, 0, 0, 0);
    if (dow >= 1 && dow <= 5) {
      const openT = new Date(dayStart.getTime() + OPEN_MIN * 60000);
      const closeT = new Date(dayStart.getTime() + CLOSE_MIN * 60000);
      const segS = cur > openT ? cur : openT;
      const segE = end2 < closeT ? end2 : closeT;
      if (segE > segS) total += (segE - segS) / 60000;
    }
    cur = new Date(dayStart.getTime() + 24 * 3600000);
  }
  return total;
}

export const bizHours = (start, end) => bizMinutes(start, end) / 60;
