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
  // 타팀 고객 수정요청 모드 — 열람 범위를 넓히지 않고 "요청"만 넣는 경로.
  //   배송지 즉시저장은 승인 우회가 되므로 이 모드에선 잠근다.
  var crossTeam=false;
  function auth(){ return {'Authorization':'Bearer '+cfg.token}; }
  function api(p){ return (cfg.api||'').replace(/\/+$/,'')+p; }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function $(id){ return hostEl?hostEl.querySelector('#'+id):document.getElementById(id); }

  function formHTML(){
    return ''
    +'<div class="rcf-form">'
    +'<div id="rcf-crossbox" style="display:none;border:1px solid #9ab8d8;background:#eef4fb;border-radius:9px;padding:10px 12px">'
      +'<div style="font-size:12.5px;font-weight:700;color:#20486f">🔁 다른 팀 고객 수정 요청 <span id="rcf-crosswho" style="font-weight:600"></span></div>'
      +'<div style="font-size:12px;color:#3c5f85;margin-top:3px">이 고객은 다른 팀 소속입니다. 저장하면 <b>바로 반영되지 않고 디렉터 승인 대기</b>로 넘어갑니다. 본인 담당으로 가져오려면 <b>담당자</b>를 본인으로, <b>팀</b>을 본인 팀으로 바꿔서 요청하세요.</div>'
      +'<div id="rcf-crosspend" style="font-size:12px;color:#9a6512;margin-top:4px"></div>'
    +'</div>'
    +'<div class="rcf-row">'
      +'<div class="rcf-f"><label>고객코드</label><input id="rcf-code" type="text" placeholder="자동"></div>'
      +'<div class="rcf-f rcf-grow"><label>고객명 *</label><input id="rcf-name" type="text"></div>'
      +'<div class="rcf-f"><label>팀 *</label><select id="rcf-team"></select></div>'
    +'</div>'
    +'<div class="rcf-row">'
      +'<div class="rcf-f"><label>RFC(세금번호)<span id="rcf-rfckey" style="color:#1f5540;font-weight:700;display:none"> — 선택 · 입력하면 그 순간 선점</span></label><input id="rcf-rfc" type="text" placeholder="예: ABC010203XY1"><div id="rcf-rfcmsg" style="font-size:11px;margin-top:3px"></div></div>'
      +'<div class="rcf-f"><label>회사 종류</label><select id="rcf-type"><option value="">미지정</option><option>refraccionaria</option><option>Mayoreo</option><option>Flotia</option><option>taller</option><option>publico</option></select></div>'
      +'<div class="rcf-f"><label>담당자</label><select id="rcf-owner"><option value="">미지정</option></select></div>'
      +'<div class="rcf-f"><label>단계</label><select id="rcf-stage"><option value="">미지정</option></select></div>'
    +'</div>'
    +'<div class="rcf-row">'
      +'<div class="rcf-f"><label>이메일 주소</label><input id="rcf-contact" type="email" placeholder="ejemplo@correo.com"></div>'
      +'<div class="rcf-f"><label>전화 (인보이스 수신)</label><input id="rcf-phone" type="text"></div>'
      +'<div class="rcf-f"><label>구매결정권자 이름</label><input id="rcf-buyername" type="text" placeholder="오퍼시트 수신인"></div>'
      +'<div class="rcf-f"><label>구매결정권자 전화(WhatsApp)</label><input id="rcf-buyerphone" type="text" placeholder="없으면 기본 전화로 발송"></div>'
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
    // ===== 0188 · 고객 선점(claim) — RFC 입력이 곧 선점 =====
    +'<div id="rcf-claimbox" style="display:none;border:1px solid #7a9c8b;background:#f2f8f5;border-radius:9px;padding:11px 12px">'
      +'<div style="font-size:12.5px;font-weight:700;color:#1f5540;margin-bottom:2px">🔒 내 고객 선점 — RFC 입력 시점이 우선권</div>'
      +'<div style="font-size:11.5px;color:#3f6b58;margin-bottom:8px">RFC 는 <b>선택</b>입니다 — 없어도 등록됩니다. 다만 <b>RFC 를 넣는 순간 그 고객이 내 고객으로 잠깁니다.</b> RFC 없이 등록하면 선점이 없고, 나중에 <b>다른 영업사원이 이 고객에 RFC 를 먼저 입력하면 그 사람에게 우선권</b>이 갑니다. CONSTANCIA 는 선택이며 나중에 고객 상세의 증빙서류에서 올려도 됩니다.</div>'
      +'<div class="rcf-row">'
        +'<div class="rcf-f rcf-grow"><label>CONSTANCIA 번호 (선택)</label><input id="rcf-conno" type="text" placeholder="스캔본에 인쇄된 번호 — 넣으면 이 번호도 함께 잠깁니다"></div>'
        +'<div class="rcf-f rcf-grow"><label>CONSTANCIA 스캔본 (선택 · PDF)</label><input id="rcf-confile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" style="padding:6px 4px"></div>'
        +'<div class="rcf-f" style="flex:0 0 auto;justify-content:flex-end"><button type="button" class="btn ghost" id="rcf-claimbtn" style="padding:8px 12px">선점 확인</button></div>'
      +'</div>'
      +'<div id="rcf-claimres" style="font-size:12px;margin-top:6px"></div>'
    +'</div>'
    // ===== 0185 · 기준품목 구매단가 → 할인율 제안 =====
    +'<div id="rcf-basebox" style="display:none;border:1px solid #c9a227;background:#fffdf4;border-radius:9px;padding:11px 12px">'
      +'<div style="font-size:12.5px;font-weight:700;color:#7a6212;margin-bottom:2px">💲 기준품목 구매단가 → 할인율 산출 (필수)</div>'
      +'<div style="font-size:11.5px;color:#8a7328;margin-bottom:8px">이 고객이 경쟁사(SYD) 기준품목을 <b>얼마에 사는지</b> 입력하면, 우리 제품을 그 가격보다 5% 싸게 주기 위한 할인율을 제안합니다.</div>'
      +'<div class="rcf-row">'
        +'<div class="rcf-f"><label>기준품목 (SYD 코드)</label><input id="rcf-basecode" type="text" value="1516049" style="font-family:ui-monospace,Consolas,monospace;font-weight:700"></div>'
        +'<div class="rcf-f"><label>고객 구매단가 (MXN) *</label><input id="rcf-baseprice" type="number" step="0.01" min="0" placeholder="0.00" style="text-align:right;font-weight:700"></div>'
        +'<div class="rcf-f" style="flex:0 0 auto;justify-content:flex-end"><button type="button" class="btn ghost" id="rcf-basecalc" style="padding:8px 12px">계산</button></div>'
      +'</div>'
      +'<div id="rcf-basepanel" style="margin-top:8px"></div>'
    +'</div>'
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
    +'.rcf-msg.ok{color:#1a7f4b}.rcf-msg.err{color:#B23A2E}.rcf-msg.pend{color:#9a6a1a}.rcf-msg.warn{color:#9a6a1a;font-weight:700}'
    +'.rcf-pp{display:flex;gap:8px;flex-wrap:wrap;align-items:stretch}'
    +'.rcf-pp .c{flex:1;min-width:132px;border:1px solid #e6dfc9;border-radius:8px;background:#fff;padding:8px 10px}'
    +'.rcf-pp .c .t{font-size:10.5px;color:#8a7f6a;font-weight:700;letter-spacing:.2px}'
    +'.rcf-pp .c .v{font-size:17px;font-weight:800;margin-top:2px;font-variant-numeric:tabular-nums}'
    +'.rcf-pp .c .s{font-size:10.5px;color:#9a9080;margin-top:2px}'
    +'.rcf-pp .c.hi{border-color:#c9a227;background:#fffaf0}.rcf-pp .c.hi .v{color:#7a6212}'
    +'.rcf-claimrow{border:1px solid #e0d8c6;border-radius:7px;padding:6px 9px;margin-top:5px;background:#fff;font-size:12px}'
    +'.rcf-claimrow.bad{border-color:#B23A2E;background:#fdf3f2}';
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

  // ===== 0188 · RFC 형식 검증 (서버 src/customerClaim.js validateRfc 와 같은 규칙) =====
  //   RFC 입력이 곧 선점이므로, 아무 문자열이나 통과하면 선점 장치가 무의미해진다.
  var RFC_RE=/^([A-ZÑ&]{3,4})(\d{2})(\d{2})(\d{2})([A-Z\d]{3})$/;
  var GENERIC_RFC=['XAXX010101000','XEXX010101000'];
  var RFC_NOTE={
    rfc_required:'RFC(세금번호)를 입력하세요 — RFC 가 곧 선점 키입니다.',
    rfc_invalid:'RFC 형식이 올바르지 않습니다. 법인 12자리(영문 3 + YYMMDD + 3) 또는 개인 13자리(영문 4 + YYMMDD + 3)여야 합니다.',
    rfc_invalid_date:'RFC 가운데 6자리(YYMMDD)의 월·일이 올바르지 않습니다. 다시 확인하세요.',
    rfc_generic:'범용 RFC(XAXX010101000 · XEXX010101000)로는 고객을 선점할 수 없습니다. 고객 고유의 RFC 를 입력하세요.',
    rfc_taken:'이미 다른 영업사원이 선점한 RFC 입니다.',
    rfc_claim_pending:'이 RFC 로는 이미 다른 영업사원의 선점 요청이 디렉터 승인 대기 중입니다 — 먼저 입력한 사람에게 우선권이 있습니다.',
    rfc_already_set:'이 고객에는 이미 RFC 가 등록되어 있습니다(=선점 완료).'
  };
  function cleanRfcLocal(v){ return String(v==null?'':v).toUpperCase().replace(/[\s\-._/]/g,'').trim(); }
  function validateRfcLocal(v){
    var t=cleanRfcLocal(v);
    if(!t) return {ok:false,error:'rfc_required'};
    if(GENERIC_RFC.indexOf(t)>=0) return {ok:false,error:'rfc_generic'};
    var m=RFC_RE.exec(t); if(!m) return {ok:false,error:'rfc_invalid'};
    var mm=Number(m[3]), dd=Number(m[4]);
    if(mm<1||mm>12||dd<1||dd>31) return {ok:false,error:'rfc_invalid_date'};
    return {ok:true,value:t,kind:m[1].length===3?'moral':'fisica'};
  }
  function showRfcMsg(rv){
    var el=$('rcf-rfcmsg'); if(!el) return;
    // 0193 · 비어 있으면 오류가 아니라 「선점 없음」 경고다(등록은 된다).
    if(rv==='empty'){ el.innerHTML='<span style="color:#9a6a1a">⚠ RFC 없이 등록됩니다 — 아직 선점되지 않습니다.</span>'; return; }
    if(!rv){ el.innerHTML=''; return; }
    el.innerHTML=rv.ok
      ? '<span style="color:#1a7f4b">✔ '+(rv.kind==='moral'?'법인 RFC':'개인 RFC')+' 형식 OK</span>'
      : '<span style="color:#B23A2E">'+esc(RFC_NOTE[rv.error]||'RFC 를 확인하세요.')+'</span>';
  }

  // ===== 0185/0188 · 선점 확인 =====
  //   자기 고객을 지키는 장치이자, 남의 고객을 모르고 건드리지 않게 하는 장치.
  //   서버는 **상호 · RFC · 담당 영업사원 · 등록일**만 내려준다(매출·상담은 절대 안 나옴).
  var lastClaim=null;
  function fmtMx(n){ if(n==null||n==='')return '—'; var v=Number(n); if(!isFinite(v))return '—';
    return '$'+v.toLocaleString('es-MX',{minimumFractionDigits:2,maximumFractionDigits:2}); }
  function fmtPct(n){ if(n==null||n==='')return '—'; var v=Number(n); return isFinite(v)?(v.toFixed(1)+'%'):'—'; }

  async function claimCheck(silent){
    var box=$('rcf-claimres'); if(!box) return null;
    var nm=($('rcf-name')&&$('rcf-name').value.trim())||'';
    var rfc=($('rcf-rfc')&&$('rcf-rfc').value.trim())||'';
    var con=($('rcf-conno')&&$('rcf-conno').value.trim())||'';
    if(!nm&&!rfc&&!con){ box.innerHTML=silent?'':'<span style="color:#B23A2E">RFC(또는 고객명)를 입력하고 확인하세요.</span>'; return null; }
    box.innerHTML='<span style="color:#6f6a60">확인 중…</span>';
    try{
      var qs='name='+encodeURIComponent(nm)+'&rfc='+encodeURIComponent(rfc)+'&constancia='+encodeURIComponent(con);
      var d=await fetch(api('/api/customers/claim-check?'+qs),{headers:auth()}).then(function(r){return r.json();});
      lastClaim=d;
      var items=(d&&d.items)||[];
      var myRfc=cleanRfcLocal(rfc);
      if(!items.length){
        box.innerHTML=(myRfc
            ? '<span style="color:#1a7f4b">✔ 겹치는 고객이 없습니다 — 이 RFC 로 등록하면 내 고객으로 선점됩니다.</span>'
            : '<span style="color:#9a6a1a">⚠ 겹치는 고객은 없지만 RFC 가 비어 있어 <b>선점되지 않습니다.</b> RFC 를 받는 대로 입력하세요.</span>')
          +(d&&d.rfc_db_lock===false?'<div style="color:#9a6a1a;margin-top:3px">⚠ 서버에 RFC 선점 잠금(0188)이 아직 적용되지 않았습니다. 디렉터에게 알려 주세요.</div>':'');
        return d;
      }
      // 0193 · RFC 충돌은 차단, 상호 유사는 경고만.
      var hard=d.blocked_constancia||d.blocked_rfc;
      box.innerHTML=(hard
          ? '<div style="color:#B23A2E;font-weight:700">⛔ '+esc(d.claim_pending?(d.claim_pending_note||RFC_NOTE.rfc_claim_pending):'이미 선점된 고객입니다 — 이대로는 등록할 수 없습니다.')+'</div>'
          : '<div style="color:#9a6a1a;font-weight:700">⚠ 상호가 비슷한 고객이 있습니다 — 같은 고객인지 확인하세요. (등록은 막지 않습니다)</div>')
        +items.map(function(x){
          var why=x.matched_rfc?'RFC 일치 — 선점됨':(x.matched_constancia?'CONSTANCIA 일치':'상호 유사');
          var st=x.approval_status==='pending'?' · <span style="color:#9a6a1a">승인대기</span>':'';
          // RFC 가 비어 있는 고객 = 아직 선점 없음 → 내 RFC 로 가져올 수 있다.
          var take=(!x.has_rfc&&x.customer_id&&myRfc&&d.claim_transfer_on)
            ? '<button type="button" class="btn ghost rcf-take" data-cid="'+x.customer_id+'" data-nm="'+esc(x.name)+'" style="padding:4px 9px;font-size:11.5px;margin-left:6px">이 고객을 내 RFC 로 선점</button>'
            : (!x.has_rfc?'<span style="color:#9a6a1a;margin-left:6px">(RFC 없음 — 선점 안 된 고객)</span>':'');
          return '<div class="rcf-claimrow'+((x.matched_constancia||x.matched_rfc)?' bad':'')+'">'
            +'<b>'+esc(x.name)+'</b> · RFC '+esc(x.rfc||'—')
            +' · 담당 <b>'+esc(x.owner_name)+'</b> · 등록 '+esc(x.registered_at||'—')
            +' <span style="color:#8a8070">('+why+')</span>'+st+take+'</div>';
        }).join('');
      bindTakeButtons();
      return d;
    }catch(e){ box.innerHTML='<span style="color:#B23A2E">선점 확인 실패 — 서버에 연결할 수 없습니다.</span>'; return null; }
  }

  // ===== 0193 · 「이 고객을 내 RFC 로 선점」 =====
  //   RFC 없이 등록돼 있는 고객에 내 RFC 를 넣는다. 내 고객이면 즉시 확정,
  //   남의 고객이면 요청 시각이 우선권 근거로 남고 디렉터 승인에서 담당이 이관된다.
  function bindTakeButtons(){
    var box=$('rcf-claimres'); if(!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('.rcf-take'), function(btn){
      btn.addEventListener('click', async function(){
        var cid=btn.getAttribute('data-cid'), nm=btn.getAttribute('data-nm')||'';
        var rv=validateRfcLocal(($('rcf-rfc')&&$('rcf-rfc').value)||'');
        if(!rv.ok){ showRfcMsg(rv); setMsg('err',RFC_NOTE[rv.error]||'RFC 를 확인하세요.'); return; }
        if(!window.confirm(nm+' 을(를) RFC '+rv.value+' 로 선점 요청합니다.\n\n· 내가 담당인 고객이면 즉시 확정됩니다.\n· 남이 담당인 고객이면 디렉터 승인 후 담당이 나에게 이관됩니다.\n· 요청 시각이 우선권의 근거가 됩니다.')) return;
        btn.disabled=true;
        try{
          var res=await fetch(api('/api/customers/'+cid+'/rfc-claim'),
            {method:'POST',headers:{'Content-Type':'application/json',...auth()},body:JSON.stringify({rfc:rv.value})});
          var d=await res.json();
          if(!res.ok||d.error){
            setMsg('err', d.note||RFC_NOTE[d.error]||('선점 요청 실패: '+(d.error||res.status)));
            btn.disabled=false; return;
          }
          setMsg(d.applied?'ok':'pend', d.note||'선점 요청을 보냈습니다.');
          await claimCheck(true);
          if(typeof cfg.onSaved==='function') cfg.onSaved(d, Number(cid), !d.applied);
        }catch(e){ setMsg('err','서버에 연결할 수 없습니다.'); btn.disabled=false; }
      });
    });
  }

  // ===== 0185 · 기준품목 구매단가 → 할인율 산출/제안 =====
  var lastCalc=null;
  async function baseCalc(){
    var panel=$('rcf-basepanel'); if(!panel) return null;
    var code=($('rcf-basecode')&&$('rcf-basecode').value.trim())||'';
    var buy=($('rcf-baseprice')&&$('rcf-baseprice').value)||'';
    if(!code){ panel.innerHTML='<span style="color:#B23A2E">기준품목 코드를 입력하세요.</span>'; return null; }
    if(!buy||Number(buy)<=0){ panel.innerHTML='<span style="color:#8a7328">구매단가를 입력하면 할인율을 계산합니다.</span>'; return null; }
    panel.innerHTML='<span style="color:#6f6a60">계산 중…</span>';
    try{
      var d=await fetch(api('/api/customers/price-baseline?code='+encodeURIComponent(code)+'&buy='+encodeURIComponent(buy)),{headers:auth()})
              .then(function(r){return r.json();});
      if(!d||!d.found){ lastCalc=null; panel.innerHTML='<span style="color:#B23A2E">기준품목 '+esc(code)+' 을(를) 제품 마스터에서 찾지 못했습니다.</span>'; return null; }
      lastCalc=d;
      var c=d.calc||{};
      var noteMap={ buy_above_list:'⚠ 구매단가가 SYD 정가보다 높습니다 — 입력값을 확인하세요.',
        ctr_already_cheaper:'ℹ CTR 정가가 이미 목표가보다 쌉니다 — 할인 0% 로도 이깁니다.',
        discount_capped:'⚠ 할인율이 상한(95%)에 걸렸습니다.',
        suggested_capped:'⚠ 제안 할인율이 상한(95%)에 걸렸습니다.' };
      var errMap={ syd_list_price_missing:'이 기준품목의 SYD List Price 가 제품 마스터에 없습니다.',
        ctr_list_price_missing:'매칭된 CTR 제품의 List Price 가 없습니다 — 제안 할인율을 계산할 수 없습니다.',
        buy_price_required:'구매단가를 입력하세요.' };
      panel.innerHTML=''
        +'<div class="rcf-pp">'
          +'<div class="c"><div class="t">SYD LIST PRICE</div><div class="v">'+fmtMx(d.syd_list_price)+'</div><div class="s">'+esc(d.base_code)+'</div></div>'
          +'<div class="c"><div class="t">고객이 받는 SYD 할인율</div><div class="v">'+fmtPct(c.syd_discount)+'</div><div class="s">1 − 구매단가 ÷ 정가</div></div>'
          +'<div class="c"><div class="t">우리 목표 판매단가</div><div class="v">'+fmtMx(c.target_price)+'</div><div class="s">구매단가 × 0.95 (5% 우위)</div></div>'
          +'<div class="c"><div class="t">CTR LIST PRICE</div><div class="v">'+fmtMx(d.ctr_list_price)+'</div><div class="s">'+esc(d.ctr_code||'—')+'</div></div>'
          +'<div class="c hi"><div class="t">▶ 제안 할인율 (CTR 정가 대비)</div><div class="v">'+fmtPct(c.suggested_discount)+'</div>'
            +'<div class="s">이 할인율이면 판매가 '+fmtMx(c.suggested_price)+'</div></div>'
        +'</div>'
        +(c.error?'<div style="color:#B23A2E;font-size:12px;margin-top:6px">'+esc(errMap[c.error]||c.error)+'</div>':'')
        +(c.note?'<div style="color:#8a7328;font-size:12px;margin-top:6px">'+esc(noteMap[c.note]||c.note)+'</div>':'')
        +'<div style="margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
          +(c.suggested_discount!=null?'<button type="button" class="btn" id="rcf-applysugg" style="padding:6px 11px;font-size:12px">제안 할인율 '+fmtPct(c.suggested_discount)+' 적용</button>':'')
          +'<span style="font-size:11.5px;color:#8a7f6a">최종 할인율은 등록자가 정하고, 디렉터 승인 시 확정됩니다.</span>'
        +'</div>';
      var ab=$('rcf-applysugg');
      if(ab) ab.addEventListener('click',function(){
        if($('rcf-discount')){ $('rcf-discount').value=c.suggested_discount; updateTermsBox(); }
        setMsg('ok','제안 할인율 '+fmtPct(c.suggested_discount)+' 을(를) 기본 할인에 적용했습니다.');
      });
      return d;
    }catch(e){ lastCalc=null; panel.innerHTML='<span style="color:#B23A2E">계산 실패 — 서버에 연결할 수 없습니다.</span>'; return null; }
  }

  // 파일 → base64 (data URL 접두부 제거)
  function readFileB64(file){
    return new Promise(function(resolve,reject){
      var fr=new FileReader();
      fr.onload=function(){ var s=String(fr.result||''); var i=s.indexOf(','); resolve(i>=0?s.slice(i+1):s); };
      fr.onerror=function(){ reject(new Error('read_failed')); };
      fr.readAsDataURL(file);
    });
  }

  // 배송지 즉시 저장 — 승인 플로우 없이 바로 반영(라벨 인쇄용 운영 정보).
  async function saveShipAddress(){
    if(!editingId){ setShipMsg('pend','고객 등록 시 함께 저장됩니다.'); return true; }
    var v=$('rcf-ship')?$('rcf-ship').value.trim():'';
    var btn=$('rcf-shipsave'); if(btn) btn.disabled=true;
    try{
      var res=await fetch(api('/api/customers/'+editingId+'/ship-address'),{method:'PATCH',headers:{'Content-Type':'application/json',...auth()},body:JSON.stringify({ship_address:v||null})});
      var d=await res.json();
      // 담당 팀이 아니면 배송지 즉시저장은 원래 막혀 있다(승인 우회 방지).
      //   이건 "실패"가 아니라 설계된 제약이므로 빨간 오류 대신 안내로 표시하고,
      //   나머지 항목의 수정 요청 흐름은 그대로 진행시킨다(2026-08-24: 타팀 고객을
      //   일반 목록에서 열어 수정할 때 빨간 forbidden_team 문구가 뜨던 문제).
      if(res.status===403&&(d.error==='forbidden_team'||d.error==='forbidden')){
        setShipMsg('pend','배송지는 담당 팀에서 수정합니다 — 나머지 변경은 그대로 요청됩니다.');
        if(btn)btn.disabled=false; return true;
      }
      if(!res.ok||d.error){ setShipMsg('err','배송지 저장 실패: '+(d.error||res.status)); if(btn)btn.disabled=false; return false; }
      setShipMsg('ok', v?'배송지 저장됨 (라벨에 인쇄됩니다)':'배송지 비움');
      if(btn)btn.disabled=false; return true;
    }catch(e){ setShipMsg('err','서버에 연결할 수 없습니다.'); if(btn)btn.disabled=false; return false; }
  }

  async function fillNew(){
    editingId=null; crossTeam=false; applyCrossTeamUI(null,null);
    $('rcf-code').value='자동…'; $('rcf-code').readOnly=true; $('rcf-code').style.background='#f2efe8';
    try{ var d=await fetch(api('/api/customers/next-code'),{headers:auth()}).then(r=>r.json()); $('rcf-code').value=d.code||''; }catch(e){ $('rcf-code').value=''; }
    ['rcf-name','rcf-rfc','rcf-contact','rcf-phone','rcf-buyername','rcf-buyerphone','rcf-memo','rcf-constancia','rcf-ship'].forEach(function(id){ if($(id))$(id).value=''; });
    if($('rcf-shipsave')) $('rcf-shipsave').style.display='none';
    setShipMsg('','');
    if($('rcf-team')) $('rcf-team').value=(teams[0]&&teams[0].id)||'';
    if($('rcf-type')) $('rcf-type').value=''; if($('rcf-owner')) $('rcf-owner').value=''; if($('rcf-stage')) $('rcf-stage').value='';
    if($('rcf-discount')) $('rcf-discount').value=0; if($('rcf-credit')) $('rcf-credit').value=0;
    if($('rcf-branches')) $('rcf-branches').value='';
    // 0185 · 선점 + 기준품목 패널은 신규 등록에서만 노출(수정은 기존 승인 흐름 그대로)
    setRegBoxes(true);
    origTerms=null; clearTermsInputs();
    $('rcf-save').textContent='고객 등록 (디렉터 승인)';
    if($('rcf-cancel')) $('rcf-cancel').style.display='none';
    setMsg('','');
  }
  // 담당자 드롭다운은 /api/sales-users(팀 스코프) 기준이라, 타팀 고객의 현재 담당자가
  // 목록에 없을 수 있다. 그대로 두면 선택이 비어 "담당자 → 미지정" 을 실수로 요청하게 되므로
  // 현재 담당자를 옵션으로 한 번 끼워 넣는다(표시 전용).
  function ensureOwnerOption(id,name){
    var o=$('rcf-owner'); if(!o||!id) return;
    if(o.querySelector('option[value="'+String(id)+'"]')) return;
    var op=document.createElement('option');
    op.value=String(id); op.textContent=(name||('사용자 #'+id))+' (타팀)';
    o.appendChild(op);
  }
  // 신규 등록에서만 선점·기준품목 박스를 띄운다.
  function setRegBoxes(isNew){
    var cb=$('rcf-claimbox'); if(cb) cb.style.display=isNew?'':'none';
    var bb=$('rcf-basebox'); if(bb) bb.style.display=isNew?'':'none';
    if(isNew){
      if($('rcf-conno')) $('rcf-conno').value='';
      if($('rcf-confile')) $('rcf-confile').value='';
      if($('rcf-baseprice')) $('rcf-baseprice').value='';
      if($('rcf-claimres')) $('rcf-claimres').innerHTML='';
      if($('rcf-basepanel')) $('rcf-basepanel').innerHTML='';
      if($('rcf-rfcmsg')) $('rcf-rfcmsg').innerHTML='';
    }
    var kb=$('rcf-rfckey'); if(kb) kb.style.display=isNew?'':'none';
    if(!isNew&&$('rcf-rfcmsg')) $('rcf-rfcmsg').innerHTML='';   // 수정에서는 RFC 형식 안내를 띄우지 않는다
    lastClaim=null; lastCalc=null;
  }
  function applyCrossTeamUI(c,pending){
    var box=$('rcf-crossbox'); if(box) box.style.display=crossTeam?'':'none';
    var who=$('rcf-crosswho');
    if(who) who.textContent=crossTeam?('— 현재 소속: '+((c&&c.team_name)||'미지정')+' / 현재 담당: '+((c&&c.owner_name)||'미지정')):'';
    var pd=$('rcf-crosspend');
    if(pd) pd.textContent=(crossTeam&&pending)?('⚠ 이미 승인 대기중인 요청이 있습니다('+(pending.requested_by_name||'-')+'). 저장하면 그 요청을 덮어씁니다.'):'';
    // 배송지: 타팀 요청 모드에서는 즉시저장 경로를 막는다(승인 우회 방지)
    var shipWrap=$('rcf-ship'); if(shipWrap) shipWrap.disabled=crossTeam;
    var sb=$('rcf-shipsave'); if(sb) sb.style.display=crossTeam?'none':'';
    setShipMsg('', crossTeam?'배송지는 담당 팀에서 수정합니다.':'');
  }
  function fillEdit(c,pending){
    editingId=c.id;
    setRegBoxes(false);
    $('rcf-code').value=c.code||''; $('rcf-code').readOnly=true; $('rcf-code').style.background='#f2efe8';
    $('rcf-name').value=c.name||''; $('rcf-rfc').value=c.rfc||''; $('rcf-contact').value=c.contact||'';
    $('rcf-phone').value=c.phone||''; $('rcf-memo').value=c.memo||''; $('rcf-constancia').value=c.constancia_fiscal||'';
    if($('rcf-buyername'))$('rcf-buyername').value=c.buyer_name||'';
    if($('rcf-buyerphone'))$('rcf-buyerphone').value=c.buyer_phone||'';
    if($('rcf-ship')) $('rcf-ship').value=c.ship_address||'';
    if($('rcf-shipsave')) $('rcf-shipsave').style.display='';
    setShipMsg('','');
    if($('rcf-team')) $('rcf-team').value=c.team_id||''; if($('rcf-type')) $('rcf-type').value=c.customer_type||'';
    ensureOwnerOption(c.owner_id,c.owner_name);
    if($('rcf-owner')) $('rcf-owner').value=c.owner_id||''; if($('rcf-stage')) $('rcf-stage').value=c.stage_id||'';
    if($('rcf-discount')) $('rcf-discount').value=(c.discount!=null?c.discount:0);
    if($('rcf-credit')) $('rcf-credit').value=(c.credit_days!=null?c.credit_days:0);
    if($('rcf-branches')) $('rcf-branches').value=(c.branch_count!=null?c.branch_count:'');
    origTerms={discount:Number(c.discount)||0, credit:Number(c.credit_days)||0};
    clearTermsInputs();
    $('rcf-save').textContent=crossTeam?'타팀 고객 수정 요청(디렉터 승인)':(cfg.isDirector?'수정 저장':'수정 요청(디렉터 승인)');
    if($('rcf-cancel')) $('rcf-cancel').style.display='';
    applyCrossTeamUI(c,pending);
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
      buyer_name:($('rcf-buyername')&&$('rcf-buyername').value.trim())||null,
      buyer_phone:($('rcf-buyerphone')&&$('rcf-buyerphone').value.trim())||null,
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

    // ===== 0193 · 신규 등록 필수값 =====
    //   RFC 는 **선택**(넣으면 형식은 엄격히 검사 + 그 순간 선점).
    //   기준품목(SYD) 구매단가는 **필수** — 할인율 산출의 유일한 근거라 비워 두면 진행 불가.
    if(!editingId){
      var rawRfc=cleanRfcLocal(b.rfc);
      if(rawRfc){
        var rv=validateRfcLocal(rawRfc);
        if(!rv.ok){ showRfcMsg(rv); setMsg('err',RFC_NOTE[rv.error]||'RFC 를 확인하세요.'); return; }
        b.rfc=rv.value;
      }else{
        // 비워 두면 등록은 되지만 선점이 없다 — 그 결과를 모르고 넘어가지 않게 한 번 확인받는다.
        b.rfc=null;
        showRfcMsg('empty');
        if(!window.confirm('RFC 없이 등록합니다.\n\n⚠ 이 고객은 아직 선점되지 않습니다. 나중에 다른 영업사원이 이 고객에 RFC 를 먼저 입력하면 그 시점·그 담당자에게 우선권이 넘어갑니다.\n또한 RFC 가 없으면 매출(팩투라) 확정이 막힙니다.\n\n이대로 등록할까요?')) return;
      }
      var bp=($('rcf-baseprice')&&$('rcf-baseprice').value)||'';
      if(!bp||Number(bp)<=0){
        var bpEl=$('rcf-baseprice'); if(bpEl){ try{ bpEl.focus(); }catch(e){} }
        setMsg('err','⛔ SYD 기준품목의 고객 구매단가를 입력해야 등록이 진행됩니다 — 할인율 산출의 근거입니다.'); return;
      }
      // 저장 직전 선점 재확인 — 입력 중 다른 사람이 먼저 등록했을 수 있다.
      //   RFC 를 넣은 경우에만 차단한다(RFC 없이 등록하는 건 상호 유사 경고만 뜨고 통과).
      var cc=await claimCheck(true);
      if(rawRfc&&cc&&(cc.blocked_rfc||cc.blocked_constancia)){
        setMsg('err','이미 선점된 고객입니다 — 위 선점 확인 결과를 보세요.'); return;
      }
      var conNo=($('rcf-conno')&&$('rcf-conno').value.trim())||'';
      if(conNo) b.constancia_no=conNo;
      b.syd_ref_code=($('rcf-basecode')&&$('rcf-basecode').value.trim())||'1516049';
      b.syd_ref_buy_price=Number(bp);
      var fi=$('rcf-confile');
      var file=(fi&&fi.files&&fi.files[0])||null;
      if(file){
        if(file.size>5*1024*1024){ setMsg('err','CONSTANCIA 파일은 5MB 이하만 첨부할 수 있습니다.'); return; }
        try{
          b.constancia_file={ file_name:file.name, mime_type:file.type||'application/pdf', data_base64:await readFileB64(file) };
        }catch(e){ setMsg('err','CONSTANCIA 파일을 읽지 못했습니다. 다시 선택하거나 비워 두고 저장하세요.'); return; }
      }
    }
    // ⚠ 수정(editingId) 에서는 RFC 를 요구하지 않는다.
    //   전화·배송지·구매결정권자만 고치려는 사람에게 RFC 형식까지 요구하면 일상 업무가 막힌다.
    //   비워 두면 서버가 기존 RFC 를 그대로 유지한다(선점은 안 풀린다).
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
      //   단, 타팀 수정요청 모드에서는 이 즉시저장 경로를 타지 않는다(디렉터 승인 우회 방지).
      if(editingId&&!crossTeam) await saveShipAddress();
      var url=editingId?api('/api/customers/'+editingId):api('/api/customers');
      var method=editingId?'PATCH':'POST';
      var res=await fetch(url,{method:method,headers:{'Content-Type':'application/json',...auth()},body:JSON.stringify(b)});
      var d=await res.json();
      if(!res.ok||d.error){
        var msg=d.error==='code_exists'||d.error==='code_taken'?'이미 있는 고객코드입니다.'
          :d.error==='forbidden_team'?'그 팀의 고객을 만들/수정할 권한이 없습니다. (타팀 고객 수정요청 권한이 필요하면 디렉터에게 요청하세요)'
          :d.error==='forbidden_team_move'?'그 팀으로 옮길 권한이 없습니다.'
          :d.error==='cross_team_request_denied'?'타팀 고객 수정요청 권한이 없습니다. 디렉터에게 요청하세요.'
          :d.error==='terms_reason_required'?(d.note||'기본할인·외상일 변경 시 수정이유와 제공 조건을 반드시 입력해야 합니다.')
          // 0185 / 0188
          :(d.error==='rfc_taken'||d.error==='constancia_taken'||d.error==='rfc_claim_pending')?('⛔ '+(d.note||RFC_NOTE[d.error]||'이미 등록된 고객입니다.'))
          :(d.error==='rfc_required'||d.error==='rfc_invalid'||d.error==='rfc_invalid_date'||d.error==='rfc_generic')
             ?(d.note||RFC_NOTE[d.error]||'RFC 를 확인하세요.')
          :d.error==='constancia_file_incomplete'?(d.note||'CONSTANCIA 첨부가 불완전합니다. 파일을 다시 선택하거나 비워 두세요.')
          :d.error==='syd_ref_price_required'?(d.note||'기준품목 구매단가를 입력하세요.')
          :(d.error==='discount_required'||d.error==='discount_negative'||d.error==='discount_too_high')?(d.note||'기본 할인율을 다시 확인하세요.')
          :d.error==='unsupported_type'?(d.note||'PDF·JPEG·PNG·WEBP만 첨부할 수 있습니다.')
          :d.error==='too_large'?(d.note||'파일은 5MB 이하만 가능합니다.')
          :d.error==='migration_required'?(d.note||'서버 업데이트가 아직 적용되지 않았습니다. 디렉터에게 문의하세요.')
          :('실패: '+(d.detail||d.error||res.status));
        setMsg('err',msg); $('rcf-save').disabled=false; return;
      }
      if(d.pending){ setMsg('pend', (d.cross_team?'타팀 고객 수정 요청을 보냈습니다. ':'수정 요청을 보냈습니다. ')+(td?'할인·외상일 변경은 디렉터 승인 후 반영·이력 기록됩니다.':'디렉터 승인 후 반영됩니다.')); }
      else if(!editingId&&d.pending_approval){
        // 0193 · 선점 여부에 따라 문구가 갈린다(서버가 note 로 내려 준다).
        setMsg(d.rfc_claimed?'pend':'warn','등록 요청: '+(d.code||'')+' · '+b.name+' — '
          +(d.note||'디렉터 승인 후 견적·매출에 쓸 수 있습니다.')
          +(d.suggested_discount!=null?(' (제안 '+fmtPct(d.suggested_discount)+' · 신청 '+fmtPct(b.discount)+')'):'')
          +(d.warning_note?(' ⚠ '+d.warning_note):''));
      }
      else { setMsg('ok', editingId?(td?'수정되었습니다. 할인·외상일 변경이 이력에 기록되었습니다.':'수정되었습니다.'):('등록되었습니다: '+(d.code||b.code||'')+' · '+b.name)); }
      $('rcf-save').disabled=false;
      if(typeof cfg.onSaved==='function') cfg.onSaved(d, editingId, !!d.pending);
      if(!editingId){
        // fillNew() 가 setMsg('','') 로 안내를 지우므로, 방금 띄운 결과 문구를 복원한다.
        var keep=$('rcf-msg')?{cls:$('rcf-msg').className,txt:$('rcf-msg').textContent}:null;
        await fillNew();
        if(keep&&$('rcf-msg')){ $('rcf-msg').className=keep.cls; $('rcf-msg').textContent=keep.txt; }
      }
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
      // 0185 · 선점 확인 · 기준품목 계산
      var clb=$('rcf-claimbtn'); if(clb) clb.addEventListener('click', function(){ claimCheck(false); });
      var bcb=$('rcf-basecalc'); if(bcb) bcb.addEventListener('click', baseCalc);
      var bp=$('rcf-baseprice'); if(bp) bp.addEventListener('change', function(){ if(!editingId) baseCalc(); });
      var cn=$('rcf-conno'); if(cn) cn.addEventListener('change', function(){ if(!editingId) claimCheck(true); });
      var rf=$('rcf-rfc');
      if(rf){
        rf.addEventListener('input', function(){ if(!editingId) showRfcMsg(rf.value.trim()?validateRfcLocal(rf.value):'empty'); });
        rf.addEventListener('change', function(){
          if(editingId) return;
          var rv=validateRfcLocal(rf.value); showRfcMsg(rf.value.trim()?rv:'empty');
          if(rv.ok){ rf.value=rv.value; claimCheck(true); }
        });
      }
      await loadRefs();
      await fillNew();
    },
    newCustomer:function(){ return fillNew(); },
    // opts: { crossTeam:true, pending:{requested_by_name} } — 타팀 고객 수정요청 모드
    editCustomer:function(c,opts){ crossTeam=!!(opts&&opts.crossTeam); fillEdit(c, opts&&opts.pending); },
    isCrossTeam:function(){ return crossTeam; },
    reloadRefs:loadRefs,
  };
  try{ console.log('[refatrix-custform] v20260901claimb loaded (0193 · RFC 선택 입력 + RFC 입력시점 선점/이관 + SYD 단가 필수 + 전원 디렉터 승인)'); }catch(e){}
})();
