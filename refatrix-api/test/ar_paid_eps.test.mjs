// =====================================================================
// 완납 판정 허용치 AR_PAID_EPS(0.5) 통일 검증 — 순수(DB 불필요)
//
// 배경(디렉터 보고 2026-09-02): "LUEMI folio 25 는 잔액이 0인데 수금완료로 안 잡힌다."
//   원인 = 화면은 금액을 **정수 페소로 반올림** 표시하는데(잔액 0),
//          서버 완납 판정은 `잔액 <= 0.005` 였다 → IVA 16% 센타보 반올림 잔여(예: 0.32)가
//          남은 건이 "화면엔 0인데 연체" 상태로 남았다.
//   해결 = 판정 기준을 화면 눈금(0.5 페소)에 맞추고, 그 값을 src/ar.js 한 곳에 둔다.
//          (2026-08-27 세션에서 정한 방침 — main 에 반영되지 않아 2026-09-02 재적용)
//
//   실행: node --test test/ar_paid_eps.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

import { AR_PAID_EPS, arIsPaid, arIsOpen, arInvoiceStatus } from '../src/ar.js';
import { computeQuoteStage } from '../src/quoteStage.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

test('AR_PAID_EPS 는 화면 반올림 눈금(0.5 페소)', () => {
  assert.equal(AR_PAID_EPS, 0.5);
});

test('경계값 — 0.49 완납 / 0.5 미수 / 과입금(음수) 완납', () => {
  assert.equal(arIsPaid(0.32), true);
  assert.equal(arIsPaid(0.49), true);
  assert.equal(arIsPaid(0.5), false);
  assert.equal(arIsOpen(0.5), true);
  assert.equal(arIsPaid(-3), true);          // 과입금
});

test('만기 지난 센타보 잔여는 연체가 아니다 (LUEMI folio 25 재현)', () => {
  const st = arInvoiceStatus({ total: 6799.26, paid: 6798.94, due_date: '2026-08-14' }, '2026-09-02');
  assert.equal(st.open, false);
  assert.equal(st.overdue, false);
});

test('진짜 미수는 그대로 연체 (RECAR folio 31 회귀)', () => {
  const st = arInvoiceStatus({ total: 24004.53, paid: 0, due_date: '2026-08-30' }, '2026-09-02');
  assert.equal(st.open, true);
  assert.equal(st.overdue, true);
  assert.equal(st.overdue_days, 3);
});

test('견적 단계: 센타보 잔여 → 수금완료 / 진짜 미수 → 수금대기(연체)', () => {
  const NOW = new Date('2026-09-02T18:00:00Z');
  const base = { invoice_id: 1, sat_no: 'AAA', due_date: '2026-08-14', status: 'posted' };
  const a = computeQuoteStage({ ...base, total_mxn: 6799.26, paid_sum: 6798.94 }, NOW);
  const b = computeQuoteStage({ ...base, total_mxn: 6958, paid_sum: 0 }, NOW);
  assert.equal(a.stage_key, 'collected');
  assert.equal(b.stage_key, 'await_collect');
  assert.equal(b.status_key, 'overdue');
});

// ── 프런트 헬퍼는 refatrix-settlement.html 에서 **추출해** 실행한다(테스트–코드 드리프트 방지) ──
function loadFrontHelpers() {
  const html = readFileSync(resolve(REPO, 'refatrix-settlement.html'), 'utf8');
  const grab = (name) => {
    const i = html.indexOf('function ' + name);
    assert.ok(i >= 0, `refatrix-settlement.html 에 ${name} 이 없습니다`);
    let d = 0;
    for (let k = html.indexOf('{', i); k < html.length; k++) {
      if (html[k] === '{') d++;
      else if (html[k] === '}' && --d === 0) return html.slice(i, k + 1);
    }
    throw new Error('unbalanced ' + name);
  };
  const ctx = vm.createContext({});
  vm.runInContext(
    'const AR_PAID_EPS=0.5;' + grab('arNorm') + grab('arPaidTip') + grab('arStatusText') + grab('arStatusChip'),
    ctx);
  return ctx;
}

test('프런트 arNorm — 서버 플래그가 늦어도 화면은 모순되지 않는다', () => {
  const ctx = loadFrontHelpers();
  ctx.rows = [
    { id: 25, outstanding: 0.32, paid_full: false, overdue: true, day_diff: 19 },   // 센타보 잔여
    { id: 31, outstanding: 24004.53, paid_full: false, overdue: true, day_diff: 3 },// 진짜 미수
    { id: 13, outstanding: 0, paid_full: true, overdue: false, day_diff: 76 },      // 이미 완납
  ];
  vm.runInContext('arNorm(rows)', ctx);

  assert.equal(ctx.rows[0].paid_full, true);
  assert.equal(ctx.rows[0].overdue, false);
  assert.equal(vm.runInContext('arStatusText(rows[0])', ctx), '완납');
  // 반올림 잔여는 숨기지 않고 툴팁으로 드러낸다
  assert.match(vm.runInContext('arStatusChip(rows[0])', ctx), /0\.32/);

  assert.equal(ctx.rows[1].paid_full, false);
  assert.equal(ctx.rows[1].overdue, true);
  assert.equal(vm.runInContext('arStatusText(rows[1])', ctx), '연체 3일');

  assert.equal(ctx.rows[2].paid_full, true);
});

test('회귀 — 하드코딩된 옛 임계값이 AR 판정에 남아있지 않다', () => {
  const fin = readFileSync(resolve(REPO, 'refatrix-api/src/routes/financeRoutes.js'), 'utf8');
  assert.equal(/paid_full:\s*[^,]*<=\s*0\.005/.test(fin), false, 'paid_full 판정에 0.005 잔존');
  assert.equal(/COALESCE\(pa\.paid,0\)\)\s*>\s*0\.01/.test(fin), false, '미수/연체 SQL 에 0.01 잔존');
});
