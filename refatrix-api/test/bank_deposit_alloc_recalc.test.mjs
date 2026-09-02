// =====================================================================
// 통지 소진액(allocated_amount) 재계산 — 「유령 부분배분」 재발 방지 (순수·DB 불필요)
//
// 배경(디렉터 보고 2026-09-02): LUEMI 통지 #12·#13 이 「부분배분」으로 인박스에 영구히 남고
//   취소·삭제도 409 has_allocation 으로 막혔다. 실측 결과 folio 13·25 는 입금 0 · 배분 0건,
//   선수금 0건인데 통지 소진액만 6,798.95 / 481.63 이 남아 있었다.
//
// 원인: bdReleaseAmount 의 레거시 분기가 `WHERE payment_id=$1 AND status='allocated'` 였다.
//   부분배분 통지는 status='pending' 이라 이 WHERE 에 안 걸려 소진액이 되돌려지지 않았고,
//   반제 헤더는 삭제되어 되돌릴 수단도 함께 사라졌다.
//
// 수정: 소진액은 증감으로 관리하지 않고 링크행 합계에서 매번 재계산(bdRecalcDeposit).
//   실행: node --test test/bank_deposit_alloc_recalc.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const read = (p) => readFileSync(resolve(REPO, p), 'utf8');

const FIN = read('refatrix-api/src/routes/financeRoutes.js');
const MIG = read('refatrix-api/migrations/0194_bank_deposit_alloc_recalc.sql');
const SET = read('refatrix-settlement.html');
const FINHTML = read('refatrix-finance.html');

// bdReleaseAmount 함수 본문만 잘라낸다
function fnBody(src, name) {
  const i = src.indexOf('async function ' + name);
  assert.ok(i >= 0, `${name} 가 없습니다`);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}
// 주석은 판정에서 제외한다(설명문에 옛 조건을 인용할 수 있으므로)
const stripComments = (src) => src.replace(/\/\/[^\n]*/g, '');

test('버그 재발 가드 — bdReleaseAmount 에 옛 status=allocated 조건이 없다', () => {
  const body = stripComments(fnBody(FIN, 'bdReleaseAmount'));
  assert.equal(/status\s*=\s*'allocated'/.test(body), false,
    "부분배분(pending) 통지를 못 되돌리던 조건이 되살아났습니다");
  assert.equal(/allocated_amount\s*=\s*0/.test(body), false,
    '소진액을 통째로 0 으로 덮어쓰면 다중 반제 통지가 어긋납니다 — 재계산을 쓰세요');
});

test('소진액은 링크행 합계에서 재계산한다 (원천 하나)', () => {
  const rc = fnBody(FIN, 'bdRecalcDeposit');
  assert.match(rc, /SUM\(l\.amount\)/, '링크행 합계로 계산해야 합니다');
  assert.match(rc, /JOIN sales_payments p ON p\.id = l\.payment_id/,
    '반제가 사라진 링크는 빠져야 스스로 치유됩니다');
  assert.match(rc, /BD_REMAIN_EPS/, '닫힘 판정은 공통 허용치를 써야 합니다');
  assert.match(fnBody(FIN, 'bdReleaseAmount'), /await bdRecalcDeposit\(c, depId\)/);
});

test('반제 헤더 삭제 전에 FK 포인터를 끊는다', () => {
  const body = stripComments(fnBody(FIN, 'bdReleaseAmount'));
  assert.match(body, /SET payment_id=NULL WHERE payment_id=\$1/);
});

test('중복 통지 등록은 되묻는다 (근본 원인 차단)', () => {
  assert.match(FIN, /error: 'duplicate_suspect'/);
  assert.match(FIN, /account_id=\$1 AND deposit_date=\$2 AND amount=\$3::numeric AND status <> 'void'/);
  assert.match(FIN, /b\.confirm_duplicate/, '의도적 재등록 경로가 있어야 합니다');
  assert.match(FIN, /AS dup_count/, '목록이 중복 건수를 실어 보내야 합니다');
});

test('0194 마이그레이션 — 멱등하고 void·booked 는 건드리지 않는다', () => {
  assert.match(MIG, /d\.status IN \('pending', 'allocated'\)/);
  assert.match(MIG, /ABS\(COALESCE\(d\.allocated_amount, 0\) - used\.u\) > 0\.005/,
    '값이 같으면 갱신하지 않아야 두 번 돌려도 결과가 같습니다');
  assert.equal(/UPDATE\s+transactions/i.test(MIG), false,
    '통지 정리는 원장(거래)을 건드리면 안 됩니다');
  assert.equal(/DELETE\s+FROM/i.test(MIG), false, '이 정리는 무엇도 삭제하지 않습니다');
});

test('화면 — 중복 의심 칩 · 중복 등록 확인창', () => {
  assert.match(SET, /중복 의심/, '수금\/정산 인박스에 중복 의심 표시');
  assert.match(SET, /d\.dup_count/);
  assert.match(FINHTML, /confirm_duplicate:!!confirmDup/);
  assert.match(FINHTML, /duplicate_suspect/);
});
