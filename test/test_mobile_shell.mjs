// 모바일 셸 1단계 — Chromium 실렌더 검증 (값이 아니라 "화면에 들어가는가"를 잰다)
import { chromium } from 'playwright';
const SUM={isDirector:false,role:'sales',name:'Oscar',pages:['quote','sales','customers','pipeline','targets','shortage','devrequest','stock','commission'],badges:{}};
const SUM_DIR={isDirector:true,role:'director',name:'Sebastian',pages:[],badges:{}};
const PAGES=[['refatrix-customers.html','고객관리'],['refatrix-pipeline.html','영업활동'],['refatrix-quote.html','견적작성'],
             ['refatrix-quotelist.html','견적추적'],['refatrix-fieldsurvey.html','현장조사'],['refatrix-board.html','일정'],['refatrix-portal.html','포털']];
const VPS=[['iPhone',390,664],['Android',360,600],['소형',320,568],['태블릿',768,900]];
let pass=0, fail=0; const F=[];
const ok=(c,m)=>{ c?pass++:(fail++,F.push(m)); };
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
async function open(file,{w,h,sum=SUM,pref=null}){
  const ctx=await b.newContext({viewport:{width:w,height:h}});
  const p=await ctx.newPage();
  await p.route('**/api/**',r=>r.fulfill({status:200,contentType:'application/json',body:r.request().url().includes('portal/summary')?JSON.stringify(sum):'{}'}));
  await p.addInitScript(([pf])=>{ sessionStorage.setItem('refatrix_session',JSON.stringify({token:'t',api:'https://x',user:{name:'Oscar',login_id:'oscar'}})); if(pf) localStorage.setItem('rfx_m',pf); else localStorage.removeItem('rfx_m'); },[pref]);
  await p.goto('file://'+process.cwd()+'/'+file,{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(900);
  return {ctx,p};
}
const M=p=>p.evaluate(()=>{const n=document.getElementById('rnav'),t=document.getElementById('rmtab'),de=document.documentElement;
  const r=e=>e?e.getBoundingClientRect():null; const nb=r(n),tb=r(t);
  const small=[...document.querySelectorAll('input,select,textarea')].filter(i=>(parseFloat(getComputedStyle(i).fontSize)||16)<16).length;
  // 하단 탭바 히트테스트: 각 탭 중앙에서 실제로 잡히는 요소가 그 탭인가
  let hit=true;
  if(tb){ for(const btn of t.querySelectorAll('.mt')){ const q=btn.getBoundingClientRect();
    const el=document.elementFromPoint(q.left+q.width/2, q.top+q.height/2); if(!el||!t.contains(el)) hit=false; } }
  return {mob:de.classList.contains('rfxm'), navH:nb?Math.round(nb.height):0, pad:Math.round(parseFloat(getComputedStyle(document.body).paddingTop)||0),
    padB:getComputedStyle(document.body).paddingBottom, tab:!!t, tabH:tb?Math.round(tb.height):0, tabN:t?t.querySelectorAll('.mt').length:0,
    tabBottom:tb?Math.round(tb.bottom):0, hit, small, vh:innerHeight,
    ovf:(function(){var se=document.scrollingElement,b=se.scrollLeft;se.scrollLeft=9999;var c=se.scrollLeft;se.scrollLeft=b;return c;})(),
    subNowrap:n&&n.querySelector('.rsub')?getComputedStyle(n.querySelector('.rsub')).flexWrap:'-',
    tgl:!!document.getElementById('rmTgl'), tglVis:(()=>{const e=document.getElementById('rmTgl');return e?getComputedStyle(e).display!=='none':false;})()};});

// A. 모바일 자동감지 — 화면 4종 × 페이지 7종
for(const [vl,w,h] of VPS){ for(const [f,name] of PAGES){
  const {ctx,p}=await open(f,{w,h}); const m=await M(p);
  const tag=`${vl} ${name}`;
  ok(m.mob, `${tag}: 모바일 모드 자동 적용 안 됨`);
  ok(m.navH<=95, `${tag}: 헤더 ${m.navH}px > 95px`);
  ok(m.subNowrap!=='wrap', `${tag}: 하위메뉴가 여전히 줄바꿈`);
  var use=h-m.pad-m.tabH;
  ok(use/h>=0.66, `${tag}: 본문 가용 ${use}px (화면의 ${Math.round(use/h*100)}%) < 66%`);
  ok(m.small===0, `${tag}: 16px 미만 입력칸 ${m.small}개 (iOS 자동확대)`);
  ok(m.ovf===0, `${tag}: 좌우로 흔들림(가로 스크롤 ${m.ovf}px)`);
  ok(m.tab && m.tabN===5, `${tag}: 하단 탭바 5칸 아님(${m.tabN})`);
  ok(m.hit, `${tag}: 하단 탭 히트테스트 실패(다른 요소가 가림)`);
  ok(Math.abs(m.tabBottom-h)<=2, `${tag}: 탭바가 화면 하단에 안 붙음(${m.tabBottom}/${h})`);
  ok(m.padB.indexOf('58px')>=0||parseFloat(m.padB)>=58, `${tag}: 본문 하단 여백 부족 → 탭바가 내용 가림(${m.padB})`);
  await ctx.close();
}}
// B. 데스크톱 회귀 — 1280×900 에서 아무것도 바뀌지 않아야 한다
for(const [f,name] of PAGES){
  const {ctx,p}=await open(f,{w:1280,h:900}); const m=await M(p);
  ok(!m.mob, `데스크톱 ${name}: 모바일 모드가 잘못 켜짐`);
  ok(!m.tab, `데스크톱 ${name}: 하단 탭바가 노출됨`);
  ok(m.subNowrap==='wrap'||m.subNowrap==='-', `데스크톱 ${name}: 하위메뉴 줄바꿈이 바뀜`);
  ok(!m.tglVis, `데스크톱 ${name}: 모바일 토글 버튼이 노출됨`);
  ok(m.ovf===0, `데스크톱 ${name}: 가로 넘침 발생 ${m.ovf}px`);
  await ctx.close();
}
// C. 저장 선택 > 자동감지 (양방향)
{ const {ctx,p}=await open('refatrix-customers.html',{w:390,h:664,pref:'off'}); const m=await M(p);
  ok(!m.mob,'강제 전체보기(off): 모바일 모드가 꺼지지 않음'); ok(!m.tab,'강제 off: 탭바가 남음');
  ok(m.tglVis,'강제 off: 되돌아올 토글 버튼이 안 보임(모바일 복귀 불가)'); await ctx.close(); }
{ const {ctx,p}=await open('refatrix-customers.html',{w:1280,h:900,pref:'on'}); const m=await M(p);
  ok(m.mob,'강제 모바일(on): 데스크톱 폭에서 적용 안 됨'); ok(m.tab,'강제 on: 탭바 없음'); await ctx.close(); }
// D. 토글 왕복 + localStorage 기억
{ const {ctx,p}=await open('refatrix-customers.html',{w:390,h:664});
  await p.click('#rmTgl'); await p.waitForTimeout(200); let m=await M(p);
  ok(!m.mob,'토글 1회: 전체보기로 안 바뀜');
  ok(await p.evaluate(()=>localStorage.getItem('rfx_m'))==='off','토글 1회: localStorage 미기록');
  await p.click('#rmTgl'); await p.waitForTimeout(200); m=await M(p);
  ok(m.mob,'토글 2회: 모바일로 복귀 안 됨'); ok(m.tab&&m.navH<=95,'토글 2회: 헤더/탭바 복원 안 됨');
  await ctx.close(); }
// E. 전체메뉴 시트
{ const {ctx,p}=await open('refatrix-customers.html',{w:390,h:664});
  await p.click('#rmtab .mmore'); await p.waitForTimeout(250);
  const d=await p.evaluate(()=>{const d=document.getElementById('rmdrawer');
    return {show:d.classList.contains('show'), items:d.querySelectorAll('.di').length, groups:d.querySelectorAll('.gt').length,
      cur:d.querySelectorAll('.di.cur').length, inView:[...d.querySelectorAll('.di')].every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>=40;})};});
  ok(d.show,'시트: 안 열림'); ok(d.items>=10,`시트: 항목 ${d.items}개 (영업 권한 화면 누락)`);
  ok(d.groups>=2,'시트: 그룹 구분 없음'); ok(d.cur===1,'시트: 현재 화면 표시 없음'); ok(d.inView,'시트: 탭 타깃 40px 미만');
  await p.click('#rmdrawer .dx'); await p.waitForTimeout(200);
  ok(await p.evaluate(()=>!document.getElementById('rmdrawer').classList.contains('show')),'시트: ✕ 로 안 닫힘');
  await p.click('#rmtab .mmore'); await p.waitForTimeout(200);
  await p.evaluate(()=>document.getElementById('rmdrawer').click());  // 배경 탭
  await p.waitForTimeout(200);
  ok(await p.evaluate(()=>!document.getElementById('rmdrawer').classList.contains('show')),'시트: 배경 탭으로 안 닫힘');
  await ctx.close(); }
// F. 역할별 탭 구성 (창고/디렉터)
{ const {ctx,p}=await open('refatrix-portal.html',{w:390,h:664,sum:{...SUM,role:'warehouse',pages:['warehouse']}});
  const k=await p.evaluate(()=>[...document.querySelectorAll('#rmtab .mt .l')].map(e=>e.textContent));
  ok(k.length===5,`창고 역할: 탭 ${k.length}칸`); await ctx.close(); }
{ const {ctx,p}=await open('refatrix-portal.html',{w:390,h:664,sum:SUM_DIR});
  const k=await p.evaluate(()=>[...document.querySelectorAll('#rmtab .mt')].length);
  ok(k===5,`디렉터: 탭 ${k}칸`); await ctx.close(); }
await b.close();
console.log(`\n${pass}/${pass+fail} 통과`);
F.forEach(x=>console.log('  ✗ '+x));
process.exit(fail?1:0);
