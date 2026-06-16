/* Refatrix 글로벌 고정 네비게이션 트리 — 모든 화면 상단에 주입
   사용법: 각 화면 <body> 안에 <script src="refatrix-nav.js"></script> 추가 */
(function(){
  if(window.__refatrixNavLoaded) return; window.__refatrixNavLoaded=true;
  try{ console.log('[refatrix-nav] v20260615h loaded'); }catch(e){}

  // 화면 정의 (파일/이름/설명)
  var SCREENS={
    salesperf:{file:'refatrix-salesperf.html',name:'영업 대시보드',desc:'매출·수금·파이프라인'},
    dashboard:{file:'refatrix-dashboard.html',name:'대시보드',desc:'위젯'},
    board:{file:'refatrix-board.html',name:'일정',desc:'달력',tab:'cal'},
    boardNotice:{file:'refatrix-board.html',name:'공지',desc:'공지사항',tab:'notice'},
    boardTodo:{file:'refatrix-board.html',name:'할 일',desc:'todo',tab:'todo'},
    quote:{file:'refatrix-quote.html',name:'견적 작성',desc:'견적·매출전환'},
    quotelist:{file:'refatrix-quotelist.html',name:'견적·매출 추적',desc:'목록·전환'},
    orderfunnel:{file:'refatrix-orderfunnel.html',name:'수주 흐름 추이',desc:'즉시매출 KPI'},
    funnel:{file:'refatrix-funnel.html',name:'견적 요청',desc:'요청 SKU',tab:'quotes'},
    funnelImm:{file:'refatrix-funnel.html',name:'매출 확정 목록',desc:'발행 가능·확정',tab:'immediate'},
    funnelShort:{file:'refatrix-funnel.html',name:'부족·발주',desc:'SKU 부족',tab:'shortage'},
    funnelDev:{file:'refatrix-funnel.html',name:'개발 필요',desc:'개발요청',tab:'dev'},
    sales:{file:'refatrix-sales.html',name:'매출 등록',desc:'인보이스',tab:'sale'},
    saleslist:{file:'refatrix-sales.html',name:'매출 목록',desc:'발행 내역',tab:'list'},
    salesshort:{file:'refatrix-sales.html',name:'부족 / 주문',desc:'부족·발주 근거',tab:'short'},
    salesapprove:{file:'refatrix-sales.html',name:'매출 승인 대기',desc:'수정·삭제 승인',tab:'approve'},
    stock:{file:'refatrix-stock.html',name:'재고 이동',desc:'입출고·조정'},
    shortage:{file:'refatrix-shortage.html',name:'부족분',desc:'발주 근거'},
    devrequest:{file:'refatrix-devrequest.html',name:'개발 요청',desc:'경쟁사코드 대응'},
    pipeline:{file:'refatrix-pipeline.html',name:'영업활동',desc:'칸반·미팅'},
    customers:{file:'refatrix-customers.html',name:'고객 등록 및 목록',desc:'고객·외상·서류',tab:'list'},
    custTeam:{file:'refatrix-customers.html',name:'고객 팀권한',desc:'팀 가시성',tab:'team'},
    custApprove:{file:'refatrix-customers.html',name:'고객 수정 승인',desc:'수정 승인',tab:'approve'},
    targets:{file:'refatrix-targets.html',name:'매출목표',desc:'목표·달성'},
    finance:{file:'refatrix-finance.html',name:'재무 · 계좌',desc:'계좌·잔액',tab:'acc'},
    finNew:{file:'refatrix-finance.html',name:'거래 등록',desc:'수입·지출',tab:'new'},
    finTxn:{file:'refatrix-finance.html',name:'거래 목록',desc:'내역·수정',tab:'txn'},
    finPay:{file:'refatrix-finance.html',name:'반제(입금)',desc:'AR 수금',tab:'pay'},
    finFixed:{file:'refatrix-finance.html',name:'고정비',desc:'정기거래',tab:'fixed'},
    finCash:{file:'refatrix-finance.html',name:'현금흐름',desc:'계획vs실적',tab:'cash'},
    finFx:{file:'refatrix-finance.html',name:'환율',desc:'USD→MXN',tab:'fx'},
    finApprove:{file:'refatrix-finance.html',name:'재무 승인 대기',desc:'거래 승인',tab:'approve'},
    settlement:{file:'refatrix-settlement.html',name:'수금/정산',desc:'AR·정산차액'},
    budget:{file:'refatrix-budget.html',name:'예산',desc:'예산 계획'},
    importcost:{file:'refatrix-importcost.html',name:'수입원가',desc:'부대비용·원가'},
    import:{file:'refatrix-import.html',name:'수입 입고',desc:'배치 등록'},
    products:{file:'refatrix-products.html',name:'제품',desc:'제품·재고',tab:'find'},
    prodFind:{file:'refatrix-products.html',name:'제품 찾기',desc:'검색·경쟁사코드·차종',tab:'find'},
    prodUpload:{file:'refatrix-products.html',name:'제품 마스터 업로드',desc:'엑셀 업로드',tab:'upload'},
    marketing:{file:'refatrix-marketing.html',name:'마케팅',desc:'예산·배분'},
    rnr:{file:'refatrix-rnr.html',name:'업무 프로세스',desc:'R&R 안내'},
    users:{file:'refatrix-users.html',name:'사용자·권한',desc:'권한 관리'},
    company:{file:'refatrix-company.html',name:'회사정보',desc:'로고·계좌'},
    portal:{file:'refatrix-portal.html',name:'포털 홈',desc:'대시보드'}
  };
  // 화면 → 권한키 (배열=하나라도 있으면 표시, null=공통, __director__=디렉터)
  var PAGEKEY={
    salesperf:null, dashboard:null, board:null, portal:null, rnr:null,
    quote:['quote','sales'], quotelist:['quote','sales'], orderfunnel:['quote','sales','products','marketing'], funnel:['quote','sales','products','marketing'],
    sales:'sales', saleslist:['sales','quote'], salesshort:['shortage','sales'], salesapprove:'sales',
    stock:['stock','sales'], shortage:['shortage','sales'], devrequest:['devrequest','quote','sales','products','marketing'],
    pipeline:'pipeline', customers:'customers', custTeam:'__director__', custApprove:'__director__', targets:'targets',
    finance:'transactions', finNew:'transactions', finTxn:'transactions', finPay:'transactions', finFixed:'transactions', finCash:'transactions', finFx:'transactions', finApprove:'transactions',
    boardNotice:null, boardTodo:null,
    funnelImm:['quote','sales','products','marketing'], funnelShort:['quote','sales','products','marketing'], funnelDev:['quote','sales','products','marketing'],
    settlement:'settlement', budget:'budget', importcost:'inventory', import:'inventory',
    products:'products', prodFind:'products', prodUpload:'__director__', marketing:'marketing',
    users:'__director__', company:'__director__'
  };
  // 그룹(트리 최상위) — 공통/영업지원/영업/재무/제품·마케팅/일정/관리
  var GROUPS=[
    {key:'common', title:'공통', color:'#C9A75C', screens:['portal','salesperf','dashboard','rnr']},
    {key:'sales', title:'영업', color:'#6FA3C7', screens:['customers','targets','pipeline','quote','quotelist','funnel','orderfunnel','funnelShort','funnelImm','funnelDev','devrequest']},
    {key:'support', title:'영업지원', color:'#7FB5C9', screens:['sales','saleslist','salesshort','salesapprove','customers','stock','shortage','settlement','importcost','import']},
    {key:'finance', title:'재무', color:'#D08C6E', screens:['finance','finNew','finTxn','finPay','finFixed','finCash','finFx','finApprove','settlement','budget']},
    {key:'pm', title:'제품·마케팅', color:'#A992D6', screens:['products','devrequest','marketing','prodFind','prodUpload']},
    {key:'cal', title:'일정', color:'#7FC4A3', screens:['board','boardNotice','boardTodo']},
    {key:'admin', title:'관리', color:'#A89A84', screens:['users','company','custTeam','custApprove']}
  ];

  // 공유 화면(여러 그룹에 표시되지만, 그룹 노출 자체를 결정하진 않음)
  var SHARED={devrequest:1, orderfunnel:1, funnel:1, funnelImm:1, funnelShort:1, funnelDev:1, import:1, importcost:1, customers:1, settlement:1};

  var sess=null, sum=null, openGroup=null;
  function getSession(){
    try{ var raw=sessionStorage.getItem('refatrix_session'); if(raw){ var o=JSON.parse(raw); if(o&&o.token) return o; } }catch(e){}
    try{ var h=location.hash.slice(1); if(h){ var p=new URLSearchParams(h); var tk=p.get('token'); if(tk) return {token:tk,api:p.get('api')||'',user:{}}; } }catch(e){}
    return null;
  }
  function canSee(key){
    var pk=PAGEKEY[key];
    if(pk===null||pk===undefined) return true;
    if(!sum) return false;
    if(sum.isDirector) return true;
    if(pk==='__director__') return false;
    var have=sum.pages||[];
    if(Array.isArray(pk)) return pk.some(function(k){return have.indexOf(k)>=0;});
    return have.indexOf(pk)>=0;
  }
  // 같은 파일을 공유하는 탭-화면들의 기본 탭(해시 tab 없을 때)
  var FILE_DEFAULT_TAB={'refatrix-sales.html':'sale','refatrix-finance.html':'acc','refatrix-board.html':'cal','refatrix-funnel.html':'quotes','refatrix-customers.html':'list','refatrix-products.html':'find'};
  function curScreen(){
    var f=(location.pathname.split('/').pop()||'').toLowerCase();
    if(FILE_DEFAULT_TAB[f]){
      var tab=FILE_DEFAULT_TAB[f]; try{ var hp=new URLSearchParams(location.hash.slice(1)); tab=hp.get('tab')||FILE_DEFAULT_TAB[f]; }catch(e){}
      for(var sk in SCREENS){ if(SCREENS[sk].file.toLowerCase()===f && (SCREENS[sk].tab||FILE_DEFAULT_TAB[f])===tab) return sk; }
      // 폴백: 그 파일의 첫 화면 키
      for(var sk2 in SCREENS){ if(SCREENS[sk2].file.toLowerCase()===f) return sk2; }
    }
    for(var k in SCREENS){ if(SCREENS[k].file.toLowerCase()===f) return k; }
    return null;
  }
  function nav(key, fromGroup){
    var s=SCREENS[key]; if(!s) return;
    try{ sessionStorage.setItem('refatrix_session', JSON.stringify({token:sess.token,api:sess.api,user:(sess.user||{}),ts:Date.now()})); }catch(e){}
    var g=fromGroup||openGroup||'';
    var hash='#token='+encodeURIComponent(sess.token)+'&api='+encodeURIComponent(sess.api||'')+'&user='+encodeURIComponent(JSON.stringify(sess.user||{}))+'&g='+encodeURIComponent(g);
    if(s.tab) hash+='&tab='+encodeURIComponent(s.tab);
    location.href=s.file+hash;
  }
  window.__rnav=nav;

  // 로그아웃: 세션 정리(브리지가 복원하는 localStorage 포함) 후 로그인 화면으로
  function rnavLogout(){
    try{ sessionStorage.removeItem('refatrix_session'); }catch(e){}
    try{ localStorage.removeItem('refatrix_session'); }catch(e){}
    try{ if(window.location.hash) history.replaceState(null,'',location.pathname); }catch(e){}
    location.href='refatrix-portal.html';
  }
  window.__rnavLogout=rnavLogout;

  function styles(){
    var css=''+
    '.topbar{display:none!important}'+ /* 화면별 두 번째 헤더 제거 — 상단 트리로 통일 */
    /* 모달/오버레이는 고정 헤더(z-index:9000)보다 위로 — 닫기 버튼 가림 방지 */
    '.daymodal,.modal,.overlay,[id$="Modal"],[id$="modal"]{z-index:10001!important}'+
    '#rnav{position:fixed;top:0;left:0;right:0;z-index:9000;font-family:inherit;background:linear-gradient(180deg,#12221d 0%,#0d1a16 100%);border-bottom:1px solid rgba(201,167,92,.28);box-shadow:0 6px 22px -10px rgba(0,0,0,.55)}'+
    '#rnav .rbar{display:flex;align-items:center;padding:0 16px;height:46px}'+
    '#rnav .rbarscroll{display:flex;align-items:center;gap:2px;flex:1 1 auto;min-width:0;overflow-x:auto;white-space:nowrap;scrollbar-width:none}'+
    '#rnav .rbarscroll::-webkit-scrollbar{display:none}'+
    '#rnav .rbarright{flex:0 0 auto;display:flex;align-items:center;white-space:nowrap;padding-left:10px}'+
    '#rnav .rhome{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;margin-right:6px;border-radius:8px;color:#C9A75C;background:rgba(201,167,92,.1);border:1px solid rgba(201,167,92,.3);cursor:pointer;font-size:15px;transition:all .14s}'+
    '#rnav .rhome:hover{background:rgba(201,167,92,.22);color:#F3ECDD}'+
    '#rnav .rlogo{display:flex;align-items:center;gap:7px;color:#F3ECDD;font-weight:800;font-size:14px;letter-spacing:.04em;margin-right:14px;flex:0 0 auto}'+
    '#rnav .rlogo .dot{width:7px;height:7px;border-radius:50%;background:#C9A75C;box-shadow:0 0 8px rgba(201,167,92,.7)}'+
    '#rnav .rg{position:relative;flex:0 0 auto;padding:14px 14px;font-size:13px;font-weight:600;color:#9fb0a8;background:transparent;border:none;cursor:pointer;letter-spacing:.02em;transition:color .15s}'+
    '#rnav .rg:hover{color:#F3ECDD}'+
    '#rnav .rg.on{color:#F3ECDD;font-weight:700}'+
    '#rnav .rg.on:after{content:"";position:absolute;left:14px;right:14px;bottom:0;height:2px;border-radius:2px 2px 0 0;background:var(--ac,#C9A75C);box-shadow:0 0 10px var(--ac,#C9A75C)}'+
    '#rnav .rsub{display:none;align-items:center;gap:7px;flex-wrap:wrap;padding:9px 16px;background:linear-gradient(180deg,#0e1c18,#0c1714);border-top:1px solid rgba(255,255,255,.05)}'+
    '#rnav .rsub.show{display:flex}'+
    '#rnav .rs{flex:0 0 auto;padding:6px 12px;border-radius:999px;font-size:12px;font-weight:500;color:#c7d2cc;background:rgba(255,255,255,.05);cursor:pointer;border:1px solid rgba(255,255,255,.07);transition:all .14s}'+
    '#rnav .rs:hover{background:rgba(201,167,92,.16);border-color:rgba(201,167,92,.4);color:#F3ECDD}'+
    '#rnav .rs.cur{background:linear-gradient(180deg,#D9BE7E,#C9A75C);color:#1a1410;font-weight:800;border-color:transparent;box-shadow:0 2px 8px -2px rgba(201,167,92,.6)}'+
    '#rnav .rwho{flex:0 0 auto;color:#7f928a;font-size:11px;font-weight:500;padding-left:14px;letter-spacing:.02em}'+
    '#rnav .rwho b{color:#bcae8e;font-weight:700}'+
    '#rnav .rlogout{flex:0 0 auto;margin-left:12px;padding:5px 12px;border-radius:8px;border:1px solid rgba(208,140,110,.45);background:rgba(208,140,110,.12);color:#e3b6a3;font-size:11px;font-weight:700;cursor:pointer;transition:all .14s;font-family:inherit}'+
    '#rnav .rlogout:hover{background:rgba(208,140,110,.28);color:#fff}';
    var st=document.createElement('style'); st.textContent=css; document.head.appendChild(st);
  }
  function groupVisible(g){
    // 공유 화면을 제외한 '앵커' 화면 중 하나라도 볼 수 있으면 그룹 노출
    var anchors=g.screens.filter(function(k){return !SHARED[k];});
    if(!anchors.length) anchors=g.screens;
    return anchors.some(function(k){return SCREENS[k]&&canSee(k);});
  }
  function render(){
    var vis=GROUPS.filter(groupVisible);
    var cur=curScreen();
    // 현재 화면이 속한 그룹 자동 오픈 — 단, 트리에서 넘어올 때 지정한 그룹(g)을 우선
    if(openGroup===null){
      var hintG=null; try{ var hp=new URLSearchParams(location.hash.slice(1)); hintG=hp.get('g')||null; }catch(e){}
      if(hintG && vis.some(function(v){return v.key===hintG && v.screens.indexOf(cur)>=0;})) openGroup=hintG;
      if(openGroup===null){ for(var i=0;i<vis.length;i++){ if(vis[i].screens.indexOf(cur)>=0){ openGroup=vis[i].key; break; } } }
      if(openGroup===null&&vis[0]) openGroup=vis[0].key;
    }
    var bar='<div class="rbar"><div class="rbarscroll"><button type="button" class="rhome" title="포털 홈" onclick="__rnav(\'portal\')">⌂</button><span class="rlogo"><span class="dot"></span>Refatrix</span>';
    vis.forEach(function(g){ bar+='<button type="button" class="rg'+(g.key===openGroup?' on':'')+'" style="--ac:'+g.color+'" onclick="__rnavGroup(\''+g.key+'\')">'+g.title+'</button>'; });
    var who=(sess&&sess.user&&sess.user.name)?sess.user.name:'';
    bar+='</div><div class="rbarright"><span class="rwho">'+(who?'<b>'+who+'</b> · ':'')+(sum?(sum.role||''):'')+'</span>';
    bar+='<button type="button" class="rlogout" title="로그아웃" onclick="__rnavLogout()">로그아웃</button></div></div>';
    // 하위 화면
    var g=vis.find(function(x){return x.key===openGroup;});
    var sub='';
    if(g){ var scr=g.screens.filter(function(k){return SCREENS[k]&&canSee(k);});
      // 중복 제거
      var seen={}; scr=scr.filter(function(k){ if(seen[k])return false; seen[k]=1; return true; });
      sub='<div class="rsub show">'+scr.map(function(k){ return '<span class="rs'+(k===cur?' cur':'')+'" onclick="__rnav(\''+k+'\',\''+openGroup+'\')" title="'+(SCREENS[k].desc||'')+'">'+SCREENS[k].name+'</span>'; }).join('')+'</div>';
    }
    var el=document.getElementById('rnav');
    el.innerHTML=bar+sub;
    syncOffset();
  }
  // 고정 헤더(바+하위메뉴)의 실제 높이만큼 본문을 내려 가림 방지
  function syncOffset(){
    var el=document.getElementById('rnav'); if(!el) return;
    var h=el.offsetHeight||46;
    var base=(window.__rnavBaseTop!==undefined)?window.__rnavBaseTop:0;
    document.body.style.paddingTop=(base+h)+'px';
  }
  window.addEventListener('resize', function(){ syncOffset(); });
  // 같은 파일 내 탭 전환은 해시만 바뀌므로(페이지 미reload), 헤더를 다시 그려 현재 화면 강조(노란색)를 갱신
  window.addEventListener('hashchange', function(){ if(document.getElementById('rnav')) render(); });
  // 탭 화면이 내부 탭 전환 후 직접 호출 → 현재 화면 강조 즉시 갱신(hashchange 미발생/캐시 대비 안전장치)
  window.__rnavRefresh=function(){ if(document.getElementById('rnav')) render(); };
  // 그룹 클릭 → 해당 그룹의 첫 번째(접근 가능) 화면으로 이동. 현재 그룹이면 토글만.
  window.__rnavGroup=function(k){
    var g=null; for(var i=0;i<GROUPS.length;i++){ if(GROUPS[i].key===k){ g=GROUPS[i]; break; } }
    if(!g){ openGroup=k; render(); return; }
    var first=null; for(var j=0;j<g.screens.length;j++){ var sk=g.screens[j]; if(SCREENS[sk]&&canSee(sk)){ first=sk; break; } }
    if(first && first!==curScreen()){ nav(first, k); return; }   // 첫 화면으로 이동(그 그룹 컨텍스트 유지)
    openGroup=k; render();                                        // 이미 그 화면이면 펼치기만
  };

  function mount(){
    styles();
    // 헤더 삽입 전, 화면 고유의 본문 상단 여백을 저장(가림 방지 + 원래 여백 유지)
    try{ window.__rnavBaseTop=parseInt(getComputedStyle(document.body).paddingTop,10)||0; }catch(e){ window.__rnavBaseTop=0; }
    var nv=document.createElement('div'); nv.id='rnav';
    document.body.insertBefore(nv, document.body.firstChild);
    sess=getSession();
    if(!sess||!sess.token){ nv.innerHTML='<div class="rbar"><span class="rlogo"><span class="dot"></span>Refatrix</span><span class="rwho">로그인 필요</span></div>'; syncOffset(); return; }
    var api=(sess.api||'').replace(/\/+$/,'');
    var authFailed=false;
    fetch(api+'/api/portal/summary',{headers:{'Authorization':'Bearer '+sess.token}}).then(function(r){
      if(r.status===401||r.status===403){
        authFailed=true;
        try{ sessionStorage.removeItem('refatrix_session'); localStorage.removeItem('refatrix_session'); }catch(e){}
        var nv2=document.getElementById('rnav');
        if(nv2) nv2.innerHTML='<div class="rbar"><button type="button" class="rhome" title="포털 홈" onclick="__rnav(\'portal\')">⌂</button><span class="rlogo"><span class="dot"></span>Refatrix</span><span class="rwho">세션 만료 — 새로고침 후 다시 로그인하세요</span></div>';
        syncOffset();
        throw new Error('unauthorized');
      }
      return r.json();
    }).then(function(d){
      sum=d||{pages:[],isDirector:false}; render();
    }).catch(function(){ if(!authFailed && !sum){ sum={pages:[],isDirector:false}; render(); } });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',mount); else mount();
})();
