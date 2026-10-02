// =====================================================================
// 고객 독점 정책 화면 — jsdom 행동 검증 (0235, 2026-09-29)
//   ① 고객 등록: 서류가 모자라면 경고 팝업 → 「돌아가기」면 저장 안 함, 「서류 없이 등록」이면 저장
//   ② 고객 등록: ③(경쟁사 인보이스)만 붙어도 외상 30일 자동, ①+② 가 모두 있어야 할인
//   ③ 견적 작성: 독점 고객이면 판매 영업사원이 독점권자로 잠기고, 남의 독점이면 경고
//   ④ 견적 출력·목록 출력·인보이스 PDF 에 「Vendedor」
//   실행: node --test test/customer_exclusivity_front.test.mjs   (jsdom 필요)
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const root = (p) => new URL('../../' + p, import.meta.url);
const CUSTFORM = readFileSync(root('refatrix-custform.js'), 'utf-8');

function bootForm(saveResp) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  const calls = [];
  w.fetch = async (url, opt) => {
    const u = String(url);
    calls.push({ url: u, method: (opt && opt.method) || 'GET', body: opt && opt.body });
    if (u.includes('/api/teams')) return { ok: true, json: async () => ({ items: [{ id: 1, name: '01' }] }) };
    if (u.includes('/api/stages')) return { ok: true, json: async () => ({ items: [{ id: 6, name: '06' }] }) };
    if (u.includes('/api/sales-users')) return { ok: true, json: async () => ({ items: [{ id: 5, name: 'Palomino', team_id: 1 }] }) };
    if (u.includes('/next-code')) return { ok: true, json: async () => ({ code: 'P-0100' }) };
    if (u.includes('claim-check')) return { ok: true, json: async () => ({ ok: true }) };
    if (u.includes('price-baseline')) return { ok: true, json: async () => ({ ok: true, suggested_discount: 40 }) };
    if (u.endsWith('/api/customers')) return { ok: true, json: async () => (saveResp || { ok: true, pending_approval: true, code: 'P-0100', note: 'ok' }) };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  w.eval(CUSTFORM);
  return { w, calls, doc: w.document };
}
const pickFile = (w, id, name) => {
  const el = w.document.getElementById(id);
  const f = new w.File(['x'], name, { type: 'application/pdf' });
  Object.defineProperty(el, 'files', { value: [f], configurable: true });
  el.dispatchEvent(new w.Event('change'));
};
async function fillMinimum(w) {
  const d = w.document;
  const set = (id, v) => { const e = d.getElementById(id); if (e) { e.value = v; e.dispatchEvent(new w.Event('input')); } };
  set('rcf-name', 'TALLER PRUEBA'); set('rcf-rfc', 'TPR990101AB1'); set('rcf-contact', 'a@b.mx'); set('rcf-phone', '8112345678');
  set('rcf-baseprice', '650'); set('rcf-discount', '40');
  const tier = d.getElementById('rcf-tier'); if (tier) { tier.value = tier.options[1] ? tier.options[1].value : 'A'; }
  for (const sel of d.querySelectorAll('select')) { if (!sel.value && sel.options.length > 1) sel.value = sel.options[1].value; }
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('F1 서류가 없으면 경고 팝업 — 돌아가기를 누르면 저장하지 않는다', async () => {
  const { w, calls, doc } = bootForm();
  w.RefCustForm.init({ api: '', token: 't', isDirector: false });
  await w.RefCustForm.mount('host');
  await w.RefCustForm.newCustomer();
  await tick();
  await fillMinimum(w);
  doc.getElementById('rcf-save').click();
  await tick(80);
  const pop = doc.getElementById('rcf-docwarn');
  assert.equal(pop.style.display, 'flex', '팝업이 떠야 한다');
  assert.match(doc.getElementById('rcf-docwarn-body').textContent, /할인이 적용되지 않습니다/);
  assert.match(doc.getElementById('rcf-docwarn-body').textContent, /선입금/);
  doc.getElementById('rcf-docwarn-back').click();
  await tick(50);
  assert.equal(pop.style.display, 'none');
  assert.ok(!calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/customers')), '돌아가기면 저장 호출이 없어야 한다');
});

test('F2 서류 없이 등록을 누르면 저장된다', async () => {
  const { w, calls, doc } = bootForm();
  w.RefCustForm.init({ api: '', token: 't', isDirector: false });
  await w.RefCustForm.mount('host');
  await w.RefCustForm.newCustomer();
  await tick();
  await fillMinimum(w);
  doc.getElementById('rcf-save').click();
  await tick(80);
  doc.getElementById('rcf-docwarn-go').click();
  await tick(80);
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/customers')), '확인하면 저장한다');
});

test('F3 ③ 경쟁사 인보이스만 붙어도 외상 30일, ①만으로는 할인 없음, ①+②+③ 이면 팝업 없음', async () => {
  const { w, calls, doc } = bootForm();
  w.RefCustForm.init({ api: '', token: 't', isDirector: false });
  await w.RefCustForm.mount('host');
  await w.RefCustForm.newCustomer();
  await tick();
  doc.getElementById('rcf-credit').value = '0';
  pickFile(w, 'rcf-facfile', 'fac.pdf');
  assert.equal(doc.getElementById('rcf-credit').value, '30');
  assert.match(doc.getElementById('rcf-docsres').textContent, /할인 미적용/);
  assert.match(doc.getElementById('rcf-docsres').textContent, /외상 30일/);
  pickFile(w, 'rcf-confile', 'con.pdf');
  assert.match(doc.getElementById('rcf-docsres').textContent, /할인 미적용/);
  pickFile(w, 'rcf-domfile', 'dom.pdf');
  assert.match(doc.getElementById('rcf-docsres').textContent, /할인 적용/);
  await fillMinimum(w);
  doc.getElementById('rcf-save').click();
  await tick(120);
  assert.notEqual(doc.getElementById('rcf-docwarn').style.display, 'flex', '서류가 다 있으면 팝업 없음');
  const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/customers'));
  assert.ok(post, '바로 저장');
  const body = JSON.parse(post.body);
  assert.ok(body.constancia_file, 'constancia 는 기존 경로');
  assert.deepEqual(body.docs.map((d) => d.doc_type).sort(), ['domicilio', 'factura_compra']);
});

// ── 견적 화면: 판매 영업사원 잠금 ────────────────────────────────────
function quoteScript() {
  const html = readFileSync(root('refatrix-quote.html'), 'utf-8');
  return html;
}
test('F4 견적: 독점 고객 → 판매자 잠김, 남의 독점 → 경고, 출력에 Vendedor', async () => {
  const html = quoteScript();
  // 빌드 토큰은 다른 작업으로 계속 올라가므로 고정하지 않는다(0247) — 기능 존재만 본다.
  assert.match(html, /id="sellerSel"/);
  const dom = new JSDOM(html.replace(/<script src="[^"]+"><\/script>/g, ''), { runScripts: 'dangerously', url: 'http://localhost/' });
  const w = dom.window;
  const answers = {
    '11': { ready: true, can_sell: true, locked: true, holder: { id: 7, name: 'Palomino', until: '2027-10-02', kind: 'sale' }, seller_id: 7 },
    '12': { ready: true, can_sell: false, error: 'exclusive_other', note: '이 고객은 Oscar 님의 독점 고객입니다(2026-10-30 까지).' },
    '13': { ready: true, can_sell: true, open: true, error: 'seller_required' },
  };
  w.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/sellers')) return { ok: true, json: async () => ({ items: [{ id: 7, name: 'Palomino', role: 'sales' }, { id: 8, name: 'Oscar', role: 'sales' }] }) };
    const m = u.match(/exclusivity\/check\?customer_id=(\d+)/);
    if (m) return { ok: true, json: async () => answers[m[1]] };
    return { ok: true, json: async () => ({ items: [] }) };
  };
  await tick(30);
  w.eval('session={token:"t",api:"",user:{id:8,name:"Oscar",role:"sales"}};');
  await w.eval('loadSellers()');
  const cs = w.document.getElementById('custSel');
  cs.innerHTML = '<option value=""></option><option value="11" data-disc="40">A</option><option value="12" data-disc="0">B</option><option value="13" data-disc="0">C</option>';
  assert.equal(w.document.getElementById('sellerSel').value, '8', '영업 본인이 기본값');
  cs.value = '11'; w.eval('onCustChange()'); await tick(30);
  assert.equal(w.document.getElementById('sellerSel').value, '7');
  assert.equal(w.document.getElementById('sellerSel').disabled, true);
  assert.match(w.document.getElementById('exclBadge').textContent, /Palomino 독점 · 2027-10-02/);
  assert.equal(w.eval('sellerName()'), 'Palomino');
  cs.value = '12'; w.eval('onCustChange()'); await tick(30);
  assert.equal(w.document.getElementById('sellerSel').disabled, false);
  assert.match(w.document.getElementById('exclBadge').textContent, /Oscar 님의 독점/);
  cs.value = '13'; w.eval('onCustChange()'); await tick(30);
  assert.match(w.document.getElementById('exclBadge').textContent, /개방/);
  // 출력 문자열에 Vendedor
  assert.match(html, /<b>Vendedor:<\/b> '\+esc\(sellerName\(\)\)/);
  assert.match(html, /'Vendedor', sellerName\(\)/);
});

test('F5 견적 목록 출력 · 인보이스 PDF 에 Vendedor(판매 영업사원)', () => {
  const ql = readFileSync(root('refatrix-quotelist.html'), 'utf-8');
  assert.match(ql, /<b>Vendedor:<\/b> '\+esc\(q\.seller_name\|\|q\.customer_owner_name\)/);
  assert.match(ql, /body\.seller_id=Number\(\$\('cvSeller'\)\.value\)/, '전환 요청에 판매자');
  assert.match(ql, /id="cvSeller"/);
  const fn = readFileSync(root('refatrix-funnel.html'), 'utf-8');
  assert.equal((fn.match(/'Vendedor: '\+esc\(vend\)/g) || []).length, 2, '인보이스 인쇄 2곳');
  const sl = readFileSync(root('refatrix-sales.html'), 'utf-8');
  assert.match(sl, /seller_id:\$\('s-seller'\)\.value\?Number/);
});

// ── 0247 · 고객 상세 디렉터 PIN 승인 패널 ─────────────────────────────
test('F6 고객 상세: 디렉터에게만 PIN 승인 패널 — 체크·사유·PIN 으로 저장, 결과 표시', async () => {
  const html = readFileSync(root('refatrix-customers.html'), 'utf-8');
  assert.match(html, /<title>[^<]*tx-1002ov\)?<\/title>/, '빌드 토큰');
  const boot = async (role) => {
    const dom = new JSDOM(html.replace(/<script src="[^"]+"><\/script>/g, ''), { runScripts: 'dangerously', url: 'http://localhost/' });
    const w = dom.window;
    const calls = [];
    let state = { discount_override: false, credit_override: false };
    w.fetch = async (url, opt) => {
      const u = String(url); calls.push({ u, opt });
      if (u.endsWith('/exclusivity')) return { ok: true, json: async () => ({ ready: true, policy: true, current: null, open: true, history: [],
        gate: { applies: true, discount_docs_ok: false, credit_docs_ok: false, ...state,
          discount_ok: state.discount_override, credit_ok: state.credit_override,
          discount_agreed: 38, credit_days_agreed: 45, discount_effective: state.discount_override ? 38 : 0,
          credit_days_effective: state.credit_override ? 45 : 0, override_by_name: state.discount_override ? 'Sebastian' : null } }) };
      if (u.endsWith('/terms-override')) {
        const b = JSON.parse(opt.body);
        if (b.pin !== '4321') return { ok: false, status: 403, json: async () => ({ error: 'bad_pin' }) };
        state = { discount_override: !!b.discount, credit_override: !!b.credit };
        return { ok: true, json: async () => ({ ok: true, discount: b.discount ? 38 : 0, credit_days: b.credit ? 45 : 0, crm_queued: true }) };
      }
      return { ok: true, json: async () => ({ items: [] }) };
    };
    await tick(20);
    w.eval(`session={token:'t',api:'',user:{id:1,name:'X',role:'${role}'}};`);
    await w.eval('loadExcl(9)');
    return { w, calls, doc: w.document };
  };
  const rep = await boot('sales');
  assert.equal(rep.doc.getElementById('ovBox'), null, '영업에게는 패널이 없다');
  const { w, calls, doc } = await boot('director');
  assert.ok(doc.getElementById('ovBox'), '디렉터에게 패널');
  assert.match(doc.getElementById('d-excl').textContent, /할인 미적용/);
  doc.getElementById('ovDisc').checked = true;
  doc.getElementById('ovCred').checked = true;
  doc.getElementById('ovSave').click(); await tick(20);
  assert.match(doc.getElementById('ovMsg').textContent, /PIN 을 입력/, 'PIN 없이 저장 안 됨');
  doc.getElementById('ovPin').value = '4321';
  doc.getElementById('ovSave').click(); await tick(20);
  assert.match(doc.getElementById('ovMsg').textContent, /사유/, '켤 때 사유 필수');
  assert.ok(!calls.some((c) => c.u.endsWith('/terms-override')), '검증 실패 시 서버 호출 없음');
  doc.getElementById('ovReason').value = '서류 추후 제출';
  doc.getElementById('ovSave').click(); await tick(60);
  const post = calls.find((c) => c.u.endsWith('/terms-override'));
  assert.deepEqual(JSON.parse(post.opt.body), { pin: '4321', reason: '서류 추후 제출', discount: true, credit: true });
  assert.match(doc.getElementById('d-excl').textContent, /할인 적용 38% · 디렉터 승인/);
  assert.match(doc.getElementById('d-excl').textContent, /외상 45일 · 디렉터 승인/);
  assert.match(doc.getElementById('ovMsg').textContent, /CRM 전송/);
});
