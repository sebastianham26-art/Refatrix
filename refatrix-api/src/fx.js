// 환율 모듈: USD→MXN, USD→KRW를 외부 API에서 하루 1회 받아 캐시. 실패 시 마지막값 유지.
import { query } from './db.js';

const DEFAULT_RATE = 17.40;          // USD→MXN: 아무 데이터도 없을 때 최후 기본값
const DEFAULT_KRW = 1350.0;          // USD→KRW: 최후 기본값
const QUOTES = ['MXN', 'KRW'];       // 외부 API에서 함께 받아 캐시할 통화
const SOURCE_URL = 'https://open.er-api.com/v6/latest/USD';

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// 외부 API를 1회 호출해 오늘자 USD→(MXN,KRW)를 모두 캐시. 성공 시 { MXN, KRW } 반환, 실패 시 null.
async function fetchExternalRates() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(SOURCE_URL, { signal: ctrl.signal });
    clearTimeout(t);
    const data = await res.json();
    if (!(data && data.result === 'success' && data.rates)) return null;
    const today = todayUTC();
    const out = {};
    for (const q of QUOTES) {
      const v = Number(data.rates[q]);
      if (v && v > 0) {
        await query(
          `INSERT INTO fx_rates (rate_date, base, quote, rate, source)
           VALUES ($1,'USD',$2,$3,'open.er-api.com')
           ON CONFLICT (rate_date, base, quote) DO UPDATE SET rate=EXCLUDED.rate, fetched_at=now()`,
          [today, q, v]);
        out[q] = v;
      }
    }
    return out;
  } catch (e) {
    return null;   // 무시하고 폴백으로
  }
}

// 오늘자 USD→<quote> 환율을 반환. { rate, asOf, stale, source }
async function getUsdRate(quote, defaultRate) {
  const today = todayUTC();
  // 1) 오늘 캐시가 있으면 그대로
  const cached = (await query(
    `SELECT rate, source FROM fx_rates WHERE base='USD' AND quote=$1 AND rate_date=$2`, [quote, today])).rows[0];
  if (cached) return { rate: Number(cached.rate), asOf: today, stale: false, source: cached.source };

  // 2) 외부 호출 시도(MXN·KRW 동시 캐시, 5초 타임아웃)
  const fetched = await fetchExternalRates();
  if (fetched && Number(fetched[quote]) > 0) {
    return { rate: Number(fetched[quote]), asOf: today, stale: false, source: 'open.er-api.com' };
  }

  // 3) 실패 시 마지막 캐시값 유지
  const last = (await query(
    `SELECT rate, rate_date, source FROM fx_rates WHERE base='USD' AND quote=$1 ORDER BY rate_date DESC LIMIT 1`, [quote])).rows[0];
  if (last) return { rate: Number(last.rate), asOf: String(last.rate_date).slice(0, 10), stale: true, source: last.source };

  // 4) 아무것도 없으면 기본값
  return { rate: defaultRate, asOf: null, stale: true, source: 'default' };
}

// 오늘자 USD→MXN 환율 (기존 호출부 호환 — 반환형 동일).
export async function getUsdMxnRate() {
  return getUsdRate('MXN', DEFAULT_RATE);
}

// 오늘자 USD→KRW 환율.
export async function getUsdKrwRate() {
  return getUsdRate('KRW', DEFAULT_KRW);
}

// 특정 날짜의 USD→MXN 환율 조회. 그날 캐시가 있으면 그 값, 없으면 그 이전 가장 최근 값, 그것도 없으면 오늘 환율.
export async function getRateForDate(dateStr) {
  if (!dateStr) return (await getUsdMxnRate()).rate;
  const exact = (await query(
    `SELECT rate FROM fx_rates WHERE base='USD' AND quote='MXN' AND rate_date=$1`, [dateStr])).rows[0];
  if (exact) return Number(exact.rate);
  const before = (await query(
    `SELECT rate FROM fx_rates WHERE base='USD' AND quote='MXN' AND rate_date<=$1 ORDER BY rate_date DESC LIMIT 1`, [dateStr])).rows[0];
  if (before) return Number(before.rate);
  return (await getUsdMxnRate()).rate;
}

// 환율 이력(요약페이지용)
export async function getFxHistory(limit = 60) {
  const rows = (await query(
    `SELECT to_char(rate_date,'YYYY-MM-DD') AS rate_date, rate, source, fetched_at FROM fx_rates WHERE base='USD' AND quote='MXN' ORDER BY rate_date DESC LIMIT $1`, [limit])).rows;
  return rows.map((r) => ({ rate_date: r.rate_date, rate: Number(r.rate), source: r.source }));
}

// 기간 환율(요약페이지: 지정 기간 추이). 오름차순(오래된→최신). quote 기본 'MXN'.
export async function getFxRange(fromStr, toStr, quote = 'MXN') {
  const cond = ["base='USD'", 'quote=$1']; const args = [quote];
  if (fromStr) { args.push(fromStr); cond.push(`rate_date>=$${args.length}`); }
  if (toStr) { args.push(toStr); cond.push(`rate_date<=$${args.length}`); }
  const rows = (await query(
    `SELECT to_char(rate_date,'YYYY-MM-DD') AS rate_date, rate, source FROM fx_rates
      WHERE ${cond.join(' AND ')} ORDER BY rate_date ASC`, args)).rows;
  return rows.map((r) => ({ rate_date: r.rate_date, rate: Number(r.rate), source: r.source }));
}
