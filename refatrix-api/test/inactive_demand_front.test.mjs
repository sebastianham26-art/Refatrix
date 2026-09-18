// =====================================================================
// 판매중단 후 견적요청(수요) UI — jsdom (0224)
//   운영 HTML 을 그대로 로드하고 fetch 만 스텁해서 검증한다.
//     · 제품검색: 비활성 행에 「요청 N건」 배지, 드릴다운을 열면 수요 표가 자동으로 뜬다
//     · 견적 화면: 비활성 SKU 를 **담을 수 있고**, 스페인어로 「진행은 되며 수요로 기록된다」고 알린다
//     · 견적 목록: 판매중단 줄 표시(막지 않는다 — 포장·전환은 그대로)
//
//   왜 UI 까지 시험하나: 서버가 기록을 남겨도 화면이 예전처럼 「담을 수 없습니다」로
//   막아 버리면 요청은 여전히 사라진다. 두 쪽이 같이 바뀌어야 의미가 있다.
// 실행: node --test test/inactive_demand_front.test.mjs   (jsdom 필요)
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const P_HTML = resolve(here, '..', '..', 'refatrix-products.html');
const Q_HTML = resolve(here, '..', '..', 'refatrix-quote.html');
const L_HTML = resolve(here, '..', '..', 'refatrix-quotelist.html');

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* 미설치 → skip */ }
const SKIP = !JSDOM || !existsSync(P_HTML) || !existsSync(Q_HTML) || !existsSync(L_HTML);
if (SKIP) console.log('[skip] jsdom 또는 운영 HTML 없음');

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

const DEMAND = {
  since_at: '2026-09-01T10:00:00.000Z', code: 'CE0536R', name: 'ROTULA',
  items: [
    { quote_id: 11, quote_no: 'Q-2026-0101', quote_date: '2026-09-10', created_at: '2026-09-10T10:00:00Z',
      status: 'draft', origin: 'erp', customer: 'REFACCIONARIA NORTE', qty: 6, creator: 'Oscar' },
    { quote_id: 12, quote_no: 'COT-20260912120000001', quote_date: '2026-09-12', created_at: '2026-09-12T10:00:00Z',
      status: 'draft', origin: 'web', customer: 'AUTOPARTES SUR', qty: 4, creator: null },
  ],
};

async function bootProducts(opts = {}) {
  const calls = [];
  const dom = new JSDOM(readFileSync(P_HTML, 'utf-8'), {
    runScripts: 'dangerously',
    url: 'https://example.test/refatrix-products.html',
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({
        token: 'T', api: 'https://api.test', user: { name: '디렉터', role: 'director' },
      }));
      w.alert = () => {}; w.confirm = () => true; w.prompt = () => '단종';
      w.fetch = async (url, o = {}) => {
        const u = String(url);
        calls.push({ url: u, method: o.method || 'GET' });
        const json = (d) => ({ ok: true, status: 200, json: async () => d });
        if (/\/api\/products\/\d+\/inactive-demand/.test(u)) return json(opts.demand || DEMAND);
        if (u.includes('/api/products/inactive-demand')) {
          return json({ items: [{ product_id: 77, code: 'CE0536R', req_n: 2, req_qty: 10, cust_n: 2 }] });
        }
        if (/\/api\/products\/\d+\/drilldown/.test(u)) {
          return json({ can_manage_status: true, rows: [], cost: null,
            product: { id: 77, code: 'CE0536R', name: 'ROTULA', is_active: false,
              inactive_reason: '단종', status_changed_at: '2026-09-01T10:00:00Z' } });
        }
        if (u.includes('/api/products?')) {
          return json({ items: [{ id: 77, code: 'CE0536R', name: 'ROTULA', scode: 'SYD-1', app: 'VERSA',
            stock_qty: 0, sold_qty: 0, list_price: 100, is_active: false, inactive_reason: '단종' }], total: 1 });
        }
        return json({ items: [], total: 0 });
      };
    },
  });
  const w = dom.window;
  await new Promise((r) => { if (w.document.readyState === 'complete') r(); else w.addEventListener('load', r); });
  await tick(120);
  return { w, d: w.document, calls, dom };
}

test('제품검색 — 판매중단 후 요청 표시 (jsdom)', { skip: SKIP }, async (t) => {
  await t.test('① 목록의 비활성 행에 요청 배지가 붙는다', async () => {
    const { d, calls } = await bootProducts();
    assert.ok(calls.some((c) => c.url.includes('/api/products/inactive-demand?ids=77')), '한 번에 조회');
    const tag = d.querySelector('.dmdtag');
    assert.ok(tag, '배지 자리');
    assert.match(tag.textContent, /요청 2건·10개/);
  });

  await t.test('② 드릴다운을 열면 수요 표가 자동으로 뜬다', async () => {
    const { w, d, calls } = await bootProducts();
    d.querySelector('tr.prow').dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(150);
    assert.ok(calls.some((c) => c.url.includes('/api/products/77/inactive-demand')), '자동 조회');
    const box = d.getElementById('dmd77');
    assert.ok(box, '수요 카드 자리');
    assert.match(box.textContent, /판매중단 후 견적요청/);
    assert.match(box.textContent, /2건/);
    assert.match(box.textContent, /10개/);
    assert.match(box.textContent, /고객/);
    assert.match(box.textContent, /REFACCIONARIA NORTE/);
    assert.match(box.textContent, /AUTOPARTES SUR/);
    assert.match(box.textContent, /웹/, '웹 요청과 영업 요청을 구분해서 보여준다');
    assert.ok(box.querySelector('.dmdXlsx'), '엑셀 버튼');
    // 기존 패널이 그대로인지(회귀)
    assert.ok(d.querySelector('.stPipe') && d.querySelector('.stTog'), '점검·전환 버튼 회귀');
  });

  await t.test('③ 요청이 없으면 「수요 신호 없음」을 분명히 말한다', async () => {
    const { w, d } = await bootProducts({ demand: { since_at: '2026-09-01T10:00:00Z', items: [] } });
    d.querySelector('tr.prow').dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(150);
    const box = d.getElementById('dmd77');
    assert.match(box.textContent, /없습니다/);
    assert.match(box.textContent, /수요 신호/);
  });
});

// ── 견적 화면 ───────────────────────────────────────────────────
async function bootQuote(opts = {}) {
  const calls = [];
  const dom = new JSDOM(readFileSync(Q_HTML, 'utf-8'), {
    runScripts: 'dangerously',
    url: 'https://example.test/refatrix-quote.html',
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({
        token: 'T', api: 'https://api.test', user: { name: '영업', role: 'sales' },
      }));
      w.alert = () => {};
      w.fetch = async (url, o = {}) => {
        const u = String(url);
        calls.push({ url: u, method: o.method || 'GET', body: o.body ? JSON.parse(o.body) : null });
        const json = (d, ok = true, status = 200) => ({ ok, status, json: async () => d });
        if (u.includes('/resolve-code')) return json({ source: 'ctr', matches: [
          { product_id: 77, ctr_code: 'CE0536R', name: 'ROTULA', list_price: 100, syd_codes: [], is_active: false }] });
        if (u.includes('/api/quotes/preview')) return json({ lines: [
          { matched: true, ctr_code: 'CE0536R', qty: 2, list_price: 100, final_price: 55,
            line_subtotal: 110, line_iva: 17.6, line_total: 127.6, stock_flag: 'ok' }],
          totals: { subtotal: 110, iva: 17.6, total: 127.6, totalQty: 2, skuCount: 1 } });
        if (u.includes('/api/quotes') && (o.method || '') === 'POST') {
          return json(opts.saveResp || { id: 5, quote_no: 'Q-2026-0102',
            inactive_lines: [{ line_no: 1, code: 'CE0536R', name: 'ROTULA' }],
            inactive_note: '판매중단(비활성) 제품 1건이 포함돼 있습니다.' });
        }
        if (u.includes('/api/customers')) return json({ items: [{ id: 3, name: 'CLIENTE', discount: 45 }] });
        return json({ items: [] });
      };
    },
  });
  const w = dom.window;
  await new Promise((r) => { if (w.document.readyState === 'complete') r(); else w.addEventListener('load', r); });
  await tick(120);
  return { w, d: w.document, calls, dom };
}

// 견적 화면은 고객을 먼저 골라야 줄을 담을 수 있다(할인율이 필요하므로).
function pickCustomer(w, d) {
  const sel = d.getElementById('custSel');
  if (!sel.querySelector('option[value="3"]')) {
    const o = d.createElement('option'); o.value = '3'; o.textContent = 'CLIENTE';
    o.setAttribute('data-disc', '45'); sel.appendChild(o);
  }
  sel.value = '3';
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
}

test('견적 화면 — 비활성 SKU 를 담을 수 있다 (jsdom)', { skip: SKIP }, async (t) => {
  await t.test('④ 코드로 넣으면 담기고, 확정 불가 경고가 뜬다', async () => {
    const { w, d } = await bootQuote();
    pickCustomer(w, d);
    await tick(60);
    d.getElementById('inCode').value = 'CE0536R';
    d.getElementById('inQty').value = '2';
    await w.addLine();
    await tick(200);
    const msg = d.getElementById('lineMsg');
    assert.equal(msg.className, 'msg warn', '막는 빨간 오류가 아니라 경고여야 한다');
    // 이 화면을 쓰는 사람은 영업사원이다 — 안내는 스페인어.
    assert.match(msg.textContent, /descontinuado/i);
    assert.match(msg.textContent, /sigue su curso/, '진행은 된다고 말한다');
    assert.match(msg.textContent, /demanda/, '어디에 기록으로 남는지 말한다');
    assert.match(msg.textContent, /Búsqueda de productos/, '기록 위치를 짚어 준다');
    assert.equal(/확정할 수 없습니다/.test(msg.textContent), false, '막는다고 말하면 안 된다');
    // 줄이 실제로 들어갔는지 — 미리보기 호출에 그 코드가 실려야 한다.
    assert.match(d.getElementById('linesWrap').textContent, /CE0536R/, '줄이 담겼다');
  });

  await t.test('⑤ 저장 후 「진행되며 수요로 기록된다」를 스페인어로 알린다', async () => {
    const { w, d } = await bootQuote();
    pickCustomer(w, d);
    await tick(60);
    d.getElementById('inCode').value = 'CE0536R';
    await w.addLine();
    await tick(200);
    await w.saveQuote();
    await tick(150);
    const m = d.getElementById('saveMsg');
    assert.match(m.textContent, /저장됨/, '저장은 된다');
    assert.match(m.textContent, /Descontinuados: 1/);
    assert.match(m.textContent, /CE0536R/);
    assert.match(m.textContent, /sigue su curso/);
    assert.match(m.textContent, /demanda/);
    assert.equal(m.className, 'msg warn');
  });
});

test('견적 화면 — 「담을 수 없습니다」 로 막는 코드가 남아 있지 않다', { skip: SKIP }, () => {
  const s = readFileSync(Q_HTML, 'utf-8');
  assert.equal(/담을 수 없습니다\.'\); return;/.test(s), false, '후보 모달에서 막던 alert 제거');
  assert.ok(/msg warn/.test(s), '대신 경고로 알린다');
});

test('견적 목록 — 표시만 하고 흐름은 막지 않는다', { skip: SKIP }, () => {
  const s = readFileSync(L_HTML, 'utf-8');
  assert.ok(/inactive_cnt/.test(s), '목록에 판매중단 줄 수 표시');
  assert.ok(/Descontinuado/.test(s), '표시는 스페인어');
  // ⚠ 포장 흐름을 중단시키는 코드가 있으면 안 된다(2026-09-18 지시).
  const blk = s.slice(s.indexOf('packing-printed'), s.indexOf('packing-printed') + 900);
  assert.equal(/inactive_product_lines/.test(blk), false, '포장 출력을 세우면 안 된다');
  assert.ok(/포장은 그대로 진행/.test(blk), '왜 안 막는지 코드에 적어 둔다');
});
