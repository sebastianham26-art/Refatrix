import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SRC = readFileSync(new URL('../../refatrix-custform.js', import.meta.url), 'utf-8');

function boot(){
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>',
    { runScripts:'outside-only', url:'http://localhost/' });
  const w = dom.window;
  const calls = [];
  w.fetch = async (url, opt) => {
    calls.push({ url:String(url), method:(opt&&opt.method)||'GET', body:opt&&opt.body });
    const u = String(url);
    if (u.includes('/api/teams')) return { ok:true, json:async()=>({items:[{id:1,name:'01_Monterrey_01'},{id:2,name:'02_Merida'}]}) };
    if (u.includes('/api/stages')) return { ok:true, json:async()=>({items:[{id:6,name:'06_거래중'}]}) };
    if (u.includes('/api/sales-users')) return { ok:true, json:async()=>({items:[{id:5,name:'Palomino',team_id:1}]}) };
    if (u.includes('/ship-address')) return { ok:true, json:async()=>({ok:true}) };
    return { ok:true, json:async()=>({ok:true,pending:true,cross_team:true}) };
  };
  w.eval(SRC);
  return { w, calls, doc:w.document };
}

const CUST_OTHER = { id:1, code:'C2001', name:'FRENOS DEL NORTE', rfc:'FDN', contact:null, phone:'+52',
  discount:0, credit_days:30, team_id:2, team_name:'02_Merida', stage_id:6, owner_id:6, owner_name:'Oscar' };

test('타팀 모드: 안내 배너 + 버튼 문구 + 배송지 즉시저장 잠금', async () => {
  const { w, doc } = boot();
  w.RefCustForm.init({ api:'', token:'t', isDirector:false });
  await w.RefCustForm.mount('host');
  w.RefCustForm.editCustomer(CUST_OTHER, { crossTeam:true, pending:{ requested_by_name:'Oscar' } });
  assert.equal(doc.getElementById('rcf-crossbox').style.display, '');
  assert.match(doc.getElementById('rcf-crosswho').textContent, /02_Merida/);
  assert.match(doc.getElementById('rcf-crosspend').textContent, /승인 대기중/);
  assert.equal(doc.getElementById('rcf-save').textContent, '타팀 고객 수정 요청(디렉터 승인)');
  assert.equal(doc.getElementById('rcf-shipsave').style.display, 'none');
  assert.equal(w.RefCustForm.isCrossTeam(), true);
});

test('타팀 모드: 현재 담당자(타팀)가 드롭다운에 유지되어 실수로 미지정되지 않는다', async () => {
  const { w, doc } = boot();
  w.RefCustForm.init({ api:'', token:'t', isDirector:false });
  await w.RefCustForm.mount('host');
  w.RefCustForm.editCustomer(CUST_OTHER, { crossTeam:true });
  const sel = doc.getElementById('rcf-owner');
  assert.equal(sel.value, '6');
  assert.match(sel.querySelector('option[value="6"]').textContent, /Oscar/);
});

test('타팀 모드 저장: ship-address 즉시저장 호출 없이 PATCH 만 나간다', async () => {
  const { w, doc, calls } = boot();
  w.RefCustForm.init({ api:'', token:'t', isDirector:false });
  await w.RefCustForm.mount('host');
  w.RefCustForm.editCustomer(CUST_OTHER, { crossTeam:true });
  doc.getElementById('rcf-owner').value='5';
  doc.getElementById('rcf-team').value='1';
  calls.length=0;
  doc.getElementById('rcf-save').click();
  await new Promise(r=>setTimeout(r,50));
  assert.equal(calls.filter(c=>c.url.includes('/ship-address')).length, 0);
  const patch = calls.find(c=>c.method==='PATCH');
  assert.ok(patch, 'PATCH 호출됨');
  const body = JSON.parse(patch.body);
  assert.equal(body.owner_id, 5);
  assert.equal(body.team_id, 1);
  assert.match(doc.getElementById('rcf-msg').textContent, /타팀 고객 수정 요청을 보냈습니다/);
});

test('자기 팀 모드(회귀): 배너 숨김 + 배송지 즉시저장 유지', async () => {
  const { w, doc, calls } = boot();
  w.RefCustForm.init({ api:'', token:'t', isDirector:false });
  await w.RefCustForm.mount('host');
  w.RefCustForm.editCustomer({ ...CUST_OTHER, id:2, team_id:1, team_name:'01_Monterrey_01', owner_id:5, owner_name:'Palomino' });
  assert.equal(doc.getElementById('rcf-crossbox').style.display, 'none');
  assert.equal(doc.getElementById('rcf-save').textContent, '수정 요청(디렉터 승인)');
  assert.equal(doc.getElementById('rcf-shipsave').style.display, '');
  calls.length=0;
  doc.getElementById('rcf-save').click();
  await new Promise(r=>setTimeout(r,50));
  assert.equal(calls.filter(c=>c.url.includes('/ship-address')).length, 1);
});

test('신규 등록으로 돌아가면 타팀 모드가 해제된다', async () => {
  const { w, doc } = boot();
  w.RefCustForm.init({ api:'', token:'t', isDirector:false });
  await w.RefCustForm.mount('host');
  w.RefCustForm.editCustomer(CUST_OTHER, { crossTeam:true });
  await w.RefCustForm.newCustomer();
  assert.equal(w.RefCustForm.isCrossTeam(), false);
  assert.equal(doc.getElementById('rcf-crossbox').style.display, 'none');
  // 0185: 신규 등록은 항상 디렉터 승인을 거치므로 버튼 문구가 바뀌었다.
  assert.equal(doc.getElementById('rcf-save').textContent, '고객 등록 (디렉터 승인)');
  // 선점·기준품목 박스는 신규 모드에서만 열린다(타팀 수정 모드에서 새면 안 된다)
  assert.equal(doc.getElementById('rcf-claimbox').style.display, '');
  assert.equal(doc.getElementById('rcf-basebox').style.display, '');
});

// 0185 — 타팀 수정 요청 모드에서는 선점·기준품목 박스가 절대 뜨면 안 된다.
//   (수정 요청에 CONSTANCIA 필수를 걸면 기존 이관 흐름이 막힌다)
test('타팀 수정 요청 모드에서는 선점·기준품목 박스가 숨겨진다', async () => {
  const { w, doc } = boot();
  w.RefCustForm.init({ api:'', token:'t', isDirector:false });
  await w.RefCustForm.mount('host');
  w.RefCustForm.editCustomer(CUST_OTHER, { crossTeam:true });
  assert.equal(doc.getElementById('rcf-claimbox').style.display, 'none');
  assert.equal(doc.getElementById('rcf-basebox').style.display, 'none');
});
