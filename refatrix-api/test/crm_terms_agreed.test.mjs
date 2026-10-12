// =====================================================================
// 20261012 · CRM 으로는 **약정** 할인율·외상일을 보낸다 (서류를 기다리지 않는다)
//   실행: TEST_PG_URL=postgres://... node --test test/crm_terms_agreed.test.mjs
//
//   디렉터 지시:
//     "서류가 없으면 할인률과 외상일이 crm으로 전송이 안되는데, 전송은 먼저 하도록 해줘."
//
//   무엇이 문제였나: 0235/0247 서류 관문이 `customers.discount`·`credit_days` 를 **0 으로
//   유보**하고 합의값은 `*_agreed` 에 둔다. CRM 전송이 실효값을 읽고 있었으니 상대에게는
//   0% · 0일이 갔고, 신규 고객은 서류가 모일 때까지 카달록에서 **정가**를 봤다.
//
//   여기서 잠그는 것:
//     ① 서류가 없어도 **약정값**이 나간다 (create · upsert 둘 다)
//     ② 서류 관문 규칙을 **복제하지 않는다** — 규칙은 트리거 한 곳에만 있어야 한다
//     ③ 0235 미적용 배포에서도 터지지 않는다 (*_agreed 컬럼이 없을 수 있다)
//     ④ 실 DB 에서 트리거가 실효값을 0 으로 만든 뒤에도 전송 본문은 약정값이다
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 DB 구간 생략');
if (PG) process.env.DATABASE_URL = PG;

const { buildPayload, termsForCrm } = await import('../src/crmSync.js');
const SRC = readFileSync(new URL('../src/crmSync.js', import.meta.url), 'utf8');

const BASE = {
  rfc: 'AIAC8310204A0', code: 'C-0100', name: 'ACME SA',
  contact: 'a@b.com', phone: '8112345678',
  customer_type: 'B', approval_status: 'approved',
};

// ── ① 순수 로직 ──────────────────────────────────────────────────────
test('서류가 없어 실효값이 0 이어도 약정값을 보낸다', () => {
  const c = { ...BASE, discount: 0, credit_days: 0, discount_agreed: 40, credit_days_agreed: 30 };
  const t = termsForCrm(c);
  assert.equal(t.discountPercent, 40, '약정 40% 가 나가야 한다 — 이게 이번 지시의 핵심이다');
  assert.equal(t.paymentDays, 30);
  assert.equal(t.gated, true, 'ERP 는 아직 유보 중이라는 사실도 알 수 있어야 한다');
});

test('create · upsert 가 같은 값을 보낸다 — 두 본문이 갈라지면 안 된다', () => {
  const c = { ...BASE, discount: 0, credit_days: 0, discount_agreed: 40, credit_days_agreed: 30 };
  const up = buildPayload('upsert', c, 'admin');
  const cr = buildPayload('create', c, 'admin');
  assert.equal(up.discountPercent, 40);
  assert.equal(up.paymentDays, 30);
  assert.equal(cr.discountPercent, 40);
  assert.equal(cr.paymentDays, 30);
});

test('서류가 완비된 고객은 전과 같다(약정 = 실효)', () => {
  const t = termsForCrm({ ...BASE, discount: 40, credit_days: 30, discount_agreed: 40, credit_days_agreed: 30 });
  assert.equal(t.discountPercent, 40);
  assert.equal(t.paymentDays, 30);
  assert.equal(t.gated, false, '같으면 어긋남이 없다');
});

test('약정이 0 이면 0 을 보낸다 — 「없으면 기본값」을 지어내지 않는다', () => {
  // 트리거에는 「조건 충족 + 약정 0 → 30일」 규칙이 있다. 그건 **관문의 규칙**이고
  //   우리가 복제하면 두 곳이 갈라진다. 우리는 약정값을 그대로 옮긴다.
  const t = termsForCrm({ ...BASE, discount: 0, credit_days: 0, discount_agreed: 0, credit_days_agreed: 0 });
  assert.equal(t.discountPercent, 0);
  assert.equal(t.paymentDays, 0);
  assert.equal(t.gated, false);
});

test('0235 미적용 배포(*_agreed 컬럼 없음)에서는 실효값이 곧 약정값이다', () => {
  const t = termsForCrm({ ...BASE, discount: 18, credit_days: 45 });
  assert.equal(t.discountPercent, 18);
  assert.equal(t.paymentDays, 45);
  assert.equal(t.gated, false);
});

test('값이 없거나 망가져도 0 으로 떨어진다(본문에 null·NaN 이 실리지 않는다)', () => {
  for (const c of [{ ...BASE }, { ...BASE, discount: null, credit_days: null },
                   { ...BASE, discount: 'abc', credit_days: '' },
                   { ...BASE, discount_agreed: null, credit_days_agreed: null }]) {
    const p = buildPayload('upsert', c, 'admin');
    assert.equal(typeof p.discountPercent, 'number');
    assert.equal(typeof p.paymentDays, 'number');
    assert.ok(Number.isFinite(p.discountPercent) && Number.isFinite(p.paymentDays));
  }
});

// ── ② 규칙을 복제하지 않았다 ─────────────────────────────────────────
test('서류 관문 규칙을 crmSync 에 복제하지 않았다', () => {
  const fn = SRC.slice(SRC.indexOf('export function termsForCrm'),
                       SRC.indexOf('/** ERP 승인 상태 → CRM'));
  for (const leak of ['constancia', 'domicilio', 'factura_compra', 'customer_documents']) {
    assert.equal(fn.includes(leak), false,
      `termsForCrm 이 ${leak} 를 보면 관문 규칙이 두 곳에 생긴다 — 트리거만 알아야 한다`);
  }
  // 실효값을 읽어 「유보됐는지」 판단만 한다 — 판단 결과로 보내는 값을 바꾸지 않는다.
  assert.ok(/gated:/.test(fn), '어긋남 여부는 사실로 돌려줘야 화면·이력이 설명할 수 있다');
});

test('전송 본문은 한 곳에서 할인·외상일을 정한다', () => {
  // create 와 upsert 가 각자 계산하면 한쪽만 고치는 날이 온다.
  assert.equal((SRC.match(/discountPercent: terms\.discountPercent/g) || []).length, 2);
  assert.equal((SRC.match(/paymentDays: terms\.paymentDays/g) || []).length, 2);
  assert.equal(/discountPercent: c\.discount/.test(SRC), false,
    '실효값을 직접 읽는 자리가 남아 있으면 그 경로만 0 이 나간다');
  assert.equal(/paymentDays: c\.credit_days/.test(SRC), false);
});

test('*_agreed 컬럼은 있는지 보고 고른다 — 없는 배포에서 쿼리가 터지면 전송이 통째로 멈춘다', () => {
  assert.ok(/customerAgreedColsReady/.test(SRC));
  assert.ok(/information_schema\.columns[\s\S]{0,200}discount_agreed/.test(SRC));
  // 긍정만 캐싱해야 배포 직후 migrate 가 늦어도 30초 안에 반영된다.
  assert.ok(/if \(agreedColsReady\) return true;/.test(SRC));
  assert.ok(/Date\.now\(\) - agreedColsProbe < PROBE_MS/.test(SRC));
});

test('화면이 「CRM 에는 약정 조건이 가 있다」고 말한다', () => {
  // 서류가 모자란 동안 카달록과 ERP 가 다른 값을 쓴다. 그 사실을 화면이 말하지 않으면
  //   「카달록은 40% 인데 왜 견적은 정가냐」가 원인 불명으로 남는다.
  const h = readFileSync(new URL('../../refatrix-customers.html', import.meta.url), 'utf8');
  assert.ok(/CRM\(웹카달록\)에는 <b>약정 조건<\/b>이 이미 전송돼 있습니다/.test(h));
  assert.ok(/두 쪽이 다릅니다/.test(h), '어긋난다는 사실을 분명히 말해야 한다');
  assert.ok(/디렉터 PIN 승인을 쓰세요/.test(h), '맞추는 방법까지 알려 줘야 행동이 바뀐다');
  // ⚠ **실제로 어긋난 항목만** 말해야 한다. 약정과 실효가 같은데 「다릅니다」라고 하면
  //   그 안내는 곧 아무도 안 읽는 문구가 된다.
  const snip = h.slice(h.indexOf('const dGap='), h.indexOf('})();', h.indexOf('const dGap=')));
  assert.ok(/n\(g\.discount_agreed\)!==n\(g\.discount_effective\)/.test(snip),
    '할인은 약정과 실효를 비교해 판단해야 한다');
  assert.ok(/n\(g\.credit_days_agreed\)!==n\(g\.credit_days_effective\)/.test(snip),
    '외상일도 따로 비교해야 한다 — 디렉터가 할인만 승인한 경우가 실제로 있다');
  assert.ok(/if\(!dGap&&!cGap\) return;/.test(snip), '어긋남이 없으면 아무 말도 하지 않는다');
});

// ── ③ 실 DB — 트리거가 실제로 0 으로 만든 뒤에도 약정값이 나간다 ──────
test('실 DB · 서류 관문이 0 으로 유보한 고객의 전송 본문', { skip: SKIP }, async () => {
  const { query } = await import('../src/db.js');
  const SFX = Date.now().toString(36).slice(-5).toUpperCase();
  const code = `TRM${SFX}`;
  const row = (await query(
    `INSERT INTO customers (code, name, rfc, contact, phone, customer_type,
                            discount, credit_days, approval_status, doc_gate)
     VALUES ($1,$2,$3,'a@b.com','811','B',40,30,'approved',true)
     RETURNING id, discount, credit_days, discount_agreed, credit_days_agreed`,
    [code, `${code} 고객`, `TRM990115${SFX.slice(0, 2).replace(/[^A-Z0-9]/g, 'A')}1`])).rows[0];

  // 트리거(0235/0247)가 **실효값을 0 으로** 유보했는지 먼저 확인한다 — 전제가 깨지면
  //   이 시험은 아무것도 지키지 못한다.
  assert.equal(Number(row.discount), 0, '서류가 없으니 실효 할인은 0 이어야 한다(전제)');
  assert.equal(Number(row.credit_days), 0, '서류가 없으니 실효 외상일은 0 이어야 한다(전제)');
  assert.equal(Number(row.discount_agreed), 40, '약정값은 보존돼야 한다(전제)');
  assert.equal(Number(row.credit_days_agreed), 30);

  // 운영이 읽는 컬럼 목록 그대로 다시 읽어 본문을 만든다.
  const c = (await query(
    `SELECT id, code, name, rfc, contact, phone, ship_address, customer_type,
            discount, credit_days, approval_status, deleted_at,
            discount_agreed, credit_days_agreed, doc_gate, discount_override, credit_override
       FROM customers WHERE id=$1`, [row.id])).rows[0];
  const p = buildPayload('upsert', c, 'admin');
  assert.equal(p.discountPercent, 40, '서류가 없어도 CRM 에는 약정 40% 가 간다');
  assert.equal(p.paymentDays, 30);

  await query(`DELETE FROM customers WHERE id=$1`, [row.id]);
});
