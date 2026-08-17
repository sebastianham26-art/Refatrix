/* 존 지정 화면 + 검수 목적지 존 표시 — 운영 HTML 의 인라인 스크립트를 그대로 실행(jsdom) */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const REPO = '/tmp/Refatrix';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

function lastScript(html) {
  return html.match(/<script>\s*\(function\(\)\{[\s\S]*?<\/script>/g).pop()
    .replace(/^<script>/, '').replace(/<\/script>$/, '');
}
function mkDom(file, { role = 'warehouse', routes = {}, expose = '' }) {
  const html = fs.readFileSync(`${REPO}/${file}`, 'utf8').replace(/<script src="refatrix-nav\.js[^"]*"><\/script>/, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://x.test/' + file, pretendToBeVisual: true });
  const w = dom.window;
  w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { id: 9, name: 'Dir', role } }));
  w.localStorage.setItem('wh_lang', 'ko');
  const sent = [];
  w.fetch = (url, opt) => {
    const u = String(url);
    if (opt && (opt.method === 'PUT' || opt.method === 'POST')) sent.push({ url: u, method: opt.method, body: opt.body ? JSON.parse(opt.body) : null });
    let body = { ok: true };
    for (const [re, val] of Object.entries(routes)) if (new RegExp(re).test(u)) { body = typeof val === 'function' ? val(u, opt) : val; break; }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.confirm = () => true;
  w.eval(lastScript(html).replace(/\}\)\(\);\s*$/, expose + '\n})();'));
  return { w, doc: w.document, sent };
}

/* ---------------- ① 검수 화면: 목적지 존 배너 ---------------- */
const mkShip = (zoneFor) => ({
  shipment: { id: 1, invoice_no: 'D26-81319563', status: 'receiving', eta: '2026-08-07' },
  pallets: [{
    id: 11, pl_no: '12', order_no: '100RA25K2C', status: 'unloaded',
    cartons_expected: 3, qty_expected: 48, checked_at: null, working: false,
    items: [
      { id: 101, code: 'CE0796', name: 'TERMINAL EXTERIOR', cartons: 1, qty: 16, rack: 'B-01-01', scanned_cartons: 0, put_cartons: 0, ...zoneFor.a },
      { id: 102, code: 'CE0152', name: 'TERMINAL', cartons: 1, qty: 16, rack: null, scanned_cartons: 0, put_cartons: 0, ...zoneFor.b },
      { id: 103, code: 'CE0154', name: 'TERMINAL', cartons: 1, qty: 16, rack: 'C-05-02', scanned_cartons: 0, put_cartons: 0, ...zoneFor.c },
    ],
  }],
  files: [],
});

async function openCheck(SHIP) {
  const ctx = mkDom('refatrix-inbound.html', {
    routes: {
      '/api/inbound/1(\\?|$)': SHIP,
      '/api/inbound(\\?|$)': { items: [{ id: 1, invoice_no: 'D26-81319563', status: 'receiving', pallets: 1, pallets_checked: 0 }] },
    },
    expose: 'window.__t={openShip:openShip,renderDetail:renderDetail,setStep:function(x){STEP=x;},zoneBigHtml:zoneBigHtml,zoneChip:zoneChip};',
  });
  await new Promise(r => setTimeout(r, 60));
  ctx.w.__t.openShip(1);
  await new Promise(r => setTimeout(r, 50));
  ctx.w.__t.setStep('check');
  ctx.w.__t.renderDetail();
  ctx.scan = (raw) => {
    const inp = ctx.doc.getElementById('scanIn');
    inp.value = raw;
    inp.dispatchEvent(new ctx.w.Event('input', { bubbles: true }));
    inp.dispatchEvent(new ctx.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };
  return ctx;
}

(async () => {
  console.log('\n① 검수 스캔 — 목적지 존을 크게 안내');
  {
    const ctx = await openCheck(mkShip({
      a: { zone: 2, zone_name: 'A동 앞', zone_is_default: false },
      b: { zone: 4, zone_name: '신규 대기', zone_is_default: true },
      c: { zone: null, zone_name: null, zone_is_default: false },
    }));
    ctx.scan("CTR'CE0796'16");
    const box = ctx.doc.getElementById('scanres');
    ok('존 배너 존재', !!box.querySelector('.zbig'), box.textContent.slice(0, 60));
    ok('존 번호 2 크게 표시', box.querySelector('.zbig .n').textContent === '2', box.querySelector('.zbig .n').textContent);
    ok('존 이름 병기', /A동 앞/.test(box.textContent));
    ok('존별 색 클래스(z2)', box.querySelector('.zbig').className.indexOf('z2') >= 0, box.querySelector('.zbig').className);
    ok('"이 박스를 옮길 곳" 문구', /옮길 곳/.test(box.textContent));
    ok('제품번호·수량도 그대로', /CE0796/.test(box.textContent) && /16 EA/.test(box.textContent));

    ctx.scan('CTR-CE0152-16');                       // 랙 없는 신규 SKU → 기본 존 4
    ok('신규 SKU 기본 존 4', ctx.doc.querySelector('#scanres .zbig .n').textContent === '4');
    ok('기본 존이라고 알려줌', /신규 SKU 기본 존/.test(ctx.doc.getElementById('scanres').textContent),
      ctx.doc.getElementById('scanres').textContent.slice(0, 120));

    ctx.scan('CTR-CE0154-16');                       // 존 미지정
    const b3 = ctx.doc.getElementById('scanres');
    ok('존 미지정은 빨간 경고', b3.querySelector('.zbig').className.indexOf('none') >= 0, b3.querySelector('.zbig').className);
    ok('존 지정 요청 안내', /존 지정/.test(b3.textContent), b3.textContent.slice(0, 140));
    ok('그래도 카톤은 집계됨(작업 중단 없음)', /1\/1/.test(b3.textContent), b3.textContent.slice(0, 160));

    const sk = ctx.doc.getElementById('sklist').textContent;
    ok('SKU 목록에 존 칩', /2/.test(sk) && ctx.doc.querySelectorAll('#sklist .zchip2').length === 3,
      ctx.doc.querySelectorAll('#sklist .zchip2').length);
    ok('존 없는 SKU 칩은 ?', Array.prototype.some.call(ctx.doc.querySelectorAll('#sklist .zchip2'), (e) => e.textContent === '?'));
  }

  console.log('\n② 존 지정 페이지 — 랙 목록·정렬·그룹·드롭다운');
  const ZDATA = {
    zones: [{ zone: 1, name: 'Zona 1' }, { zone: 2, name: 'Zona 2' }, { zone: 3, name: 'Zona 3' }, { zone: 4, name: 'Zona 4' }],
    racks: [
      { rack: 'A-01-03', products: 4, group: 'A', zone: null },
      { rack: 'A-2-9', products: 2, group: 'A', zone: 1 },
      { rack: 'A-2-10', products: 1, group: 'A', zone: null },
      { rack: 'B-01-01', products: 7, group: 'B', zone: 2 },
      { rack: 'C-05-02', products: 3, group: 'C', zone: null },
    ],
    orphans: [{ rack: 'Z-09-09', zone: 3 }],
    new_zone: null,
    no_rack_products: 26,
    totals: { racks: 5, mapped: 2, unmapped: 3 },
  };
  {
    const ctx = mkDom('refatrix-zones.html', { role: 'director', routes: { '/api/warehouse/zones': ZDATA } });
    await new Promise(r => setTimeout(r, 60));
    const rows = Array.prototype.map.call(ctx.doc.querySelectorAll('td.rack'), (e) => e.textContent);
    ok('랙 5개 표시', rows.length === 5, rows);
    ok('서버가 준 순서 유지(A-2-9 → A-2-10)', JSON.stringify(rows) === JSON.stringify(['A-01-03', 'A-2-9', 'A-2-10', 'B-01-01', 'C-05-02']), rows);
    ok('그룹 구분줄 3개(A·B·C)', ctx.doc.querySelectorAll('tr.gsep').length === 3, ctx.doc.querySelectorAll('tr.gsep').length);
    const sels = ctx.doc.querySelectorAll('select.zsel[data-rack]');
    ok('랙마다 드롭다운', sels.length === 5, sels.length);
    ok('드롭다운은 미지정+4개 = 5옵션', sels[0].options.length === 5, sels[0].options.length);
    ok('기존 지정값이 선택됨(A-2-9 → 1)', ctx.doc.querySelector('select.zsel[data-rack="A-2-9"]').value === '1');
    ok('미지정 행은 빨간 표시', ctx.doc.querySelectorAll('tr.unmapped').length === 3, ctx.doc.querySelectorAll('tr.unmapped').length);
    ok('KPI 미지정 3', /3/.test(ctx.doc.querySelectorAll('.kpi')[2].textContent), ctx.doc.querySelectorAll('.kpi')[2].textContent);
    ok('랙 없는 신규 SKU 26 표시', /26/.test(ctx.doc.querySelectorAll('.kpi')[3].textContent));
    ok('사라진 랙 안내', /Z-09-09/.test(ctx.doc.body.textContent));
    ok('처음엔 저장 비활성', ctx.doc.getElementById('btnSave').disabled === true);
    ok('존별 배정 랙 수 표시(존1=1, 존2=1)', /1/.test(ctx.doc.querySelectorAll('.zbox .cnt')[0].textContent));
  }

  console.log('\n③ 존 지정 — 변경·일괄지정·저장 payload');
  {
    const ctx = mkDom('refatrix-zones.html', { role: 'director', routes: { '/api/warehouse/zones': ZDATA } });
    await new Promise(r => setTimeout(r, 60));
    const setSel = (rack, v) => {
      const s = ctx.doc.querySelector(`select.zsel[data-rack="${rack}"]`);
      s.value = v; s.dispatchEvent(new ctx.w.Event('change', { bubbles: true }));
    };
    setSel('A-01-03', '1');
    ok('변경 1건 표시', /1/.test(ctx.doc.getElementById('dirty').textContent), ctx.doc.getElementById('dirty').textContent);
    ok('저장 활성화', ctx.doc.getElementById('btnSave').disabled === false);
    ok('변경 행 강조', ctx.doc.querySelectorAll('tr.dirty').length === 1);
    setSel('A-01-03', '');
    ok('원래 값으로 되돌리면 변경 0', /변경 없음/.test(ctx.doc.getElementById('dirty').textContent), ctx.doc.getElementById('dirty').textContent);

    // 앞글자 일괄지정: A 그룹 3개 → 존 3
    ctx.doc.getElementById('bulkG').value = 'A';
    ctx.doc.getElementById('bulkZ').value = '3';
    ctx.doc.getElementById('btnBulk').dispatchEvent(new ctx.w.Event('click', { bubbles: true }));
    ok('A 그룹 3개 일괄 변경', ctx.doc.querySelectorAll('tr.dirty').length === 3, ctx.doc.querySelectorAll('tr.dirty').length);
    ok('A-2-9 도 1 → 3 으로', ctx.doc.querySelector('select.zsel[data-rack="A-2-9"]').value === '3');
    ok('B 그룹은 그대로', ctx.doc.querySelector('select.zsel[data-rack="B-01-01"]').value === '2');

    // 신규 기본 존 + 존 이름
    const nz = ctx.doc.getElementById('newZone'); nz.value = '4'; nz.dispatchEvent(new ctx.w.Event('change', { bubbles: true }));
    const zn = ctx.doc.getElementById('zn1'); zn.value = 'A동 앞'; zn.dispatchEvent(new ctx.w.Event('input', { bubbles: true }));

    ctx.doc.getElementById('btnSave').dispatchEvent(new ctx.w.Event('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 40));
    const put = ctx.sent.filter((x) => x.method === 'PUT')[0];
    ok('PUT 전송됨', !!put, ctx.sent.map((x) => x.method + ' ' + x.url));
    ok('변경된 랙만 map 에 담김(3건)', put && put.body.map.length === 3, put && put.body.map);
    ok('A 그룹 3개가 zone 3', put && put.body.map.every((m) => m.zone === 3 && m.rack.indexOf('A') === 0), put && put.body.map);
    ok('new_zone 4 포함', put && put.body.new_zone === 4, put && put.body.new_zone);
    ok('존 이름 전달', put && put.body.zones.find((z) => z.zone === 1).name === 'A동 앞', put && put.body.zones);
    ok('저장 후 변경 표시 초기화', /변경 없음/.test(ctx.doc.getElementById('dirty').textContent));
  }

  console.log('\n④ 미지정 해제 · 검색 · 미지정만 보기 · 비디렉터');
  {
    const ctx = mkDom('refatrix-zones.html', { role: 'director', routes: { '/api/warehouse/zones': ZDATA } });
    await new Promise(r => setTimeout(r, 60));
    const s = ctx.doc.querySelector('select.zsel[data-rack="B-01-01"]');
    s.value = ''; s.dispatchEvent(new ctx.w.Event('change', { bubbles: true }));
    ctx.doc.getElementById('btnSave').dispatchEvent(new ctx.w.Event('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 40));
    const put = ctx.sent.filter((x) => x.method === 'PUT')[0];
    ok('해제는 zone:null 로 전송', put && put.body.map[0].zone === null && put.body.map[0].rack === 'B-01-01', put && put.body.map);

    const ctx2 = mkDom('refatrix-zones.html', { role: 'director', routes: { '/api/warehouse/zones': ZDATA } });
    await new Promise(r => setTimeout(r, 60));
    const q = ctx2.doc.getElementById('q'); q.value = 'A-2'; q.dispatchEvent(new ctx2.w.Event('input', { bubbles: true }));
    ok('검색 필터 2건', ctx2.doc.querySelectorAll('td.rack').length === 2, Array.prototype.map.call(ctx2.doc.querySelectorAll('td.rack'), (e) => e.textContent));
    const q2 = ctx2.doc.getElementById('q'); q2.value = ''; q2.dispatchEvent(new ctx2.w.Event('input', { bubbles: true }));
    const ou = ctx2.doc.getElementById('onlyU'); ou.checked = true; ou.dispatchEvent(new ctx2.w.Event('change', { bubbles: true }));
    ok('미지정만 보기 3건', ctx2.doc.querySelectorAll('td.rack').length === 3, ctx2.doc.querySelectorAll('td.rack').length);

    const ctx3 = mkDom('refatrix-zones.html', { role: 'warehouse', routes: { '/api/warehouse/zones': ZDATA } });
    await new Promise(r => setTimeout(r, 60));
    ok('비디렉터는 드롭다운 비활성', ctx3.doc.querySelector('select.zsel[data-rack]').disabled === true);
    ok('비디렉터는 저장 불가', ctx3.doc.getElementById('btnSave').disabled === true);
    ok('보기 전용 안내', /디렉터만 저장/.test(ctx3.doc.body.textContent));
  }

  console.log('\n⑤ 랙이 하나도 없을 때');
  {
    const empty = { ...ZDATA, racks: [], orphans: [], totals: { racks: 0, mapped: 0, unmapped: 0 } };
    const ctx = mkDom('refatrix-zones.html', { role: 'director', routes: { '/api/warehouse/zones': empty } });
    await new Promise(r => setTimeout(r, 60));
    ok('안내문 표시', /제품마스터에 지정된 랙이 없습니다/.test(ctx.doc.body.textContent), ctx.doc.body.textContent.slice(0, 200));
    ok('오류 없이 렌더', ctx.doc.querySelectorAll('.zbox').length === 4);
  }

  console.log('\n' + (fail ? '❌' : '✅') + ` 결과: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 실행 오류:', e); process.exit(2); });
