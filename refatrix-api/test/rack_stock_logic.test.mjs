// 랙별 재고(0245) — 피킹 배분 순수 로직 (DB 불필요)
//   실행: node --test test/rack_stock_logic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitPick, pickOrder, normRack, picksText } from '../src/rackStock.js';

const R = (rack, qty, kind = 'carton', held = 0) => ({ rack, qty, kind, held });

test('fast moving 먼저, 그다음 수량 많은 랙(들르는 랙 수 최소)', () => {
  assert.deepEqual(splitPick([R('AE1-3', 15), R('AE1-1', 30), R('FM-01', 4, 'fast')], 20).map((p) => [p.rack, p.qty]),
    [['FM-01', 4], ['AE1-1', 16]]);
});
test('다른 지시서가 잡은 수량은 피하고, 그래도 모자라면 그 실물까지', () => {
  assert.deepEqual(splitPick([R('FM-01', 4, 'fast', 4), R('AE1-3', 10)], 3).map((p) => [p.rack, p.qty]), [['AE1-3', 3]]);
  assert.deepEqual(splitPick([R('FM-01', 4, 'fast', 4), R('AE1-3', 2)], 5).map((p) => [p.rack, p.qty]), [['AE1-3', 2], ['FM-01', 3]]);
});
test('랙 합보다 많이 필요하면 남는 분량은 위치 미지정(rack:null)', () => {
  const p = splitPick([R('A1', 2)], 5);
  assert.deepEqual(p.map((x) => [x.rack, x.qty]), [['A1', 2], [null, 3]]);
  assert.deepEqual(splitPick([], 4).map((x) => [x.rack, x.qty]), [[null, 4]]);
});
test('소수 수량 · 0 요청', () => {
  assert.deepEqual(splitPick([R('A1', 1.5)], 1.25).map((x) => [x.rack, x.qty]), [['A1', 1.25]]);
  assert.deepEqual(splitPick([R('A1', 3)], 0), []);
});
test('정렬 동률 → 랙 번호 자연정렬(A-1-9 < A-1-10)', () => {
  assert.deepEqual(pickOrder([R('A-1-10', 5), R('A-1-9', 5)]).map((r) => r.rack), ['A-1-9', 'A-1-10']);
});
test('랙 정규화·표시 문자열', () => {
  assert.equal(normRack('  ae1-3 '), 'AE1-3');
  assert.equal(picksText([{ rack: 'FM-01', qty: 4 }, { rack: null, qty: 2 }, { rack: 'AE1-3', qty: 2 }]), 'FM-01 ×4 · AE1-3 ×2');
});
