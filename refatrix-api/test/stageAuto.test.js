import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAdvance } from '../src/stageAuto.js';

test('decideAdvance: 미지정(-1)에서는 어떤 단계로도 전진', () => {
  assert.equal(decideAdvance(null, 30), true);
  assert.equal(decideAdvance(0, 30), true);
});
test('decideAdvance: 접촉(20) → 견적(30) 전진', () => {
  assert.equal(decideAdvance(20, 30), true);
});
test('decideAdvance: 이미 견적(30)이면 견적(30)으로 재이동 안 함', () => {
  assert.equal(decideAdvance(30, 30), false);
});
test('decideAdvance: 협상(40)에서 견적(30)으로 후퇴 안 함', () => {
  assert.equal(decideAdvance(40, 30), false);
});
test('decideAdvance: 견적(30) → 거래중(60) 전진', () => {
  assert.equal(decideAdvance(30, 60), true);
});
test('decideAdvance: 이미 거래중(60)이면 거래중으로 재이동 안 함', () => {
  assert.equal(decideAdvance(60, 60), false);
});
test('decideAdvance: 문자열 sort_order(node-pg) 처리', () => {
  assert.equal(decideAdvance('20', '30'), true);
  assert.equal(decideAdvance('60', '60'), false);
});
