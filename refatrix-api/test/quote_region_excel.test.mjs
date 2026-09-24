// jsdom: 견적작성 「📚 전체 견적」 차종 지역 선택 (qt-0924rg)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const XS = require('xlsx-js-style');
const HTML = fs.readFileSync(process.env.QUOTE_HTML || path.resolve('refatrix-quote.html'), 'utf8')
  .replace(/<script src="[^"]+"><\/script>/g, '');

const ITEMS = [
  { ctr_code:'CB0001', name:'ROTULA INFERIOR', syd_codes:'1', app:'NISSAN Versa 2012-2019 // VOLKSWAGEN Jetta 2011-2018', list_price:100, stock_qty:5, vio_model:'Nissan Versa', vio_year:'2012-2019', vio_units:900000 },
  { ctr_code:'CB0002', name:'ROTULA INFERIOR', syd_codes:'2', app:'VOLKSWAGEN Jetta 2011-2018', list_price:200, stock_qty:0 },
  { ctr_code:'CQ0003L', name:'HORQUILLA (L)', syd_codes:'3', app:'CHEVROLET, GMC Aveo 2008-2017', list_price:300, stock_qty:2 },
  { ctr_code:'CE0004', name:'TERMINAL EXTERIOR', syd_codes:'4', app:'JAC Sei3 2017-2020 // MG ZS 2020-2024', list_price:50, stock_qty:1 },
  { ctr_code:'CE0005', name:'TERMINAL EXTERIOR', syd_codes:'5', app:'', list_price:70, stock_qty:1 },
  { ctr_code:'CE0006', name:'TERMINAL EXTERIOR', syd_codes:'6', app:'TOYOTA Hilux 2005-2015 // KIA Rio 2018-2023', list_price:80, stock_qty:3 },
];

async function boot(){
  const dom = new JSDOM(HTML, { runScripts:'dangerously', url:'https://example.test/refatrix-quote.html', pretendToBeVisual:true });
  const w = dom.window;
  const calls = [];
  w.fetch = async (u) => { calls.push(String(u));
    if (String(u).includes('/api/quotes/price-list')) return { ok:true, json:async()=>({ items:ITEMS, discountRate:40 }) };
    return { ok:true, json:async()=>({}), text:async()=>'' }; };
  w.alert = ()=>{};
  await new Promise(r=>setTimeout(r,30));
  w.XLSX = XS;
  const files = [];
  w.XLSX = Object.assign({}, XS, { writeFile:(wb,name)=>{ files.push({ name, wb:XS.read(XS.write(wb,{type:'buffer',bookType:'xlsx'}),{type:'buffer',cellFormula:true,cellStyles:true}) }); } });
  return { w, calls, files, $: id=>w.document.getElementById(id) };
}
const tick = (ms=60)=>new Promise(r=>setTimeout(r,ms));

test('버튼 → 모달 열림, 지역별 SKU 수 표시, 기본 선택(미표기 제외)', async () => {
  const { w, $, calls } = await boot();
  await w.eval('downloadAllQuote()'); await tick();
  assert.equal($('rgModal').style.display, 'flex');
  assert.ok(calls.some(u=>u.includes('price-list?all=1')));
  const items = [...w.document.querySelectorAll('#rgList .rgItem')];
  assert.deepEqual(items.map(x=>x.dataset.r), ['AS','EU','AM','CN','NA']);
  const txt = r => w.document.querySelector(`.rgItem[data-r=${r}] .ct`).textContent;
  assert.match(txt('AS'), /^2 SKU3행/);   // CB0001(Versa) + CE0006(Hilux·Rio 2행)
  assert.match(txt('EU'), /^2 SKU/);   // CB0001, CB0002
  assert.match(txt('AM'), /^1 SKU/);
  assert.match(txt('CN'), /^1 SKU/);   // CE0004 (JAC + MG → 2행)
  assert.match(txt('NA'), /^1 SKU/);
  const checked = [...w.document.querySelectorAll('#rgList input:checked')].map(x=>x.value);
  assert.deepEqual(checked, ['AS','EU','AM','CN']);
  assert.equal($('rgGo').disabled, false);
});

test('지역별 시트 분리: 시트명·행·대표행(Subtotal) 재계산·제목', async () => {
  const { w, $, files } = await boot();
  await w.eval('downloadAllQuote()'); await tick();
  $('rgGo').click(); await tick(120);
  assert.equal(files.length, 1);
  const { name, wb } = files[0];
  assert.match(name, /^cotizacion_completa_asia_europa_america_china_/);
  assert.deepEqual(wb.SheetNames, ['Asia','Europa','América','China']);
  const eu = wb.Sheets['Europa'];
  assert.match(eu['A3'].v, /Vehículos europeos/);
  // Europa: Jetta 그룹 CB0001, CB0002 — CB0001 대표는 원래 Versa(아시아)였지만 이 시트에선 자기 행이 대표(O=1)
  const codes = [], prin = [];
  for (let r=9; eu['C'+r]; r++){ codes.push(eu['C'+r].v); prin.push(eu['O'+r].v); }
  assert.deepEqual(codes, ['CB0001','CB0002']);
  assert.deepEqual(prin, [1,1]);
  assert.equal(eu['G6'].v, 0.4);
  assert.match(eu['N12'].f, /SUMPRODUCT\(\$N\$9:\$N\$10,\$O\$9:\$O\$10\)/);
  // China: CE0004 가 JAC·MG 두 행 → 중복(빨강) + 대표 1행
  const cn = wb.Sheets['China']; const cc=[], cp=[];
  for (let r=9; cn['C'+r]; r++){ cc.push(cn['C'+r].v); cp.push(cn['O'+r].v); }
  assert.deepEqual(cc, ['CE0004','CE0004']);
  assert.equal(cp.reduce((a,b)=>a+b,0), 1);
  assert.equal($('rgModal').style.display, 'none');
  assert.match($('lineMsg').textContent, /다운로드 완료.*지역: 아시아차종/);
});

test('한 시트로 합치기: 선택 지역만, 원래 VIO 순서 유지', async () => {
  const { w, $, files } = await boot();
  await w.eval('downloadAllQuote()'); await tick();
  w.document.querySelector('#rgList input[value=AM]').checked=false;
  w.document.querySelector('#rgList input[value=CN]').checked=false;
  w.document.querySelector('#rgList input[value=AM]').dispatchEvent(new w.Event('change'));
  w.document.querySelector('input[name=rgMode][value=merge]').checked=true;
  $('rgGo').click(); await tick(120);
  const { wb, name } = files[0];
  assert.deepEqual(wb.SheetNames, ['Selección']);
  assert.match(name, /asia_europa_/);
  const ws = wb.Sheets['Selección']; const cs=[];
  for (let r=9; ws['C'+r]; r++) cs.push(ws['C'+r].v);
  assert.ok(!cs.includes('CQ0003L') && !cs.includes('CE0004') && !cs.includes('CE0005'));
  assert.equal(cs[0], 'CB0001'); // VIO 1위 Versa 먼저
});

test('전체 선택 + 합치기 = 기존 전체 견적과 동일(시트 Completo·파일명·행수)', async () => {
  const { w, $, files } = await boot();
  await w.eval('downloadAllQuote()'); await tick();
  $('rgAll').click();
  w.document.querySelector('input[name=rgMode][value=merge]').checked=true;
  $('rgGo').click(); await tick(120);
  const { wb, name } = files[0];
  assert.deepEqual(wb.SheetNames, ['Completo']);
  assert.match(name, /^cotizacion_completa_(?!asia)/);
  assert.match(wb.Sheets.Completo['A3'].v, /Catálogo completo CTR/);
});

test('전체 해제 → 다운로드 버튼 비활성, Top 500은 모달 없이 즉시', async () => {
  const { w, $, files, calls } = await boot();
  await w.eval('downloadAllQuote()'); await tick();
  $('rgNone').click();
  assert.equal($('rgGo').disabled, true);
  $('rgCancel').click();
  assert.equal($('rgModal').style.display, 'none');
  await w.eval('downloadTop500()'); await tick(120);
  assert.ok(calls.some(u=>u.includes('top=500')));
  assert.deepEqual(files[0].wb.SheetNames, ['Top500']);
});

test('브랜드 → 지역 매핑 누락 없음', async () => {
  const { w } = await boot();
  const miss = w.eval('VEH.BRANDS.filter(b=>!VEH.REGION[b])');
  assert.deepEqual([...miss], []);
});
