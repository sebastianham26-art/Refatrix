// =====================================================================
// 포장작업지시서 「Ubicación rack」 — 화면(jsdom) 검증
//   · 운영 refatrix-quotelist.html 을 그대로 파싱해 openConvert → printPickList 를 실행하고,
//     window.open 으로 써지는 실제 인쇄 HTML 을 잡아 검사한다(손으로 베낀 마크업이 아님).
//   · 검사 대상: 랙 값 표시 / 랙 자연정렬 / 미지정 맨 뒤 + SIN UBICACIÓN / 상단 미지정 카드 /
//     모달 사전 경고 / 이스케이프 / 기존 열·서명폼 회귀.
//   실행: node --test test/packing_rack_front.test.mjs   (jsdom 필요)
// =====================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, '..', '..', 'refatrix-quotelist.html');
const html = fs.readFileSync(HTML, 'utf8');

let JSDOM;
try { ({ JSDOM } = await import('jsdom')); } catch { /* jsdom 없으면 skip */ }
const opts = JSDOM ? {} : { skip: 'jsdom 미설치 — skip (npm i -D jsdom)' };

const S = (code, rack, qty = 1) => ({ ctr_code: code, product_name: 'Prod ' + code, qty, avail: qty, rack_location: rack });

// 화면을 띄우고 매출전환 모달을 연 뒤 window 를 돌려준다.
//   preview.in_stock 을 바꿔가며 지시서를 뽑는다. 인쇄 HTML 은 dom.__printed 에 모인다.
async function boot(inStock) {
  const printed = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-quotelist.html',
    beforeParse(win) {
      win.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { name: 'dir', role: 'director' } }));
      win.alert = (m) => { printed.push({ alert: String(m) }); };
      win.confirm = () => true;
      // 인쇄창 스텁 — document.write 로 들어오는 HTML 을 그대로 모은다.
      win.open = () => {
        const buf = [];
        return { document: { open() {}, write(h) { buf.push(h); }, close() { printed.push(buf.join('')); } } };
      };
      win.fetch = async (url, init) => {
        const u = String(url);
        const json = (o) => ({ ok: true, status: 200, json: async () => o });
        if (/\/convert-preview/.test(u)) return json({ is_guest: false, already: false, counts: { in_stock: inStock.length, shortage: 0, new_dev: 0 }, in_stock: inStock, shortage: [], new_dev: [] });
        if (/\/packing-doc$/.test(u)) return json({ has: false });
        if (/\/packing-printed$/.test(u)) return json({ packing_printed_at: '2026-08-26T15:00:00Z', packing_due_at: '2026-08-27T15:00:00Z' });
        if (/\/api\/quotes\/\d+$/.test(u)) return json({ quote: { id: 7 }, lines: inStock.map((x) => ({ ctr_code: x.ctr_code, syd_codes: 'SYD-' + x.ctr_code })) });
        if (/\/api\/quotes\?/.test(u)) return json({ items: [], summary: {} });
        if (/\/api\/quotes\/counts/.test(u)) return json({ open: 0, guest_pending: 0, delete_pending: 0 });
        if (/\/api\/company/.test(u)) return json({ emisor: 'Refatrix', rfc: 'RFC1', phone: '55' });
        if (/\/api\/auth\/(login|me)/.test(u)) return json({ token: 't', user: { name: 'dir', role: 'director' }, perm: {} });
        return json({});
      };
    },
  });
  await new Promise((r) => dom.window.addEventListener('load', r));
  const w = dom.window;
  w.session = { token: 't', user: { name: 'dir', role: 'director' }, api: 'https://api.test' };
  w.isDirector = true;
  dom.__printed = printed;
  await w.openConvert(7, false, 'Cliente X');
  return dom;
}

// 인쇄 HTML 의 표 본문에서 [SKU, 랙셀] 을 순서대로 뽑는다.
function rowsOf(doc) {
  const out = [];
  const re = /<td class="c-sku">([\s\S]*?)<\/td>[\s\S]*?<td class="c-rack">([\s\S]*?)<\/td>/g;
  let m; while ((m = re.exec(doc))) out.push([m[1], m[2]]);
  return out;
}
async function printOf(dom) {
  dom.__printed.length = 0;
  await dom.window.printPickList();
  const doc = dom.__printed.find((x) => typeof x === 'string');
  assert.ok(doc, '인쇄 HTML 이 생성되어야 한다 (alert: ' + JSON.stringify(dom.__printed) + ')');
  return doc;
}

test('① 랙 값이 지시서에 실제로 찍힌다', opts, async () => {
  const dom = await boot([S('CE0001', 'A-01-03'), S('CE0002', 'B-02-11')]);
  const doc = await printOf(dom);
  assert.match(doc, /Ubicación rack/, '열 제목은 그대로');
  const rows = rowsOf(doc);
  assert.deepEqual(rows.map((r) => r[1]), ['A-01-03', 'B-02-11']);
  assert.doesNotMatch(doc, /SIN UBICACIÓN/, '전부 지정돼 있으면 경고가 없어야 한다');
  assert.doesNotMatch(doc, /SKU sin ubicación/, '미지정 카드도 없어야 한다');
});

test('② 랙 자연정렬 — A-1-9 가 A-1-10 보다 앞', opts, async () => {
  const dom = await boot([S('CE0010', 'A-1-10'), S('CE0009', 'A-1-9'), S('CE0002', 'A-1-2')]);
  const rows = rowsOf(await printOf(dom));
  assert.deepEqual(rows.map((r) => r[1]), ['A-1-2', 'A-1-9', 'A-1-10']);
  assert.deepEqual(rows.map((r) => r[0]), ['CE0002', 'CE0009', 'CE0010'], '# 번호도 랙 순서를 따른다');
});

test('③ 대소문자 무시 · 랙이 같으면 SKU 코드순', opts, async () => {
  const dom = await boot([S('CE0300', 'b-01-01'), S('CE0100', 'B-01-01'), S('CE0200', 'a-02-01')]);
  const rows = rowsOf(await printOf(dom));
  assert.deepEqual(rows.map((r) => r[1]), ['a-02-01', 'B-01-01', 'b-01-01']);
  assert.deepEqual(rows.map((r) => r[0]), ['CE0200', 'CE0100', 'CE0300']);
});

test('④ 랙 미지정은 맨 뒤 + 빨간 SIN UBICACIÓN + 상단 카드', opts, async () => {
  const dom = await boot([S('CE0001', ''), S('CE0002', 'C-01-01'), S('CE0003', null), S('CE0004', 'A-01-01')]);
  const doc = await printOf(dom);
  const rows = rowsOf(doc);
  assert.deepEqual(rows.map((r) => r[0]), ['CE0004', 'CE0002', 'CE0001', 'CE0003'], '지정된 랙 먼저, 미지정은 뒤');
  assert.equal(rows[0][1], 'A-01-01');
  assert.match(rows[2][1], /class="norack">⚠ SIN UBICACIÓN</);
  assert.match(rows[3][1], /SIN UBICACIÓN/);
  assert.match(doc, /SKU sin ubicación<\/span><span class="v" style="color:#c0392b">2</, '상단 카드에 미지정 2건');
  assert.match(doc, /td\.c-rack \.norack\{[^}]*color:#c0392b/, '빨간색 CSS 가 실려야 한다');
  assert.match(doc, /\.pk-tbl td\.c-rack\{color:#1c1b19/, '본문 랙 셀만 진하게(머리글은 흰 글씨 유지)');
});

test('⑤ 전부 미지정이면 기존처럼 SKU 코드순', opts, async () => {
  const dom = await boot([S('CE0020', ' '), S('CE0003', ''), S('CE0010', null)]);
  const rows = rowsOf(await printOf(dom));
  assert.deepEqual(rows.map((r) => r[0]), ['CE0003', 'CE0010', 'CE0020']);
  assert.equal(rows.filter((r) => /SIN UBICACIÓN/.test(r[1])).length, 3);
});

test('⑥ 랙 문자열은 이스케이프된다', opts, async () => {
  const dom = await boot([S('CE0001', 'A<script>x</script>')]);
  const doc = await printOf(dom);
  assert.match(doc, /A&lt;script&gt;/);
  assert.doesNotMatch(rowsOf(doc)[0][1], /<script>/);
});

test('⑦ 모달에서 출력 전에 미지정 SKU 를 경고한다', opts, async () => {
  const dom = await boot([S('CE0001', ''), S('CE0002', 'A-01-01'), S('CE0003', '')]);
  const pv = dom.window.document.getElementById('cvPreview').innerHTML;
  assert.match(pv, /랙 위치가 없는 SKU 2개/);
  assert.match(pv, /CE0001, CE0003/);
  assert.match(pv, /랙 위치 순 정렬/);

  const clean = await boot([S('CE0002', 'A-01-01')]);
  const pv2 = clean.window.document.getElementById('cvPreview').innerHTML;
  assert.doesNotMatch(pv2, /랙 위치가 없는 SKU/, '전부 지정이면 경고가 없어야 한다');
});

test('⑧ 회귀 — 열 구성·수량·SYD·서명폼·기한이 그대로다', opts, async () => {
  const dom = await boot([S('CE0001', 'A-01-01', 4), S('CE0002', 'A-01-02', 6)]);
  const doc = await printOf(dom);
  for (const t of ['Clave SKU', 'Clave SYD', 'Producto', 'Cantidad', 'Ubicación rack', 'Surtido',
    'ORDEN DE SURTIDO Y EMPAQUE', 'Nombre del operador', 'Firma', 'Límite de empaque']) {
    assert.match(doc, new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), t + ' 가 사라졌다');
  }
  assert.match(doc, /SYD-CE0001/, 'SYD 매핑 회귀');
  assert.match(doc, /Piezas totales<\/span><span class="v">10</, '총수량 10');
  assert.equal(dom.window.document.getElementById('cvUploadBtn').disabled, false, '출력하면 스캔 업로드가 열린다');
});
