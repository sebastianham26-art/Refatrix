/* =====================================================================
 * refatrix-vehiclemap.js — 차종으로 제품찾기(차량 하부 도면) 공용 모듈 · 2026-11-27f · 27g(메이커 → 연식 → 모델) · 27h(플랫폼 신규 차종 🆕)
 *   쓰는 화면: 제품마케팅 › 제품(refatrix-products.html · 보기) · 견적(refatrix-quote.html · 담기)
 *   API: GET /api/products/app-makers · app-models · app-years · vehicle-map (quote · products · sales 화면 권한)
 *
 *   RefatrixVehicleMap.create({
 *     els:{maker, model, year, btn, result},   // 화면이 가진 select · 버튼 · 결과 칸
 *     api:()=>'https://…', headers:()=>({Authorization:'Bearer …'}),
 *     mode:'browse' | 'pick',
 *     onDetail(code)        — browse: 「제품 상세 보기」
 *     onPick({code, product_id, brand, qty, item}) — pick: 견적에 담기
 *     inQuote({code, product_id}) → 이미 담긴 수량(배지)
 *     ready() → true | '안내 문구'   — pick: 담기 가능 여부(예: 고객 미선택)
 *     openPhoto(ctr, syd)   — 없으면 내장 사진 창
 *   }) → { search, loadMakers, render, data }
 *
 *   담기 규칙(견적 화면의 기존 흐름 그대로)
 *     CTR 부품   → {code: CTR, product_id} — 재고가 모자라면 견적 미리보기 · 저장이 재고부족분으로 기록
 *     경쟁사만   → {code: SYD 또는 BAW, brand} — CTR 미매칭 줄 → 저장 시 개발요청(입력 브랜드)로 기록
 * ===================================================================== */
(function(){
  'use strict';
  if(window.RefatrixVehicleMap) return;
  var CSS='  /* ── 2026-11-27 · 차종으로 제품찾기(차량 도면) — 밝은 북유럽 매장 톤: 파랑 · 노랑 · 흰 바탕 · 둥근 알약 버튼 ── */\n  .vm-toggle{display:flex;gap:6px;margin-top:16px;background:#fff;border:1px solid #DFDFDF;border-radius:64px;padding:5px;width:max-content;max-width:100%;flex-wrap:wrap}\n  .vm-tg{border:0;background:transparent;color:#111;border-radius:64px;padding:11px 22px;min-height:44px;font:inherit;font-size:14px;font-weight:700;cursor:pointer}\n  .vm-tg:hover{background:#F5F5F5}\n  .vm-tg[aria-selected="true"]{background:#0058A3;color:#fff}\n  .vm-tg:focus-visible,.vm-btn:focus-visible,.vm .vm-chip:focus-visible,.vm .vm-mk:focus-visible,.vm .vm-row:focus-visible{outline:3px solid #FFDB00;outline-offset:2px}\n  .vm{font-family:\'Noto Sans KR\',\'IBM Plex Sans KR\',system-ui,sans-serif;color:#111;border:0;border-radius:4px;padding:28px}\n  .vm .vm-head h2{margin:0;font-size:24px;font-weight:700;color:#111;letter-spacing:-.3px}\n  .vm .vm-sub{margin-top:6px;font-size:13px;color:#484848;line-height:1.55;max-width:760px}\n  .vm .vm-sel{display:flex;gap:12px;flex-wrap:wrap;margin-top:18px;align-items:flex-end}\n  .vm .vm-sel>div{flex:1;min-width:150px}\n  .vm .vm-sel label{font-size:12px;color:#484848;font-weight:700;margin:0 0 6px}\n  .vm .vm-sel select{width:100%;min-height:48px;border:1px solid #929292;border-radius:4px;padding:0 12px;font:inherit;font-size:14px;background:#fff;color:#111}\n  .vm .vm-sel select:focus{outline:2px solid #0058A3;outline-offset:0;border-color:#0058A3}\n  .vm .vm-go{flex:0 0 auto!important;min-width:0!important}\n  .vm-btn{border:0;border-radius:64px;background:#0058A3;color:#fff;font:inherit;font-weight:700;font-size:14px;padding:0 30px;min-height:48px;cursor:pointer}\n  .vm-btn:hover{background:#004F93}\n  .vm-btn.ghost{background:#fff;color:#111;border:1px solid #111}\n  .vm-btn.ghost:hover{background:#F5F5F5}\n  .vm-btn.sm{min-height:36px;padding:0 16px;font-size:12.5px}\n  .vm .vm-sum{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0 4px;align-items:center}\n  .vm .vm-pill{display:inline-flex;align-items:center;gap:8px;background:#F5F5F5;border-radius:64px;padding:8px 16px;font-size:13px;color:#111}\n  .vm .vm-pill b{font-size:17px}\n  .vm .vm-pill.yel{background:#FFDB00}\n  .vm .vm-veh{font-size:20px;font-weight:700;margin-right:6px}\n  .vm .vm-body{display:flex;gap:22px;flex-wrap:wrap;align-items:flex-start;margin-top:14px}\n  .vm .vm-draw{flex:999 1 470px;min-width:0;background:#F5F5F5;border-radius:4px;padding:18px}\n  .vm .vm-side{flex:1 1 380px;min-width:0;display:flex;flex-direction:column;gap:14px}\n  .vm .vm-chips{display:flex;gap:6px;flex-wrap:wrap}\n  .vm .vm-chip{border:1px solid #DFDFDF;background:#fff;color:#111;border-radius:64px;padding:7px 14px;min-height:36px;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px}\n  .vm .vm-chip[aria-pressed="true"]{background:#111;color:#fff;border-color:#111}\n  .vm .vm-chip .n{font-weight:400;opacity:.75}\n  .vm .vm-stage{position:relative;width:440px;max-width:100%;margin:10px auto 0;aspect-ratio:440/700}\n  .vm .vm-stage svg{position:absolute;inset:0;width:100%;height:100%}\n  .vm .vm-mk{position:absolute;transform:translate(-50%,-50%);width:32px;height:32px;border-radius:50%;padding:0;font:inherit;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.25)}\n  .vm .vm-mk.own{background:#0058A3;color:#fff;border:2px solid #fff}\n  .vm .vm-mk.zero{background:#fff;color:#B34700;border:3px solid #E07B18}\n  .vm .vm-mk.comp{background:#fff;color:#484848;border:2px dashed #767676}\n  .vm .vm-mk.on{box-shadow:0 0 0 4px #FFDB00,0 1px 3px rgba(0,0,0,.3)}\n  .vm .vm-mk.dim{opacity:.25}\n  .vm .vm-legend{display:flex;gap:16px;flex-wrap:wrap;justify-content:center;font-size:12px;color:#484848;margin-top:12px}\n  .vm .vm-legend span{display:inline-flex;align-items:center;gap:6px}\n  .vm .vm-legend i{width:14px;height:14px;border-radius:50%;display:inline-block}\n  .vm .vm-card{background:#fff;border:1px solid #DFDFDF;border-radius:4px}\n  .vm .vm-det{padding:18px;border:2px solid #111}\n  .vm .vm-det .t{font-size:18px;font-weight:700;line-height:1.3}\n  .vm .vm-det .t small{display:block;font-size:12.5px;font-weight:400;color:#484848;margin-top:2px}\n  .vm .vm-det .ps{font-size:13px;margin-top:8px}\n  .vm .vm-codes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:12px}\n  .vm .vm-codes>div{background:#F5F5F5;border-radius:4px;padding:8px 10px;min-width:0}\n  .vm .vm-codes .k{font-size:11px;font-weight:700;color:#484848}\n  .vm .vm-codes .v{font-size:13.5px;font-weight:700;word-break:break-all}\n  .vm .vm-codes .ctr{background:#E6F0F8}\n  .vm .vm-codes .ctr .k{color:#0058A3}\n  .vm .vm-qty{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:8px}\n  .vm .vm-qty>div{border:1px solid #DFDFDF;border-radius:4px;padding:8px;display:flex;align-items:center;gap:6px;min-width:0}\n  .vm .vm-qty b{font-size:15px;font-variant-numeric:tabular-nums;white-space:nowrap}\n  .vm .vm-q{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;font-variant-numeric:tabular-nums}\n  .vm .vm-q svg,.vm .vm-qty svg{flex:none}\n  .vm .vm-code{position:relative;cursor:pointer;color:#0058A3;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px;background:none;border:0;padding:0;font:inherit;font-weight:700}\n  /* 11-27d · OE 말풍선 — 화면(body)에 띄워서 목록 스크롤 · 카드 경계에 잘리지 않게. 여러 개면 줄바꿈 */\n  .vm-oepop{position:fixed;z-index:9500;max-width:min(400px,calc(100vw - 16px));background:#111;color:#fff;border-radius:4px;padding:10px 12px;font-family:\'Noto Sans KR\',\'IBM Plex Sans KR\',system-ui,sans-serif;font-size:12.5px;line-height:1.45;box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none}\n  .vm-oepop .h{font-size:11px;font-weight:700;color:#FFDB00;margin-bottom:4px}\n  .vm-oepop .l{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:2px 14px}\n  .vm-oepop .l span{white-space:nowrap;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}\n  .vm .vm-oe{margin-top:8px;font-size:12px;color:#484848;line-height:1.55;overflow-wrap:anywhere}\n  .vm .vm-oe b{color:#111}\n  .vm .vm-lh{padding:12px 16px;border-bottom:1px solid #DFDFDF;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center}\n  .vm .vm-lh b{font-size:14px}\n  .vm .vm-ico{display:flex;gap:10px;font-size:11px;color:#484848;flex-wrap:wrap}\n  .vm .vm-list{max-height:620px;overflow:auto}\n  .vm .vm-row{width:100%;text-align:left;border:0;border-bottom:1px solid #F0F0F0;background:#fff;padding:10px 16px;display:flex;align-items:center;gap:12px;min-height:56px;font:inherit;cursor:pointer;color:#111}\n  .vm .vm-row:hover{background:#F5F5F5}\n  .vm .vm-row.on{background:#FFF8CC}\n  .vm .vm-row .dot{flex:none;width:12px;height:12px;border-radius:50%}\n  .vm .vm-row .mid{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}\n  .vm .vm-row .nm{font-size:13px;font-weight:700}\n  .vm .vm-row .cd{font-size:12px;color:#484848}\n  .vm .vm-row .cd .nw{white-space:nowrap}\n  .vm .vm-row .qs{flex:none;display:grid;grid-template-columns:repeat(2,64px);gap:3px 8px;font-size:12px;color:#484848}\n  .vm .vm-row .qs .st{font-weight:700;color:#0A6B3A}\n  .vm .vm-row .qs .st.z{color:#B34700}\n  .vm .vm-row .qs .bo{color:#CC0008}\n  .vm .vm-row .cp{flex:none;width:136px;text-align:right;font-size:11.5px;font-weight:700;color:#767676}\n  .vm .vm-sec{padding:6px 16px;font-size:11.5px;font-weight:700;color:#484848;background:#FAFAFA;border-bottom:1px solid #F0F0F0}\n  .vm .vm-empty{padding:18px 16px;font-size:13px;color:#484848}\n  .vm .vm-note{font-size:11.5px;color:#767676;line-height:1.6}\n  @media (max-width:560px){ .vm{padding:18px} .vm .vm-mk{width:26px;height:26px;font-size:11px} .vm .vm-qty{grid-template-columns:repeat(2,minmax(0,1fr))} .vm .vm-row .qs{grid-template-columns:repeat(2,56px)} }\n  /* 11-27f · 견적 담기(pick) 모드 */\n  .vm .vm-pick{margin-top:14px;padding-top:12px;border-top:1px dashed #DFDFDF;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}\n  .vm .vm-pick label{display:block;font-size:11.5px;font-weight:700;color:#484848;margin:0 0 4px}\n  .vm .vm-pick input,.vm .vm-pick select{min-height:44px;border:1px solid #929292;border-radius:4px;padding:0 10px;font:inherit;font-size:14px;background:#fff;color:#111}\n  .vm .vm-pick input{width:96px}\n  .vm .vm-pick .vm-btn{background:#FFDB00;color:#111}\n  .vm .vm-pick .vm-btn:hover{background:#F2CD00}\n  .vm .vm-pick .vm-btn:disabled{background:#EDEDED;color:#767676;cursor:not-allowed}\n  .vm .vm-pnote{flex-basis:100%;font-size:12px;line-height:1.5;color:#484848}\n  .vm .vm-pnote.warn{color:#8A4A00}\n  .vm .vm-pnote.dev{color:#5B3A8E}\n  .vm .vm-pmsg{flex-basis:100%;font-size:12.5px;font-weight:700;color:#0A6B3A;min-height:1em}\n  .vm .vm-pmsg.err{color:#CC0008}\n  .vm .vm-add{flex:none;width:36px;height:36px;border-radius:50%;border:0;background:#FFDB00;color:#111;font:inherit;font-size:18px;font-weight:700;cursor:pointer;line-height:1}\n  .vm .vm-add:hover{background:#F2CD00}\n  .vm .vm-add:disabled{background:#EDEDED;color:#929292;cursor:not-allowed}\n  .vm .vm-add:focus-visible{outline:3px solid #0058A3;outline-offset:2px}\n  .vm .vm-inq{display:inline-block;margin-left:6px;background:#0058A3;color:#fff;border-radius:64px;padding:1px 8px;font-size:11px;font-weight:700;vertical-align:1px}\n  .rvm-ph-ov{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9600;display:flex;align-items:center;justify-content:center;padding:16px}\n  .rvm-ph{background:#fff;border-radius:4px;max-width:880px;width:100%;max-height:92vh;overflow:auto;padding:16px 18px;font-family:\'Noto Sans KR\',system-ui,sans-serif}\n  .rvm-ph .hd{display:flex;align-items:center;gap:10px;margin-bottom:10px;font-weight:700}\n  .rvm-ph .hd button{margin-left:auto;border:1px solid #111;background:#fff;border-radius:64px;padding:6px 14px;cursor:pointer;font:inherit}\n  .rvm-ph .gr{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}\n  .rvm-ph figure{margin:0;background:#F5F5F5;border-radius:4px;padding:8px;text-align:center}\n  .rvm-ph img{max-width:100%;max-height:260px;object-fit:contain}\n  .rvm-ph figcaption{font-size:12px;color:#484848;margin-top:4px}\n';
  function injectCss(){ if(document.getElementById('rvm-css')) return; var st=document.createElement('style'); st.id='rvm-css'; st.textContent=CSS; (document.head||document.documentElement).appendChild(st); }
  function escP(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function qty(n){ return n==null?'—':Number(n).toLocaleString('es-MX',{maximumFractionDigits:3}); }

  // 내장 사진 창 — CTR(R2 {code}_1~6.webp) · SYD(syd.com.mx {code}.jpg) · 안 뜨는 사진은 숨김
  var R2='https://pub-d34920cb200c42ce91c5cbda135f16d6.r2.dev/products/', SYDF='https://syd.com.mx/Catalogo/fotos/';
  function builtinPhoto(ctr, syd){
    var old=document.getElementById('rvmPh'); if(old) old.remove();
    var figs=[];
    if(ctr){ var e=encodeURIComponent(ctr); for(var n=1;n<=6;n++) figs.push({src:R2+e+'/'+e+'_'+n+'.webp',cap:'CTR '+ctr+(n>1?' · '+n:'')}); }
    String(syd||'').split(/\s*\/\/\s*/).filter(Boolean).forEach(function(s){ figs.push({src:SYDF+encodeURIComponent(s)+'.jpg',cap:'SYD '+s}); });
    var ov=document.createElement('div'); ov.className='rvm-ph-ov'; ov.id='rvmPh';
    ov.innerHTML='<div class="rvm-ph" role="dialog" aria-modal="true" aria-label="제품 사진"><div class="hd">📷 제품 사진 · '+escP(ctr||syd||'')+'<button type="button">✕ 닫기</button></div>'
      +'<div class="gr">'+figs.map(function(f){ return '<figure><img alt="'+escP(f.cap)+'" src="'+escP(f.src)+'"><figcaption translate="no">'+escP(f.cap)+'</figcaption></figure>'; }).join('')+'</div>'
      +'<div class="hd" style="font-weight:400;font-size:12px;color:#484848;margin:8px 0 0" id="rvmPhNone"></div></div>';
    document.body.appendChild(ov);
    var left=figs.length, none=ov.querySelector('#rvmPhNone');
    function chk(){ if(left<=0 && !ov.querySelector('figure')) none.textContent='등록된 사진이 없습니다.'; }
    ov.querySelectorAll('img').forEach(function(im){ im.addEventListener('error',function(){ im.closest('figure').remove(); left--; chk(); }); im.addEventListener('load',function(){ left--; }); });
    if(!figs.length) none.textContent='등록된 사진이 없습니다.';
    function close(){ ov.remove(); document.removeEventListener('keydown',esc); }
    function esc(ev){ if(ev.key==='Escape') close(); }
    ov.querySelector('.hd button').addEventListener('click',close);
    ov.addEventListener('click',function(ev){ if(ev.target===ov) close(); });
    document.addEventListener('keydown',esc);
  }

  function create(O){
    injectCss();
    var E=O.els, PICK=O.mode==='pick';
    var photo=O.openPhoto||builtinPhoto;
    var curAll=[];

    // ── 차종 드롭다운(같은 이름 묶음 표기 · 11-27b · 메이커 낱개 11-27e 는 서버가) ──
    function fillSelect(sel,items,allLabel,groups){
      var extra={}, fresh={}; (groups||[]).forEach(function(g){ var o=(g.variants||[]).filter(function(x){ return x!==g.label; }); if(o.length) extra[g.label]=o; if(g.pf_only) fresh[g.label]=1; });
      // 11-27h · 🆕 = 플랫폼 신규 차종(제품 아직 연결 안 됨)
      sel.innerHTML='<option value="">'+escP(allLabel)+'</option>'+(items||[]).map(function(v){ var o=extra[v];
        return '<option value="'+escP(v)+'"'+(o?' title="'+escP('같은 이름으로 묶은 표기: '+o.join(' · '))+'"':'')+'>'+escP(v)+(o?'  ('+escP(o.slice(0,3).join(' · '))+(o.length>3?' …':'')+')':'')+(fresh[v]?'  🆕':'')+'</option>'; }).join('');
    }
    function getJ(path){ return fetch(O.api()+path,{headers:O.headers()}).then(function(x){ return x.json(); }); }
    // 11-27g · 순서 = 메이커 → 연식 → 모델. 연식을 고르면 그 연식에 해당하는 모델만 나온다(연식 비우면 메이커의 모든 모델).
    //   연식을 바꿔도 고른 모델이 새 목록에 있으면 그대로 둔다.
    function keep(sel, prev){ if(prev && [].some.call(sel.options,function(o){ return o.value===prev; })) sel.value=prev; }
    // 11-27h · 다시 불러도(제품 저장 뒤) 고른 메이커는 그대로
    function loadMakers(){ var prev=E.maker.value; return getJ('/api/products/app-makers').then(function(d){ fillSelect(E.maker,d.items,'선택',d.groups); keep(E.maker,prev); }).catch(function(){}); }
    function loadYears(){
      var prev=E.year.value;
      return getJ('/api/products/app-years?maker='+encodeURIComponent(E.maker.value)).then(function(d){ fillSelect(E.year,d.items,'전체 연식'); keep(E.year,prev); }).catch(function(){}).then(loadModels);
    }
    function loadModels(){
      var prev=E.model.value, y=E.year.value;
      return getJ('/api/products/app-models?maker='+encodeURIComponent(E.maker.value)+(y?'&year='+encodeURIComponent(y):'')).then(function(d){ fillSelect(E.model,d.items,'선택',d.groups); keep(E.model,prev); }).catch(function(){});
    }

    // ── 담기(pick) ──
    function pickRefs(it){
      if(it.kind==='ctr') return [{code:it.code, product_id:it.id, brand:'', label:'CTR '+it.code}];
      return (it.syd||[]).map(function(c){ return {code:c, product_id:null, brand:'SYD', label:'SYD '+c}; })
        .concat((it.baw||[]).map(function(c){ return {code:c, product_id:null, brand:'BAW', label:'BAW '+c}; }));
    }
    function inQuoteN(it){
      if(!O.inQuote) return 0;
      return pickRefs(it).reduce(function(t,r){ return t+(Number(O.inQuote(r))||0); },0);
    }
    function inQuoteBadge(it){ if(!PICK) return ''; var n=inQuoteN(it); return n?'<span class="vm-inq" translate="no" title="이 견적에 담긴 수량">견적 '+qty(n)+'</span>':''; }
    function readyState(){ if(!O.ready) return true; var r=O.ready(); return r===true?true:(r||'담을 수 없습니다.'); }
    var lastMsg={uid:'',text:'',err:false};
    function pickBoxHtml(it){
      var refs=pickRefs(it), rd=readyState();
      if(!refs.length) return '<div class="vm-pick"><div class="vm-pnote">담을 코드가 없습니다.</div></div>';
      var note='', cls='';
      if(it.kind==='ctr'){
        if(it.is_active===false){ note='⛔ 비활성(판매중단) 제품입니다 — 담으면 견적 화면의 안내가 함께 뜹니다.'; cls='warn'; }
        else if(Number(it.stock_qty)<=0){ note='창고 0 — 견적에 담으면 재고 부족으로 표시되고, 견적 저장 시 재고부족분으로 기록됩니다.'; cls='warn'; }
        else note='창고 '+qty(it.stock_qty)+' — 수량이 재고보다 많으면 모자라는 만큼 재고부족분으로 기록됩니다.';
      } else { note='CTR 미개발 — 아래 코드가 견적에 미등록 코드(브랜드 '+escP(refs[0].brand)+')로 담기고, 견적 저장 시 카탈로그 개발요청으로 기록됩니다.'; cls='dev'; }
      var h='<div class="vm-pick">'
        +(refs.length>1?'<div><label for="vmPickCode">담을 코드</label><select id="vmPickCode" translate="no">'+refs.map(function(r,i){ return '<option value="'+i+'">'+escP(r.label)+'</option>'; }).join('')+'</select></div>'
          :'<div><label>담을 코드</label><div translate="no" style="min-height:44px;display:flex;align-items:center;font-weight:700">'+escP(refs[0].label)+'</div></div>')
        +'<div><label for="vmPickQty">수량</label><input id="vmPickQty" type="number" min="1" step="1" value="1" inputmode="numeric"></div>'
        +'<div><button type="button" class="vm-btn" id="vmPickBtn"'+(rd===true?'':' disabled')+'>＋ 견적에 담기</button></div>'
        +'<div class="vm-pnote '+cls+'">'+note+'</div>'
        +(rd===true?'':'<div class="vm-pnote warn">'+escP(rd)+'</div>')
        +'<div class="vm-pmsg'+(lastMsg.err?' err':'')+'" id="vmPickMsg" role="status">'+(lastMsg.uid===it.uid?escP(lastMsg.text):'')+'</div>'
        +'</div>';
      return h;
    }
    function rowPickHtml(it){
      var rd=readyState(); if(!pickRefs(it).length) return '';
      return '<button type="button" class="vm-add" data-uid="'+escP(it.uid)+'"'+(rd===true?'':' disabled')+' aria-label="'+escP((it.name||'')+' 견적에 1개 담기')+'" title="견적에 1개 담기">＋</button>';
    }
    function doPick(it, ref, q){
      var rd=readyState();
      if(rd!==true){ lastMsg={uid:it.uid,text:rd,err:true}; vmSel=it.uid; vmRender(); return; }
      if(!(q>0)){ lastMsg={uid:it.uid,text:'수량을 1 이상 입력하세요.',err:true}; vmSel=it.uid; vmRender(); return; }
      try{ O.onPick({code:ref.code, product_id:ref.product_id||null, brand:ref.brand||'', qty:q, item:it}); }
      catch(e){ lastMsg={uid:it.uid,text:'담기 실패: '+e.message,err:true}; vmSel=it.uid; vmRender(); return; }
      lastMsg={uid:it.uid,text:'✓ '+ref.label+' '+qty(q)+'개를 견적에 담았습니다.',err:false};
      vmSel=it.uid; vmRender();
    }
    function bindPick(r){
      if(!PICK) return;
      var btn=r.querySelector('#vmPickBtn');
      if(btn) btn.addEventListener('click',function(){
        var it=curAll.find(function(x){ return x.uid===vmSel; }); if(!it) return;
        var refs=pickRefs(it), sel=r.querySelector('#vmPickCode'), q=Number((r.querySelector('#vmPickQty')||{}).value);
        doPick(it, refs[sel?Number(sel.value)||0:0], q);
      });
      var qi=r.querySelector('#vmPickQty'); if(qi) qi.addEventListener('keydown',function(e){ if(e.key==='Enter'&&btn){ e.preventDefault(); btn.click(); } });
      r.querySelectorAll('.vm-add').forEach(function(b){ b.addEventListener('click',function(e){
        e.stopPropagation(); var it=curAll.find(function(x){ return x.uid===b.getAttribute('data-uid'); }); if(it) doPick(it, pickRefs(it)[0], 1); }); });
    }

    const VM_CAT_ORDER=['ball','tie','rack','arm','link','bush','shock','other'];
    const VM_CAT_COLOR={ball:'#0058A3',tie:'#0A7D6B',rack:'#6A3FB5',arm:'#B3541E',link:'#A3246B',bush:'#5B6B00',shock:'#1F6F8B',other:'#484848'};
    const VM_CAT_KO={ball:'볼조인트',tie:'타이로드엔드',rack:'랙엔드',arm:'컨트롤암',link:'스태빌라이저 링크',bush:'부싱',shock:'쇽업소버',other:'기타'};
    // 도면 좌표(viewBox 440×700, 왼쪽 바퀴 기준 x · 오른쪽은 440−x) — [앞 y, 뒤 y, x, 상(upper) y 보정]
    const VM_SLOT={ tie:[126,520,96,0], rack:[140,0,168,0], ball:[182,566,74,-62], arm:[206,592,132,-70],
      link:[236,486,112,0], bush:[222,512,152,0], shock:[160,545,44,0], other:[258,468,170,0] };
    const VM_KO={front:'앞',rear:'뒤',upper:'상',lower:'하',lh:'좌',rh:'우'};
    const VM_ICON={
      st:'<svg width="SZ" height="SZ" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4"/><path d="M12 11v10"/></svg>',
      tr:'<svg width="SZ" height="SZ" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 6h13v10H1z"/><path d="M14 10h4l3 3v3h-7z"/><circle cx="5.5" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/></svg>',
      bo:'<svg width="SZ" height="SZ" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
      sd:'<svg width="SZ" height="SZ" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>'};
    const VM_TIP={st:'창고재고 · Inventario en almacén',tr:'운송재고 · En tránsito',bo:'생산 중 백오더 · En producción',sd:'누적판매 · Ventas acumuladas'};
    const vmIco=(k,sz)=>VM_ICON[k].replace(/SZ/g,String(sz||14));
    let vmData=null, vmCat='', vmSlot='', vmSel='', vmShowComp=true;

    function vmPosKo(p){ if(!p) return '위치 미지정';
      const part=(a)=>(a||[]).map(k=>VM_KO[k]).filter(Boolean).join('/');
      return [part(p.blocks),part(p.levels),part(p.sides)].filter(Boolean).join('·')||'위치 미지정'; }   // 제품검색 배지(koText)와 같은 표기
    function vmPosSrc(p){ if(!p) return ''; return p.src==='erp'?'CTR 확인값':(p.src==='vehicle'?'이 차종 업로드':(p.src==='xref'?'경쟁사 마스터 UBICACIÓN':'다른 차종 업로드')); }

    // 한 부품 → 도면 자리 [{key, x, y}]
    function vmSlots(it){
      const p=it.pos; if(!p||!p.blocks||!p.blocks.length) return [];
      const sl=VM_SLOT[it.cat]||VM_SLOT.other;
      const sides=(p.sides&&p.sides.length)?p.sides:['lh','rh'];
      const levels=(p.levels&&p.levels.length)?p.levels:[''];
      const out=[];
      p.blocks.forEach(function(b){
        let y=b==='front'?sl[0]:sl[1];
        if(!y) y=b==='front'?140:520;   // 랙엔드가 뒤에 있다고 적힌 경우 등
        levels.forEach(function(lv){
          const yy=y+(lv==='upper'?sl[3]:0);
          sides.forEach(function(sd){
            const x=sd==='rh'?440-sl[2]:sl[2];
            out.push({key:[it.cat,b,lv||'-',sd].join('|'), x:x, y:yy, b:b, lv:lv, sd:sd});
          });
        });
      });
      return out;
    }

    function vmItems(){
      if(!vmData) return [];
      const a=vmData.items.map(function(x){ return Object.assign({kind:'ctr', uid:'c'+x.id}, x); });
      const b=vmShowComp?vmData.competitors.map(function(x){ return Object.assign({kind:'comp', uid:'x'+x.row_no, name:x.descripcion||'(품명 없음)'}, x); }):[];
      return a.concat(b);
    }
    function vmState(it){ return it.kind==='comp'?'comp':(Number(it.stock_qty)>0?'own':'zero'); }

    async function vehSearch(){
      const maker=E.maker.value,model=E.model.value,year=E.year.value;
      const r=E.result;
      if(!maker||!model){ r.innerHTML='<div class="vm-empty">메이커와 모델을 고르세요. 연식은 비워 두면 그 모델 전체입니다.</div>'; return; }
      r.innerHTML='<div class="vm-empty">찾는 중…</div>';
      const ps=new URLSearchParams({maker:maker,model:model}); if(year) ps.set('year',year);
      try{
        const res=await fetch(O.api()+'/api/products/vehicle-map?'+ps.toString(),{headers:O.headers()});
        const d=await res.json();
        if(!res.ok||d.error){ r.innerHTML='<div class="vm-empty">조회 실패: '+escP(d.error||res.status)+'</div>'; return; }
        vmData=d; vmCat=''; vmSlot=''; vmSel='';
        const first=vmItems().find(function(x){ return vmSlots(x).length; });
        if(first) vmSel=first.uid;
        vmRender();
      }catch(e){ r.innerHTML='<div class="vm-empty">서버 연결 실패.</div>'; }
    }

    function vmRender(){
      vmOeHide();
      const r=E.result; if(!vmData){ r.innerHTML=''; return; }
      const d=vmData, v=d.vehicle||{}, c=d.counts||{};
      const all=vmItems(); curAll=all;
      const vis=all.filter(function(x){ return !vmCat||x.cat===vmCat; });
      // 자리별 묶음
      const slots=new Map();
      vis.forEach(function(it){ vmSlots(it).forEach(function(s){
        if(!slots.has(s.key)) slots.set(s.key,{key:s.key,x:s.x,y:s.y,b:s.b,lv:s.lv,sd:s.sd,cat:it.cat,items:[]});
        const g=slots.get(s.key); if(!g.items.includes(it)) g.items.push(it); }); });
      const unplaced=vis.filter(function(it){ return !vmSlots(it).length; });
      let h='<div class="vm-sum"><span class="vm-veh" translate="no">'+escP(v.maker||'')+' '+escP(v.model||'')+(v.year?' '+escP(v.year):'')+'</span>'
        +'<span class="vm-pill yel"><b translate="no">'+qty(c.ctr||0)+'</b>CTR 적용 제품</span>'
        +'<span class="vm-pill"><b translate="no">'+qty(c.ctr_in_stock||0)+'</b>재고 있음</span>'
        +'<span class="vm-pill"><b translate="no">'+qty(c.competitors||0)+'</b>경쟁사만(SYD · BAW)</span>'
        +(c.truncated?'<span class="vm-pill">1,500개까지만 표시</span>':'')+'</div>';
      // 무리 칩
      const cnt={}; all.forEach(function(x){ cnt[x.cat]=(cnt[x.cat]||0)+1; });
      h+='<div class="vm-body"><section class="vm-draw" aria-label="차량 하부 도면">'
        +'<div class="vm-chips"><button type="button" class="vm-chip" data-cat="" aria-pressed="'+(!vmCat)+'">전체 <span class="n" translate="no">'+all.length+'</span></button>'
        +VM_CAT_ORDER.filter(function(k){ return cnt[k]; }).map(function(k){
          return '<button type="button" class="vm-chip" data-cat="'+k+'" aria-pressed="'+(vmCat===k)+'"><i style="width:10px;height:10px;border-radius:50%;background:'+VM_CAT_COLOR[k]+';display:inline-block" aria-hidden="true"></i>'+VM_CAT_KO[k]+' <span class="n" translate="no">'+cnt[k]+'</span></button>'; }).join('')
        +'<label class="vm-chip" style="margin:0;font-weight:700"><input type="checkbox" id="vmComp" style="width:auto;margin:0"'+(vmShowComp?' checked':'')+'> 경쟁사(SYD · BAW) 표시</label></div>'
        +'<div class="vm-stage">'+vmSvg()+[...slots.values()].map(function(g){
          const st=g.items.some(function(x){ return vmState(x)==='own'; })?'own':(g.items.some(function(x){ return vmState(x)==='zero'; })?'zero':'comp');
          const on=vmSlot===g.key||(!vmSlot&&g.items.some(function(x){ return x.uid===vmSel; }));
          const dim=vmSlot&&vmSlot!==g.key;
          const lab=VM_CAT_KO[g.cat]+' '+VM_KO[g.b]+(g.lv?' '+VM_KO[g.lv]:'')+' '+VM_KO[g.sd]+' · '+g.items.length+'개';
          return '<button type="button" class="vm-mk '+st+(on?' on':'')+(dim?' dim':'')+'" data-slot="'+escP(g.key)+'" aria-label="'+escP(lab)+'" title="'+escP(lab)+'" style="left:'+(g.x/440*100)+'%;top:'+(g.y/700*100)+'%'
            +(st==='own'?';background:'+VM_CAT_COLOR[g.cat]:'')+'"><span translate="no">'+g.items.length+'</span></button>'; }).join('')
        +'</div>'
        +'<div class="vm-legend"><span><i style="background:#0058A3"></i>보유 · 재고 있음 (색 = 부품 무리)</span><span><i style="background:#fff;border:3px solid #E07B18"></i>보유 · 창고 0</span><span><i style="background:#fff;border:2px dashed #767676"></i>CTR 없음 · 경쟁사만</span></div>'
        +(unplaced.length?'<div class="vm-note" style="margin-top:10px;text-align:center">위치 미지정 <b translate="no">'+unplaced.length+'</b>개 — 장착위치가 아직 등록되지 않아 도면에 없습니다(오른쪽 목록 맨 아래).</div>':'')
        +'</section><div class="vm-side">'+vmDetailHtml(all)+vmListHtml(vis, slots, unplaced)+'</div></div>'
        +'<div class="vm-note" style="margin-top:14px">장착위치: CTR 확인값(Platform 카탈로그 점검) → 장착위치 업로드(이 차종 줄 우선) 순 · 경쟁사 부품은 크로스레퍼런스 마스터 APLICACIÓN · UBICACIÓN 글 기준(적용차종 글자 매칭이라 확인 필요). '
        +'창고재고 = 제품 현재고 · 운송 = 수입입고 마감 전 선적 · 백오더 = 생산 중(공장 발주 미입고 잔량 − 운송 중, 견적 엑셀 En producción 과 같음) · 누적판매 = 게시 인보이스 전체 기간(보이는 팀 기준).</div>';
      r.innerHTML=h;
      // 이벤트
      r.querySelectorAll('.vm-chip[data-cat]').forEach(function(b){ b.addEventListener('click',function(){ vmCat=b.getAttribute('data-cat')||''; vmSlot=''; vmRender(); }); });
      const cb=r.querySelector('#vmComp'); if(cb) cb.addEventListener('change',function(){ vmShowComp=cb.checked; vmSlot=''; vmRender(); });
      r.querySelectorAll('.vm-mk').forEach(function(b){ b.addEventListener('click',function(){
        const k=b.getAttribute('data-slot'); if(vmSlot===k){ vmSlot=''; } else { vmSlot=k; const g=slots.get(k); if(g&&g.items[0]) vmSel=g.items[0].uid; } vmRender(); }); });
      r.querySelectorAll('.vm-row').forEach(function(b){
        b.addEventListener('click',function(e){ if(e.target.closest('.vm-code')||e.target.closest('.vm-add')) return; vmSel=b.getAttribute('data-uid'); vmRender(); });
        b.addEventListener('keydown',function(e){ if((e.key==='Enter'||e.key===' ')&&!e.target.closest('.vm-code')&&!e.target.closest('.vm-add')&&!e.target.closest('input,select')){ e.preventDefault(); vmSel=b.getAttribute('data-uid'); vmRender(); } }); });
      r.querySelectorAll('.vm-code').forEach(function(b){ b.addEventListener('click',function(e){ e.stopPropagation();
        vmOeHide(); photo(b.getAttribute('data-ctr')||'', b.getAttribute('data-syd')||''); }); });
      r.querySelectorAll('.vm-code[data-oe]').forEach(function(b){
        b.addEventListener('mouseenter',function(){ vmOeShow(b); }); b.addEventListener('focus',function(){ vmOeShow(b); });
        b.addEventListener('mouseleave',vmOeHide); b.addEventListener('blur',vmOeHide); });
      const clr=r.querySelector('#vmClear'); if(clr) clr.addEventListener('click',function(){ vmSlot=''; vmRender(); });
      const dt=r.querySelector('#vmDrill'); if(dt) dt.addEventListener('click',function(){ if(O.onDetail) O.onDetail(dt.getAttribute('data-code')); });
      bindPick(r);
    }

    function vmSvg(){
      return '<svg viewBox="0 0 440 700" role="img" aria-label="차량 하부 평면도 — 위쪽이 앞차축, 아래쪽이 뒷차축">'
        +'<text x="220" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#484848">▲ FRENTE · 앞</text>'
        +'<rect x="95" y="40" width="250" height="620" rx="90" fill="#fff" stroke="#929292" stroke-width="2"/>'
        +'<path d="M120 236 Q220 196 320 236 L310 292 Q220 272 130 292 Z" fill="#EDEDED" stroke="#C4C4C4"/>'
        +'<rect x="130" y="302" width="180" height="228" rx="18" fill="none" stroke="#C4C4C4" stroke-dasharray="5 5"/>'
        +'<path d="M130 600 Q220 622 310 600 L318 634 Q220 656 122 634 Z" fill="#EDEDED" stroke="#C4C4C4"/>'
        +'<rect x="150" y="56" width="140" height="62" rx="10" fill="#F5F5F5" stroke="#C4C4C4"/>'
        +'<text x="220" y="92" text-anchor="middle" font-size="11" fill="#767676">MOTOR</text>'
        +'<line x1="62" y1="160" x2="378" y2="160" stroke="#111" stroke-width="5"/>'
        +'<line x1="140" y1="140" x2="300" y2="140" stroke="#484848" stroke-width="3"/>'
        +'<line x1="62" y1="545" x2="378" y2="545" stroke="#111" stroke-width="5"/>'
        +'<rect x="30" y="112" width="40" height="96" rx="8" fill="#111"/><rect x="370" y="112" width="40" height="96" rx="8" fill="#111"/>'
        +'<rect x="30" y="497" width="40" height="96" rx="8" fill="#111"/><rect x="370" y="497" width="40" height="96" rx="8" fill="#111"/>'
        +'<rect x="158" y="166" width="124" height="20" rx="10" fill="#FFDB00"/>'
        +'<text x="220" y="180" text-anchor="middle" font-size="11" font-weight="700" fill="#111">앞차축 · Eje delantero</text>'
        +'<rect x="158" y="551" width="124" height="20" rx="10" fill="#FFDB00"/>'
        +'<text x="220" y="565" text-anchor="middle" font-size="11" font-weight="700" fill="#111">뒷차축 · Eje trasero</text>'
        +'<text x="10" y="360" font-size="12" font-weight="700" fill="#484848">IZQ</text>'
        +'<text x="406" y="360" font-size="12" font-weight="700" fill="#484848">DER</text>'
        +'</svg>';
    }

    // 11-27d · OE 말풍선 — body 에 붙이고 화면 안으로 자리 잡기(위/아래 · 좌우 끝 맞춤). 목록 스크롤 · 카드 overflow 에 안 잘림
    function vmOeHide(){ const el=document.getElementById('vmOePop'); if(el) el.remove(); }
    function vmOeShow(btn){
      vmOeHide();
      const list=String(btn.getAttribute('data-oe')||'').split('|').filter(Boolean);
      const el=document.createElement('div'); el.className='vm-oepop'; el.id='vmOePop'; el.setAttribute('role','tooltip'); el.setAttribute('translate','no');
      el.innerHTML='<div class="h">OE · '+escP(btn.getAttribute('data-ctr')||'')+(list.length>1?' · '+list.length+'개':'')+'</div>'
        +(list.length?'<div class="l">'+list.map(function(x){ return '<span>'+escP(x)+'</span>'; }).join('')+'</div>':'<div>등록된 OE 없음</div>');
      // 여러 개면 2~3열로 펼쳐 세로로 길어지지 않게(화면 폭 안에서)
      const cols=Math.min(3, Math.max(1, Math.ceil(list.length/4)));
      el.style.width=Math.min(cols*132+24, (window.innerWidth||1024)-16)+'px';
      document.body.appendChild(el);
      const r=btn.getBoundingClientRect(), w=el.offsetWidth, h=el.offsetHeight, vw=window.innerWidth||1024, vh=window.innerHeight||768;
      let top=r.bottom+6; if(top+h>vh-8 && r.top-6-h>=8) top=r.top-6-h;
      let left=Math.min(Math.max(8, r.left), Math.max(8, vw-w-8));
      el.style.top=Math.max(8,top)+'px'; el.style.left=left+'px';
    }

    function vmCodeBtn(ctr, syd, oe){
      // 코드 버튼 — CTR: 마우스 올리면 OE · 누르면 사진 / SYD: 누르면 SYD 사진
      if(ctr) return '<button type="button" class="vm-code" translate="no" data-ctr="'+escP(ctr)+'" data-syd="'+escP(syd||'')+'" data-oe="'+escP((oe||[]).join('|'))+'" aria-label="'+escP(ctr+' · OE '+((oe&&oe.length)?oe.join(', '):'등록 없음'))+'">'+escP(ctr)
        +'</button>';
      return syd?'<button type="button" class="vm-code" translate="no" data-ctr="" data-syd="'+escP(syd)+'">'+escP(syd)+'</button>':'—';
    }

    function vmDetailHtml(all){
      const it=all.find(function(x){ return x.uid===vmSel; });
      if(!it) return '<div class="vm-card vm-det"><div class="vm-note">도면의 번호나 오른쪽 목록을 누르면 부품 정보가 여기에 나옵니다.</div></div>';
      const isC=it.kind==='ctr';
      const sydTxt=(it.syd||[]).join(' // ');
      let h='<div class="vm-card vm-det">'
        +'<div class="t">'+escP(it.name||'')+'<small>'+VM_CAT_KO[it.cat]+(isC?'':' · CTR 카탈로그에 없음 (경쟁사 코드)')+'</small></div>'
        +'<div class="ps">장착위치: <b>'+escP(vmPosKo(it.pos))+'</b>'+(it.pos?' <span class="vm-note">('+vmPosSrc(it.pos)+')</span>':'')+'</div>'
        +'<div class="vm-codes">'
        +'<div class="ctr"><div class="k" translate="no">CTR</div><div class="v">'+(isC?vmCodeBtn(it.code, sydTxt, it.oe):'<span style="color:#767676">없음</span>')+'</div></div>'
        +'<div><div class="k" translate="no">SYD</div><div class="v">'+((it.syd||[]).length?(it.syd||[]).map(function(s){ return isC?'<span translate="no">'+escP(s)+'</span>':vmCodeBtn('', s); }).join(' · '):'—')+'</div></div>'
        +'<div><div class="k" translate="no">BAW</div><div class="v" translate="no">'+((it.baw||[]).length?escP(it.baw.join(' · ')):'—')+'</div></div>'
        +'</div>'
        +(isC?'<div class="vm-oe" translate="no"><b>OE</b> '+((it.oe||[]).length?escP(it.oe.join(' · ')):'등록 없음')+'</div>':'');
      if(isC){
        const boC=Number(it.backorder_qty)>0?' style="color:#CC0008"':'', stC=Number(it.stock_qty)>0?'':' style="color:#B34700"';
        h+='<div class="vm-qty" translate="no">'
          +'<div title="'+VM_TIP.st+'">'+vmIco('st',20)+'<b'+stC+'>'+qty(it.stock_qty)+'</b></div>'
          +'<div title="'+VM_TIP.tr+(it.transit_eta?' · ETA '+escP(it.transit_eta):'')+'">'+vmIco('tr',20)+'<b>'+qty(it.transit_qty)+'</b></div>'
          +'<div title="'+VM_TIP.bo+'">'+vmIco('bo',20)+'<b'+boC+'>'+qty(it.backorder_qty)+'</b></div>'
          +'<div title="'+VM_TIP.sd+'">'+vmIco('sd',20)+'<b>'+qty(it.sold_qty)+'</b></div></div>'
          +'<div class="vm-note" style="margin-top:8px">랙: <b translate="no">'+((it.racks||[]).length?escP(it.racks.map(function(x){ return x.rack+' ('+qty(x.qty)+')'; }).join(' · ')):'—')+'</b>'
          +(it.transit_eta?' · 운송 도착 예정 <b translate="no">'+escP(it.transit_eta)+'</b>':'')
          +(it.po_open_qty!=null?'<br>발주 미입고 잔량 <b translate="no">'+qty(it.po_open_qty)+'</b> = 운송 <span translate="no">'+qty(it.transit_qty)+'</span> + 생산 중 <span translate="no">'+qty(it.backorder_qty)+'</span>':'')
          +(Number(it.short_qty)>0?' · 고객 주문 미출고 부족분 <b translate="no">'+qty(it.short_qty)+'</b>':'')+'</div>'
          +(PICK?pickBoxHtml(it):(O.onDetail?'<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button type="button" class="vm-btn sm" id="vmDrill" data-code="'+escP(it.code)+'">제품 상세 보기</button></div>':''));
      } else {
        h+='<div class="vm-note" style="margin-top:10px">적용차종(마스터): <span translate="no">'+escP(it.aplicacion||'')+'</span>'+(it.year_known?'':' · 연식 표기 없음')
          +(it.ubicacion?'<br>UBICACIÓN: <span translate="no">'+escP(it.ubicacion)+'</span>':'')+'<br>CTR 개발 대상 후보 — SYD 코드를 누르면 SYD 카탈로그 사진이 열립니다.</div>'
          +(PICK?pickBoxHtml(it):'');
      }
      return h+'</div>';
    }

    function vmRowHtml(it){
      const isC=it.kind==='ctr', st=vmState(it);
      const dot=st==='comp'?'background:#fff;border:2px dashed #767676':('background:'+(st==='zero'?'#fff;border:3px solid #E07B18':VM_CAT_COLOR[it.cat]));
      let h='<div role="button" tabindex="0" class="vm-row'+(it.uid===vmSel?' on':'')+'" data-uid="'+escP(it.uid)+'">'
        +'<span class="dot" style="'+dot+'" aria-hidden="true"></span>'
        +'<span class="mid"><span class="nm">'+escP(it.name||'')+' · '+escP(vmPosKo(it.pos))+inQuoteBadge(it)+'</span>'
        +'<span class="cd" translate="no">'+(isC?vmCodeBtn(it.code,(it.syd||[]).join(' // '),it.oe):'<span style="color:#767676">CTR 없음</span>')
        +((it.syd||[]).length?' · <span class="nw">SYD '+(isC?escP(it.syd.join(' / ')):it.syd.map(function(s){ return vmCodeBtn('',s); }).join(' / '))+'</span>':'')
        +((it.baw||[]).length?' · <span class="nw">BAW '+escP(it.baw.join(' / '))+'</span>':'')+'</span></span>';
      if(isC){
        h+='<span class="qs" translate="no">'
          +'<span class="vm-q st'+(Number(it.stock_qty)>0?'':' z')+'" title="'+VM_TIP.st+'">'+vmIco('st')+qty(it.stock_qty)+'</span>'
          +'<span class="vm-q" title="'+VM_TIP.tr+'">'+vmIco('tr')+qty(it.transit_qty)+'</span>'
          +'<span class="vm-q'+(Number(it.backorder_qty)>0?' bo':'')+'" title="'+VM_TIP.bo+'">'+vmIco('bo')+qty(it.backorder_qty)+'</span>'
          +'<span class="vm-q" title="'+VM_TIP.sd+'">'+vmIco('sd')+qty(it.sold_qty)+'</span></span>';
      } else h+='<span class="cp">미보유 · 개발 대상</span>';
      if(PICK) h+=rowPickHtml(it);
      return h+'</div>';
    }

    function vmListHtml(vis, slots, unplaced){
      let rows=vis;
      if(vmSlot&&slots.has(vmSlot)) rows=slots.get(vmSlot).items;
      const placed=rows.filter(function(x){ return vmSlots(x).length; });
      const un=vmSlot?[]:unplaced;
      const ord=function(a,b){ const ca=VM_CAT_ORDER.indexOf(a.cat), cb=VM_CAT_ORDER.indexOf(b.cat);
        return (a.kind===b.kind?0:(a.kind==='ctr'?-1:1)) || ca-cb || String(a.code||a.descripcion||'').localeCompare(String(b.code||b.descripcion||'')); };
      let h='<div class="vm-card"><div class="vm-lh"><b>'+(vmSlot?'선택한 자리 부품':'이 차종의 부품')+' (<span translate="no">'+(placed.length+un.length)+'</span>)</b>'
        +(vmSlot?'<button type="button" class="vm-btn ghost sm" id="vmClear">전체 보기</button>':'')
        +'<span class="vm-ico" translate="no"><span class="vm-q" title="'+VM_TIP.st+'">'+vmIco('st')+'Alm.</span><span class="vm-q" title="'+VM_TIP.tr+'">'+vmIco('tr')+'Tráns.</span><span class="vm-q" title="'+VM_TIP.bo+'">'+vmIco('bo')+'BO</span><span class="vm-q" title="'+VM_TIP.sd+'">'+vmIco('sd')+'Acum.</span></span></div>'
        +'<div class="vm-list">';
      if(!placed.length&&!un.length){
        const pv=vmData&&vmData.pf_vehicle;
        if(pv){   // 11-27h · 플랫폼 신규 차종 — 제품이 아직 연결되지 않음
          const yr=pv.year_from?(pv.year_from+'~'+(pv.year_to||'')):'연식 미정';
          const oe=(pv.oe_ref||[]).filter(function(o){ return o&&o.oe; });
          h+='<div class="vm-empty"><b>연결된 제품 없음</b> — 🆕 플랫폼 신규 차종 <span translate="no">'+escP(pv.brand+' '+pv.model)+' · '+escP(yr)+'</span>'
            +(pv.source?' · 출처 <span translate="no">'+escP(pv.source)+'</span>':'')
            +'<div class="vm-note" style="margin-top:6px">제품 마스터에서 CTR 제품의 적용차종에 <span translate="no">'+escP(String(pv.brand).toUpperCase()+' '+pv.model+' '+(pv.year_from||new Date().getFullYear())+'-'+(pv.year_to||Math.max(Number(pv.year_from)||0,new Date().getFullYear())))+'</span> 처럼 넣으면 여기에 나옵니다.</div>'
            +(oe.length?'<div class="vm-note" style="margin-top:6px">참고 OE(플랫폼): <span translate="no">'+oe.slice(0,12).map(function(o){ return escP((o.cat?o.cat+' ':'')+(o.pos?o.pos+' ':'')+o.oe); }).join(' · ')+(oe.length>12?' …':'')+'</span></div>':'')
            +'</div>';
        } else h+='<div class="vm-empty">이 차종에 맞는 부품이 없습니다.</div>';
      }
      h+=placed.sort(ord).map(vmRowHtml).join('');
      if(un.length) h+='<div class="vm-sec">위치 미지정 — 장착위치 등록 필요</div>'+un.sort(ord).map(vmRowHtml).join('');
      return h+'</div></div>';
    }


    if(E.btn) E.btn.addEventListener('click', vehSearch);
    if(E.maker) E.maker.addEventListener('change', function(){ E.year.value=''; E.model.value=''; loadYears(); });   // 메이커 → 연식 목록 → 모델 목록
    if(E.year) E.year.addEventListener('change', loadModels);                                                       // 연식 → 그 연식 모델만
    window.addEventListener('scroll', vmOeHide, true);
    return { search: vehSearch, loadMakers: loadMakers, render: function(){ if(vmData) vmRender(); }, data: function(){ return vmData; }, hideTip: vmOeHide };
  }
  // 스타일은 불러오자마자 넣는다 — 토글 · 패널이 도면을 열기 전에도 같은 모양
  if(document.head) injectCss(); else document.addEventListener('DOMContentLoaded', injectCss);
  window.RefatrixVehicleMap = { create: create, version: '20261127g' };
})();
