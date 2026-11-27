// =====================================================================
// vehicle_map_front.test.mjs — 2026-11-27 · 제품 찾기 상단 토글 + 차종으로 제품찾기(차량 도면) 화면 (jsdom)
//   토글 · 기억 · 딥링크 · 도면 마커(재고 있음/창고 0/경쟁사만) · 자리 선택 · 무리 칩 · 경쟁사 끄기
//   CTR 코드 OE 툴팁 · 사진 팝업(CTR · SYD) · 키보드 선택 · 「제품 상세 보기」 → 제품검색
//   실행: node test/vehicle_map_front.test.mjs
// =====================================================================
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const P_HTML = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'refatrix-products.html');
import assert from 'node:assert/strict';
const html=fs.readFileSync(P_HTML,'utf8');
const b64=(o)=>Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/,'');
const tok='x.'+b64({sub:1,exp:Math.floor(Date.now()/1000)+3600})+'.y';
const VM={vehicle:{maker:'NISSAN',model:'Versa',year:2015},
 items:[
  {id:1,code:'CB0165',name:'ROTULA INFERIOR',cat:'ball',syd:['SYD1'],baw:['BW1'],oe:['40160-3AN0A'],pos:{blocks:['front'],levels:['lower'],sides:['lh'],src:'erp'},stock_qty:12,transit_qty:200,transit_eta:'2026-12-20',backorder_qty:0,sold_qty:1860,racks:[{rack:'A-03-2',qty:12}]},
  {id:2,code:'CR0074',name:'TERMINAL INTERIOR',cat:'rack',syd:['SYD2'],baw:[],oe:[],pos:{blocks:['front'],levels:[],sides:[],src:'vehicle'},stock_qty:0,transit_qty:0,transit_eta:null,backorder_qty:30,sold_qty:5,racks:[]},
  {id:3,code:'CV0012',name:'BUJE',cat:'bush',syd:[],baw:[],oe:[],pos:null,stock_qty:3,transit_qty:0,backorder_qty:0,sold_qty:0,racks:[]}],
 competitors:[{row_no:9,cat:'link',descripcion:'TORNILLO ESTABILIZADOR TRASERO',syd:['SYD9'],baw:['BW9'],pos:{blocks:['rear'],levels:[],sides:[],src:'xref'},aplicacion:'Versa 12-19',year_known:true,ubicacion:null}],
 counts:{ctr:3,ctr_in_stock:2,ctr_placed:2,competitors:1}};
const calls=[];
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,url:'https://erp.refatrix.com/refatrix-products.html',
 beforeParse(w){
  w.sessionStorage.setItem('refatrix_session',JSON.stringify({token:tok,api:'https://api.test',user:{name:'Dir',role:'director'}}));
  w.localStorage.removeItem('refatrix_find_mode');
  w.scrollTo=()=>{}; w.HTMLElement.prototype.scrollIntoView=function(){};
  w.fetch=async(u,o)=>{ calls.push(String(u)); const j=(x)=>({ok:true,status:200,json:async()=>x,text:async()=>JSON.stringify(x),blob:async()=>null});
   if(u.includes('/api/products/vehicle-map')) return j(VM);
   if(u.includes('/app-makers')) return j({items:['NISSAN','TOYOTA']});
   if(u.includes('/app-models')) return j({items:['Versa','Sentra']});
   if(u.includes('/app-years')) return j({items:[2019,2015]});
   if(u.includes('/api/products?')||u.includes('/api/products/search')) return j({items:[],total:0});
   return j({items:[]}); };
 }});
const w=dom.window, d=w.document;
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const t=async(n,f)=>{try{await f();console.log('PASS',n)}catch(e){console.log('FAIL',n,e.stack.split('\n').slice(0,3).join(' | '));process.exitCode=1}};
w.addEventListener('error',e=>console.log('JSERR',e.message));
await sleep(400);
await t('토글 — 기본 제품검색, 차종 카드 숨김',()=>{
  assert.ok(!d.getElementById('findToggle').classList.contains('hidden'));
  assert.ok(!d.getElementById('searchCard').classList.contains('hidden'));
  assert.ok(d.getElementById('vehCard').classList.contains('hidden'));});
await t('토글 → 차종 · 기억',()=>{
  d.getElementById('fmVeh').click();
  assert.ok(d.getElementById('searchCard').classList.contains('hidden'));
  assert.ok(!d.getElementById('vehCard').classList.contains('hidden'));
  assert.equal(d.getElementById('fmVeh').getAttribute('aria-selected'),'true');
  assert.equal(w.localStorage.getItem('refatrix_find_mode'),'veh');});
await t('모델 없으면 안내',async()=>{ d.getElementById('vehBtn').click(); await sleep(20);
  assert.match(d.getElementById('vehResult').textContent,/메이커와 모델/); });
await t('조회 → 도면 마커 · 목록 · 상세',async()=>{
  const mk=d.getElementById('veh-maker'); mk.value='NISSAN';
  const mo=d.getElementById('veh-model'); mo.innerHTML='<option value="Versa">Versa</option>'; mo.value='Versa';
  const yr=d.getElementById('veh-year'); yr.innerHTML='<option value="2015">2015</option>'; yr.value='2015';
  d.getElementById('vehBtn').click(); await sleep(50);
  assert.ok(calls.some(u=>u.includes('vehicle-map?maker=NISSAN&model=Versa&year=2015')));
  const m=[...d.querySelectorAll('.vm-mk')];
  // ball front lower lh(1) + rack front 좌우(2) + comp link rear 좌우(2) = 5
  assert.equal(m.length,5,'마커 5');
  assert.equal(d.querySelectorAll('.vm-mk.zero').length,2,'재고0 랙엔드 양쪽');
  assert.equal(d.querySelectorAll('.vm-mk.comp').length,2,'경쟁사만 양쪽');
  assert.equal(d.querySelectorAll('.vm-row').length,4,'목록 4 (위치 미지정 포함)');
  assert.match(d.querySelector('.vm-list').textContent,/위치 미지정/);
  const det=d.querySelector('.vm-det').textContent;
  assert.match(det,/ROTULA INFERIOR/); assert.match(det,/앞·하·좌/);
  assert.match(det,/1,860/); assert.match(det,/A-03-2/);
  assert.ok(d.querySelector('.vm-det .vm-code .tip').textContent.includes('40160-3AN0A'),'OE 툴팁');
  assert.equal(d.querySelector('.vm-det .vm-qty').getAttribute('translate'),'no');
  assert.ok(d.querySelector('.vm-det .vm-qty svg'),'아이콘');
});
await t('마커 클릭 → 그 자리만 · 전체 보기',async()=>{
  d.querySelector('.vm-mk.comp').click(); await sleep(10);
  assert.equal(d.querySelectorAll('.vm-row').length,1);
  assert.match(d.querySelector('.vm-det').textContent,/CTR 카탈로그에 없음/);
  assert.match(d.querySelector('.vm-det').textContent,/BW9/);
  assert.ok(d.querySelector('.vm-det .vm-codes .vm-code[data-syd="SYD9"]'),'SYD 코드 버튼');
  d.getElementById('vmClear').click(); await sleep(10);
  assert.equal(d.querySelectorAll('.vm-row').length,4);});
await t('무리 칩 · 경쟁사 끄기',async()=>{
  d.querySelector('.vm-chip[data-cat="rack"]').click(); await sleep(10);
  assert.equal(d.querySelectorAll('.vm-mk').length,2);
  d.querySelector('.vm-chip[data-cat=""]').click(); await sleep(10);
  const cb=d.getElementById('vmComp'); cb.checked=false; cb.dispatchEvent(new w.Event('change')); await sleep(10);
  assert.equal(d.querySelectorAll('.vm-mk.comp').length,0); assert.equal(d.querySelectorAll('.vm-row').length,3);
  const cb2=d.getElementById('vmComp'); cb2.checked=true; cb2.dispatchEvent(new w.Event('change')); await sleep(10);});
await t('CTR 코드 클릭 → 사진 팝업 · SYD 사진',async()=>{
  [...d.querySelectorAll('.vm-row')].find(r=>r.textContent.includes('ROTULA')).click(); await sleep(10);
  d.querySelector('.vm-det .vm-code[data-ctr="CB0165"]').click(); await sleep(10);
  const ov=d.getElementById('pmOv'); assert.ok(ov,'모달');
  assert.match(ov.textContent,/CB0165/); assert.match(ov.textContent,/SYD1/);
  d.getElementById('pmX').click(); assert.ok(!d.getElementById('pmOv'));
  d.querySelector('.vm-mk.comp').click(); await sleep(10);
  d.querySelector('.vm-det .vm-code[data-syd="SYD9"]').click(); await sleep(10);
  assert.match(d.getElementById('pmOv').textContent,/제품 사진 · SYD9/);
  d.getElementById('pmX').click();});
await t('행 클릭 선택 · 키보드',async()=>{
  d.getElementById('vmClear')&&d.getElementById('vmClear').click(); await sleep(10);
  const row=[...d.querySelectorAll('.vm-row')].find(r=>r.textContent.includes('TERMINAL INTERIOR'));
  row.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true})); await sleep(10);
  assert.match(d.querySelector('.vm-det').textContent,/TERMINAL INTERIOR/);
  assert.match(d.querySelector('.vm-det').textContent,/장착위치: 앞 /);});
await t('제품 상세 보기 → 제품검색으로 코드 검색',async()=>{
  d.getElementById('vmDrill').click(); await sleep(20);
  assert.ok(!d.getElementById('searchCard').classList.contains('hidden'));
  assert.equal(d.getElementById('q').value,'CR0074');
  assert.equal(w.localStorage.getItem('refatrix_find_mode'),'search');});
await t('딥링크 mode=veh',async()=>{
  w.location.hash='#tab=find&mode=veh'; await sleep(30);
  assert.ok(!d.getElementById('vehCard').classList.contains('hidden'));});
await t('업로드 탭이면 토글 숨김',async()=>{
  w.location.hash='#tab=history'; await sleep(30);
  assert.ok(d.getElementById('findToggle').classList.contains('hidden'));
  assert.ok(d.getElementById('vehCard').classList.contains('hidden'));});
process.exit(process.exitCode||0);
