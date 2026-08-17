// 구매검토 화면 — 엑셀 다운로드(현재 조회 조건 전체) 프런트 테스트
// 실행: node --test refatrix-api/test/purchasereview_excel.test.mjs   (jsdom 필요)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HTML = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../refatrix-purchasereview.html');

function mkItem(i, over = {}) {
  return {
    product_id: i, ctr: 'CA' + String(i).padStart(4, '0'), name: 'BALATA ' + i,
    syd: ['SYD-' + i, 'SYD-' + i + 'B'], applications: ['NISSAN Frontier 2010-2015', 'TOYOTA Hilux 2016-'],
    stock_qty: i, backorder_qty: i * 2, sold_qty: i * 3, shortage_qty: i * 4, ...over,
  };
}

// 화면을 로그인된 상태로 띄우고, fetch/XLSX 를 가로챈다.
async function boot({ total, pageOf }) {
  const html = fs.readFileSync(HTML, 'utf8');
  const calls = [];
  const written = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://example.test/refatrix-purchasereview.html' });
  const w = dom.window;
  w.XLSX = {
    utils: {
      json_to_sheet: (rows) => ({ rows }),
      book_new: () => ({ sheets: [] }),
      book_append_sheet: (wb, ws, name) => { wb.sheets.push({ ws, name }); },
    },
    writeFile: (wb, fname) => written.push({ wb, fname }),
  };
  w.fetch = async (url, opt) => {
    const u = new w.URL(url);
    if (u.pathname === '/api/login') {
      return { ok: true, json: async () => ({ token: 't', user: { name: '테스터', role: 'director' } }) };
    }
    calls.push({ url: u, headers: (opt && opt.headers) || {} });
    const limit = Number(u.searchParams.get('limit')) || 0;
    const offset = Number(u.searchParams.get('offset')) || 0;
    return { ok: true, json: async () => ({ items: pageOf(limit, offset), total, summary: {} }) };
  };
  await new Promise((r) => w.addEventListener('load', r));
  w.document.getElementById('lid').value = 'u';
  w.document.getElementById('pin').value = '1';
  await w.login();
  await new Promise((r) => setTimeout(r, 0));
  return { w, calls, written, dom };
}

const pager = (n) => (limit, offset) => {
  const out = [];
  for (let i = offset + 1; i <= Math.min(offset + limit, n); i++) out.push(mkItem(i));
  return out;
};

test('버튼이 존재하고 XLSX 라이브러리를 로드한다', async () => {
  const html = fs.readFileSync(HTML, 'utf8');
  assert.match(html, /id="xlsxBtn"/);
  assert.match(html, /xlsx\.full\.min\.js/);
});

test('전체가 한 청크에 들어오면 1회 호출 후 파일을 쓴다', async () => {
  const { w, calls, written } = await boot({ total: 3, pageOf: pager(3) });
  calls.length = 0;
  await w.exportExcel();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.searchParams.get('limit'), '5000');
  assert.equal(calls[0].url.searchParams.get('offset'), '0');
  assert.equal(written.length, 1);
  assert.match(written[0].fname, /^refatrix_purchase_review_\d{8}\.xlsx$/);
  assert.equal(written[0].wb.sheets[0].name, '구매검토');
  assert.equal(written[0].wb.sheets[0].ws.rows.length, 3);
});

test('열 구성 = CTR·제품명·SYD·적용차종(전체)·현재재고·backorder·누적판매·견적부족', async () => {
  const { w, written } = await boot({ total: 1, pageOf: pager(1) });
  await w.exportExcel();
  const row = written[0].wb.sheets[0].ws.rows[0];
  assert.deepEqual(Object.keys(row), ['CTR', '제품명', 'SYD', '적용차종', '현재재고', 'backorder', '누적판매', '견적부족']);
  assert.equal(row.CTR, 'CA0001');
  assert.equal(row['제품명'], 'BALATA 1');
  assert.equal(row.SYD, 'SYD-1, SYD-1B');
  assert.equal(row['적용차종'], 'NISSAN Frontier 2010-2015 / TOYOTA Hilux 2016-'); // 화면의 70자 말줄임 없음
  assert.equal(row['현재재고'], 1);
  assert.equal(row.backorder, 2);
  assert.equal(row['누적판매'], 3);
  assert.equal(row['견적부족'], 4);
});

test('페이지(200)를 넘어 전체 12,000행을 3회 나눠 모두 받는다', async () => {
  const { w, calls, written } = await boot({ total: 12000, pageOf: pager(12000) });
  calls.length = 0;
  await w.exportExcel();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.url.searchParams.get('offset')), ['0', '5000', '10000']);
  assert.equal(written[0].wb.sheets[0].ws.rows.length, 12000);
});

test('현재 검색어·수요만·정렬 조건을 그대로 사용한다', async () => {
  const { w, calls } = await boot({ total: 1, pageOf: pager(1) });
  w.document.getElementById('q').value = 'CA0032';
  w.document.getElementById('demandOnly').checked = true;
  w.document.getElementById('tbl').querySelector('th[data-s="sold"]').click(); // 정렬 = sold/desc + 재조회
  await new Promise((r) => setTimeout(r, 0));
  calls.length = 0;
  await w.exportExcel();
  const p = calls[0].url.searchParams;
  assert.equal(p.get('q'), 'CA0032');
  assert.equal(p.get('demand'), '1');
  assert.equal(p.get('sort'), 'sold');
  assert.equal(p.get('dir'), 'desc');
  assert.equal(calls[0].headers.Authorization, 'Bearer t');
});

test('결과 0건이면 파일을 만들지 않고 안내한다', async () => {
  const { w, written } = await boot({ total: 0, pageOf: () => [] });
  await w.exportExcel();
  assert.equal(written.length, 0);
  assert.match(w.document.getElementById('msg').textContent, /내보낼 데이터가 없습니다/);
});

test('서버 오류 시 버튼이 복구되고 오류를 표시한다', async () => {
  const { w } = await boot({ total: 1, pageOf: pager(1) });
  w.fetch = async () => ({ ok: false, json: async () => ({ error: 'forbidden' }) });
  await w.exportExcel();
  const btn = w.document.getElementById('xlsxBtn');
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, '⬇ 엑셀 다운로드');
  assert.match(w.document.getElementById('msg').textContent, /엑셀 다운로드 실패: forbidden/);
});
