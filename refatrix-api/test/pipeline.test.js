import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysBetween, pipelineByStage, detectBottleneck, stalledCustomers } from '../src/pipeline.js';

const stages = [
  { id: 1, name: '00_미지정', sort_order: 0 },
  { id: 2, name: '01_잠재', sort_order: 10 },
  { id: 3, name: '03_견적', sort_order: 30 },
  { id: 4, name: '06_거래중', sort_order: 60 },
];

test('daysBetween', () => {
  assert.equal(daysBetween('2026-06-01', '2026-06-11'), 10);
  assert.equal(daysBetween('2026-06-11', '2026-06-01'), 0);
});

test('pipelineByStage counts + avg', () => {
  const customers = [
    { id: 10, stage_id: 2, stage_since: '2026-06-01' }, // 10 days
    { id: 11, stage_id: 2, stage_since: '2026-05-12' }, // 30 days
    { id: 12, stage_id: 3, stage_since: '2026-04-12' }, // 60 days
    { id: 13, stage_id: 4, stage_since: '2026-06-10' }, // 거래중
  ];
  const p = pipelineByStage(stages, customers, '2026-06-11');
  const s잠재 = p.find((x) => x.stage_id === 2);
  assert.equal(s잠재.count, 2);
  assert.equal(s잠재.avg_days, 20);
  assert.equal(s잠재.max_days, 30);
  const s견적 = p.find((x) => x.stage_id === 3);
  assert.equal(s견적.avg_days, 60);
});

test('detectBottleneck = longest avg excluding 거래중', () => {
  const customers = [
    { id: 11, stage_id: 2, stage_since: '2026-05-12' }, // 잠재 30
    { id: 12, stage_id: 3, stage_since: '2026-04-12' }, // 견적 60 ← bottleneck
    { id: 13, stage_id: 4, stage_since: '2020-01-01' }, // 거래중(제외)
  ];
  const p = pipelineByStage(stages, customers, '2026-06-11');
  const b = detectBottleneck(p);
  assert.equal(b.stage_id, 3);
  assert.equal(b.name, '03_견적');
});

test('detectBottleneck null when empty', () => {
  const p = pipelineByStage(stages, [], '2026-06-11');
  assert.equal(detectBottleneck(p), null);
});

test('stalledCustomers over threshold', () => {
  const customers = [
    { id: 10, stage_id: 2, stage_since: '2026-06-01' }, // 10 < 30
    { id: 12, stage_id: 3, stage_since: '2026-04-12' }, // 60 >= 30
  ];
  const p = pipelineByStage(stages, customers, '2026-06-11');
  const s = stalledCustomers(p, 30);
  assert.equal(s.length, 1);
  assert.equal(s[0].customer_id, 12);
  assert.equal(s[0].days, 60);
});
