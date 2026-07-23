/* Refatrix 공유 고객 등록/수정 폼 모듈 — 영업·영업지원 화면이 동일 UX를 쓰도록 단일 소스
   사용법:
     RefCustForm.init({ api, token, isDirector, onSaved });
     RefCustForm.mount('hostElementId');     // 폼 렌더
     RefCustForm.newCustomer();              // 신규 모드(다음코드 자동)
     RefCustForm.editCustomer(custObject);   // 수정 모드(객체 채움)
   수정 저장은 비디렉터면 디렉터 승인 대기로 전송됩니다. */
(function(){
  var cfg={api:'',token:'',isDirector:false,onSaved:null};
  var teams=[], stages=[], owners=[], editingId=null, hostEl=null, origTerms=null;
  function auth(){ return {'Authorization':'Bearer '+cfg.token}; }
  function api(p){ return (cfg.api||'').replace(/\/+$/,'')+p; }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function $(id){ return hostEl?hostEl.querySelector('#'+id):document.getElementById(id); }

  function formHTML(){
    return ''
    +'<div class="rcf-form">'
    +'<div class="rcf-row">'
      +'<div class="rcf-f"><label>고객코드</label><input id="rcf-code" type="text" placeholder="자동"></div>'
      +'<div class="rcf-f rcf-grow"><label>고객명 *</label><input id="rcf-name" type="text"></div>'
      +'<div class="rcf-f"><label>팀 *</label><select id="rcf-team"></select></div>'
    +'</div>'
    +'<div class="rcf-row">'
      +'<div class="rcf-f"><label>RFC(세금번호)</label><input id="rcf-rfc" type="text"></div>'
      +'<div class="rcf-f"><label>회사 종류</label><select id="rcf-type"><option value="">미지정</option><option>refraccionaria</option><option>Mayoreo</option><option>Flotia</option><option>taller</option><option>publico</option></select></div>'
      +'<div class="rcf-f"><label>담당자</label><select id="rcf-owner"><option value="">미지정</option></select></div>'
      +'<div class="rcf-f"><label>단계</label><select id="rcf-stage"><option value="">미지정</option></select></div>'
    +'</div>'
    +'<div class="rcf-row">'
      +'<div class="rcf-f"><label>이메일 주소</label><input id="rcf-contact" type="email" placeholder="ejemplo@correo.com"></div>'
      +'<div class="rcf-f"><label>전화</label><input id="rcf-phone" type="text"></div>'
      +'<div class="rcf-f"><label>기본 할인(%)</label><input id="rcf-discount" type="number" step="0.01" value="0"></div>'
      +'<div class="rcf-f"><label>외상일(일)</label><input id="rcf-credit" type="number" value="0"></div>'
      +'<div class="rcf-f"><label>지점 수</label><input id="rcf-branches" type="number" min="0" placeholder="예: 3"></div>'
    +'</div>'
    +'<div id="rcf-termsbox" style="display:none;border:1px solid #e3b04b;background:#fffaf0;border-radius:9px;padding:10px 12px">'
      +'<div style="font-size:12px;font-weight:700;color:#9a6512;margin-bottom:6px">⚠ 기본 할인(%)·외상일 변경 — 수정이유와 제공 조건을 반드시 작성해야 합니다. <span id="rcf-termswhat"></span></div>'
      +'<div class="rcf-row">'
        +'<div class="rcf-f rcf-grow"><label>수정이유 *</label><textarea id="rcf-treason" rows="2" placeholder="예: 월 구매액 증가에 따른 할인율 상향"></textarea></div>'
        +'<div class="rcf-f rcf-grow"><label>제공 조건 *</label><textarea id="rcf-tcond" rows="2" placeholder="예: 월 최소 매입 $50,000 MXN 유지 조건"></textarea></div>'
      +'</div>'
      +'<div class="rcf-msg" id="rcf-termshint" style="color:#9a6512"></div>'
    +'</div>'
    +'<div class="rcf-row"><div class="rcf-f rcf-grow"><label>메모</label><input id="rcf-memo" type="text"></div></div>'
    +'<div class="rcf-row"><div class="rcf-f rcf-grow"><label>배송지 (Dirección de envío) — 포장 라벨·패킹리스트에 인쇄됩니다. 등록 주소와 달라도 됩니다.</label>'
      +'<textarea id="rcf-ship" rows="2" placeholder="예: Av. Insurgentes Sur 1234, Col. Del Valle, C.P. 03100, Benito Juárez, CDMX"></textarea>'
      +'<div class="rcf-shipbar"><button type="button" class="btn" id="rcf-shipsave" style="display:none">배송지 즉시 저장</button><span class="rcf-msg" id="rcf-shipmsg"></span></div>'
    +'</div></div>'
    +'<div class="rcf-row"><div class="rcf-f rcf-grow"><label>Constancia de Situación Fiscal (세무 등록상태)</label><input id="rcf-constancia" type="text" placeholder="예: RFC · Régimen · 등록상태"></div></div>'
    +'<div class="rcf-actions">'
      +'<button class="btn" id="rcf-save">저장</button>'
      +'<button class="btn ghost" id="rcf-cancel" style="display:none">취소</button>'
      +'<span class="rcf-msg" id="rcf-msg"></span>'
    +'</div>'
    +'</div>';
  }
  function styles(){
    if(document.getElementById('rcf-style')) return;
    var css=''
    +'.rcf-form{display:flex;flex-direction:column;gap:10px}'
    +'.rcf-row{display:flex;gap:10px;flex-wrap:wrap}'
    +'.rcf-f{flex:1;min-width:130px;display:flex;flex-direction:column;gap:3px}'
    +'.rcf-f.rcf-grow{flex:2.5}'
    +'.rcf-f label{font-size:11px;color:#6f6a60;font-weight:600}'
    +'.rcf-f input,.rcf-f select,.rcf-f textarea{padding:8px 9px;border:1px solid #ddd6c6;border-radius:7px;font-size:13px;background:#fff;font-family:inherit}'
    +'.rcf-f textarea{resize:vertical;min-height:44px;line-height:1.45}'
    +'.rcf-shipbar{display:flex;align-items:center;gap:8px;margin-top:4px}'
    +'.rcf-shipbar .btn{padding:5px 10px;font-size:12px}'
    +'.rcf-actions{display:flex;align-items:center;gap:10px;margin-top:4px}'
    +'.rcf-msg{font-size:12px}'
    +'.rcf-msg.ok{color:#1a7f4b}.rcf-msg.err{color:#B23A2E}.rcf-msg.pend{color:#9a6a1a}';
    var st=document.createElement('style'); st.id='rcf-style'; st.textContent=css; document.head.appendChild(st);
  }

  async function loadRefs(){
    try{ teams=(await fetch(api('/api/teams'),{headers:auth()}).then(r=>r.json())).items||[]; }catch(e){ teams=[]; }
    try{ stages=(await fetch(api('/api/stages'),{headers:auth()}).then(r=>r.json())).items||[]; }catch(e){ stages=[]; }
    try{ owners=(await fetch(api('/api/sales-users'),{headers:auth()}).then(r=>r.json())).items||[]; }catch(e){ owners=[]; }
    var t=$('rcf-team'); if(t) t.innerHTML=teams.map(function(x){return '<option value="'+x.id+'">'+esc(x.name)+'</option>';}).join('');
    var s=$('rcf-stage'); if(s) s.innerHTML='<option value="">미지정</option>'+stages.map(function(x){return '<option value="'+x.id+'">'+esc(x.name)+'</option>';}).join('');
    var o=$('rcf-owner'); if(o) o.innerHTML='<option value="">미지정</option>'+owners.map(function(x){return '<option value="'+x.id+'">'+esc(x.name)+'</option>';}).join('');
  }

  function setMsg(cls,txt){ var m=$('rcf-msg'); if(m){ m.className='rcf-msg '+(cls||''); m.textContent=txt||''; } }
  function setShipMsg(cls,txt){ var m=$('rcf-shipmsg'); if(m){ m.className='rcf-msg '+(cls||''); m.textContent=txt||''; } }

  // ===== 기본 할인(%)·외상일 변경 통제 =====
  function validEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); }
  // 수정 모드에서 할인/외상일이 원래 값과 달라졌는지 + 어떤 변경인지
  function termsDiff(){
    if(!editingId||!origTerms) return null;
    var nd=Number($('rcf-discount')&&$('rcf-discount').value)||0;
    var nc=Number($('rcf-credit')&&$('rcf-credit').value)||0;
    var parts=[];
    if(nd!==origTerms.discount) parts.push('기본할인 '+origTerms.discount+'% → '+nd+'%');
    if(nc!==origTerms.credit) parts.push('외상일 '+origTerms.credit+'일 → '+nc+'일');
    return parts.length?{parts:parts}:null;
  }
  // 변경 감지 시 수정이유·제공조건 입력 박스 표시/숨김
  function updateTermsBox(){
    var box=$('rcf-termsbox'); if(!box) return;
    var d=termsDiff();
    box.style.display=d?'':'none';
    var w=$('rcf-termswhat'); if(w) w.textContent=d?('('+d.parts.join(' · ')+')'):'';
    var h=$('rcf-termshint');
    if(h) h.textContent=d?(cfg.isDirector?'디렉터 수정: 작성 즉시 반영되며 변경이력에 기록됩니다.':'저장 시 디렉터 승인 대기로 전송되며, 승인 후 변경이력에 기록됩니다.'):'';
  }
  function clearTermsInputs(){ if($('rcf-treason'))$('rcf-treason').value=''; if($('rcf-tcond'))$('rcf-tcond').value=''; updateTermsBox(); }

  // 배송지 즉시 저장 — 승인 플로우 없이 바로 반영(라벨 인쇄용 운영 정보).
  async function saveShipAddress(){
    if(!editingId){ setShipMsg('pend','고객 등록 시 함께 저장됩니다.'); return true; }
    var v=$('rcf-ship')?$('rcf-ship').value.trim():'';
    var btn=$('rcf-shipsave'); if(btn) btn.disabled=true;
    try{
      var res=await fetch(api('/api/customers/'+editingId+'/ship-address'),{method:'PATCH',headers:{'Content-Type':'application/json',...auth()},body:JSON.stringify({ship_address:v||null})});
      var d=await res.json();
      if(!res.ok||d.error){ setShipMsg('err','배송지 저장 실패: '+(d.error||res.status)); if(btn)btn.disabled=false; return false; }
      setShipMsg('ok', v?'배송지 저장됨 (라벨에 인쇄됩니다)':'배송지 비움');
      if(btn)btn.disabled=false; return true;
    }catch(e){ setShipMsg('err','서버에 연결할 수 없습니다.'); if(btn)btn.disabled=false; return false; }
  }

  async function fillNew(){
    editingId=null;
    $('rcf-code').value='자동…'; $('rcf-code').readOnly=true; $('rcf-code').style.background='#f2efe8';
    try{ var d=await fetch(api('/api/customers/next-code'),{headers:auth()}).then(r=>r.json()); $('rcf-code').value=d.code||''; }catch(e){ $('rcf-code').value=''; }
    ['rcf-name','rcf-rfc','rcf-contact','rcf-phone','rcf-memo','rcf-constancia','rcf-ship'].forEach(function(id){ if($(id))$(id).value=''; });
    if($('rcf-shipsave')) $('rcf-shipsave').style.display='none';
    setShipMsg('','');
    if($('rcf-team')) $('rcf-team').value=(teams[0]&&teams[0].id)||'';
    if($('rcf-type')) $('rcf-type').value=''; if($('rcf-owner')) $('rcf-owner').value=''; if($('rcf-stage')) $('rcf-stage').value='';
    if($('rcf-discount')) $('rcf-discount').value=0; if($('rcf-credit')) $('rcf-credit').value=0;
    if($('rcf-branches')) $('rcf-branches').value='';
    origTerms=null; clearTermsInputs();
    $('rcf-save').textContent='고객 등록';
    if($('rcf-cancel')) $('rcf-cancel').style.display='none';
    setMsg('','');
  }
  function fillEdit(c){
    editingId=c.id;
    $('rcf-code').value=c.code||''; $('rcf-code').readOnly=true; $('rcf-code').style.background='#f2efe8';
    $('rcf-name').value=c.name||''; $('rcf-rfc').value=c.rfc||''; $('rcf-contact').value=c.contact||'';
    $('rcf-phone').value=c.phone||''; $('rcf-memo').value=c.memo||''; $('rcf-constancia').value=c.constancia_fiscal||'';
    if($('rcf-ship')) $('rcf-ship').value=c.ship_address||'';
    if($('rcf-shipsave')) $('rcf-shipsave').style.display='';
    setShipMsg('','');
    if($('rcf-team')) $('rcf-team').value=c.team_id||''; if($('rcf-type')) $('rcf-type').value=c.customer_type||'';
    if($('rcf-owner')) $('rcf-owner').value=c.owner_id||''; if($('rcf-stage')) $('rcf-stage').value=c.stage_id||'';
    if($('rcf-discount')) $('rcf-discount').value=(c.discount!=null?c.discount:0);
    if($('rcf-credit')) $('rcf-credit').value=(c.credit_days!=null?c.credit_days:0);
    if($('rcf-branches')) $('rcf-branches').value=(c.branch_count!=null?c.branch_count:'');
    origTerms={discount:Number(c.discount)||0, credit:Number(c.credit_days)||0};
    clearTermsInputs();
    $('rcf-save').textContent=cfg.isDirector?'수정 저장':'수정 요청(디렉터 승인)';
    if($('rcf-cancel')) $('rcf-cancel').style.display='';
    setMsg('','');
  }

  function readBody(){
    return {
      code:$('rcf-code').value.trim(), name:$('rcf-name').value.trim(),
      team_id:$('rcf-team').value?Number($('rcf-team').value):null,
      rfc:$('rcf-rfc').value.trim()||null, customer_type:$('rcf-type').value||null,
      owner_id:$('rcf-owner').value?Number($('rcf-owner').value):null,
      stage_id:$('rcf-stage').value?Number($('rcf-stage').value):null,
      contact:$('rcf-contact').value.trim()||null, phone:$('rcf-phone').value.trim()||null,
      discount:Number($('rcf-discount').value)||0, credit_days:Number($('rcf-credit').value)||0,
      branch_count:($('rcf-branches')&&$('rcf-branches').value!=='')?Number($('rcf-branches').value):null,
      memo:$('rcf-memo').value.trim()||null, constancia_fiscal:$('rcf-constancia').value.trim()||null,
      ship_address:($('rcf-ship')&&$('rcf-ship').value.trim())||null,
    };
  }

  async function save(){
    var b=readBody();
    if(!b.name){ setMsg('err','고객명을 입력하세요.'); return; }
    if(!b.team_id){ setMsg('err','팀을 선택하세요.'); return; }
    if(b.contact&&!validEmail(b.contact)){ setMsg('err','이메일 주소 형식이 올바르지 않습니다. (예: ejemplo@correo.com)'); return; }
    // 기본할인·외상일 변경 → 수정이유·제공조건 필수
    var td=termsDiff();
    if(td){
      var tr=$('rcf-treason')?$('rcf-treason').value.trim():'';
      var tc=$('rcf-tcond')?$('rcf-tcond').value.trim():'';
      if(!tr||!tc){ updateTermsBox(); setMsg('err','기본할인·외상일 변경 시 수정이유와 제공 조건을 모두 작성해야 합니다.'); return; }
      b.terms_reason=tr; b.terms_conditions=tc;
    }
    $('rcf-save').disabled=true;
    try{
      // 수정 모드: 배송지는 승인 대기 없이 즉시 저장(전용 엔드포인트) — 나머지 필드는 기존 흐름 유지.
      if(editingId) await saveShipAddress();
      var url=editingId?api('/api/customers/'+editingId):api('/api/customers');
      var method=editingId?'PATCH':'POST';
      var res=await fetch(url,{method:method,headers:{'Content-Type':'application/json',...auth()},body:JSON.stringify(b)});
      var d=await res.json();
      if(!res.ok||d.error){
        var msg=d.error==='code_exists'||d.error==='code_taken'?'이미 있는 고객코드입니다.'
          :d.error==='forbidden_team'?'그 팀의 고객을 만들/수정할 권한이 없습니다.'
          :d.error==='terms_reason_required'?(d.note||'기본할인·외상일 변경 시 수정이유와 제공 조건을 반드시 입력해야 합니다.')
          :('실패: '+(d.detail||d.error||res.status));
        setMsg('err',msg); $('rcf-save').disabled=false; return;
      }
      if(d.pending){ setMsg('pend', td?'수정 요청을 보냈습니다. 할인·외상일 변경은 디렉터 승인 후 반영·이력 기록됩니다.':'수정 요청을 보냈습니다. 디렉터 승인 후 반영됩니다.'); }
      else { setMsg('ok', editingId?(td?'수정되었습니다. 할인·외상일 변경이 이력에 기록되었습니다.':'수정되었습니다.'):('등록되었습니다: '+(d.code||b.code||'')+' · '+b.name)); }
      $('rcf-save').disabled=false;
      if(typeof cfg.onSaved==='function') cfg.onSaved(d, editingId, !!d.pending);
      if(!editingId) fillNew();
    }catch(e){ setMsg('err','서버에 연결할 수 없습니다.'); $('rcf-save').disabled=false; }
  }

  window.RefCustForm={
    init:function(o){ cfg.api=o.api||''; cfg.token=o.token||''; cfg.isDirector=!!o.isDirector; cfg.onSaved=o.onSaved||null; },
    mount:async function(hostId, opts){
      styles();
      hostEl=document.getElementById(hostId); if(!hostEl) return;
      hostEl.innerHTML=formHTML();
      $('rcf-save').addEventListener('click', save);
      var di=$('rcf-discount'); if(di) di.addEventListener('input', updateTermsBox);
      var ci=$('rcf-credit'); if(ci) ci.addEventListener('input', updateTermsBox);
      var sb=$('rcf-shipsave'); if(sb) sb.addEventListener('click', saveShipAddress);
      var cb=$('rcf-cancel'); if(cb) cb.addEventListener('click', function(){ if(opts&&opts.onCancel)opts.onCancel(); fillNew(); });
      await loadRefs();
      await fillNew();
    },
    newCustomer:function(){ return fillNew(); },
    editCustomer:function(c){ fillEdit(c); },
    reloadRefs:loadRefs,
  };
  try{ console.log('[refatrix-custform] v20260723b loaded (이메일 주소 + 할인·외상일 이유/조건 필수)'); }catch(e){}
})();
