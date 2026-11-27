// 주소 ↔ 좌표 (OpenStreetMap Nominatim) — 고객개발 「지도에서 새 가게 등록」
//   GEOCODE_URL 로 서버 바꿈(기본 공개 서버, 키 불필요). 공개 서버 규칙: 초당 1회 이하 · User-Agent 필수 → 간격·캐시.
//   응답이 없으면 null(화면은 지도에서 직접 찍기로).
const BASE = () => (process.env.GEOCODE_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
const cache = new Map();
let last = 0, chain = Promise.resolve();
let fetchImpl = (...a) => fetch(...a);
export function _setGeoFetch(f) { fetchImpl = f; cache.clear(); }
function wait() {
  const gap = process.env.GEOCODE_URL ? 0 : Number(process.env.GEOCODE_MIN_GAP_MS || 1100);
  const p = chain.then(async () => { const w = last + gap - Date.now(); if (w > 0) await new Promise((r) => setTimeout(r, w)); last = Date.now(); });
  chain = p.catch(() => {}); return p;
}
async function get(path) {
  const url = BASE() + path;
  if (cache.has(url)) return cache.get(url);
  await wait();
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Refatrix-ERP/1.0 (prospects)', 'Accept-Language': 'es' } });
    if (!res.ok) return null;
    const j = await res.json();
    cache.set(url, j); if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return j;
  } catch (_) { return null; } finally { clearTimeout(t); }
}
// Nominatim address → 우리 칸
export function pickAddress(a = {}) {
  return {
    calle: a.road || a.pedestrian || a.footway || a.street || null,
    numero: a.house_number || null,
    colonia: a.neighbourhood || a.suburb || a.quarter || a.residential || a.hamlet || null,
    cp: a.postcode ? String(a.postcode).replace(/\D/g, '').slice(0, 5) || null : null,
    municipio: a.city || a.town || a.municipality || a.village || a.county || null,
    estado: a.state || null,
  };
}
const shape = (x) => ({ lat: Number(x.lat), lng: Number(x.lon), label: x.display_name, ...pickAddress(x.address || {}) });
export async function geocodeSearch(q, { near = null } = {}) {
  const s = String(q || '').trim().slice(0, 200); if (s.length < 3) return [];
  let p = '/search?format=jsonv2&addressdetails=1&limit=6&countrycodes=mx&q=' + encodeURIComponent(s);
  if (near && Number.isFinite(near.lat) && Number.isFinite(near.lng)) {   // 지금 보는 지도 근처 우선(제한은 아님)
    const d = 0.6; p += `&viewbox=${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`;
  }
  const j = await get(p);
  return Array.isArray(j) ? j.map(shape).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng)) : null;
}
export async function geocodeReverse(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const j = await get(`/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}`);
  return j && j.address ? shape({ ...j, lat: String(lat), lon: String(lng) }) : null;
}
