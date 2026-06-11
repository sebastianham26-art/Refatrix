import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOutstanding, allocateOldestFirst, validateAllocations } from '../src/settlement.js';

test('computeOutstanding: partial', () => {
  const r = computeOutstanding(1000, 300);
  assert.equal(r.outstanding, 700);
  assert.equal(r.fullyPaid, false);
});

test('computeOutstanding: fully paid exact', () => {
  const r = computeOutstanding(1000, 1000);
  assert.equal(r.outstanding, 0);
  assert.equal(r.fullyPaid, true);
});

test('computeOutstanding: overpaid clamps outstanding to 0', () => {
  const r = computeOutstanding(1000, 1200);
  assert.equal(r.outstanding, 0);
  assert.equal(r.fullyPaid, true);
});

test('allocateOldestFirst: fills oldest first, exact', () => {
  const { allocations, advance } = allocateOldestFirst(1500, [
    { id: 1, outstanding: 1000 }, { id: 2, outstanding: 800 },
  ]);
  assert.deepEqual(allocations, [{ invoice_id: 1, amount: 1000 }, { invoice_id: 2, amount: 500 }]);
  assert.equal(advance, 0);
});

test('allocateOldestFirst: leftover becomes advance (선수금)', () => {
  const { allocations, advance } = allocateOldestFirst(2000, [
    { id: 1, outstanding: 700 }, { id: 2, outstanding: 800 },
  ]);
  assert.deepEqual(allocations, [{ invoice_id: 1, amount: 700 }, { invoice_id: 2, amount: 800 }]);
  assert.equal(advance, 500);
});

test('allocateOldestFirst: partial on first only', () => {
  const { allocations, advance } = allocateOldestFirst(400, [
    { id: 1, outstanding: 700 }, { id: 2, outstanding: 800 },
  ]);
  assert.deepEqual(allocations, [{ invoice_id: 1, amount: 400 }]);
  assert.equal(advance, 0);
});

test('allocateOldestFirst: skips zero-outstanding', () => {
  const { allocations } = allocateOldestFirst(500, [
    { id: 1, outstanding: 0 }, { id: 2, outstanding: 800 },
  ]);
  assert.deepEqual(allocations, [{ invoice_id: 2, amount: 500 }]);
});

test('validateAllocations: ok when sum+advance = total', () => {
  const r = validateAllocations(1500, [{ invoice_id: 1, amount: 1000 }, { invoice_id: 2, amount: 500 }], { 1: 1000, 2: 800 });
  assert.equal(r.ok, true);
});

test('validateAllocations: ok with advance', () => {
  const r = validateAllocations(2000, [{ invoice_id: 1, amount: 700 }, { invoice_id: 2, amount: 800 }], { 1: 700, 2: 800 }, 500);
  assert.equal(r.ok, true);
});

test('validateAllocations: mismatch flagged', () => {
  const r = validateAllocations(1500, [{ invoice_id: 1, amount: 1000 }], { 1: 1000 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.error === 'sum_mismatch'));
});

test('validateAllocations: over outstanding flagged', () => {
  const r = validateAllocations(1200, [{ invoice_id: 1, amount: 1200 }], { 1: 1000 }, 0);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.error === 'over_outstanding'));
});
