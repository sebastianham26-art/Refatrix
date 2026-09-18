/* 20260918tier · 고객 등록/수정 폼 — 필수값(이메일·전화·TIER) 동작 검증
   운영 파일(refatrix-custform.js)을 그대로 jsdom 에서 실행한다. */
import fs from 'fs';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import assert from 'node:assert';

const SRC = fs.readFileSync(new URL('../refatrix-custform.js', import.meta.url), 'utf8');

async function boot() {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>',
    { runScripts: 'dangerously', url: 'https://erp.test/' });
  const w = dom.window;
  const calls = [];
  w.fetch = async (url, opt) => {
    calls.push({ url: String(url), opt });
    const u = String(url);
    const j = (o) => ({ ok: true, status: 200, json: async () => o });
    if (u.includes('/api/teams')) return j({ items: [{ id: 1, name: 'MTY' }, { id: 2, name: 'MID' }] });
    if (u.includes('/api/stages')) return j({ items: [{ id: 9, name: 'Prospecto' }] });
    if (u.includes('/api/sales-users')) return j({ items: [{ id: 7, name: 'Oscar' }] });
    if (u.includes('/api/customers/next-code')) return j({ code: 'C-0999' });
    if (u.includes('/claim-check')) return j({ blocked_rfc: false, blocked_constancia: false, items: [] });
    return j({ id: 123, code: 'C-0999' });
  };
  w.confirm = () => false;          // RFC 없이 등록 확인창 → 거기서 멈춘다
  w.alert = () => {};
  const s = w.document.createElement('script'); s.textContent = SRC;
  w.document.body.appendChild(s);
  w.RefCustForm.init({ api: '', token: 't', isDirector: true, onSaved: null });
  await w.RefCustForm.mount('host');
  calls.length = 0;                  // 부트 중 호출은 버린다
  return { w, calls, $: (id) => w.document.getElementById(id) };
}
const msg = (w) => w.document.getElementById('rcf-msg').textContent;
const saved = (calls) => calls.filter((c) => (c.opt && /POST|PATCH/.test(c.opt.method || '')) && !/claim-check|ship-address/.test(c.url));

/* ───────── 화면 ───────── */
test('TIER 드롭다운이 A~D 네 가지 + Sin seleccionar 로 바뀌었다', async () => {
  const { $ } = await boot();
  const opts = [...$('rcf-type').options].map((o) => o.value);
  assert.deepStrictEqual(opts, ['', 'A', 'B', 'C', 'D']);
  assert.ok($('rcf-type').options[1].textContent.includes('Distribuidor mayorista'));
  assert.ok($('rcf-type').options[4].textContent.includes('pequeño volumen'));
});

test('이메일·전화·TIER 라벨에 * 가 붙었다', async () => {
  const { w } = await boot();
  const t = w.document.getElementById('host').textContent;
  assert.ok(t.includes('이메일 주소 *'));
  assert.ok(t.includes('전화 (인보이스 수신) *'));
  assert.ok(t.includes('회사 종류 · TIER *'));
});

/* ───────── 신규 등록 ───────── */
async function newCust(over = {}) {
  const b = await boot();
  b.$('rcf-name').value = over.name !== undefined ? over.name : 'Refaccionaria Prueba';
  b.$('rcf-team').value = '1';
  b.$('rcf-contact').value = over.contact !== undefined ? over.contact : 'cliente@correo.com';
  b.$('rcf-phone').value = over.phone !== undefined ? over.phone : '8112345678';
  b.$('rcf-type').value = over.tier !== undefined ? over.tier : 'C';
  return b;
}

test('신규: 이메일 비우면 저장 요청 자체가 안 나간다', async () => {
  const b = await newCust({ contact: '' });
  b.$('rcf-save').click(); await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(saved(b.calls).length, 0);
  assert.ok(msg(b.w).includes('이메일 주소를 입력해야'));
});

test('신규: 이메일 형식이 틀리면 막힌다', async () => {
  const b = await newCust({ contact: 'abc' });
  b.$('rcf-save').click(); await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(saved(b.calls).length, 0);
  assert.ok(msg(b.w).includes('형식'));
});

test('신규: 전화를 비우면 막힌다', async () => {
  const b = await newCust({ phone: '' });
  b.$('rcf-save').click(); await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(saved(b.calls).length, 0);
  assert.ok(msg(b.w).includes('전화번호를 입력해야'));
});

test('신규: TIER 를 안 고르면 막힌다', async () => {
  const b = await newCust({ tier: '' });
  b.$('rcf-save').click(); await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(saved(b.calls).length, 0);
  assert.ok(msg(b.w).includes('TIER'));
});

test('신규: 넷 다 채우면 이메일/전화/TIER 로는 안 막힌다 (다음 단계로 넘어간다)', async () => {
  const b = await newCust();
  b.$('rcf-save').click(); await new Promise((r) => setTimeout(r, 30));
  const m = msg(b.w);
  assert.ok(!m.includes('이메일') && !m.includes('전화번호') && !m.includes('TIER'), '메시지=' + m);
});

/* ───────── 기존 고객 수정 ───────── */
function legacyCust(over = {}) {
  return Object.assign({
    id: 55, code: 'C-0055', name: 'Cliente Viejo', team_id: 1, rfc: 'FEL990715AB1',
    contact: 'viejo@correo.com', phone: '8100000000', customer_type: 'refraccionaria',
    discount: 10, credit_days: 30, owner_id: 7, stage_id: 9,
  }, over);
}

test('수정: 이메일을 지우면 저장이 막힌다 (디렉터 지시)', async () => {
  const b = await boot();
  b.w.RefCustForm.editCustomer(legacyCust());
  b.$('rcf-contact').value = '';
  b.$('rcf-save').click(); await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(saved(b.calls).length, 0);
  assert.ok(msg(b.w).includes('이메일 주소를 입력해야'));
});

test('수정: 전화·TIER 가 예전 값이어도 저장은 통과한다 (일상 업무를 막지 않는다)', async () => {
  const b = await boot();
  b.w.RefCustForm.editCustomer(legacyCust());
  b.$('rcf-phone').value = '8199999999';
  b.$('rcf-save').click(); await new Promise((r) => setTimeout(r, 60));
  const s = saved(b.calls);
  assert.strictEqual(s.length, 1, '저장 요청 1건이어야 함');
  assert.strictEqual(JSON.parse(s[0].opt.body).phone, '8199999999');
});

test('수정: 예전 회사 종류 값이 드롭다운에서 사라지지 않는다', async () => {
  const b = await boot();
  b.w.RefCustForm.editCustomer(legacyCust());
  assert.strictEqual(b.$('rcf-type').value, 'refraccionaria');
  const legacy = b.$('rcf-type').querySelector('option[data-legacy="1"]');
  assert.ok(legacy && legacy.textContent.includes('기존 값'));
  assert.ok(b.$('rcf-typewarn').style.display !== 'none', 'TIER 미지정 경고가 보여야 함');
});

test('수정: TIER 고객을 열면 경고가 안 뜨고 임시 항목도 안 생긴다', async () => {
  const b = await boot();
  b.w.RefCustForm.editCustomer(legacyCust({ customer_type: 'B' }));
  assert.strictEqual(b.$('rcf-type').value, 'B');
  assert.strictEqual(b.$('rcf-type').querySelector('option[data-legacy="1"]'), null);
  assert.strictEqual(b.$('rcf-typewarn').style.display, 'none');
});

test('수정: 두 고객을 연달아 열어도 임시 항목이 쌓이지 않는다', async () => {
  const b = await boot();
  b.w.RefCustForm.editCustomer(legacyCust({ customer_type: 'taller' }));
  b.w.RefCustForm.editCustomer(legacyCust({ customer_type: 'publico' }));
  assert.strictEqual(b.$('rcf-type').querySelectorAll('option[data-legacy="1"]').length, 1);
  assert.strictEqual(b.$('rcf-type').value, 'publico');
});
