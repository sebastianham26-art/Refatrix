// =====================================================================
// Refatrix ERP · salesTrend.js (2026-10-16 · 구매 › 판매 이력·주기)
// 순수 계산 모듈(DB 없음) — SKU 월별 판매 시계열 → 판매 주기 · 수요유형 · 예측.
//
//   수요유형(Syntetos-Boylan): ADI(판매 간격, 개월) × CV²(판매 1회 수량 변동)
//     꾸준 smooth   : ADI<1.32 · CV²<0.49  → 최근 6개월 가중이동평균
//     변동 erratic  : ADI<1.32 · CV²≥0.49  → 가중이동평균
//     간헐 inter    : ADI≥1.32 · CV²<0.49  → Croston-SBA
//     불규칙 lumpy  : ADI≥1.32 · CV²≥0.49  → Croston-SBA(신뢰 낮음)
//     신규 new      : 첫 판매가 3개월 이내                  → 가중이동평균
//     정지 dead     : 마지막 판매 후 6개월 이상            → 예측 0
//     무판매 none   : 기간 내 판매 없음                    → 예측 0
//
//   이번 달은 진행 중이라 예측·간격·추세 계산에서 뺀다(완료된 달만 사용).
//   단, 「마지막 판매 후 경과」와 기간 합계에는 이번 달 판매도 넣는다.
//   디렉터 결정(2026-10-16): 리드타임 기본 4개월 · ERP 매출만 · 견적 부족은 별도 열(예측 포함은 선택).
// =====================================================================

export const ADI_CUT = 1.32;
export const CV2_CUT = 0.49;
export const NEW_MONTHS = 3;
export const DEAD_MONTHS = 6;
export const CROSTON_ALPHA = 0.2;
export const DEFAULT_LEAD = 4;
export const DEFAULT_SAFE = 1;

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

// 'YYYY-MM' 로부터 n개월 시계열 키(오래된 → 최근, 마지막 = endYm).
export function monthKeys(endYm, n) {
  const [y, m] = String(endYm).split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}
export function monthDiff(aYm, bYm) {   // b − a (개월)
  const [ay, am] = String(aYm).split('-').map(Number);
  const [by, bm] = String(bYm).split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

// 가중이동평균(최근 k개월, 최근일수록 무게↑) — k보다 짧으면 있는 만큼.
export function wma(series, k = 6) {
  const s = series.slice(-k);
  if (!s.length) return 0;
  let num = 0, den = 0;
  s.forEach((q, i) => { num += q * (i + 1); den += i + 1; });
  return num / den;
}

// Croston-SBA: 간헐수요 월 예측 = (1−α/2) · z / p
//   z = 판매 1회 수량의 지수평활, p = 판매 간격(개월)의 지수평활.
export function crostonSba(series, alpha = CROSTON_ALPHA) {
  let z = null, p = null, q = 1;
  for (const x of series) {
    if (x > 0) {
      if (z === null) { z = x; p = q; } else { z += alpha * (x - z); p += alpha * (q - p); }
      q = 1;
    } else q++;
  }
  if (z === null || !p) return 0;
  return (1 - alpha / 2) * z / p;
}

// 판매 주기 통계(완료된 달 시계열 기준).
export function cycleStats(series) {
  const idx = [];
  series.forEach((q, i) => { if (q > 0) idx.push(i); });
  const gaps = [];
  for (let i = 1; i < idx.length; i++) gaps.push(idx[i] - idx[i - 1]);
  const sizes = idx.map((i) => series[i]);
  const mu = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0;
  let cv2 = null;
  if (sizes.length > 1 && mu > 0) {
    const v = sizes.reduce((a, b) => a + (b - mu) ** 2, 0) / (sizes.length - 1);
    cv2 = v / (mu * mu);
  }
  // 판매월이 1개뿐이면 간격을 알 수 없다 → ADI 는 기간 길이(드물다)로 본다.
  const adi = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : (idx.length ? series.length : null);
  return { months: idx.length, adi, cv2, avgSize: mu };
}

export function classify({ months, adi, cv2, sinceLast, ageMonths }) {
  if (!months && sinceLast === null) return 'none';
  if (sinceLast !== null && sinceLast >= DEAD_MONTHS) return 'dead';
  if (ageMonths !== null && ageMonths < NEW_MONTHS) return 'new';
  if (!months) return 'new';                     // 이번 달에만 판매(완료월 0건)
  const c = cv2 === null ? 0 : cv2;
  if (adi < ADI_CUT) return c < CV2_CUT ? 'smooth' : 'erratic';
  return c < CV2_CUT ? 'inter' : 'lumpy';
}

export function forecastFor(type, series) {
  if (type === 'dead' || type === 'none') return 0;
  if (type === 'inter' || type === 'lumpy') return crostonSba(series);
  return wma(series, 6);
}

/**
 * SKU 하나 분석.
 * @param {object} a
 *   series        : number[]  기간 월별 판매(마지막 = 이번 달, 진행 중)
 *   lostSeries    : number[]  같은 길이 — 재고 부족으로 못 판 수량(견적·매출 부족 − 판매로 해소된 몫)
 *   firstSaleYm   : 'YYYY-MM'|null  전 기간 첫 판매월
 *   curYm         : 'YYYY-MM' 이번 달
 *   stock, backorder : 현재고 · 발주 미입고 잔량(운송중 포함)
 *   lead, safe    : 리드타임·안전재고(개월)
 */
export function analyzeSku(a) {
  const series = a.series.map((x) => Number(x) || 0);
  const lost = (a.lostSeries || series.map(() => 0)).map((x) => Number(x) || 0);
  const done = series.slice(0, -1);                      // 완료된 달
  const lead = Number.isFinite(+a.lead) ? +a.lead : DEFAULT_LEAD;
  const safe = Number.isFinite(+a.safe) ? +a.safe : DEFAULT_SAFE;

  let lastIdx = -1;
  series.forEach((q, i) => { if (q > 0) lastIdx = i; });
  const sinceLast = lastIdx < 0 ? null : series.length - 1 - lastIdx;
  const ageMonths = a.firstSaleYm ? monthDiff(a.firstSaleYm, a.curYm) : null;

  const cs = cycleStats(done);
  const type = classify({ months: cs.months, adi: cs.adi, cv2: cs.cv2, sinceLast, ageMonths });
  const fc = forecastFor(type, done);
  // 견적 부족 포함 예측: 판매+못 판 수량으로 같은 방식. 유형은 판매 기준 유지.
  const withLost = done.map((q, i) => q + lost[i]);
  const lostTotal = lost.reduce((x, y) => x + y, 0);
  let fcLost = fc;
  if (lostTotal > 0) {
    const t2 = type === 'dead' || type === 'none' ? (cycleStats(withLost).adi < ADI_CUT ? 'smooth' : 'inter') : type;
    fcLost = forecastFor(t2, withLost);
  }

  const total = series.reduce((x, y) => x + y, 0);
  const avg6 = done.slice(-6).reduce((x, y) => x + y, 0) / Math.max(1, Math.min(6, done.length));
  const l3 = done.slice(-3).reduce((x, y) => x + y, 0);
  const p3 = done.slice(-6, -3).reduce((x, y) => x + y, 0);
  const trend = p3 > 0 ? (l3 - p3) / p3 : (l3 > 0 ? 1 : null);

  const stock = Number(a.stock) || 0, backorder = Number(a.backorder) || 0;
  const supply = stock + backorder;
  const plan = (f) => {
    const cover = f > 0 ? supply / f : null;
    const sug = f > 0 ? Math.max(0, Math.ceil(f * (lead + safe) - supply)) : 0;
    return { cover: cover === null ? null : r1(cover), suggest: sug };
  };
  const p0 = plan(fc), p1 = plan(fcLost);
  // 다음 판매 예상(개월 후): 평균 간격 − 마지막 판매 후 경과. 0 이하 = 이번 달.
  const nextIn = cs.adi && sinceLast !== null && type !== 'dead' && type !== 'none'
    ? Math.max(0, r1(cs.adi - sinceLast)) : null;

  return {
    type, total: r3(total), sale_months: cs.months, done_months: done.length,
    adi: cs.adi === null ? null : r2(cs.adi), cv2: cs.cv2 === null ? null : r2(cs.cv2),
    avg_size: r1(cs.avgSize), avg6: r1(avg6), trend: trend === null ? null : r2(trend),
    since_last: sinceLast, last_ym: lastIdx < 0 ? null : a.months ? a.months[lastIdx] : null,
    next_in: nextIn,
    fc: r1(fc), fc_lost: r1(fcLost), lost_total: r3(lostTotal),
    supply: r3(supply), cover: p0.cover, suggest: p0.suggest,
    cover_lost: p1.cover, suggest_lost: p1.suggest,
  };
}

// 품명·코드 → 부품군(견적 화면 partKind 와 같은 판정 순서, 토르니요 세분 제외).
export function partKind(name, code) {
  const n = String(name || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const c = String(code || '').trim().toUpperCase();
  if (n.includes('GOMA')) return 'BUJE';
  if (n.includes('BASE') && n.includes('AMORTIGUADOR')) return 'BASE DE AMORTIGUADOR';
  if (n.includes('TORNILLO') || n.includes('ESTABILIZADOR')) return 'TORNILLO ESTABILIZADOR';
  if (n.includes('STABILIZER')) return 'STABILIZER LINK';
  if (n.includes('HORQUILLA')) return 'HORQUILLA';
  if (n.includes('BRAZO') && n.includes('AUXILIAR')) return 'BRAZO AUXILIAR';
  if (n.includes('VARILLA')) return 'VARILLA LATERAL';
  if (n.includes('ROTULA')) return 'RÓTULA';
  if (n.includes('TERMINAL')) return n.includes('INTERIOR') ? 'TERMINAL INTERIOR' : 'TERMINAL EXTERIOR';
  if (n.includes('BUJE')) return 'BUJE';
  if (n.includes('AMORTIGUADOR')) return 'AMORTIGUADOR';
  if (n.includes('SOPORTE') && n.includes('MOTOR')) return 'ENGINE MOUNTING';
  const p = c.slice(0, 2);
  return ({ CB: 'RÓTULA', CQ: 'HORQUILLA', CL: 'TORNILLO ESTABILIZADOR', CR: 'TERMINAL INTERIOR', CE: 'TERMINAL EXTERIOR', GV: 'BUJE', GY: 'AMORTIGUADOR' })[p] || '기타';
}

// L/R 짝 코드(CE0351R ↔ CE0351L). 짝이 없으면 null.
export function pairCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (/^[A-Z]{2}\d+[LR]$/.test(c)) return c.slice(0, -1) + (c.endsWith('L') ? 'R' : 'L');
  return null;
}
