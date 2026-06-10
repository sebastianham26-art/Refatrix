// 환율 모듈: USD→MXN을 외부 API에서 하루 1회 받아 캐시. 실패 시 마지막값 유지.
import { query } from './db.js';

const DEFAULT_RATE = 17.40;          // 아무 데이터도 없을 때 최후 기본값
const SOURCE_URL = 'https://open.er-api.com/v6/latest/USD';

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// 오늘자 USD→MXN 환율을 반환. { rate, asOf, stale, source }
export async function getUsdMxnRate() {
  const today = todayUTC();
  // 1) 오늘 캐시가 있으면 그대로
  const cached = (await query(
    `SELECT rate, rate_date, source FROM fx_rates WHERE base='USD' AND quote='MXN' AND rate_date=$1`, [today])).rows[0];
  if (cached) return { rate: Number(cached.rate), asOf: today, stale: false, source: cached.source };

  // 2) 외부 호출 시도(5초 타임아웃)
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(SOURCE_URL, { signal: ctrl.signal });
    clearTimeout(t);
    const data = await res.json();
    const mxn = data && data.result === 'success' && data.rates ? Number(data.rates.MXN) : null;
    if (mxn && mxn > 0) {
      await query(
        `INSERT INTO fx_rates (rate_date, base, quote, rate, source)
         VALUES ($1,'USD','MXN',$2,'open.er-api.com')
         ON CONFLICT (rate_date, base, quote) DO UPDATE SET rate=EXCLUDED.rate, fetched_at=now()`,
        [today, mxn]);
      return { rate: mxn, asOf: today, stale: false, source: 'open.er-api.com' };
    }
  } catch (e) {
    // 무시하고 폴백으로
  }

  // 3) 실패 시 마지막 캐시값 유지
  const last = (await query(
    `SELECT rate, rate_date, source FROM fx_rates WHERE base='USD' AND quote='MXN' ORDER BY rate_date DESC LIMIT 1`)).rows[0];
  if (last) return { rate: Number(last.rate), asOf: String(last.rate_date).slice(0, 10), stale: true, source: last.source };

  // 4) 아무것도 없으면 기본값
  return { rate: DEFAULT_RATE, asOf: null, stale: true, source: 'default' };
}

// 환율 이력(요약페이지용)
export async function getFxHistory(limit = 60) {
  const rows = (await query(
    `SELECT rate_date, rate, source, fetched_at FROM fx_rates WHERE base='USD' AND quote='MXN' ORDER BY rate_date DESC LIMIT $1`, [limit])).rows;
  return rows.map((r) => ({ rate_date: String(r.rate_date).slice(0, 10), rate: Number(r.rate), source: r.source }));
}
