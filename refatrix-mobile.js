/* Refatrix 모바일 보완 레이어 — 1단계 보완 (2026-10-15, build m20261015a)
   refatrix-nav.js 가 자동으로 불러온다(HTML 개별 수정 불필요).
   모든 규칙은 html.rfxm(모바일 모드)일 때만 적용 → PC 화면은 변화 없음.
   ① 터치 영역 42px  ② 여백 축소  ③ 넓은 표: 첫 열 고정 + 밀기 안내
   ④ 팝업(모달) → 아래에서 올라오는 전체폭 시트  ⑤ 이미지·긴 글자 넘침 방지
   ⑥ 화면 밖으로 삐져나온 가로 입력줄(판매·입고원가 품목줄, 재고 엑셀 버튼줄 등) 자동 줄바꿈
      — 이것 때문에 휴대폰이 화면 전체를 축소해서 보여주던 문제 해결 */
(function(){
  if(window.__rfxMobileLoaded) return; window.__rfxMobileLoaded=true;
  var BUILD='m20261015a';
  try{ console.log('[refatrix-mobile] '+BUILD+' loaded'); }catch(e){}

  var M='html.rfxm ';
  var css=''+
  /* ① 터치 영역 — 손가락 기준 최소 42px */
  M+'button,'+M+'.btn,'+M+'.chip,'+M+'.mbtn,'+M+'.mtab,'+M+'.tab,'+M+'a.btn,'+M+'select,'+
  M+'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]){min-height:42px}'+
  M+'input[type=checkbox],'+M+'input[type=radio]{width:20px;height:20px}'+
  M+'#rnav .rs{min-height:36px}'+                       /* 상단 하위메뉴 칩은 한 줄 유지 */
  M+'table button,'+M+'table .btn,'+M+'table select,'+M+'table input{min-height:34px}'+  /* 표 안은 행 높이 유지 */
  /* ② 여백 축소 — 화면 폭을 내용에 더 쓴다 */
  M+'.wrap{padding-left:10px!important;padding-right:10px!important}'+
  M+'.card{padding-left:12px!important;padding-right:12px!important}'+
  M+'img,'+M+'video,'+M+'canvas{max-width:100%;height:auto}'+
  M+'td,'+M+'th{overflow-wrap:anywhere}'+
  M+'h1{font-size:20px}'+M+'h2{font-size:18px}'+
  /* ③ 넓은 표 — 가로 스크롤 + 첫 열 고정 + 안내 */
  M+'table.rfx-wide th,'+M+'table.rfx-wide td{white-space:nowrap;padding:7px 9px;font-size:13px}'+
  M+'table.rfx-wide tr>*:first-child{position:sticky;left:0;z-index:1;background:var(--card,#fff);box-shadow:6px 0 8px -6px rgba(0,0,0,.28)}'+
  M+'table.rfx-wide thead tr>*:first-child{z-index:2;background:var(--rfxm-th,var(--card,#fff))}'+
  M+'table.rfx-wide.rfx-nostick tr>*:first-child{position:static;box-shadow:none}'+
  M+'.rfx-swipe{display:flex;align-items:center;gap:6px;margin:6px 0 4px;font-size:11.5px;font-weight:600;color:#8a7a55}'+
  M+'.rfx-swipe:before{content:"⇆";font-size:14px}'+
  '.rfx-swipe{display:none}'+M+'.rfx-swipe{display:flex}'+
  /* ④ 팝업 → 하단 시트 */
  M+'.rfx-sheetbg{align-items:flex-end!important;justify-content:stretch!important;padding:0!important}'+
  M+'.rfx-sheet{width:100%!important;max-width:100%!important;min-width:0!important;margin:0!important;'+
     'max-height:92vh!important;max-height:92dvh!important;overflow:auto!important;-webkit-overflow-scrolling:touch;'+
     'border-radius:16px 16px 0 0!important;padding-bottom:calc(14px + env(safe-area-inset-bottom))!important;'+
     'animation:rfxUp .18s ease-out}'+
  '@keyframes rfxUp{from{transform:translateY(24px);opacity:.6}to{transform:none;opacity:1}}'+
  M+'.rfx-sheet table{max-width:100%}'+
  /* ⑥ 넘치는 가로줄 → 줄바꿈 */
  M+'.rfx-wrap{flex-wrap:wrap!important;row-gap:8px}'+
  M+'.rfx-wrap>*{min-width:0;max-width:100%}'+
  M+'.rfx-wrap>[style*="margin-left:auto"]{margin-left:0!important}'+
  M+'.rfx-fit{max-width:100%!important;min-width:0!important;box-sizing:border-box}'+
  M+'input[type=file]{width:100%;min-width:0;max-width:100%}';
  var st=document.createElement('style'); st.id='rfx-mobile-css'; st.textContent=css;
  (document.head||document.documentElement).appendChild(st);

  function on(){ return document.documentElement.classList.contains('rfxm'); }
  function vw(){ return window.innerWidth||document.documentElement.clientWidth||390; }

  /* ③ 넓은 표 표시 */
  function markTables(){
    var ts=document.querySelectorAll('table');
    for(var i=0;i<ts.length;i++){
      var t=ts[i];
      if(t.closest('#rnav,#rmtab,#rmdrawer')) continue;
      if(!t.offsetParent && getComputedStyle(t).position!=='fixed') continue;   // 숨김 탭의 표는 건너뜀
      var wide=t.scrollWidth>t.clientWidth+4;
      t.classList.toggle('rfx-wide', wide);
      // 첫 열이 rowspan/colspan 이면 고정 시 겹침 → 고정하지 않음
      if(wide){
        // 고정하지 않는 경우: 본문 첫 칸 rowspan / 2단 머리글 / 첫 열이 화면 절반 이상(나머지가 안 보임)
        var ns=false;
        if(t.querySelector('tbody tr>*:first-child[rowspan]')) ns=true;
        else if(t.tHead && t.tHead.rows.length>1) ns=true;
        else{
          var rows=t.tBodies[0]?t.tBodies[0].rows:[], c=null;
          for(var r=0;r<rows.length;r++){ var fc=rows[r].cells[0]; if(fc && !(fc.colSpan>1)){ c=fc; break; } }
          if(c && c.getBoundingClientRect().width>vw()*0.5) ns=true;
        }
        t.classList.toggle('rfx-nostick', ns);
      }
      var prev=t.previousElementSibling, has=prev&&prev.classList&&prev.classList.contains('rfx-swipe');
      if(wide && !has){ var h=document.createElement('div'); h.className='rfx-swipe'; h.textContent='표를 옆으로 밀어서 보기 · Desliza'; t.parentNode.insertBefore(h,t); }
      else if(!wide && has){ prev.parentNode.removeChild(prev); }
    }
  }

  /* ④ 화면 전체를 덮는 팝업 배경 → 안쪽 상자를 시트로 */
  function markSheets(){
    var W=vw(), H=window.innerHeight||800;
    var all=document.body?document.body.querySelectorAll('div,section,dialog'):[];
    for(var i=0;i<all.length;i++){
      var el=all[i];
      if(el.id==='rnav'||el.id==='rmtab'||el.id==='rmdrawer'||el.closest('#rnav,#rmtab,#rmdrawer')) continue;
      if(el.offsetParent!==null) continue;                  // fixed/숨김 요소만 후보(빠른 필터)
      var s=getComputedStyle(el);
      if(s.position!=='fixed'||s.display==='none'||s.visibility==='hidden') continue;
      var r=el.getBoundingClientRect();
      if(r.width<W*0.95||r.height<H*0.9) continue;          // 화면 전체 배경만
      if(el.classList.contains('rfx-sheetbg')) continue;
      // 안쪽 상자: 보이는 첫 자식 요소
      var box=null;
      for(var j=0;j<el.children.length;j++){ var ch=el.children[j]; if(ch.tagName!=='SCRIPT'&&ch.tagName!=='STYLE'&&getComputedStyle(ch).display!=='none'){ box=ch; break; } }
      if(!box || box.getBoundingClientRect().height<60) continue;
      if(s.display!=='flex' && s.display!=='grid') continue;  // 가운데 정렬 배경만 안전하게 처리
      el.classList.add('rfx-sheetbg'); box.classList.add('rfx-sheet');
    }
  }

  /* ⑥ 화면보다 넓어진 가로(flex) 줄 → 줄바꿈 */
  function wrapRows(){
    var W=document.documentElement.clientWidth||vw();
    var root=document.body; if(!root) return;
    var els=root.querySelectorAll('div,form,section,fieldset,header,footer,nav,label,p,span');
    for(var i=0;i<els.length;i++){
      var el=els[i];
      if(el.classList.contains('rfx-wrap')) continue;
      if(el.closest('#rnav,#rmtab,#rmdrawer,table')) continue;
      var r=el.getBoundingClientRect(); if(!r.width) continue;
      if(r.right<=W+2 && el.scrollWidth<=el.clientWidth+2) continue;
      var s=getComputedStyle(el);
      if(s.display.indexOf('flex')<0 || s.flexDirection.indexOf('column')===0 || s.flexWrap!=='nowrap') continue;
      if(/(auto|scroll)/.test(s.overflowX)) continue;          // 의도된 가로 스크롤 줄은 유지
      el.classList.add('rfx-wrap');
    }
    // 줄바꿈 후에도 화면 밖으로 나간 상자 → 화면 폭에 맞춤(가장 바깥 것부터, 최대 3회)
    for(var pass=0;pass<3;pass++){
      var fixed=0;
      for(var k=0;k<els.length;k++){
        var e=els[k];
        if(e.classList.contains('rfx-fit')||e.closest('#rnav,#rmtab,#rmdrawer,table,.rfx-sheet')) continue;
        var rr=e.getBoundingClientRect(); if(!rr.width||rr.right<=W+2) continue;
        var es=getComputedStyle(e); if(es.position==='fixed'||es.position==='absolute') continue;
        var p=e.parentElement, inScroll=false;
        for(var q=p;q&&q!==document.body;q=q.parentElement){ if(/(auto|scroll)/.test(getComputedStyle(q).overflowX)){ inScroll=true; break; } }
        if(inScroll) continue;
        if(p&&p!==document.body&&p.getBoundingClientRect().right>W+2&&!p.classList.contains('rfx-fit')) continue;  // 바깥 상자부터
        e.classList.add('rfx-fit'); fixed++;
      }
      if(!fixed) break;
    }
  }

  var t=null;
  function run(){ t=null; if(!on()||!document.body) return; try{ wrapRows(); }catch(e){} try{ markTables(); }catch(e){} try{ markSheets(); }catch(e){} }
  function later(){ if(t) return; t=setTimeout(run,180); }
  function start(){
    run();
    try{ new MutationObserver(later).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','hidden','open']}); }catch(e){}
    window.addEventListener('resize', later);
    window.addEventListener('orientationchange', function(){ setTimeout(run,260); });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.__rfxMobileRun=run;
})();
