/* Refatrix 글로벌 고정 네비게이션 트리 — 모든 화면 상단에 주입
   사용법: 각 화면 <body> 안에 <script src="refatrix-nav.js"></script> 추가 */
(function(){
  if(window.__refatrixNavLoaded) return; window.__refatrixNavLoaded=true;

  // 화면 정의 (파일/이름/설명)
  var SCREENS={
    salesperf:{file:'refatrix-salesperf.html',name:'영업 대시보드',desc:'매출·수금·파이프라인'},
    dashboard:{file:'refatrix-dashboard.html',name:'대시보드',desc:'위젯'},
    board:{file:'refatrix-board.html',name:'일정·공지·할 일',desc:'달력·공지'},
    quote:{file:'refatrix-quote.html',name:'견적 작성',desc:'견적·매출전환'},
    quotelist:{file:'refatrix-quotelist.html',name:'견적·매출 추적',desc:'목록·전환'},
    orderfunnel:{file:'refatrix-orderfunnel.html',name:'수주 흐름 추이',desc:'즉시매출 KPI'},
    funnel:{file:'refatrix-funnel.html',name:'수주 흐름 세부',desc:'드릴다운'},
    sales:{file:'refatrix-sales.html',name:'매출 등록',desc:'인보이스'},
    stock:{file:'refatrix-stock.html',name:'재고 이동',desc:'입출고·조정'},
    shortage:{file:'refatrix-shortage.html',name:'부족분',desc:'발주 근거'},
    devrequest:{file:'refatrix-devrequest.html',name:'개발 요청',desc:'경쟁사코드 대응'},
    pipeline:{file:'refatrix-pipeline.html',name:'영업활동',desc:'칸반·미팅'},
    customers:{file:'refatrix-customers.html',name:'고객',desc:'고객·외상'},
    targets:{file:'refatrix-targets.html',name:'매출목표',desc:'목표·달성'},
    finance:{file:'refatrix-finance.html',name:'재무',desc:'거래·캐시플로'},
    settlement:{file:'refatrix-settlement.html',name:'수금/정산',desc:'AR·정산차액'},
    budget:{file:'refatrix-budget.html',name:'예산',desc:'예산 계획'},
    importcost:{file:'refatrix-importcost.html',name:'수입원가',desc:'부대비용·원가'},
    import:{file:'refatrix-import.html',name:'수입 입고',desc:'배치 등록'},
    products:{file:'refatrix-products.html',name:'제품',desc:'제품·재고'},
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
    sales:'sales', stock:['stock','sales'], shortage:['shortage','sales'], devrequest:['devrequest','quote','sales','products','marketing'],
    pipeline:'pipeline', customers:'customers', targets:'targets',
    finance:'transactions', settlement:'settlement', budget:'budget', importcost:'inventory', import:'inventory',
    products:'products', marketing:'marketing',
    users:'__director__', company:'__director__'
  };
  // 그룹(트리 최상위) — 공통/영업지원/영업/재무/제품·마케팅/일정/관리
  var GROUPS=[
    {key:'common', title:'공통', color:'#C9A75C', screens:['portal','salesperf','dashboard','rnr']},
    {key:'sales', title:'영업', color:'#6FA3C7', screens:['quote','quotelist','orderfunnel','funnel','pipeline','customers','targets','devrequest']},
    {key:'support', title:'영업지원', color:'#7FB5C9', screens:['sales','stock','shortage','settlement','importcost','import']},
    {key:'finance', title:'재무', color:'#D08C6E', screens:['finance','settlement','budget','importcost']},
    {key:'pm', title:'제품·마케팅', color:'#A992D6', screens:['products','devrequest','marketing']},
    {key:'cal', title:'일정', color:'#7FC4A3', screens:['board']},
    {key:'admin', title:'관리', color:'#A89A84', screens:['users','company']}
  ];

  // 공유 화면(여러 그룹에 표시되지만, 그룹 노출 자체를 결정하진 않음)
  var SHARED={devrequest:1, orderfunnel:1, funnel:1, settlement:1, importcost:1, import:1};

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
  function curScreen(){
    var f=(location.pathname.split('/').pop()||'').toLowerCase();
    for(var k in SCREENS){ if(SCREENS[k].file.toLowerCase()===f) return k; }
    return null;
  }
  function nav(key){
    var s=SCREENS[key]; if(!s) return;
    try{ sessionStorage.setItem('refatrix_session', JSON.stringify({token:sess.token,api:sess.api,user:(sess.user||{}),ts:Date.now()})); }catch(e){}
    var hash='#token='+encodeURIComponent(sess.token)+'&api='+encodeURIComponent(sess.api||'')+'&user='+encodeURIComponent(JSON.stringify(sess.user||{}));
    location.href=s.file+hash;
  }
  window.__rnav=nav;

  function styles(){
    var css=''+
    '#rnav{position:sticky;top:0;z-index:9000;font-family:inherit;background:linear-gradient(180deg,#12221d 0%,#0d1a16 100%);border-bottom:1px solid rgba(201,167,92,.28);box-shadow:0 6px 22px -10px rgba(0,0,0,.55)}'+
    '#rnav .rbar{display:flex;align-items:center;gap:2px;padding:0 16px;height:46px;overflow-x:auto;white-space:nowrap;scrollbar-width:none}'+
    '#rnav .rbar::-webkit-scrollbar{display:none}'+
    '#rnav .rlogo{display:flex;align-items:center;gap:7px;color:#F3ECDD;font-weight:800;font-size:14px;letter-spacing:.04em;margin-right:16px;flex:0 0 auto}'+
    '#rnav .rlogo .dot{width:7px;height:7px;border-radius:50%;background:#C9A75C;box-shadow:0 0 8px rgba(201,167,92,.7)}'+
    '#rnav .rg{position:relative;flex:0 0 auto;padding:14px 14px;font-size:13px;font-weight:600;color:#9fb0a8;background:transparent;border:none;cursor:pointer;letter-spacing:.02em;transition:color .15s}'+
    '#rnav .rg:hover{color:#F3ECDD}'+
    '#rnav .rg.on{color:#F3ECDD;font-weight:700}'+
    '#rnav .rg.on:after{content:"";position:absolute;left:14px;right:14px;bottom:0;height:2px;border-radius:2px 2px 0 0;background:var(--ac,#C9A75C);box-shadow:0 0 10px var(--ac,#C9A75C)}'+
    '#rnav .rsub{display:none;align-items:center;gap:7px;flex-wrap:wrap;padding:9px 16px;background:rgba(255,255,255,.035);border-top:1px solid rgba(255,255,255,.06)}'+
    '#rnav .rsub.show{display:flex}'+
    '#rnav .rs{flex:0 0 auto;padding:6px 12px;border-radius:999px;font-size:12px;font-weight:500;color:#c7d2cc;background:rgba(255,255,255,.05);cursor:pointer;border:1px solid rgba(255,255,255,.07);transition:all .14s}'+
    '#rnav .rs:hover{background:rgba(201,167,92,.16);border-color:rgba(201,167,92,.4);color:#F3ECDD}'+
    '#rnav .rs.cur{background:linear-gradient(180deg,#D9BE7E,#C9A75C);color:#1a1410;font-weight:800;border-color:transparent;box-shadow:0 2px 8px -2px rgba(201,167,92,.6)}'+
    '#rnav .rwho{margin-left:auto;flex:0 0 auto;color:#7f928a;font-size:11px;font-weight:500;padding-left:14px;letter-spacing:.02em}'+
    '#rnav .rwho b{color:#bcae8e;font-weight:700}';
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
    // 현재 화면이 속한 그룹 자동 오픈
    if(openGroup===null){ for(var i=0;i<vis.length;i++){ if(vis[i].screens.indexOf(cur)>=0){ openGroup=vis[i].key; break; } } if(openGroup===null&&vis[0]) openGroup=vis[0].key; }
    var bar='<div class="rbar"><span class="rlogo"><span class="dot"></span>Refatrix</span>';
    vis.forEach(function(g){ bar+='<button type="button" class="rg'+(g.key===openGroup?' on':'')+'" style="--ac:'+g.color+'" onclick="__rnavGroup(\''+g.key+'\')">'+g.title+'</button>'; });
    var who=(sess&&sess.user&&sess.user.name)?sess.user.name:'';
    bar+='<span class="rwho">'+(who?'<b>'+who+'</b> · ':'')+(sum?(sum.role||''):'')+'</span></div>';
    // 하위 화면
    var g=vis.find(function(x){return x.key===openGroup;});
    var sub='';
    if(g){ var scr=g.screens.filter(function(k){return SCREENS[k]&&canSee(k);});
      // 중복 제거
      var seen={}; scr=scr.filter(function(k){ if(seen[k])return false; seen[k]=1; return true; });
      sub='<div class="rsub show">'+scr.map(function(k){ return '<span class="rs'+(k===cur?' cur':'')+'" onclick="__rnav(\''+k+'\')" title="'+(SCREENS[k].desc||'')+'">'+SCREENS[k].name+'</span>'; }).join('')+'</div>';
    }
    var el=document.getElementById('rnav');
    el.innerHTML=bar+sub;
  }
  window.__rnavGroup=function(k){ openGroup=k; render(); };

  function mount(){
    styles();
    var nv=document.createElement('div'); nv.id='rnav';
    document.body.insertBefore(nv, document.body.firstChild);
    sess=getSession();
    if(!sess||!sess.token){ nv.innerHTML='<div class="rbar"><span class="rlogo">Refatrix</span><span class="rwho">로그인 필요</span></div>'; return; }
    var api=(sess.api||'').replace(/\/+$/,'');
    fetch(api+'/api/portal/summary',{headers:{'Authorization':'Bearer '+sess.token}}).then(function(r){return r.json();}).then(function(d){
      sum=d||{pages:[],isDirector:false}; render();
    }).catch(function(){ sum={pages:[],isDirector:false}; render(); });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',mount); else mount();
})();
