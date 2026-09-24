// 20260924 · 물려받은 키는 환경이 달라도 비지 않는다.
//   사고: 원천(고객 상거래정보)은 운영 키만 있고 오더상태는 테스트로 켰다 →
//   키가 안 실려 CRM 이 「ERR_API_KEY — API key es requerida」.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { borrowToken, activeToken } = await import('../src/integrations.js');

const src = { key: 'customer_commercial', label: '고객 상거래정보', env: 'prod',
  auth_token: null, auth_token_test: null, auth_token_prod: 'PROD-KEY-64' };

test('원천에 운영 키만 있어도 테스트로 켠 창구에 키가 실린다', () => {
  const ep = borrowToken({ key: 'order_status', env: 'test', auth_from: 'customer_commercial' }, src);
  assert.equal(activeToken(ep), 'PROD-KEY-64');
  assert.equal(ep.token_borrowed_from, 'customer_commercial');
});

test('운영으로 켜면 원천의 운영 키', () => {
  assert.equal(activeToken(borrowToken({ key: 'o', env: 'prod' }, src)), 'PROD-KEY-64');
});

test('원천에 환경별 키가 따로 있으면 같은 환경 키를 쓴다', () => {
  const both = { ...src, auth_token_test: 'TEST-KEY' };
  assert.equal(activeToken(borrowToken({ key: 'o', env: 'test' }, both)), 'TEST-KEY');
  assert.equal(activeToken(borrowToken({ key: 'o', env: 'prod' }, both)), 'PROD-KEY-64');
});

test('옛 단일 키(auth_token)만 있어도 된다', () => {
  const legacy = { key: 's', env: 'test', auth_token: 'OLD' };
  assert.equal(activeToken(borrowToken({ key: 'o', env: 'prod' }, legacy)), 'OLD');
});

test('원천에도 키가 없으면 그대로 둔다(화면이 경고한다)', () => {
  const ep = { key: 'o', env: 'test' };
  assert.equal(borrowToken(ep, { key: 's', env: 'prod' }), ep);
});
