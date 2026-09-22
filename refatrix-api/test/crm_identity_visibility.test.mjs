// CRM 전송 — **무엇을 보냈는지 보이게 한다** (2026-09-22)
//
//   겪은 일: ERP 에서 고객 이메일을 고쳤는데 CRM 에 반영되지 않았고,
//   다른 건에서는 `ERR_VALIDATION — Para un RFC nuevo son requeridos razonSocial,
//   contactEmail, contactPhone y businessTypeId` 가 떴다.
//   두 증상 모두 **원인을 화면에서 볼 수 없다**는 점이 진짜 문제였다:
//     · 신원 동봉은 Railway 변수 하나(CRM_UPSERT_IDENTITY)로 **조용히** 꺼진다.
//     · 거절 사유에는 스페인어 문장만 남아, 넷 중 무엇이 빠졌는지 「원문」을 열어야 알았다.
//
//   여기서 잠그는 것: 우리가 보낸 것과 안 보낸 것이 **이력과 화면에 사실대로** 적힌다.
//   ⚠ 상대의 「필수」 규칙은 우리 코드에 복제하지 않는다 — 그건 규칙을 두 곳에 두는 일이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { buildPayload, identityNote, crmStatus, upsertIdentityOn } =
  await import('../src/crmSync.js');

const BASE = {
  id: 1, code: 'C-0100', rfc: 'AIAC8310204A0', name: 'ACME SA',
  contact: 'a@b.com', phone: '8112345678',
  discount: 10, credit_days: 30, approval_status: 'approved',
};

test('보낸 신원과 안 보낸 신원을 그대로 적는다', () => {
  const full = identityNote(buildPayload('upsert', { ...BASE, customer_type: 'A' }, 'admin'));
  for (const k of ['razonSocial', 'contactEmail', 'contactPhone', 'businessTypeId']) {
    assert.ok(full.includes(k), k + ' 가 「보냄」에 있어야 한다');
  }
  assert.equal(full.includes('안 보냄'), false, '다 보냈으면 「안 보냄」이 없어야 한다');
});

test('TIER 가 없으면 businessTypeId 가 빠졌다고 적는다', () => {
  // 지금 ERR_VALIDATION 이 나는 가장 흔한 경우다. 이력만 보고 바로 알아야 한다.
  const n = identityNote(buildPayload('upsert', { ...BASE, customer_type: 'refraccionaria' }, 'admin'));
  assert.match(n, /안 보냄:.*businessTypeId/);
  assert.match(n, /보냄:.*contactEmail/, '이메일은 보냈다는 사실도 같이 보여야 한다');
});

test('이메일이 비면 contactEmail 이 빠졌다고 적는다', () => {
  const n = identityNote(buildPayload('upsert', { ...BASE, customer_type: 'B', contact: null }, 'admin'));
  assert.match(n, /안 보냄:.*contactEmail/);
});

test('우리는 「무엇이 필수인지」를 판정하지 않는다', () => {
  // 상대의 검증 규칙을 우리 코드에 복제하면 상대가 규칙을 바꾸는 날 두 곳이 갈라진다.
  const src = readFileSync(new URL('../src/crmSync.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export function identityNote'), src.indexOf('export function upsertIdentityOn'));
  assert.equal(/required|requerid|필수/.test(fn), false,
    'identityNote 는 사실만 나열한다 — 필수 여부는 상대가 정한다');
});

test('킬스위치가 꺼져 있으면 신원이 아예 안 실리고, 그것이 기록에 드러난다', () => {
  const prev = process.env.CRM_UPSERT_IDENTITY;
  try {
    process.env.CRM_UPSERT_IDENTITY = '0';
    assert.equal(upsertIdentityOn(), false);
    const n = identityNote(buildPayload('upsert', { ...BASE, customer_type: 'A' }, 'admin'));
    assert.match(n, /^안 보냄:/, '신원을 통째로 안 보낸 사실이 그대로 적혀야 한다');
    // ⚠ 「안 보냄」이 「보냄」을 포함하므로 부분일치로 검사하면 안 된다.
    assert.equal(/(^|\/ )보냄:/.test(n), false, '보낸 것이 하나도 없어야 한다');
  } finally {
    if (prev === undefined) delete process.env.CRM_UPSERT_IDENTITY;
    else process.env.CRM_UPSERT_IDENTITY = prev;
  }
});

test('킬스위치 상태가 화면으로 내려간다', () => {
  // 이 값이 없으면 화면은 꺼진 줄 모른다 — 그게 이번 사고의 본질이다.
  assert.equal(crmStatus().upsert_identity, true);
  const prev = process.env.CRM_UPSERT_IDENTITY;
  try {
    process.env.CRM_UPSERT_IDENTITY = 'off';
    assert.equal(crmStatus().upsert_identity, false);
  } finally {
    if (prev === undefined) delete process.env.CRM_UPSERT_IDENTITY;
    else process.env.CRM_UPSERT_IDENTITY = prev;
  }
});

test('거절 사유에 신원 요약을 덧붙인다(전송 엔진)', () => {
  const src = readFileSync(new URL('../src/crmSync.js', import.meta.url), 'utf8');
  assert.ok(/const ident = r\.error \? null : identityNote\(payload\)/.test(src),
    '상대가 실제로 답했을 때만 붙여야 한다 — 타임아웃에 붙이면 소음이다');
  assert.ok(/신원 \$\{ident\}/.test(src), 'last_error 에 함께 남아야 한다');
  // 성공했을 때는 붙이지 않는다 — 평소에 시끄러우면 진짜 신호가 묻힌다.
  const okBlock = src.slice(src.indexOf('if (okNow) {'), src.indexOf('} else {'));
  assert.equal(/identityNote/.test(okBlock), false);
});

test('화면이 「신원 안 보내는 중」을 배너로 알린다', () => {
  const g = readFileSync(new URL('../../refatrix-integrations.html', import.meta.url), 'utf8');
  assert.ok(/eng\.upsert_identity === false/.test(g), '서버가 준 사실을 보고 판단해야 한다(추측 금지)');
  assert.ok(/CRM_UPSERT_IDENTITY/.test(g), '어느 변수를 고쳐야 하는지 알려 줘야 한다');
  assert.ok(/반영되지 않습니다/.test(g), '무슨 일이 벌어지는지 말해야 한다');
});
