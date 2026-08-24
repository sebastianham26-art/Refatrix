// refatrix-customers.html 전체를 jsdom 으로 로드해 "고객 수정" 실동작을 재현
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../../refatrix-customers.html', import.meta.url), 'utf8');
const custform = readFileSync(new URL('../../refatrix-custform.js', import.meta.url), 'utf8');

const CUST = { id:7, code:'C1001', name:'REFACCIONES MTY', rfc:'RMT', contact:null, phone:'+52',
  discount:0, credit_days:15, team_id:1, team_name:'01_Monterrey_01', stage_id:6, owner_id:5,
  owner_name:'Palomino', customer_type:null, memo:null, constancia_fiscal:null, ship_address:null,
  outstanding:0, overdue:0, sales_total:0, doc_count:0, days_no_sales:1 };

function boot(role='director', crossFlag=false){
  const dom = new JSDOM(html, { runScripts:'dangerously', url:'http://localhost/', pretendToBeVisual:true });
  const w = dom.window;
  const log = [];
  const J = (o)=>({ ok:true, status:200, json:async()=>o });
  w.fetch = async (url, opt) => {
    const u=String(url), m=(opt&&opt.method)||'GET';
    log.push({u,m,body:opt&&opt.body});
    if(u.includes('/api/login')) return J({token:'tk',user:{id:1,name:'관리자',role}});
    if(u.includes('/api/me/access')) return J({role,isDirector:role==='director',access:{customers:'edit'},cross_team_request:crossFlag});
    if(u.includes('/api/teams')) return J({items:[{id:1,name:'01_Monterrey_01'},{id:2,name:'02_Merida'}]});
    if(u.includes('/api/stages')) return J({items:[{id:6,name:'06_거래중'}]});
    if(u.includes('/api/sales-users')) return J({items:[{id:5,name:'Palomino',team_id:1}]});
    if(u.includes('/api/team-admin/teams')) return J({items:[{id:1,name:'01_Monterrey_01',is_sales:true},{id:2,name:'02_Merida',is_sales:true}]});
    if(u.includes('/api/customers/stage-summary')) return J({teams:[],total:{}});
    if(u.includes('/api/customer-change-requests')) return J({items:[]});
    if(u.includes('/api/customers/lookup')) return J({items:[{id:9,code:'C2001',name:'FRENOS',rfc:'F',team_id:2,team_name:'02_Merida',owner_id:6,owner_name:'Oscar',in_scope:false,pending_change:false}]});
    if(/\/api\/customers\/(\d+)\/edit-basic/.test(u)){
      const cid=Number(u.match(/\/api\/customers\/(\d+)\/edit-basic/)[1]);
      // 7 = 내 팀 고객(바로 수정 가능) / 9 = 타팀(승인 필요) / 8 = 상대팀 열람만(보이지만 수정은 승인 필요)
      if(cid===7) return J({item:CUST,in_scope:true,cross_team:false,pending:null});
      if(cid===8) return J({item:{...CUST,id:8,team_id:2,team_name:'02_Merida',owner_id:6,owner_name:'Oscar'},in_scope:true,cross_team:true,pending:null});
      return J({item:{...CUST,id:9,team_id:2,team_name:'02_Merida',owner_id:6,owner_name:'Oscar'},in_scope:false,cross_team:true,pending:null});
    }
    if(/\/api\/customers\/\d+\/documents/.test(u)) return J({items:[]});
    if(/\/api\/customers\/\d+\/visits/.test(u)) return J({items:[]});
    if(/\/api\/customers\/\d+\/terms-history/.test(u)) return J({items:[]});
    if(/\/api\/customers\/(\d+)$/.test(u) && m==='GET'){
      const cid=Number(u.match(/\/api\/customers\/(\d+)$/)[1]);
      const c=cid===8?{...CUST,id:8,team_id:2,team_name:'02_Merida',owner_id:6,owner_name:'Oscar'}:{...CUST,id:cid};
      return J({customer:c,invoices:[],summary:{year:2026,ytd_actual:0,year_target:null},reorder_summary:null});
    }
    if(/\/api\/customers\/\d+$/.test(u) && m==='PATCH') return J({ok:true});
    if(u.includes('/ship-address')) return J({ok:true});
    if(u.includes('/api/customers?')||u.endsWith('/api/customers')) return J({items:[CUST]});
    return J({items:[]});
  };
  // custform 은 별도 <script src> 라 jsdom이 못 받아옴 → 직접 주입
  const s=w.document.createElement('script'); s.textContent=custform; w.document.body.appendChild(s);
  return { w, doc:w.document, log };
}
const wait=(ms=60)=>new Promise(r=>setTimeout(r,ms));

test('페이지 로드 시 자바스크립트 오류가 없다', async () => {
  const errs=[];
  const dom = new JSDOM(html, { runScripts:'dangerously', url:'http://localhost/',
    virtualConsole: new (await import('jsdom')).VirtualConsole().on('jsdomError', e=>errs.push(e.message)) });
  await wait(80);
  assert.deepEqual(errs, [], '로드 중 오류: '+errs.join(' | '));
  dom.window.close();
});

test('디렉터: 로그인 → 목록 → 열기 → 수정 → 저장(PATCH) 정상', async () => {
  const { w, doc, log } = boot('director');
  doc.getElementById('pin').value='729143';
  doc.getElementById('go').click();
  await wait(150);
  assert.ok(!doc.getElementById('app').classList.contains('hidden'), '로그인 후 앱이 열려야 함');
  assert.match(doc.getElementById('custList').innerHTML, /REFACCIONES MTY/, '목록 렌더');
  w.openCustomer(7); await wait(120);
  assert.ok(!doc.getElementById('detailCard').classList.contains('hidden'), '상세 열림');
  doc.getElementById('editBtn').click(); await wait(120);
  assert.ok(!doc.getElementById('custForm').classList.contains('hidden'), '수정 폼 열림');
  assert.equal(doc.getElementById('rcf-name').value, 'REFACCIONES MTY', '기존 값이 폼에 채워짐');
  assert.equal(doc.getElementById('rcf-save').textContent, '수정 저장');
  doc.getElementById('rcf-name').value='REFACCIONES MTY 2';
  log.length=0;
  doc.getElementById('rcf-save').click(); await wait(150);
  const patch=log.find(x=>x.m==='PATCH' && /\/api\/customers\/7$/.test(x.u));
  assert.ok(patch, 'PATCH /api/customers/7 이 나가야 함. 실제 호출: '+JSON.stringify(log.map(x=>x.m+' '+x.u)));
  assert.equal(JSON.parse(patch.body).name, 'REFACCIONES MTY 2');
  assert.match(doc.getElementById('rcf-msg').textContent, /수정되었습니다/);
});

test('영업(자기 팀 고객): 수정 → 승인요청 PATCH 정상', async () => {
  const { w, doc, log } = boot('sales');
  doc.getElementById('pin').value='1';
  doc.getElementById('go').click(); await wait(150);
  w.openCustomer(7); await wait(120);
  doc.getElementById('editBtn').click(); await wait(120);
  assert.equal(doc.getElementById('rcf-save').textContent, '수정 요청(디렉터 승인)');
  log.length=0;
  doc.getElementById('rcf-save').click(); await wait(150);
  assert.ok(log.find(x=>x.m==='PATCH' && /\/api\/customers\/7$/.test(x.u)), 'PATCH 나감');
});

test('권한 OFF 영업에게는 타팀 카드가 보이지 않는다', async () => {
  const { doc } = boot('sales', false);
  doc.getElementById('pin').value='1'; doc.getElementById('go').click(); await wait(150);
  assert.ok(doc.getElementById('crossCard').classList.contains('hidden'));
});

test('권한 ON 영업: 타팀 카드 노출 → 찾기 → 수정요청 폼', async () => {
  const { w, doc, log } = boot('sales', true);
  doc.getElementById('pin').value='1'; doc.getElementById('go').click(); await wait(150);
  assert.ok(!doc.getElementById('crossCard').classList.contains('hidden'), '카드 노출');
  doc.getElementById('crossQ').value='FRENOS';
  doc.getElementById('crossBtn').click(); await wait(120);
  assert.match(doc.getElementById('crossList').innerHTML, /FRENOS/);
  await w.crossEdit(9); await wait(150);
  assert.equal(doc.getElementById('rcf-save').textContent, '타팀 고객 수정 요청(디렉터 승인)');
  assert.equal(doc.getElementById('rcf-crossbox').style.display, '');
});

test('상대팀 열람만 있는 고객을 일반 목록에서 수정 → 배송지 잠기고 승인요청 모드로 열린다', async () => {
  const { w, doc, log } = boot('sales', false);
  doc.getElementById('pin').value='1';
  doc.getElementById('go').click(); await wait(150);
  w.openCustomer(8); await wait(120);
  doc.getElementById('editBtn').click(); await wait(180);
  assert.equal(doc.getElementById('rcf-crossbox').style.display, '', '안내 배너가 떠야 함');
  assert.equal(doc.getElementById('rcf-shipsave').style.display, 'none', '배송지 즉시저장 버튼이 잠겨야 함');
  assert.equal(doc.getElementById('rcf-save').textContent, '타팀 고객 수정 요청(디렉터 승인)');
  log.length=0;
  doc.getElementById('rcf-save').click(); await wait(180);
  assert.equal(log.filter(x=>x.u.includes('/ship-address')).length, 0,
    'ship-address 를 호출하면 안 됨(403 빨간 오류의 원인이었음). 호출: '+JSON.stringify(log.map(x=>x.m+" "+x.u)));
  assert.ok(log.find(x=>x.m==='PATCH' && /\/api\/customers\/8$/.test(x.u)), 'PATCH 는 나가야 함');
});
