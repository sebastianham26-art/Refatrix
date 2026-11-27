// 실제 도로 주행 거리 — OSRM(OpenStreetMap 도로망) route API
//   OSRM_URL 환경변수로 서버를 바꿀 수 있음(기본: 공개 서버 router.project-osrm.org, 키 불필요)
//   결과는 메모리 + DB(prospect_road_cache) 캐시. 서버 응답이 없으면 null → 호출 쪽이 근사치 사용
import crypto from 'node:crypto';
import { query } from './db.js';
import { estimateRoute } from './prospectCore.js';

const BASE = () => (process.env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/+$/, '');
const PUBLIC = () => !process.env.OSRM_URL;
const CHUNK = 80;                               // 한 번에 보내는 좌표 수(겹치는 1점 포함)
const mem = new Map();                          // key → {km, osrm_min, path}
let downUntil = 0;                              // 연속 실패 시 잠시 호출 중단(화면이 느려지지 않게)
let lastCall = 0, chain = Promise.resolve();
let fetchImpl = (...a) => fetch(...a);
export function _setFetch(f) { fetchImpl = f; mem.clear(); downUntil = 0; }   // 테스트용

const r5 = (v) => Math.round(Number(v) * 1e5) / 1e5;
const keyOf = (pts) => crypto.createHash('sha1').update(pts.map((p) => r5(p.lng) + ',' + r5(p.lat)).join(';')).digest('hex');

// 공개 서버 예의: 호출 간격을 둠(자체 서버면 간격 없음)
function throttle() {
  const gap = PUBLIC() ? Number(process.env.OSRM_MIN_GAP_MS || 300) : 0;
  const p = chain.then(async () => { const w = lastCall + gap - Date.now(); if (w > 0) await new Promise((r) => setTimeout(r, w)); lastCall = Date.now(); });
  chain = p.catch(() => {}); return p;
}
async function osrmLeg(pts, timeoutMs) {
  await throttle();
  const url = BASE() + '/route/v1/driving/' + pts.map((p) => r5(p.lng) + ',' + r5(p.lat)).join(';') + '?overview=simplified&geometries=geojson&steps=false';
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Refatrix-ERP/1.0' } });
    if (!res.ok) throw new Error('osrm_http_' + res.status);
    const j = await res.json();
    const r = j && j.code === 'Ok' && j.routes && j.routes[0];
    if (!r) throw new Error('osrm_' + (j && j.code));
    return { m: Number(r.distance) || 0, s: Number(r.duration) || 0, path: ((r.geometry && r.geometry.coordinates) || []).map((c) => [c[1], c[0]]) };
  } finally { clearTimeout(t); }
}

// pts=[{lat,lng}...] 순서대로 도로 주행 → {km, osrm_min, path:[[lat,lng]]} | null
// cacheOnly=true 면 캐시에 있을 때만 돌려줌(목록 화면용)
export async function roadDistance(points, { timeoutMs = 6000, cacheOnly = false } = {}) {
  const pts = (points || []).filter((p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) && Number(p.lat) !== 0);
  if (pts.length < 2) return { km: 0, osrm_min: 0, path: pts.map((p) => [Number(p.lat), Number(p.lng)]) };
  const key = keyOf(pts);
  if (mem.has(key)) return mem.get(key);
  try {
    const row = (await query(`SELECT km, osrm_min, path FROM prospect_road_cache WHERE key=$1`, [key])).rows[0];
    if (row) { const v = { km: Number(row.km), osrm_min: row.osrm_min == null ? null : Number(row.osrm_min), path: row.path || null }; mem.set(key, v); return v; }
  } catch (_) { /* 0342 전 */ }
  if (cacheOnly || Date.now() < downUntil) return null;
  try {
    const legs = [];
    for (let i = 0; i < pts.length - 1; i += CHUNK - 1) legs.push(pts.slice(i, i + CHUNK));
    const out = await Promise.all(legs.map((l) => osrmLeg(l, timeoutMs)));
    const m = out.reduce((a, x) => a + x.m, 0), s = out.reduce((a, x) => a + x.s, 0);
    const path = out.flatMap((x, k) => (k ? x.path.slice(1) : x.path));
    const v = { km: Math.round(m / 100) / 10, osrm_min: Math.round(s / 60), path };
    mem.set(key, v); if (mem.size > 3000) mem.delete(mem.keys().next().value);
    try {
      await query(`INSERT INTO prospect_road_cache (key, km, osrm_min, path, provider) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (key) DO NOTHING`,
        [key, v.km, v.osrm_min, JSON.stringify(path), BASE()]);
    } catch (_) { /* 0342 전 */ }
    return v;
  } catch (e) {
    downUntil = Date.now() + 60000;              // 1분 동안은 근사치로
    return null;
  }
}

// 루트 추정(도로 거리 우선). 도로 계산이 안 되면 근사치(직선 × 도로 보정)로, source='approx'
export async function estimateRoad(stops, settings, start = null, opts = {}) {
  const pts = (start ? [start] : []).concat((stops || []).filter((x) => x && x.lat != null && x.lng != null));
  const road = await roadDistance(pts, opts);
  const e = estimateRoute(stops, settings, start, road);
  if (!road && !opts.cacheOnly) e.road_error = true;
  if (!road && opts.cacheOnly) roadDistance(pts).catch(() => {});   // 목록 화면: 다음에 열 때 도로 거리가 나오도록 뒤에서 계산
  return e;
}
