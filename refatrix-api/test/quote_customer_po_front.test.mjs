// =====================================================================
// 고객 PO번호(Orden de compra) — 화면 검증 (jsdom, 0225)
//
//   운영 HTML 을 **그대로** 로드하고 fetch 만 스텁한다.
//   서버가 PO 를 들고 다녀도 화면이 안 찍으면 창고는 여전히 대조를 못 한다 —
//   그래서 「종이에 실제로 무엇이 찍히는가」까지 본다.
//
//     ① 견적 작성  : PO 칸이 있고, 저장 요청 본문에 customer_po_no 가 실린다
//     ② 견적 목록  : 견적번호 **아래에 작게** PO · 한 칸 검색이 전 기간으로 나간다
//     ③ 견적 상세  : 전환된 견적에서도 PO 만 따로 저장된다
//     ④ 창고      : 패킹리스트 Pedido = 「우리번호/ 고객PO」 · PO 없으면 구분자도 없다
//     ⑤ 매출확정  : PO 열 + 검색
//
// 실행: node --test test/quote_customer_po_front.test.mjs   (jsdom 필요)
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const Q_HTML = resolve(here, '..', '..', 'refatrix-quote.html');
const L_HTML = resolve(here, '..', '..', 'refatrix-quotelist.html');
const W_HTML = resolve(here, '..', '..', 'refatrix-warehouse.html');
const F_HTML = resolve(here, '..', '..', 'refatrix-funnel.html');

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* 미설치 → skip */ }
const SKIP = !JSDOM || ![Q_HTML, L_HTML, W_HTML, F_HTML].every(existsSync);
if (SKIP) console.log('[skip] jsdom 또는 운영 HTML 없음');

const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const SESSION = { token: 'T', api: 'https://api.test', user: { name: '디렉터', role: 'director' } };

function boot(file, router) {
  const calls = [];
  const dom = new JSDOM(readFileSync(file, 'utf-8'), {
    runScripts: 'dangerously',
    url: 'https://example.test/' + file.split('/').pop(),
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify(SESSION));
      w.alert = () => {}; w.confirm = () => true; w.prompt = () => '';
      w.print = () => {};
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
      w.fetch = async (url, o = {}) => {
        const u = String(url);
        calls.push({ url: u, method: o.method || 'GET', body: o.body });
        const json = (d) => ({ ok: true, status: 200, json: async () => d });
        const hit = router(u, o, json);
        return hit || json({ items: [] });
      };
    },
  });
  const w = dom.window;
  return { w, d: w.document, calls, dom,
    ready: new Promise((r) => { if (w.document.readyState === 'complete') r(); else w.addEventListener('load', r); }) };
}

// ═══════════════════════════════════════════════════════════════════════
// ① 견적 작성 화면
// ═══════════════════════════════════════════════════════════════════════
test('견적 작성 — 고객 PO 칸 (jsdom)', { skip: SKIP }, async (t) => {
  const bootQuote = async () => {
    const ctx = boot(Q_HTML, (u, o, json) => {
      if (u.includes('/api/customers')) {
        return json({ items: [{ id: 1, code: 'C001', name: 'REFACCIONARIA NORTE', discount: 30 }] });
      }
      if (u.includes('/api/quotes/preview')) {
        return json({ lines: [{ matched: true, product_id: 10, ctr_code: 'CE0536R', input_code: 'CE0536R',
          product_name: 'ROTULA', qty: 2, list_price: 100, final_price: 70, line_total: 162.4, stock_flag: 'ok' }],
          totals: { subtotal: 140, iva: 22.4, total: 162.4, totalQty: 2, skuCount: 1 } });
      }
      if (u.endsWith('/api/quotes') && (o.method === 'POST')) {
        return json({ id: 55, quote_no: 'Q-2026-0431', customer_po_no: 'OC-2026-118' });
      }
      return null;
    });
    await ctx.ready; await tick(200);
    return ctx;
  };

  await t.test('① 헤더에 고객 PO 입력칸이 있다 (60자 상한)', async () => {
    const { d } = await bootQuote();
    const el = d.getElementById('custPo');
    assert.ok(el, 'PO 입력칸이 있어야 한다');
    assert.equal(el.getAttribute('maxlength'), '60', 'DB·인쇄 상한과 같아야 한다');
  });

  await t.test('② 저장하면 요청 본문에 customer_po_no 가 실린다', async () => {
    const { w, d, calls } = await bootQuote();
    d.getElementById('custSel').value = '1';
    w.onCustChange();
    await tick(150);
    d.getElementById('inCode').value = 'CE0536R';
    d.getElementById('inQty').value = '2';
    w.addLine();
    await tick(200);
    d.getElementById('custPo').value = '  OC-2026-118  ';   // 앞뒤 공백은 화면이 정리한다
    calls.length = 0;
    w.saveQuote();
    await tick(250);
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/quotes'));
    assert.ok(post, '견적 저장 요청이 나가야 한다');
    const body = JSON.parse(post.body);
    assert.equal(body.customer_po_no, 'OC-2026-118', '공백을 정리해서 보낸다');
  });

  await t.test('③ PO 를 안 넣으면 null 로 보낸다 (빈 문자열 금지)', async () => {
    const { w, d, calls } = await bootQuote();
    d.getElementById('custSel').value = '1';
    w.onCustChange(); await tick(150);
    d.getElementById('inCode').value = 'CE0536R'; d.getElementById('inQty').value = '1';
    w.addLine(); await tick(200);
    calls.length = 0;
    w.saveQuote(); await tick(250);
    const body = JSON.parse(calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/quotes')).body);
    assert.equal(body.customer_po_no, null);
  });

  await t.test('④ 「전체 비우기」는 PO 도 같이 지운다 (앞 고객 PO 가 따라붙지 않게)', async () => {
    const { w, d } = await bootQuote();
    d.getElementById('custPo').value = 'OC-2026-118';
    w.clearLines();
    await tick(60);
    assert.equal(d.getElementById('custPo').value, '');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ② ③ 견적 목록 · 상세
// ═══════════════════════════════════════════════════════════════════════
const QUOTE_ROW = {
  id: 55, quote_no: 'Q-2026-0431', quote_date: '2026-09-18', status: 'confirmed',
  total_mxn: 162.4, subtotal_mxn: 140, total_qty: 2, sku_count: 1,
  customer_po_no: 'OC-2026-118', party_name: 'REFACCIONARIA NORTE', is_guest: false,
  creator_name: 'Oscar', open: true, cls: { ok: 1, short: 0, dev: 0, ok_qty: 2, short_qty: 0, dev_qty: 0, ok_amt: 162.4, short_amt: 0 },
};
const QUOTE_NOPO = { ...QUOTE_ROW, id: 56, quote_no: 'Q-2026-0432', customer_po_no: null, party_name: 'AUTOPARTES SUR' };

test('견적 목록 — PO 표시와 한 칸 검색 (jsdom)', { skip: SKIP }, async (t) => {
  const bootList = async (opts = {}) => {
    const ctx = boot(L_HTML, (u, o, json) => {
      if (u.includes('/api/quotes/open-count')) return json({ open: 2, guest_pending: 0, delete_pending: 0 });
      if (u.includes('/api/quotes?')) return json({ items: opts.items || [QUOTE_ROW, QUOTE_NOPO] });
      if (/\/api\/quotes\/\d+\/customer-po/.test(u)) return json({ ok: true, customer_po_no: opts.poEcho ?? 'OC-NUEVA-9' });
      if (/\/api\/quotes\/\d+$/.test(u)) {
        return json({ quote: opts.quote || { ...QUOTE_ROW, customer_id: 1, customer_name: 'REFACCIONARIA NORTE' }, lines: [] });
      }
      if (u.includes('/api/company')) return json({ emisor: 'Refatrix' });
      return null;
    });
    await ctx.ready; await tick(250);
    return ctx;
  };

  await t.test('① 견적번호 **아래에** 작은 PO 배지가 붙는다', async () => {
    const { d } = await bootList();
    const html = d.getElementById('listWrap').innerHTML;
    assert.match(html, /Q-2026-0431/);
    assert.match(html, /PO OC-2026-118/, '견적번호 셀 안에 PO 가 같이 있어야 한다');
  });

  await t.test('② PO 가 없는 견적에는 「—」 같은 잡음을 찍지 않는다', async () => {
    const { w, d } = await bootList();
    assert.equal(w.poSmall(null), '', 'PO 를 안 쓰는 고객 목록이 대시로 덮이면 안 된다');
    assert.match(w.poSmall('4471'), /PO 4471/);
    assert.ok(!d.getElementById('listWrap').innerHTML.includes('PO null'));
  });

  await t.test('③ 검색하면 기간을 비우고 q= 로 전 기간 조회한다', async () => {
    const { w, d, calls } = await bootList();
    d.getElementById('qSearch').value = '4471';
    calls.length = 0;
    w.runSearch();
    await tick(250);
    const get = calls.find((c) => c.url.includes('/api/quotes?'));
    assert.ok(get, '목록 조회가 다시 나가야 한다');
    assert.match(get.url, /q=4471/);
    assert.match(get.url, /from=&to=/, '기간을 비워 전 기간에서 찾는다');
    assert.ok(!/open=1|status=/.test(get.url), '검색 중에는 상태 칩도 걸지 않는다');
  });

  await t.test('④ 검색 중이라는 사실을 화면이 말해 준다', async () => {
    const { w, d } = await bootList();
    d.getElementById('qSearch').value = 'OC-2026';
    w.runSearch(); await tick(250);
    const note = d.getElementById('qSearchNote');
    assert.notEqual(note.style.display, 'none');
    assert.match(note.textContent, /기간·상태 선택은 무시/);
    assert.match(note.textContent, /OC-2026/);
  });

  await t.test('⑤ 검색 해제하면 예전 조회로 돌아간다', async () => {
    const { w, d, calls } = await bootList();
    d.getElementById('qSearch').value = '4471';
    w.runSearch(); await tick(250);
    calls.length = 0;
    w.clearSearch(); await tick(250);
    const get = calls.find((c) => c.url.includes('/api/quotes?'));
    assert.ok(!get.url.includes('q='), '검색어가 빠져야 한다');
    assert.equal(d.getElementById('qSearchNote').style.display, 'none');
  });

  await t.test('⑥ Enter 로도 찾는다', async () => {
    const { w, d, calls } = await bootList();
    const el = d.getElementById('qSearch');
    el.value = 'NORTE';
    calls.length = 0;
    el.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick(250);
    assert.ok(calls.some((c) => c.url.includes('q=NORTE')));
  });
});

test('견적 상세 — PO 단독 저장 (jsdom)', { skip: SKIP }, async (t) => {
  const bootDetail = async (quote, poEcho) => {
    const ctx = boot(L_HTML, (u, o, json) => {
      if (u.includes('/api/quotes/open-count')) return json({ open: 1, guest_pending: 0, delete_pending: 0 });
      if (u.includes('/api/quotes?')) return json({ items: [QUOTE_ROW] });
      if (/\/api\/quotes\/\d+\/customer-po/.test(u)) return json({ ok: true, customer_po_no: poEcho });
      if (/\/api\/quotes\/\d+$/.test(u)) return json({ quote, lines: [] });
      return null;
    });
    await ctx.ready; await tick(250);
    ctx.w.openDetail(55);
    await tick(250);
    return ctx;
  };
  const CONVERTED = { ...QUOTE_ROW, status: 'converted', customer_id: 1, customer_name: 'REFACCIONARIA NORTE',
    customer_po_no: null, open: false };

  await t.test('① 매출 전환된 견적에서도 PO 칸이 열려 있다', async () => {
    const { d } = await bootDetail(CONVERTED, 'OC-TARDE-1');
    const input = d.getElementById('poInput');
    assert.ok(input, '전환 뒤에 PO 가 오는 일이 흔하다 — 여기서 막으면 답이 없다');
    assert.ok(!input.disabled);
    assert.ok(d.getElementById('poSave'));
  });

  await t.test('② 저장하면 전용 엔드포인트로만 나간다 (라인·금액을 건드리지 않는다)', async () => {
    const { w, d, calls } = await bootDetail(CONVERTED, 'OC-TARDE-1');
    d.getElementById('poInput').value = '  OC-TARDE-1 ';
    calls.length = 0;
    d.getElementById('poSave').dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(300);
    const post = calls.find((c) => c.method === 'POST');
    assert.ok(post, 'POST 가 나가야 한다');
    assert.match(post.url, /\/api\/quotes\/55\/customer-po$/);
    assert.equal(JSON.parse(post.body).customer_po_no, 'OC-TARDE-1');
    assert.ok(!calls.some((c) => c.method === 'PUT'), 'PUT(라인 전체 교체)은 나가면 안 된다');
  });

  await t.test('③ 저장 후 「Pedido: 우리번호 / PO」 를 그대로 보여 준다', async () => {
    const { w, d } = await bootDetail(CONVERTED, 'OC-TARDE-1');
    d.getElementById('poInput').value = 'OC-TARDE-1';
    d.getElementById('poSave').dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(300);
    assert.match(d.getElementById('poMsg').textContent, /Q-2026-0431 \/ OC-TARDE-1/);
  });

  await t.test('④ 마이그레이션 전이면 사람이 알아들을 말로 알려 준다', async () => {
    const ctx = boot(L_HTML, (u, o, json) => {
      if (u.includes('/api/quotes/open-count')) return json({ open: 1, guest_pending: 0, delete_pending: 0 });
      if (u.includes('/api/quotes?')) return json({ items: [QUOTE_ROW] });
      if (/customer-po/.test(u)) return { ok: false, status: 503, json: async () => ({ error: 'migration_required', migration: '0225' }) };
      if (/\/api\/quotes\/\d+$/.test(u)) return json({ quote: CONVERTED, lines: [] });
      return null;
    });
    await ctx.ready; await tick(250);
    ctx.w.openDetail(55); await tick(250);
    ctx.d.getElementById('poInput').value = 'X';
    ctx.d.getElementById('poSave').dispatchEvent(new ctx.w.Event('click', { bubbles: true }));
    await tick(300);
    assert.match(ctx.d.getElementById('poMsg').textContent, /마이그레이션\(0225\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ④ 창고 — 패킹리스트·라벨의 Pedido
// ═══════════════════════════════════════════════════════════════════════
const SHIP = {
  quote_id: 55, quote_no: 'Q-2026-0431', quote_date: '2026-09-18',
  customer_po_no: 'OC-2026-118',
  customer: 'REFACCIONARIA NORTE', customer_code: 'C001', customer_rfc: 'RFN010101AAA',
  ship_address: null, sat_no: 'A-123', has_sat: true, inv_date: '2026-09-18', total_mxn: 162.4,
  packed_at: '2026-09-18T18:00:00Z', box_count: 1, total_qty: 2, sku_count: 1,
  boxes: [{ box_id: 1, box_no: 1, box_qty: 2, box_sku: 1,
    lines: [{ ctr_code: 'CE0536R', syd_code: 'SYD-1', ean: '', qty: 2 }] }],
};

test('창고 — 패킹리스트 Pedido 에 고객 PO 가 같이 인쇄된다 (jsdom)', { skip: SKIP }, async (t) => {
  const bootWh = async () => {
    const ctx = boot(W_HTML, (u, o, json) => {
      if (u.includes('/api/warehouse/packing-queue/')) return json({ items: [] });
      if (u.includes('/api/warehouse/packing-queue')) {
        return json({ count: 1, in_business: true, items: [{ quote_id: 55, quote_no: 'Q-2026-0431',
          customer_po_no: 'OC-2026-118', customer: 'REFACCIONARIA NORTE', printed_at: '2026-09-18T12:00:00Z',
          due_at: null, overdue: false, elapsed_biz_sec: 60, total_qty: 2, sku_count: 1, packed_qty: 0 }] });
      }
      if (/\/api\/warehouse\/ship\/\d+/.test(u)) return json(SHIP);
      if (u.includes('/api/warehouse/ship-queue')) return json({ items: [] });
      if (u.includes('/api/company')) return json({ emisor: 'Refatrix', rfc: 'REF010101AAA' });
      return null;
    });
    await ctx.ready; await tick(250);
    ctx.WH = ctx.w.__WH__;
    return ctx;
  };

  await t.test('① pedidoText — 우리번호 뒤 「/」, 한 칸 띄고 고객 PO (디렉터 지정 형식)', async () => {
    const { WH } = await bootWh();
    assert.equal(WH.pedidoText({ quote_no: 'Q-2026-0431', customer_po_no: 'OC-2026-118' }), 'Q-2026-0431/ OC-2026-118');
  });

  await t.test('② PO 가 없으면 구분자도 찍지 않는다 (빈 슬래시는 「뭔가 빠졌나」로 읽힌다)', async () => {
    const { WH } = await bootWh();
    assert.equal(WH.pedidoText({ quote_no: 'Q-2026-0431', customer_po_no: null }), 'Q-2026-0431');
    assert.equal(WH.pedidoText({ quote_no: 'Q-2026-0431', customer_po_no: '   ' }), 'Q-2026-0431');
    assert.equal(WH.pedidoText({ quote_no: 'Q-2026-0431' }), 'Q-2026-0431');
  });

  await t.test('③ A4 패킹리스트(LISTA DE EMPAQUE)의 Pedido 칸에 두 번호가 같이 들어간다', async () => {
    const { WH } = await bootWh();
    const html = WH.buildPackingListHTML(SHIP);
    assert.match(html, /LISTA DE EMPAQUE/);
    assert.match(html, /<b>Pedido:<\/b> Q-2026-0431\/ OC-2026-118/);
    // 원본·사본 2부 모두에 찍혀야 한다
    const n = (html.match(/Q-2026-0431\/ OC-2026-118/g) || []).length;
    assert.equal(n, 2, 'ORIGINAL(고객)·COPIA(창고) 두 부 모두');
  });

  await t.test('④ PO 가 없는 오더의 패킹리스트는 예전 그대로다 (회귀)', async () => {
    const { WH } = await bootWh();
    const html = WH.buildPackingListHTML({ ...SHIP, customer_po_no: null });
    assert.match(html, /<b>Pedido:<\/b> Q-2026-0431</);
    assert.ok(!html.includes('Q-2026-0431/'), '슬래시가 붙으면 안 된다');
  });

  await t.test('⑤ 박스 라벨(HTML 폴백)에도 같이 찍힌다', async () => {
    const { WH } = await bootWh();
    const html = WH.buildLabelsHTML(SHIP);
    assert.match(html, /<b>Pedido:<\/b> Q-2026-0431\/ OC-2026-118/);
  });

  await t.test('⑥ 포장 대기 목록에 PO 배지가 보인다 (창고가 고객 PO 로 찾을 수 있게)', async () => {
    const { d } = await bootWh();
    assert.match(d.getElementById('queue').innerHTML, /PO OC-2026-118/);
  });

  await t.test('⑦ poBadge — PO 가 없으면 아무것도 그리지 않는다', async () => {
    const { WH } = await bootWh();
    assert.equal(WH.poBadge(null), '');
    assert.equal(WH.poBadge(''), '');
    assert.match(WH.poBadge('4471'), /PO 4471/);
  });

  await t.test('⑧ PO 에 HTML 특수문자가 있어도 이스케이프된다', async () => {
    const { WH } = await bootWh();
    const html = WH.buildPackingListHTML({ ...SHIP, customer_po_no: '<b>X</b>&Y' });
    assert.ok(!html.includes('<b>X</b>&Y'), '고객이 준 문자열을 그대로 심으면 안 된다');
    assert.match(html, /&lt;b&gt;X&lt;\/b&gt;/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ⑤ 매출 확정 목록
// ═══════════════════════════════════════════════════════════════════════
test('매출 확정 목록 — PO 열과 검색 (jsdom)', { skip: SKIP }, async (t) => {
  const IMM = {
    months: ['2026-09'], can_filter: false, summary: null, search: null, search_all_periods: false,
    able: [{ id: 55, quote_no: 'Q-2026-0431', qdate: '2026-09-18', age_days: 3,
      customer_po_no: 'OC-2026-118', customer_name: 'REFACCIONARIA NORTE', ok_sku: 1, ok_qty: 2 }],
    done: [{ id: 9, invoice_id: 9, quote_no: 'Q-2026-0400', inv_date: '2026-09-10', sat_no: 'A-99',
      temp_sat: false, customer_po_no: 'PO-AGO-77', customer_name: 'AUTOPARTES SUR', owner_name: 'Oscar',
      total_mxn: 500, inv_sku: 2, inv_qty: 8 }],
  };
  const bootFunnel = async () => {
    const ctx = boot(F_HTML, (u, o, json) => {
      if (u.includes('/funnel/immediate')) return json(IMM);
      if (u.includes('/api/sales/credit-days/pending')) return json({ items: [] });
      return null;
    });
    await ctx.ready; await tick(250);
    if (typeof ctx.w.loadImmediate === 'function') { await ctx.w.loadImmediate(); await tick(200); }
    return ctx;
  };

  await t.test('① 두 표 모두 「고객 PO」 열을 갖는다', async () => {
    const { d } = await bootFunnel();
    const html = d.getElementById('body').innerHTML;
    assert.match(html, /고객 PO/);
    assert.match(html, /OC-2026-118/, '발행 가능(미전환) 견적의 PO');
    assert.match(html, /PO-AGO-77/, '이미 발행된 인보이스의 PO');
  });

  await t.test('② poCell — PO 가 없으면 「—」 한 칸만 (열이 비어 보이지 않게)', async () => {
    const { w } = await bootFunnel();
    assert.match(w.poCell(null), /—/);
    assert.match(w.poCell('4471'), /4471/);
  });

  await t.test('③ 검색하면 q= 가 실려 나가고, 전 기간에서 찾았다고 알려 준다', async () => {
    const { w, d, calls } = await bootFunnel();
    d.getElementById('immQ').value = 'PO-AGO-77';
    calls.length = 0;
    w.runImmSearch();
    await tick(250);
    const get = calls.find((c) => c.url.includes('/funnel/immediate'));
    assert.ok(get, '다시 조회해야 한다');
    assert.match(get.url, /q=PO-AGO-77/);
    assert.match(d.getElementById('body').textContent, /기간 선택을 무시하고 전 기간/);
  });

  await t.test('④ 검색 해제하면 q= 없이 돌아간다', async () => {
    const { w, d, calls } = await bootFunnel();
    d.getElementById('immQ').value = 'X';
    w.runImmSearch(); await tick(250);
    calls.length = 0;
    w.clearImmSearch(); await tick(250);
    const get = calls.find((c) => c.url.includes('/funnel/immediate'));
    assert.ok(!get.url.includes('q='));
  });
});
