// =====================================================================
// 고객 등록 고도화 — **RFC 선점(0188)** + 디렉터 승인 + 기준품목 할인율 제안 (0185)
//
//   0188: 선점 조건이 CONSTANCIA(번호+PDF) → **RFC 입력** 으로 바뀌었다.
//         CONSTANCIA 는 선택 증빙이며, 없어도 등록·승인이 된다.
//
//   배경: 100% 커미션 영업사원은 서로의 존재를 모른다. 고객을 먼저 등록한 사람이
//         그 고객의 수익을 갖는 구조이므로, 선점 판정과 할인율 산출이 틀리면
//         곧바로 돈 문제가 된다. 아래는 그 두 축을 못 박아 두는 테스트다.
//
//   검증 범위
//     A. 선점 키 정규화 — 표기(하이픈·공백·점·대소문자)로 우회할 수 없어야 한다.
//     B. 기준품목 단가 → 할인율 산출/제안 — 5% 우위 공식과 경계값.
//     C. 등록자가 정한 할인율 검증 + 제안 대비 격차.
//     D. 백엔드 소스 계약 — 자동생성 폐지, 승인 게이트, 필수값이 실제로 코드에 있는지.
//     E. 프런트 계약 — 필수 입력·선점 재확인이 저장 경로에 있는지.
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  normalizeClaimKey, looksLikeRfc, computeBaselineDiscount,
  validateChosenDiscount, discountGap, UNDERCUT_RATE, MAX_DISCOUNT_PCT,
  validateRfc, cleanRfc, GENERIC_RFC,
  // 0193
  validateRfcOptional, normalizeCompanyName, companyNameTokens, nameSimilarity, NAME_SIMILAR_THRESHOLD,
} from '../src/customerClaim.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = join(HERE, '..');
const REPO = join(API, '..');
const read = (p) => readFileSync(p, 'utf8');

// ── A. 선점 키 정규화 ────────────────────────────────────────────────
test('A1. CONSTANCIA 표기 흔들림은 같은 선점 키로 접힌다', () => {
  const forms = ['ABC-123 456', 'abc.123.456', ' ABC123456 ', 'a b c 1 2 3 4 5 6', 'ABC/123/456'];
  const keys = forms.map(normalizeClaimKey);
  assert.deepEqual([...new Set(keys)], ['ABC123456'],
    '표기만 바꿔 같은 CONSTANCIA 를 두 번 등록할 수 있으면 선점이 무너진다');
});

test('A2. 빈 값·기호만 있는 값은 선점 키가 되지 않는다(NULL)', () => {
  for (const v of ['', '   ', null, undefined, '---', '...']) {
    assert.equal(normalizeClaimKey(v), null, `"${v}" 이 키가 되면 유니크 인덱스가 엉뚱하게 걸린다`);
  }
});

test('A3. DB 생성컬럼과 같은 규칙 — 영숫자만 남기고 대문자', () => {
  // migrations/0185 의 constancia_no_norm / rfc_norm 과 **글자 단위로 일치**해야 한다.
  //   아래 기대값은 실제 PostgreSQL 16 에서
  //   NULLIF(upper(regexp_replace(x,'[^A-Za-z0-9]','','g')),'') 을 돌려 얻은 값이다.
  const PG = [
    ['ABC-123 456', 'ABC123456'],
    ['abc.123.456', 'ABC123456'],
    ['  ABC123456 ', 'ABC123456'],
    ['a b c 1 2 3 4 5 6', 'ABC123456'],
    ['ABC/123/456', 'ABC123456'],
    ['Ñ-90/aa_1', '90AA1'],        // Ñ 는 A-Za-z0-9 밖 → 제거(숫자 90 은 남음)
    ['---', null],
    ['sol990101aa1', 'SOL990101AA1'],
  ];
  for (const [input, expected] of PG) {
    assert.equal(normalizeClaimKey(input), expected,
      `JS 와 DB 정규화가 어긋나면 서버 사전검사와 유니크 인덱스가 다른 판정을 내린다: "${input}"`);
  }
});

test('A4. looksLikeRfc 는 기존 데이터 조회용으로 느슨하게 남는다', () => {
  assert.equal(looksLikeRfc('SOL990101AA1'), true);
  assert.equal(looksLikeRfc('ABC010203XY1'), true);
  assert.equal(looksLikeRfc('AB12'), false);
  assert.equal(looksLikeRfc(''), false);
});

// ── A′. 0188 · RFC = 선점 키 ─────────────────────────────────────────
//   RFC 하나로 고객이 선점되므로, 여기가 뚫리면 아무 문자열로 남의 고객을 잠글 수 있다.
test('A5. 표기(공백·하이픈·점·소문자)가 달라도 같은 RFC 로 정리된다 — Ñ·& 는 살린다', () => {
  assert.equal(cleanRfc(' sol-990101 aa1 '), 'SOL990101AA1');
  assert.equal(cleanRfc('S.O.L.990101AA1'), 'SOL990101AA1');
  assert.equal(cleanRfc('PEÑA800101AB1'), 'PEÑA800101AB1');
  assert.equal(cleanRfc('A&B010203XY1'), 'A&B010203XY1');
});

test('A6. 법인 12자리 / 개인 13자리만 통과한다', () => {
  const moral = validateRfc('ABC010203XY1');
  assert.equal(moral.ok, true); assert.equal(moral.kind, 'moral'); assert.equal(moral.value, 'ABC010203XY1');
  const fisica = validateRfc('sola-990101-aa1');
  assert.equal(fisica.ok, true); assert.equal(fisica.kind, 'fisica'); assert.equal(fisica.value, 'SOLA990101AA1');
});

test('A7. 형식이 아닌 값으로는 선점할 수 없다', () => {
  assert.equal(validateRfc('').error, 'rfc_required');
  assert.equal(validateRfc(null).error, 'rfc_required');
  assert.equal(validateRfc('ABC12').error, 'rfc_invalid');              // 너무 짧다
  assert.equal(validateRfc('AB010203XY1').error, 'rfc_invalid');        // 영문 2자
  assert.equal(validateRfc('ABCDE010203XY1').error, 'rfc_invalid');     // 영문 5자
  assert.equal(validateRfc('ABC0102030XY1').error, 'rfc_invalid');      // 숫자 7자
  assert.equal(validateRfc('내고객임시').error, 'rfc_invalid');
});

test('A8. RFC 가운데 6자리는 날짜다 — 월·일이 말이 안 되면 막는다', () => {
  assert.equal(validateRfc('ABC011303XY1').error, 'rfc_invalid_date');  // 13월
  assert.equal(validateRfc('ABC010299XY1').error, 'rfc_invalid_date');  // 99일
  assert.equal(validateRfc('ABC011231XY1').ok, true);
});

test('A9. SAT 범용 RFC 로는 선점할 수 없다(선점되면 그 뒤 모두가 막힌다)', () => {
  for (const g of GENERIC_RFC) assert.equal(validateRfc(g).error, 'rfc_generic');
  assert.equal(validateRfc('xaxx-010101-000').error, 'rfc_generic');
});

test('A10. 선점 키 정규화는 검증 통과값에도 그대로 적용된다(DB 생성컬럼과 일치)', () => {
  const v = validateRfc('sol-990101-aa1').value;
  assert.equal(normalizeClaimKey(v), 'SOL990101AA1');
});

// ── B. 기준품목 단가 → 할인율 ────────────────────────────────────────
test('B1. 기본 시나리오 — SYD 정가 1000, 고객 구매가 650', () => {
  // 고객은 SYD 에서 35% 할인 → 650. 우리는 650 보다 5% 싼 617.50 을 목표.
  // CTR 정가 1400 이면 617.50/1400 = 0.44107… → 할인율 55.893%
  const r = computeBaselineDiscount({ buy_price: 650, syd_list_price: 1000, ctr_list_price: 1400 });
  assert.equal(r.ok, true);
  assert.equal(r.syd_discount, 35);
  assert.equal(r.target_price, 617.5);
  // 55.89% — customers.discount 가 NUMERIC(5,2) 이므로 제안값도 2자리로 맞춘다.
  //   (3자리로 보여 주고 2자리로 저장하면 "제안대로 승인했는데 값이 다르다"가 된다)
  assert.equal(r.suggested_discount, 55.89);
  assert.ok(Math.abs(r.suggested_price - 617.5) <= 0.15,
    `제안 할인율로 계산한 판매가(${r.suggested_price})는 목표가 617.5 에 2자리 반올림 오차 안에서 붙어야 한다`);
});

test('B2. 제안 할인율은 항상 목표가(= 구매가 × 0.95)를 만들어 낸다', () => {
  const cases = [
    { buy: 100, syd: 200, ctr: 300 },
    { buy: 812.4, syd: 1200, ctr: 1680 },
    { buy: 49.99, syd: 60, ctr: 84 },
    { buy: 1234.56, syd: 2000, ctr: 2900 },
  ];
  for (const c of cases) {
    const r = computeBaselineDiscount({ buy_price: c.buy, syd_list_price: c.syd, ctr_list_price: c.ctr });
    const back = c.ctr * (1 - r.suggested_discount / 100);
    // 할인율 2자리 반올림의 이론 최대 오차 = CTR 정가 × 0.00005
    const tol = c.ctr * 0.00005 + 0.011;
    assert.ok(Math.abs(back - c.buy * 0.95) <= tol,
      `구매가 ${c.buy} → 목표 ${c.buy * 0.95}, 역산 ${back} (허용 ${tol.toFixed(3)})`);
  }
});

test('B3. 5% 우위 비율은 상수 하나로 관리된다', () => {
  assert.equal(UNDERCUT_RATE, 0.05);
  const r = computeBaselineDiscount({ buy_price: 1000, syd_list_price: 2000, ctr_list_price: 2000 });
  assert.equal(r.target_price, 950);
});

test('B4. CTR 정가가 이미 목표가보다 싸면 할인 0% 를 제안하고 알린다', () => {
  const r = computeBaselineDiscount({ buy_price: 1000, syd_list_price: 1200, ctr_list_price: 800 });
  assert.equal(r.suggested_discount, 0);
  assert.equal(r.note, 'ctr_already_cheaper');
  assert.equal(r.suggested_price, 800, '할인 0% → 판매가는 정가 그대로');
});

test('B5. 구매단가가 SYD 정가보다 높으면 입력 의심 신호를 준다', () => {
  const r = computeBaselineDiscount({ buy_price: 1500, syd_list_price: 1000, ctr_list_price: 1400 });
  assert.equal(r.syd_discount, 0, '음수 할인율을 그대로 저장하면 안 된다');
  assert.equal(r.note, 'buy_above_list');
});

test('B6. 정가가 없으면 계산 결과 대신 명확한 오류코드', () => {
  const noSyd = computeBaselineDiscount({ buy_price: 650, syd_list_price: null, ctr_list_price: 1400 });
  assert.equal(noSyd.error, 'syd_list_price_missing');
  assert.equal(noSyd.ok, false);
  const noCtr = computeBaselineDiscount({ buy_price: 650, syd_list_price: 1000, ctr_list_price: 0 });
  assert.equal(noCtr.error, 'ctr_list_price_missing');
  assert.equal(noCtr.suggested_discount, null, '근거 없이 제안값을 지어내면 안 된다');
});

test('B7. 구매단가 미입력·0·음수는 계산 자체를 거부', () => {
  for (const v of [null, '', 0, -5]) {
    const r = computeBaselineDiscount({ buy_price: v, syd_list_price: 1000, ctr_list_price: 1400 });
    assert.equal(r.error, 'buy_price_required');
  }
});

test('B8. 할인율은 95% 상한을 넘지 않는다', () => {
  const r = computeBaselineDiscount({ buy_price: 1, syd_list_price: 100000, ctr_list_price: 100000 });
  assert.ok(r.syd_discount <= MAX_DISCOUNT_PCT);
  assert.ok(r.suggested_discount <= MAX_DISCOUNT_PCT);
});

// ── C. 등록자가 정한 할인율 ──────────────────────────────────────────
test('C1. 저장 전 할인율 검증 — 범위 밖은 저장되지 않는다', () => {
  assert.equal(validateChosenDiscount(0).ok, true);
  assert.equal(validateChosenDiscount('42.5').value, 42.5);
  assert.equal(validateChosenDiscount('42.567').value, 42.57, 'DB(NUMERIC(5,2)) 정밀도로 맞춰 저장한다');
  assert.equal(validateChosenDiscount(-1).error, 'discount_negative');
  assert.equal(validateChosenDiscount(99).error, 'discount_too_high');
  assert.equal(validateChosenDiscount(null).error, 'discount_required');
  assert.equal(validateChosenDiscount('abc').error, 'discount_required');
});

test('C2. 제안 대비 격차 — 디렉터가 한눈에 볼 숫자', () => {
  assert.equal(discountGap(60, 55.89), 4.11);    // 제안보다 더 깎아 달라는 요청
  assert.equal(discountGap(50, 55.89), -5.89);   // 제안보다 보수적
  assert.equal(discountGap(55.89, 55.89), 0);
  assert.equal(discountGap(null, 55.89), null);
});

// ── D. 백엔드 소스 계약 ──────────────────────────────────────────────
const custRoutes = read(join(API, 'src/routes/customerRoutes.js'));
const custAuto = read(join(API, 'src/customerAuto.js'));
const quoteRoutes = read(join(API, 'src/routes/quoteRoutes.js'));
const migration = read(join(API, 'migrations/0185_customer_registration_claim.sql'));
const migrationRfc = read(join(API, 'migrations/0188_customer_claim_rfc.sql'));

test('D1. 고객 자동생성 경로가 사라졌다 — 승인·CONSTANCIA 우회 구멍 차단', () => {
  assert.ok(!/INSERT\s+INTO\s+customers/i.test(custAuto),
    'customerAuto.js 가 여전히 고객을 만들면 견적 화면으로 승인을 우회할 수 있다');
  assert.ok(custAuto.includes('customer_not_registered'));
});

test('D2. 견적·가격표 두 경로 모두 미등록/승인대기 고객을 막는다', () => {
  // 경로마다 "판정" 1회 + "응답 error" 1회 = 2개씩, 견적 + 가격표 = 4개
  const hits = quoteRoutes.match(/customer_not_registered/g) || [];
  assert.equal(hits.length, 4, '견적 생성과 가격표 두 곳 모두에 있어야 한다');
  const pend = quoteRoutes.match(/customer_not_approved/g) || [];
  assert.ok(pend.length >= 4, '게스트 경로 + 등록고객 경로 양쪽에서 승인상태를 본다');
  assert.ok(quoteRoutes.includes('isPendingCustomer'));
});

test('D3. 등록 API 는 RFC 를 요구하지 않고 SYD 단가는 요구한다 (0193)', () => {
  assert.ok(/const rfcChk = validateRfcOptional\(b\.rfc\)/.test(custRoutes),
    'RFC 는 선택이지만 넣은 값의 형식은 여전히 엄격히 봐야 한다');
  assert.ok(!/const rfcChk = validateRfc\(b\.rfc\)/.test(custRoutes),
    'RFC 를 다시 필수로 만들면 상담 이력을 먼저 쌓지 못한다');
  assert.ok(custRoutes.includes('syd_ref_price_required'), '기준품목(SYD) 구매단가는 필수(할인율 근거)');
  // CONSTANCIA 를 강제하던 관문은 사라져야 한다
  assert.ok(!custRoutes.includes('constancia_no_required'),
    'CONSTANCIA 번호를 다시 필수로 만들면 선점 시점이 뒤로 밀린다');
  assert.ok(!custRoutes.includes('constancia_file_required'),
    'CONSTANCIA 스캔본을 다시 필수로 만들면 선점 시점이 뒤로 밀린다');
  // 증빙이 선택이 된 이상, 저장 실패로 등록(=선점)을 되돌리면 안 된다
  assert.ok(!/UPDATE customers SET deleted_at=now\(\) WHERE id=\$1/.test(custRoutes),
    '증빙 저장 실패로 롤백하면 그 사이 남이 같은 RFC 를 가져갈 수 있다');
  assert.ok(custRoutes.includes("docWarning = 'constancia_save_failed'"), '대신 경고로 알려야 한다');
});

test('D3b. RFC 는 저장 전 정규화본으로 들어간다(표기 흔들림 제거)', () => {
  assert.ok(/const rfcClean = rfcChk\.value/.test(custRoutes));
  assert.ok(/\[code, b\.name, rfcClean,/.test(custRoutes), '원본 b.rfc 가 그대로 저장되면 안 된다');
});

test('D4. 0193 · 모든 등록이 pending — 디렉터 본인 등록도 예외가 아니다', () => {
  assert.ok(/const status = 'pending'/.test(custRoutes),
    '승인 경로가 하나여야 등록 이력·커미션 귀속이 흔들리지 않는다');
  assert.ok(!/const status = isDir \? 'approved' : 'pending'/.test(custRoutes),
    '디렉터 등록만 승인을 건너뛰면 유사고객 검토가 그 건에서만 사라진다');
  // 항상 pending 이므로 승인자·승인시각은 등록 시점에 비어 있어야 한다
  assert.ok(/status, null, null,/.test(custRoutes), 'pending 인데 approved_by 가 박히면 승인 이력이 거짓이 된다');
});

test('D5. 선점 조회 API 는 매출·연락처를 절대 내려주지 않는다', () => {
  const m = custRoutes.match(/claim-check[\s\S]*?return \{\s*items: rows\.map[\s\S]*?\};/);
  assert.ok(m, 'claim-check 핸들러를 찾지 못했다');
  const body = m[0];
  for (const leak of ['sales_total', 'outstanding', 'total_mxn', 'c.phone', 'c.contact', 'c.memo', 'team_name']) {
    assert.ok(!body.includes(leak), `선점 조회에 ${leak} 이 새면 남의 실적이 보인다`);
  }
  for (const need of ['c.name', 'c.rfc', 'owner_name', 'registered_at']) {
    assert.ok(body.includes(need), `${need} 은 선점 판단에 필요하다`);
  }
});

test('D6. 엑셀 일괄 등록으로 신규 고객을 만드는 경로는 디렉터 전용', () => {
  assert.ok(/} else if \(!isDir\) \{\s*\n\s*blockedNew\+\+;/.test(custRoutes),
    '엑셀 업로드가 열려 있으면 선점·승인 없이 고객을 대량 생성할 수 있다');
});

test('D7. 승인은 CONSTANCIA 스캔본이 없어도 통과한다 (0188 — 선택 증빙)', () => {
  assert.ok(!/return reply\.code\(400\)\.send\(\{ error: 'constancia_missing'/.test(custRoutes),
    'CONSTANCIA 가 승인을 막으면 선택 항목이라고 할 수 없다');
  assert.ok(/const hadDoc = Number\(docs\.n\) > 0/.test(custRoutes), '증빙 유무는 이력에 남긴다');
  assert.ok(/constancia_doc: hadDoc/.test(custRoutes));
});

test('D8. 반려는 사유가 필수이고 선점을 풀어 준다', () => {
  assert.ok(custRoutes.includes("error: 'reason_required'"));
  assert.ok(/approval_status='rejected'[\s\S]{0,120}deleted_at=now\(\)/.test(custRoutes));
  // 유니크 인덱스가 rejected 를 제외해야 반려 후 다른 사람이 등록할 수 있다
  assert.ok(/uq_customers_constancia_no[\s\S]*?approval_status <> 'rejected'/.test(migration));
  assert.ok(/uq_customers_rfc_claim[\s\S]*?approval_status, 'approved'\) <> 'rejected'/.test(migrationRfc),
    'RFC 유니크가 rejected 를 제외하지 않으면 반려해도 선점이 안 풀린다');
});

test('D9. 마이그레이션은 기존 고객을 approved 로 백필한다(회귀 방지)', () => {
  assert.ok(/UPDATE customers SET approval_status = 'approved' WHERE approval_status IS NULL/.test(migration));
});

// ── D′. 0188 · RFC 선점 마이그레이션 계약 ────────────────────────────
test('D9b. 0188 은 기존 RFC 중복을 예외 처리한 뒤에 유니크를 건다', () => {
  assert.ok(/ADD COLUMN IF NOT EXISTS rfc_claim_exempt BOOLEAN NOT NULL DEFAULT false/.test(migrationRfc));
  const iExempt = migrationRfc.indexOf('SET rfc_claim_exempt = true');
  const iIndex = migrationRfc.indexOf('uq_customers_rfc_claim');
  assert.ok(iExempt > 0 && iIndex > iExempt,
    '중복 예외 백필이 유니크 인덱스 생성보다 먼저여야 운영 DB 에서 마이그레이션이 깨지지 않는다');
  // 그룹의 최초 1건만 선점을 갖는다
  assert.ok(/row_number\(\) OVER \(PARTITION BY rfc_norm ORDER BY created_at, id\)/.test(migrationRfc));
  assert.ok(/d\.rn > 1/.test(migrationRfc));
});

test('D9c. 0188 은 재실행해도 안전하다(멱등)', () => {
  assert.ok(/ADD COLUMN IF NOT EXISTS/.test(migrationRfc));
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS/.test(migrationRfc));
});

test('D9d. 선점 유니크는 예외 행을 제외한다', () => {
  assert.ok(/uq_customers_rfc_claim[\s\S]*?rfc_claim_exempt = false/.test(migrationRfc));
});

test('D9e. 애플리케이션 사전조회는 예외 행도 선점자로 본다(남의 고객 가로채기 방지)', () => {
  const m = custRoutes.match(/async function findRfcHolder[\s\S]*?\n\}/);
  assert.ok(m, '선점 사전조회 헬퍼(findRfcHolder)를 찾지 못했다');
  assert.ok(!m[0].includes('rfc_claim_exempt'),
    '사전조회가 예외 행을 건너뛰면 레거시 중복 고객을 다른 영업사원이 새로 등록해 가져간다');
  assert.ok(/c\.rfc_norm = \$1/.test(m[0]), 'RFC 가 선점 키여야 한다');
  // 0193 · 대기 중인 선점 요청도 선점자로 본다
  assert.ok(/FROM customer_rfc_claims[\s\S]*?status='pending'/.test(m[0]),
    '대기 요청을 무시하면 먼저 RFC 를 입력한 사람의 우선권이 새 등록으로 뚫린다');
});

test('D9f. 수정은 RFC 를 요구하지 않는다 — 빈값이면 기존값 유지(오류 아님)', () => {
  // 전화·배송지만 고치려는 사람에게 RFC 를 강요하면 일상 업무가 막힌다.
  assert.ok(/rfcVal = \(b\.rfc !== undefined && String\(b\.rfc\)\.trim\(\) !== ''\) \? String\(b\.rfc\)\.trim\(\) : \(c\.rfc \|\| null\)/
    .test(custRoutes), '빈값이면 현재값 유지 — 지워서 선점이 풀리는 일만 막으면 된다');
  const apply = custRoutes.match(/async function applyCustomerUpdate[\s\S]*?\n  \}/)[0];
  assert.ok(!apply.includes('validateRfc'),
    '수정 경로에 RFC 형식 검증이 들어가면 레거시 고객(RFC 없음·형식 지저분)을 못 고친다');
  for (const k of ['rfc_required', 'rfc_invalid', 'rfc_invalid_date', 'rfc_generic']) {
    assert.ok(!apply.includes(k), `수정 경로가 ${k} 로 막으면 안 된다`);
  }
});

test('D9g. 수정으로 남의 선점을 뺏는 것만 막는다', () => {
  const apply = custRoutes.match(/async function applyCustomerUpdate[\s\S]*?\n  \}/)[0];
  assert.ok(/e\.claimError = err/.test(apply), 'DB 유니크가 500 을 던지기 전에 누가 갖고 있는지 알려 준다');
  assert.ok(/findRfcHolder\(normalizeClaimKey\(rfcVal\)/.test(apply),
    '수정 경로도 확정 선점 + 대기 요청을 같이 봐야 한다');
  // 반대로 CONSTANCIA 번호는 이제 지울 수 있다(선점 키가 아니므로)
  assert.ok(/b\.constancia_no === undefined[\s\S]{0,140}String\(b\.constancia_no\)\.trim\(\) \|\| null/.test(custRoutes));
});

test('D10. 승인 화면 diff 3종 세트에 constancia_no 가 빠짐없이 들어갔다', () => {
  // 2026-08-18 buyer_phone 사고와 같은 유형(한 곳만 누락 → 승인해도 반영 0)을 막는다
  assert.ok(/proposed = \{[\s\S]*?constancia_no: b\.constancia_no/.test(custRoutes), 'proposed 화이트리스트');
  assert.ok(/LABELS = \{[\s\S]*?constancia_no: 'CONSTANCIA/.test(custRoutes), 'LABELS');
  assert.ok(/cur_constancia_no/.test(custRoutes), 'cur 매핑');
  assert.ok(/constancia_no=\$19/.test(custRoutes), 'applyCustomerUpdate');
});

test('D10b. 고객코드 발번은 삭제된 고객의 코드까지 센다', () => {
  // 반려 = 소프트삭제. customers.code 는 유니크라 삭제행의 번호를 다시 뽑으면
  // INSERT 가 5번 재시도 끝에 code_generation_failed 로 죽는다.
  // (통합 테스트에서 "반려 직후 같은 고객 재등록" 이 실패해 발견한 버그)
  assert.ok(/SELECT code FROM customers`\)/.test(custRoutes),
    'computeNextCode 가 deleted_at IS NULL 로 걸러지면 반려 후 재등록이 막힌다');
  assert.ok(!/SELECT code FROM customers WHERE deleted_at IS NULL/.test(custRoutes));
});

test('D11. 기준품목 코드는 환경변수로 바꿀 수 있고 기본값은 1516049', () => {
  assert.ok(/process\.env\.SYD_BASE_CODE \|\| '1516049'/.test(custRoutes));
});

test('D12. 제안 할인율은 상수 마크업이 아니라 실제 CTR List Price 로 계산한다', () => {
  assert.ok(/p\.list_price_syd, p\.list_price/.test(custRoutes),
    'CTR 정가(list_price)를 제품 마스터에서 함께 읽어야 한다');
  assert.ok(!/1\.40|CTR_MARKUP/.test(custRoutes),
    'viofinder 의 ×1.40 상수를 여기서 쓰면 SKU 별 실제 정가와 어긋난다');
});

// ── E. 프런트 계약 ───────────────────────────────────────────────────
const custform = read(join(REPO, 'refatrix-custform.js'));
const custHtml = read(join(REPO, 'refatrix-customers.html'));

test('E0. 수정 화면은 RFC 를 요구하지 않는다(일상 업무 방해 금지)', () => {
  const save = custform.match(/async function save\(\)[\s\S]*?\n  \}/)[0];
  assert.ok(/if\(!editingId\)\{[\s\S]*var rv=validateRfcLocal/.test(save),
    'RFC 검증은 신규 등록 블록 안에만 있어야 한다');
  assert.ok(!save.includes('RFC 는 선점 키라 비울 수 없습니다'),
    '수정에서 RFC 를 막으면 전화·배송지만 고치려는 사람이 저장을 못 한다');
  // 0193 · 배지는 「선택 · 입력하면 선점」 — 신규 등록에서만 뜬다
  assert.ok(custform.includes(`id="rcf-rfckey" style="color:#1f5540;font-weight:700;display:none"> — 선택 · 입력하면 그 순간 선점`));
  assert.ok(/kb\.style\.display=isNew\?'':'none'/.test(custform));
});

test('E1. 신규 등록 폼은 RFC 를 막지 않고 SYD 단가만 막는다 (0193)', () => {
  const save = custform.match(/async function save\(\)[\s\S]*?\n  \}/);
  assert.ok(save, 'save() 를 찾지 못했다');
  const s = save[0];
  assert.ok(/if\(rawRfc\)\{[\s\S]*var rv=validateRfcLocal\(rawRfc\)/.test(s),
    'RFC 를 넣은 경우에만 형식을 본다');
  assert.ok(/\}else\{[\s\S]*b\.rfc=null;/.test(s), 'RFC 를 비우면 그대로 통과해야 한다');
  assert.ok(s.includes('RFC 없이 등록합니다'), '선점이 없다는 사실을 한 번은 확인받아야 한다');
  assert.ok(s.includes('SYD 기준품목의 고객 구매단가를 입력해야 등록이 진행됩니다'));
  assert.ok(!s.includes('CONSTANCIA 번호를 입력해야'), 'CONSTANCIA 번호를 다시 필수로 만들면 안 된다');
  assert.ok(!s.includes('CONSTANCIA 스캔본(PDF)을 첨부하세요'), 'CONSTANCIA 파일을 다시 필수로 만들면 안 된다');
  assert.ok(s.includes('constancia_file'), '첨부한 경우에는 body 에 실려야 서버가 저장한다');
});

test('E1b. 프런트 RFC 검증은 서버(customerClaim.js)와 같은 규칙이다', () => {
  // 규칙이 갈라지면 "화면은 통과, 저장은 실패" 가 되어 영업사원이 선점을 놓친다
  assert.ok(custform.includes("var GENERIC_RFC=['XAXX010101000','XEXX010101000']"));
  assert.ok(custform.includes('A-ZÑ&'), '법인 3자·개인 4자 패턴이 같아야 한다');
  for (const k of ['rfc_required', 'rfc_invalid', 'rfc_invalid_date', 'rfc_generic']) {
    assert.ok(custform.includes(k), `${k} 안내 문구가 프런트에도 있어야 한다`);
  }
});

test('E2. 저장 직전 선점을 한 번 더 확인한다(입력 중 남이 먼저 등록한 경우)', () => {
  const save = custform.match(/async function save\(\)[\s\S]*?\n  \}/)[0];
  assert.ok(/var cc=await claimCheck\(true\)/.test(save));
  assert.ok(/cc\.blocked_rfc\|\|cc\.blocked_constancia/.test(save));
});

test('E3. 선점·기준품목 박스는 신규 등록에서만 뜬다(수정 화면 회귀 없음)', () => {
  assert.ok(/function setRegBoxes\(isNew\)/.test(custform));
  assert.ok(/fillEdit\(c,pending\)\{\s*\n\s*editingId=c\.id;\s*\n\s*setRegBoxes\(false\);/.test(custform));
});

test('E4. 파일은 5MB 상한이 프런트·백엔드 양쪽에 있다', () => {
  assert.ok(custform.includes('5*1024*1024'));
  assert.ok(custRoutes.includes('MAX_DOC_BYTES'));
});

test('E5. 디렉터 등록 승인 탭이 붙었고 디렉터에게만 보인다', () => {
  assert.ok(custHtml.includes('id="tab-reg"'));
  assert.ok(custHtml.includes('loadRegApprovals'));
  assert.ok(/\$\('regTabBtn'\)\.classList\.add\('hidden'\)/.test(custHtml),
    '비디렉터에게 등록 승인 탭이 보이면 안 된다');
});

test('E6. 승인 대기 고객은 목록에서 배지로 구분된다', () => {
  assert.ok(/approval_status==='pending'\?' <span class="pill"[^']*등록 승인대기/.test(custHtml));
});

test('E7. 견적·현장조사에서 "자동 등록" 안내 문구가 사라졌다', () => {
  const quote = read(join(REPO, 'refatrix-quote.html'));
  const fs2 = read(join(REPO, 'refatrix-fieldsurvey.html'));
  assert.ok(!quote.includes('Se registrará automáticamente como cliente'),
    '자동 등록 안내가 남아 있으면 영업사원이 잘못된 기대를 갖는다');
  assert.ok(!fs2.includes('견적 발송 시 자동으로 고객 등록됩니다'));
  assert.ok(quote.includes("c.approval_status!=='pending'"), '승인대기 고객은 견적 드롭다운에서 제외');
  assert.ok(fs2.includes('customer_not_registered'), '현장조사에도 안내 메시지가 있어야 한다');
});

test('E8. 빌드 마커가 올라갔다(하드 리프레시 확인용)', () => {
  assert.ok(custform.includes('v20260901claimb'));
  assert.ok(custHtml.includes('refatrix-custform.js?v=20260901claimb'), 'custform 캐시버스터 동기화');
  // 탭 제목 마커는 화면이 바뀔 때마다 올라간다(merge-0903 = 🔗 고객 병합 추가).
  assert.ok(custHtml.includes('merge-0903'));
});

test('E9. 화면 문구가 "RFC 로 선점" 으로 바뀌었다', () => {
  assert.ok(custform.includes('🔒 내 고객 선점 — RFC 입력 시점이 우선권'));
  assert.ok(custHtml.includes('RFC 가 없는 고객은 선점되지 않은 상태'), '승인 대기 탭 안내');
  assert.ok(custHtml.includes('RFC 선점이 풀립니다'), '반려 확인 문구');
  assert.ok(custHtml.includes('rfc_claim_exempt'), '레거시 중복 고객은 상세에서 보호 제외임을 알려야 한다');
});

// =====================================================================
// F. 0193 · RFC 선택 입력 + 「RFC 입력 시점 = 우선권」 선점 이관
//
//   돈이 걸린 규칙이라 순수 함수(F1~F4)와 소스 계약(F5~F12) 양쪽을 못 박는다.
// =====================================================================

test('F1. RFC 를 비우면 통과하고, 넣으면 0188 과 똑같이 엄격하다', () => {
  const empty = validateRfcOptional('');
  assert.equal(empty.ok, true);
  assert.equal(empty.value, null);
  assert.equal(empty.empty, true, '비었다는 사실이 호출부에 보여야 선점 여부를 판단할 수 있다');
  for (const v of [null, undefined, '   ', '-- ']) {
    assert.equal(validateRfcOptional(v).ok, true, `"${v}" 는 미입력으로 봐야 한다`);
  }
  // 넣은 값은 여전히 막는다 — 느슨해지면 「아무 문자열로 선점」 우회가 살아난다
  assert.equal(validateRfcOptional('내고객임시').error, 'rfc_invalid');
  assert.equal(validateRfcOptional('XAXX010101000').error, 'rfc_generic');
  assert.equal(validateRfcOptional('ABC011303XY1').error, 'rfc_invalid_date');
  const ok = validateRfcOptional('fel-990715-ab1');
  assert.equal(ok.value, 'FEL990715AB1', '정리본으로 저장돼야 표기 흔들림이 DB 에 남지 않는다');
  assert.equal(ok.empty, false);
});

test('F2. 상호명 정규화 — 법인격 표기·악센트는 판정에서 걷어낸다', () => {
  assert.equal(normalizeCompanyName('Refaccionés  Peña, S.A. de C.V.'), 'REFACCIONES PENA S A DE C V');
  assert.deepEqual(companyNameTokens('Refacciones Peña, S.A. de C.V.'), ['REFACCIONES', 'PENA']);
  assert.deepEqual(companyNameTokens('S.A. de C.V.'), [], '법인격 표기만 남으면 판정할 게 없다');
});

test('F3. 유사도는 짧은 쪽 기준 — 지점 표기가 붙어도 같은 상호로 잡는다', () => {
  assert.equal(nameSimilarity('Refacciones Peña SA de CV', 'REFACCIONES PENA MONTERREY'), 1,
    '지점 표기가 붙은 같은 상호를 놓치면 중복 등록을 경고하지 못한다');
  assert.equal(nameSimilarity('Autopartes Del Norte', 'Llantas Garcia'), 0);
  assert.ok(nameSimilarity('Refacciones Peña', 'Refacciones Lopez') < NAME_SIMILAR_THRESHOLD,
    '한 단어만 겹치는 흔한 업종명("Refacciones")이 경고를 뒤덮으면 안 된다');
  // 빈 값·법인격만 있는 값은 0 — 경고가 무차별로 뜨지 않게
  assert.equal(nameSimilarity('', 'Refacciones Peña'), 0);
  assert.equal(nameSimilarity('S.A. de C.V.', 'Refacciones SA de CV'), 0);
});

test('F4. 유사 상호는 경고일 뿐 — 등록을 막는 임계값이 아니다', () => {
  assert.ok(NAME_SIMILAR_THRESHOLD > 0 && NAME_SIMILAR_THRESHOLD < 1);
  // ⚠ 팀 생성의 name_taken(sales_teams) 과 헷갈리지 않게 **고객 등록 핸들러 안에서만** 본다.
  const create = custRoutes.match(/app\.post\('\/api\/customers', \{[\s\S]*?\n  \}\);/)[0];
  assert.ok(!/name_taken|name_similar_blocked/.test(create),
    '상호 일치로 등록을 차단하면 지점·법인 분리에서 오탐이 더 비싸다');
  assert.ok(!/if \(similar\.length\)[\s\S]{0,120}reply\.code\(409\)/.test(create),
    '유사 상호는 경고일 뿐 — 저장을 막으면 안 된다');
  assert.ok(/const similar = await findSimilarCustomers\(b\.name/.test(custRoutes),
    '차단하지 않는 대신 승인 화면이 볼 수 있게 응답·이력에 실어야 한다');
});

test('F5. 마이그레이션 0193 — 선점 시각/선점자 + 대기 요청 유니크', () => {
  const sql = read(join(API, 'migrations', '0193_customer_rfc_optional_claim.sql'));
  assert.ok(/ADD COLUMN IF NOT EXISTS rfc_claimed_at/.test(sql));
  assert.ok(/ADD COLUMN IF NOT EXISTS rfc_claimed_by/.test(sql));
  assert.ok(/CREATE TABLE IF NOT EXISTS customer_rfc_claims/.test(sql));
  // ★ 같은 RFC 로 대기 요청은 하나뿐 = 먼저 입력한 사람이 우선권
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS uq_rfc_claims_pending_rfc[\s\S]*?WHERE status = 'pending'/.test(sql),
    '이 유니크가 없으면 두 사람이 같은 RFC 로 동시에 요청해 우선권이 흐려진다');
  // 백필: 기존 RFC 보유 고객은 등록 시점을 선점 시점으로 본다(회귀 없음)
  assert.ok(/SET rfc_claimed_at = created_at/.test(sql));
  assert.ok(/AND rfc_claimed_at IS NULL/.test(sql), '재실행해도 값이 흔들리지 않아야 한다(멱등)');
  // 한 고객에 서로 다른 RFC 요청이 여러 건 붙는 것은 허용(디렉터가 판단)
  assert.ok(!/UNIQUE INDEX[^;]*customer_rfc_claims \(customer_id\)[^;]*pending/.test(sql));
});

test('F6. 등록 응답이 「선점됐는지」를 분명히 말한다', () => {
  assert.ok(/claimed_by: rfcClean \? 'rfc' : null/.test(custRoutes),
    'RFC 없이 등록했는데 claimed_by 가 채워지면 영업사원이 선점된 줄 안다');
  assert.ok(custRoutes.includes('아직 선점되지 않았습니다'), 'RFC 없이 등록한 사람에게 결과를 말해야 한다');
  assert.ok(custRoutes.includes('우선권이 갑니다'), '누가 가져갈 수 있는지까지 말해야 행동이 바뀐다');
});

test('F7. 선점 이관 — 내 고객이면 즉시, 남의 고객이면 디렉터 승인', () => {
  const route = custRoutes.match(/app\.post\('\/api\/customers\/:id\/rfc-claim'[\s\S]*?\n  \}\);/);
  assert.ok(route, 'rfc-claim 엔드포인트를 찾지 못했다');
  const r = route[0];
  assert.ok(/const chk = validateRfc\(req\.body\?\.rfc\)/.test(r),
    '이관은 RFC 가 본질이므로 여기서는 필수 + 엄격해야 한다');
  assert.ok(/if \(c\.rfc_norm\)[\s\S]{0,200}rfc_already_set/.test(r),
    '이미 선점된 고객을 이 경로로 덮어쓰면 선점이 뒤집힌다');
  assert.ok(/const mine = c\.owner_id != null && Number\(c\.owner_id\) === Number\(perm\.userId\)/.test(r));
  assert.ok(/if \(mine\)[\s\S]{0,400}rfc_claimed_at=now\(\)/.test(r),
    '내 고객에 RFC 를 채우는 건 뺏는 게 아니므로 즉시 확정돼야 한다');
  assert.ok(/uq_rfc_claims_pending_rfc/.test(r), '동시 요청은 DB 유니크로 최종 판정해야 한다');
});

test('F8. ★ 선점 시점은 승인 시각이 아니라 RFC 입력 시각이다', () => {
  const appr = custRoutes.match(/app\.post\('\/api\/customer-rfc-claims\/:id\/approve'[\s\S]*?\n  \}\);/)[0];
  assert.ok(/rfc_claimed_at=\$2[\s\S]{0,200}k\.requested_at/.test(appr),
    '승인 시각을 박으면 "먼저 입력한 사람이 우선" 이라는 규칙 자체가 무너진다');
  assert.ok(/owner_id=\$3/.test(appr) && /k\.requested_by/.test(appr), '담당이 요청자로 이관돼야 한다');
  assert.ok(/status='superseded'/.test(appr), '같은 고객의 나머지 요청은 무효 처리돼야 한다');
  assert.ok(/rfc_claimed_by=\$3/.test(appr));
});

test('F9. 이관 대기 목록은 요청 시각 오름차순 = 우선순위', () => {
  const list = custRoutes.match(/app\.get\('\/api\/customer-rfc-claims'[\s\S]*?\n  \}\);/)[0];
  assert.ok(/ORDER BY k\.requested_at, k\.id/.test(list),
    '정렬이 뒤집히면 디렉터가 나중에 넣은 사람을 1순위로 본다');
  assert.ok(/priority: i \+ 1/.test(list));
  // 팀 스코프를 타지 않는 경로라 금액·연락처가 새면 안 된다
  assert.ok(!/discount|credit_days|phone|contact/.test(list),
    '선점 이관 목록에 거래조건·연락처가 실리면 안 된다');
});

test('F10. 반려는 사유 필수 — 이관 요청도 등록 반려와 같은 기준', () => {
  const rej = custRoutes.match(/app\.post\('\/api\/customer-rfc-claims\/:id\/reject'[\s\S]*?\n  \}\);/)[0];
  assert.ok(/reason_required/.test(rej));
  assert.ok(/status='rejected'/.test(rej));
});

test('F11. 매출은 RFC 없이 확정할 수 없다 — 견적은 열려 있다', () => {
  const sales = read(join(API, 'src', 'routes', 'salesRoutes.js'));
  const quote = read(join(API, 'src', 'routes', 'quoteRoutes.js'));
  assert.ok(/if \(!normalizeClaimKey\(cust\.rfc\)\)[\s\S]{0,200}customer_rfc_required/.test(sales),
    '매출 관문이 없으면 선점 없는 고객에 매출이 꽂혀 커미션 귀속이 무주공산이 된다');
  // 견적 → 매출 전환도 같은 규칙(우회로가 되면 관문이 의미 없다)
  assert.ok(/customer_rfc_required/.test(quote), '전환 경로가 뚫려 있으면 관문이 무의미하다');
  // 반대로 견적 작성 자체는 RFC 를 요구하지 않아야 한다
  assert.ok(!/quote[\s\S]{0,80}rfc_required/.test(quote),
    '견적까지 막으면 RFC 를 못 받은 초기 접촉 단계가 통째로 막힌다');
});

test('F12. 승인 화면이 「RFC 없음」과 유사 상호를 보여 준다', () => {
  assert.ok(custHtml.includes('RFC 없음 — 선점 안 됨'), '승인 카드에서 눈에 띄어야 한다');
  assert.ok(custHtml.includes('⚠ 유사 상호'), '중복 여부를 판단할 재료가 있어야 한다');
  assert.ok(custHtml.includes('claimTabBtn') && custHtml.includes('tab-claim'), '선점 이관 탭');
  assert.ok(custHtml.includes('우선권의 근거'), '요청 시각이 왜 중요한지 화면에서 말해야 한다');
  assert.ok(custHtml.includes('claimRfcNow'), '상세에서 바로 RFC 를 채워 선점을 확정할 수 있어야 한다');
  // 전원 승인 대기로 바뀐 사실이 안내에 반영돼야 한다
  assert.ok(custHtml.includes('디렉터가 직접 등록한 건도 포함'));
});

test('F13. 등록 폼에서 「이 고객을 내 RFC 로 선점」 경로가 살아 있다', () => {
  assert.ok(custform.includes('rcf-take'), 'claim-check 결과에서 바로 선점 요청을 걸 수 있어야 한다');
  assert.ok(/\/rfc-claim/.test(custform));
  assert.ok(custform.includes('has_rfc'), 'RFC 없는 고객만 요청 대상이다');
  assert.ok(custform.includes('요청 시각이 우선권의 근거가 됩니다'));
});

// =====================================================================
// G. 0194 · 철 지난 선점 예외(rfc_claim_exempt) 정리
//
//   0188 의 예외 플래그는 「마이그레이션이 돌던 순간」의 스냅샷이다.
//   상대 고객이 그 뒤 삭제·반려되거나 RFC 가 정정되면 중복은 사라졌는데 플래그만 남고,
//   그 고객은 **실제로 DB 유니크 보호를 못 받는 상태**로 방치된다(표시만 이상한 게 아니다).
// =====================================================================

test('G1. 마이그레이션 0194 — 중복이 해소된 행만 예외를 푼다', () => {
  const sql = read(join(API, 'migrations', '0194_rfc_claim_exempt_cleanup.sql'));
  assert.ok(/SET rfc_claim_exempt = false/.test(sql));
  // ★ 핵심: "같은 RFC 를 쓰는 살아있는 고객이 없다" 일 때만
  assert.ok(/NOT EXISTS \([\s\S]*?o\.rfc_norm = c\.rfc_norm[\s\S]*?o\.deleted_at IS NULL/.test(sql),
    '진짜 중복 그룹까지 풀면 uq_customers_rfc_claim 이 깨진다');
  assert.ok(/o\.id <> c\.id/.test(sql), '자기 자신을 중복으로 세면 아무것도 풀리지 않는다');
  assert.ok(/COALESCE\(o\.approval_status, ?'approved'\) <> 'rejected'/.test(sql),
    '반려 행은 유니크 대상이 아니므로 중복으로 세면 안 된다');
  // 데이터는 건드리지 않는다(플래그만)
  assert.ok(!/DELETE FROM customers|SET rfc *=|deleted_at *= *now\(\)/.test(sql));
});

test('G2. 상세는 「진짜 중복」과 「철 지난 표시」를 구분해 말한다', () => {
  assert.ok(/rfc_dup_count: rfcDup \? rfcDup\.count : null/.test(custRoutes),
    '지금 기준 중복 건수를 세지 않으면 화면이 옛날 플래그를 그대로 읊는다');
  assert.ok(/c\.rfc_dup_count===0/.test(custHtml), '0건이면 「철 지난 표시」로 안내해야 한다');
  assert.ok(custHtml.includes('이 RFC 를 쓰는 다른 고객은 지금 없습니다'));
  assert.ok(custHtml.includes('선점 보호 복구'), '디렉터에게는 복구 버튼이 있어야 한다');
  // 팀 스코프를 넘는 조회라 금액·연락처가 새면 안 된다
  const dupq = custRoutes.match(/let rfcDup = null;[\s\S]*?\n    \}/)[0];
  assert.ok(!/discount|credit_days|phone|contact|rfc\b.*AS/.test(dupq.replace(/rfc_norm/g, '')),
    '중복 조회에 거래조건·연락처가 실리면 안 된다');
});

test('G3. 해제 API — 진짜 중복은 막고, 해소된 건만 푼다', () => {
  const rel = custRoutes.match(/app\.post\('\/api\/customers\/:id\/rfc-exempt-release'[\s\S]*?\n  \}\);/)[0];
  assert.ok(/rfc_still_duplicated/.test(rel), '아직 중복이면 이유를 말하고 막아야 한다');
  assert.ok(/uq_customers_rfc_claim/.test(rel), '경합은 DB 유니크로 최종 판정해야 한다');
  assert.ok(/rfc_required/.test(rel), 'RFC 가 빈 행은 해제 대상이 아니다');
  const scan = custRoutes.match(/app\.post\('\/api\/customers\/rfc-exempt-rescan'[\s\S]*?\n  \}\);/)[0];
  assert.ok(/NOT EXISTS \([\s\S]*?o\.rfc_norm = c\.rfc_norm/.test(scan),
    '재검사는 마이그레이션 0194 와 같은 규칙이어야 한다');
  assert.ok(/rfc_exempt_release/.test(scan), '복구도 이력에 남아야 한다');
});

test('G4. 예외 목록·정리는 디렉터 전용', () => {
  for (const p of ["'/api/customers/rfc-exempt'", "'/api/customers/rfc-exempt-rescan'",
                   "'/api/customers/:id/rfc-exempt-release'"]) {
    const m = custRoutes.match(new RegExp(`app\\.(get|post)\\(${p.replace(/[/]/g, '\\/')}, \\{ preHandler: \\[authGuard, requireDirector\\]`));
    assert.ok(m, `${p} 는 requireDirector 여야 한다 — 영업사원이 남의 선점을 풀면 안 된다`);
  }
  assert.ok(custHtml.includes('선점 예외 정리'), '디렉터 화면에 정리 카드가 있어야 한다');
  assert.ok(custHtml.includes('rescanRfcExempt') && custHtml.includes('releaseRfcExempt'));
});
