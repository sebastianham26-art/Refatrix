// =====================================================================
// 고객 독점 정책 — 순수 계산 검증 (0235, 2026-09-29)
//   실행: node --test test/customer_exclusivity.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeExclusivity, addDays, yearEnd, daysBetween } from '../src/exclusivity.js';

const A = 1, B = 2, C = 3;
const inv = (id, date, seller, net = 100) => ({ id, date, seller, net });

test('날짜: 30일·1년 경계(포함 기준)', () => {
  assert.equal(addDays('2026-10-01', 29), '2026-10-30');
  assert.equal(yearEnd('2026-10-03'), '2027-10-02');
  assert.equal(yearEnd('2028-02-29'), '2029-02-28');   // 2/29 시작 → 다음 해 2/28 까지
  assert.equal(yearEnd('2026-01-01'), '2026-12-31');
  assert.equal(daysBetween('2026-10-01', '2026-10-31'), 30);
});

test('X1 RFC 등록만 — 30일 동안 등록자 독점, 31일째 개방', () => {
  const r1 = computeExclusivity({ rfcFrom: '2026-10-01', rfcAgent: A, invoices: [], today: '2026-10-30' });
  assert.equal(r1.current.kind, 'rfc'); assert.equal(r1.current.agent, A); assert.equal(r1.current.ends_on, '2026-10-30');
  const r2 = computeExclusivity({ rfcFrom: '2026-10-01', rfcAgent: A, invoices: [], today: '2026-10-31' });
  assert.equal(r2.current, null); assert.equal(r2.open, true);
});

test('X2 30일 안에 등록자가 판매 → 인보이스일부터 1년', () => {
  const r = computeExclusivity({ rfcFrom: '2026-10-01', rfcAgent: A, invoices: [inv(10, '2026-10-20', A)], today: '2026-11-15' });
  assert.equal(r.current.kind, 'sale'); assert.equal(r.current.agent, A);
  assert.equal(r.current.starts_on, '2026-10-20'); assert.equal(r.current.ends_on, '2027-10-19');
  assert.equal(r.invoiceAgent[10], A);
  // 지난 RFC 기간은 이력에 남는다(판매 전날까지)
  assert.equal(r.periods[0].kind, 'rfc'); assert.equal(r.periods[0].ends_on, '2026-10-19');
});

test('X3 RFC 기간 중 다른 사람 이름으로 들어온 인보이스도 커미션은 등록자', () => {
  const r = computeExclusivity({ rfcFrom: '2026-10-01', rfcAgent: A, invoices: [inv(10, '2026-10-05', B)], today: '2026-10-06' });
  assert.equal(r.invoiceAgent[10], A); assert.equal(r.current.agent, A);
});

test('X4 30일 소멸 후 먼저 인보이스한 사람이 1년 독점', () => {
  const r = computeExclusivity({ rfcFrom: '2026-10-01', rfcAgent: A,
    invoices: [inv(10, '2026-11-05', B), inv(11, '2026-11-06', C)], today: '2026-11-10' });
  assert.equal(r.current.agent, B); assert.equal(r.current.starts_on, '2026-11-05');
  assert.equal(r.invoiceAgent[10], B); assert.equal(r.invoiceAgent[11], B);   // 두 번째 판매도 독점권자에게
});

test('X5 1년 안에 서로 다른 6개월 → 같은 사람 +1년, 5개월이면 개방', () => {
  const six = ['2026-10-20', '2026-11-03', '2026-12-10', '2027-01-15', '2027-03-01', '2027-06-30'].map((d, i) => inv(20 + i, d, A));
  const r = computeExclusivity({ rfcFrom: null, rfcAgent: null, invoices: six, today: '2027-10-25' });
  assert.equal(r.current.agent, A); assert.equal(r.current.renewed, true);
  assert.equal(r.current.starts_on, '2027-10-20'); assert.equal(r.current.ends_on, '2028-10-19');
  const five = six.slice(0, 5);
  const r2 = computeExclusivity({ rfcFrom: null, rfcAgent: null, invoices: five, today: '2027-10-25' });
  assert.equal(r2.current, null); assert.equal(r2.open, true);
});

test('X6 같은 달 여러 건은 1개월로 센다', () => {
  const invs = ['2026-10-01', '2026-10-15', '2026-10-30', '2026-11-01', '2026-11-20', '2026-12-01', '2027-01-01', '2027-02-01']
    .map((d, i) => inv(30 + i, d, A));
  const r = computeExclusivity({ invoices: invs, today: '2027-10-05' });
  assert.equal(r.current, null);   // 10·11·12·1·2 = 5개월 → 연장 안 됨
});

test('X7 연장 실패 후 개방 → 다음 인보이스 낸 사람이 새 1년', () => {
  const r = computeExclusivity({ invoices: [inv(40, '2026-10-01', A), inv(41, '2027-12-01', B)], today: '2027-12-02' });
  assert.equal(r.current.agent, B); assert.equal(r.current.starts_on, '2027-12-01');
  assert.equal(r.invoiceAgent[40], A); assert.equal(r.invoiceAgent[41], B);
});

test('X8 전액 반품(순매출 0) 인보이스는 독점을 만들지 않는다', () => {
  const r = computeExclusivity({ rfcFrom: '2026-10-01', rfcAgent: A, invoices: [inv(50, '2026-10-10', A, 0)], today: '2026-11-05' });
  assert.equal(r.current, null);   // RFC 30일이 그대로 소멸
  assert.equal(r.invoiceAgent[50], A);
});

test('X9 첫 인보이스가 취소(목록에서 빠짐)되면 다음 인보이스 기준으로 다시 계산', () => {
  const r = computeExclusivity({ rfcFrom: '2026-10-01', rfcAgent: A, invoices: [inv(61, '2026-11-10', B)], today: '2026-11-11' });
  assert.equal(r.current.agent, B);
});

test('X10 RFC 없이 개방 상태 + 판매자 없는 인보이스는 기간을 만들지 않는다', () => {
  const r = computeExclusivity({ invoices: [inv(70, '2026-10-10', null)], today: '2026-10-11' });
  assert.equal(r.current, null); assert.equal(r.invoiceAgent[70], null);
});
