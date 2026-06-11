// 매출 AR 반제(입금 배분) 계산 — 순수 함수
function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

// 인보이스별 미수금: outstanding = total - 이미 입금된 합계
export function computeOutstanding(totalMxn, paidMxn) {
  const out = r2(Number(totalMxn) - Number(paidMxn || 0));
  return { outstanding: out < 0 ? 0 : out, fullyPaid: Number(paidMxn || 0) + 1e-9 >= Number(totalMxn) };
}

// 오래된 순 자동 배분: 입금 총액을 미수 인보이스(오래된 순)에 채움.
// invoices: [{ id, outstanding }] (이미 오래된 순 정렬). 반환 allocations + advance(과입금=선수금).
export function allocateOldestFirst(totalAmount, invoices) {
  let remaining = r2(totalAmount);
  const allocations = [];
  for (const inv of invoices) {
    if (remaining <= 0) break;
    const out = r2(inv.outstanding);
    if (out <= 0) continue;
    const amt = remaining >= out ? out : remaining;
    allocations.push({ invoice_id: inv.id, amount: r2(amt) });
    remaining = r2(remaining - amt);
  }
  return { allocations, advance: r2(remaining > 0 ? remaining : 0) };
}

// 배분 검증: 배분 합계 + 선수금 = 입금 총액, 각 배분 ≤ 해당 인보이스 미수금
export function validateAllocations(totalAmount, allocations, outstandingById, advance = 0) {
  const sum = r2(allocations.reduce((s, a) => s + Number(a.amount || 0), 0));
  const total = r2(totalAmount);
  const adv = r2(advance);
  const errors = [];
  for (const a of allocations) {
    if (Number(a.amount) < 0) errors.push({ invoice_id: a.invoice_id, error: 'negative' });
    const out = outstandingById[a.invoice_id];
    if (out != null && Number(a.amount) - out > 0.001) errors.push({ invoice_id: a.invoice_id, error: 'over_outstanding', outstanding: out });
  }
  const diff = r2(total - sum - adv);
  if (Math.abs(diff) > 0.001) errors.push({ error: 'sum_mismatch', diff });
  return { ok: errors.length === 0, errors, sum, advance: adv };
}

export { r2 };
