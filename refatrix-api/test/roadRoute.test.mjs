// 실제 도로 거리(OSRM) — 외부 호출은 흉내(mock)
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.OSRM_MIN_GAP_MS = '0';
const { roadDistance, estimateRoad, _setFetch } = await import('../src/roadRoute.js');

const pts = Array.from({ length: 12 }, (_, i) => ({ lat: 25.67 + i * 0.002, lng: -100.31 + i * 0.001 }));
const ok = (calls) => async (url) => { calls.push(url); const n = url.split('/driving/')[1].split('?')[0].split(';').length;
  return { ok: true, json: async () => ({ code: 'Ok', routes: [{ distance: (n - 1) * 700, duration: (n - 1) * 90, geometry: { coordinates: [[-100.31, 25.67], [-100.3, 25.69]] } }] }) }; };

test('도로 거리: OSRM 결과로 km·시간·연료, 경로선 포함', async () => {
  const calls = []; _setFetch(ok(calls));
  const e = await estimateRoad(pts, { visit_min: 20, km_per_liter: 10, speed_kmh: 22 });
  assert.equal(e.source, 'road'); assert.equal(e.km, 7.7);                 // 11구간 × 700m
  assert.equal(e.drive_min, Math.round(7.7 / 22 * 60)); assert.equal(e.visit_min, 240); assert.equal(e.fuel_l, 0.8);
  assert.ok(e.path.length >= 2); assert.equal(calls.length, 1);
  assert.match(calls[0], /\/route\/v1\/driving\/-100\.31,25\.67;/);
  await estimateRoad(pts, {}); assert.equal(calls.length, 1);              // 같은 순서는 캐시
});
test('도로 거리: 좌표가 많으면 나눠 보내고 합산', async () => {
  const calls = []; _setFetch(ok(calls));
  const many = Array.from({ length: 170 }, (_, i) => ({ lat: 25.6 + i * 0.001, lng: -100.3 }));
  const r = await roadDistance(many);
  assert.equal(calls.length, 3); assert.equal(r.km, Math.round(169 * 700 / 100) / 10);
});
test('도로 서버 실패 → 근사치(source=approx)로, 목록 화면은 캐시만', async () => {
  _setFetch(async () => { throw new Error('down'); });
  const e = await estimateRoad(pts, { road_factor: 1.3 });
  assert.equal(e.source, 'approx'); assert.ok(e.km > 0); assert.equal(e.road_error, true);
  _setFetch(async () => { throw new Error('should not call'); });
  const e2 = await estimateRoad(pts.slice(0, 3), {}, null, { cacheOnly: true });
  assert.equal(e2.source, 'approx');
});
