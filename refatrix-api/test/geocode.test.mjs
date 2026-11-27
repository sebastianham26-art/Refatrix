// 주소 ↔ 좌표(Nominatim) — 외부 호출은 흉내
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.GEOCODE_MIN_GAP_MS = '0';
const { geocodeSearch, geocodeReverse, pickAddress, _setGeoFetch } = await import('../src/geocode.js');

test('주소 찾기: Nominatim 결과 → 좌표·거리·번호·콜로니아·CP·시·주', async () => {
  const calls = [];
  _setGeoFetch(async (url) => { calls.push(url); return { ok: true, json: async () => ([{ lat: '25.6866', lon: '-100.3161', display_name: 'Av. Ruiz Cortines 2500, Moderna, Monterrey',
    address: { road: 'Avenida Ruiz Cortines', house_number: '2500', suburb: 'Moderna', postcode: '64530', city: 'Monterrey', state: 'Nuevo León' } }]) }; });
  const r = await geocodeSearch('Ruiz Cortines 2500 Monterrey', { near: { lat: 25.7, lng: -100.3 } });
  assert.equal(r.length, 1); assert.equal(r[0].lat, 25.6866); assert.equal(r[0].colonia, 'Moderna'); assert.equal(r[0].cp, '64530'); assert.equal(r[0].municipio, 'Monterrey');
  assert.match(calls[0], /countrycodes=mx/); assert.match(calls[0], /viewbox=/);
  await geocodeSearch('Ruiz Cortines 2500 Monterrey', { near: { lat: 25.7, lng: -100.3 } }); assert.equal(calls.length, 1, '같은 주소는 캐시');
  assert.deepEqual(await geocodeSearch('ab'), []);
});
test('찍은 곳 주소(reverse) · 서버 실패 → null', async () => {
  _setGeoFetch(async () => ({ ok: true, json: async () => ({ display_name: 'x', address: { road: 'Calle 60', house_number: '500', neighbourhood: 'Centro', postcode: '97000', city: 'Mérida', state: 'Yucatán' } }) }));
  const a = await geocodeReverse(20.97, -89.62);
  assert.equal(a.calle, 'Calle 60'); assert.equal(a.estado, 'Yucatán'); assert.equal(a.lat, 20.97);
  _setGeoFetch(async () => { throw new Error('down'); });
  assert.equal(await geocodeSearch('Calle inexistente 123'), null);
  assert.deepEqual(pickAddress({ town: 'Kanasín', postcode: '97370-1' }).cp, '97370');
});
