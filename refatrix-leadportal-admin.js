// =====================================================================
// refatrix-leadportal-admin.js — 제품·마케팅 › Meta 광고 문의 › 「🔑 고객 접속코드」 탭 (0297 · 2026-10-26 · build lp-1026a)
//   refatrix-metaleads.html 의 본 스크립트 뒤에 로드된다 — 그 페이지의 전역 api() · session · esc() · $() 를 쓴다.
//   · 디렉터: 접속코드 발급(만료일 직접 입력 · 기준 금액 · 조건 메모 · 열람 범위) · 목록(기한 변경 · 정지/재개 · 재발급 · 삭제 · 이력) · 연락처 공개 기록
//   · 담당 영업사원 · 디렉터: 고객 매장 재고(고객이 포털에서 고친 값과 같은 칸) — 칸을 벗어나면 저장, 이력
// =====================================================================
(function () {
  'use strict';
  var LP = { st: null, codes: [], cust: null, shelfCust: null, loaded: false, timer: null, timer2: null };
  var g = function (id) { return document.getElementById(id); };
  var money = function (n) { return n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }); };
  var money2 = function (n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); };
  var STATE = { active: ['사용 중', 's-on'], soon: ['곧 만료', 's-soon'], expired: ['만료', 's-exp'], paused: ['정지', 's-off'] };
  var ERRK = { director_only: '디렉터만 할 수 있습니다.', migration_required: '서버에 0297 마이그레이션이 아직 없습니다 — Railway 콘솔에서 npm run migrate.',
    customer_required: '고객을 고르세요.', expires_required: '만료일을 입력하세요.', expires_past: '만료일이 오늘보다 앞입니다.', bad_amount: '기준 금액은 숫자로 입력하세요.',
    customer_pending: '승인 대기 고객에게는 발급할 수 없습니다.', not_your_customer: '담당 고객이 아닙니다.', unknown_code: '없는 부품번호입니다.', bad_qty: '0 이상의 정수를 입력하세요.' };
  function say(ok, t, el) { var m = g(el || 'lpMsg'); if (!m) return; m.className = 'msg ' + (ok ? 'ok' : 'err'); m.textContent = t; if (ok) setTimeout(function () { if (m.textContent === t) m.className = 'msg'; }, 5000); }
  function errT(e) { return ERRK[e && e.message] || (e && e.data && e.data.note) || ('오류: ' + (e && e.message)); }
  function today() { return (LP.st && LP.st.today) || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date()); }
  function days(a, b) { return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000); }
  function ymd(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

  async function load() {
    try { LP.st = await api('GET', '/api/lead-portal-admin/status'); }
    catch (e) { var m = g('lpMig'); if (m) { m.classList.remove('hidden'); m.textContent = e.message === 'http_404' ? '서버가 아직 이 기능을 모릅니다(백엔드 배포 · migrate 확인).' : errT(e); } return; }
    if (!LP.st.ready) { var mm = g('lpMig'); mm.classList.remove('hidden'); mm.textContent = ERRK.migration_required; }
    g('lpDirOnly').classList.toggle('hidden', !LP.st.director);
    if (LP.st.director) {
      var box = g('lpScopeBox');
      box.innerHTML = (LP.st.states || []).map(function (s) { return '<label class="lp-ck"><input type="checkbox" value="' + esc(s) + '"> ' + esc(s) + '</label>'; }).join('');
      if (!g('lpExp').value) { var d = new Date(Date.UTC(+today().slice(0, 4), +today().slice(5, 7) - 1, +today().slice(8, 10) + 30)); g('lpExp').value = d.toISOString().slice(0, 10); expHint(); }
      if (LP.st.ready) { loadCodes(); loadReveals(); }
    }
    LP.loaded = true;
  }

  // ── 발급 ──────────────────────────────────────────────
  function expHint() {
    var v = g('lpExp').value;
    g('lpExpHint').textContent = ymd(v) ? (v < today() ? '⚠ 오늘보다 앞입니다' : '오늘부터 ' + days(today(), v) + '일 · 만료일 23:59(멕시코시티)까지 열람') : '';
  }
  async function searchCust(qEl, listEl, onPick) {
    var q = g(qEl).value.trim(); var list = g(listEl);
    if (q.length < 2) { list.innerHTML = ''; return; }
    try {
      var d = await api('GET', '/api/lead-portal-admin/customers?q=' + encodeURIComponent(q));
      list.innerHTML = d.items.length ? d.items.map(function (c) { return '<div class="lp-opt" data-cid="' + c.id + '" data-name="' + esc(c.name) + '" data-code="' + esc(c.code) + '" data-disc="' + c.discount + '"><b>' + esc(c.code) + '</b> · ' + esc(c.name) + ' <span class="muted">' + c.discount + '%</span></div>'; }).join('')
        : '<div class="lp-opt muted">일치하는 고객이 없습니다(담당 고객만 보입니다)</div>';
      list.onclick = function (e) { var o = e.target.closest('[data-cid]'); if (!o) return; list.innerHTML = ''; onPick({ id: Number(o.dataset.cid), name: o.dataset.name, code: o.dataset.code, discount: Number(o.dataset.disc) }); };
    } catch (e) { list.innerHTML = '<div class="lp-opt muted">' + esc(errT(e)) + '</div>'; }
  }
  async function pickIssueCust(c) {
    LP.cust = c;
    g('lpCustQ').value = c.code + ' · ' + c.name;
    g('lpCustSel').textContent = '할인율 ' + c.discount + '% (포털 가격에 적용)';
    g('lpRef').innerHTML = '<span class="muted">매출 불러오는 중…</span>';
    try {
      var r = await api('GET', '/api/lead-portal-admin/customer-ref/' + c.id);
      g('lpRef').innerHTML = '<div class="lp-ref3"><div>최근 30일<b>' + money(r.d30) + '</b></div><div>최근 3개월<b>' + money(r.d90) + '</b></div><div>최근 12개월<b>' + money(r.d365) + '</b></div></div>'
        + '<div class="hint" style="margin-top:6px">' + (r.last_date ? '마지막 매출 ' + esc(r.last_date) + ' · ' + money(r.last_amount) : '매출 기록 없음')
        + ' — 참고용이며 기한은 자동으로 정하지 않습니다.' + (r.codes ? ' <b>이 고객은 이미 접속코드 ' + r.codes + '개가 있습니다.</b>' : '') + '</div>';
    } catch (e) { g('lpRef').innerHTML = '<span class="muted">' + esc(errT(e)) + '</span>'; }
  }
  async function issue() {
    if (!LP.cust) { say(false, ERRK.customer_required); return; }
    var scope = g('lpScopeMode').value === 'pick' ? [].map.call(g('lpScopeBox').querySelectorAll('input:checked'), function (i) { return i.value; }) : [];
    if (g('lpScopeMode').value === 'pick' && !scope.length) { say(false, '열람할 주를 하나 이상 고르세요(전체면 「전체 문의」).'); return; }
    g('lpIssue').disabled = true;
    try {
      var d = await api('POST', '/api/lead-portal-admin/codes', { customer_id: LP.cust.id, expires_on: g('lpExp').value, basis_amount: g('lpAmt').value.trim(), memo: g('lpMemo').value.trim(), scope_states: scope });
      showIssued(d, LP.cust.name, d.item.expires_on);
      say(true, '발급했습니다 — 코드는 지금 한 번만 보입니다.');
      LP.cust = null; g('lpCustQ').value = ''; g('lpCustSel').textContent = ''; g('lpRef').innerHTML = ''; g('lpAmt').value = ''; g('lpMemo').value = '';
      loadCodes();
    } catch (e) { say(false, errT(e)); }
    finally { g('lpIssue').disabled = false; }
  }
  function showIssued(d, name, exp) {
    g('lpIssued').innerHTML = '<div class="lp-issued"><div class="hint">발급됨 · ' + esc(name) + ' · ' + esc(exp) + '까지</div>'
      + '<div class="lp-big">' + esc(d.code) + '</div>'
      + '<label style="margin-top:8px">고객 안내문 (스페인어 · 복사해서 WhatsApp으로 전달)</label><pre class="lp-pre" id="lpInvite">' + esc(d.invite) + '</pre>'
      + '<div class="row"><button type="button" class="btn sm" id="lpCopyInv">📋 안내문 복사</button><button type="button" class="btn sm ghost" id="lpCopyCode">코드만 복사</button><button type="button" class="btn sm ghost" id="lpHideIss">닫기</button></div></div>';
    var copy = function (t) { try { navigator.clipboard.writeText(t).then(function () { say(true, '복사했습니다.'); }); } catch (e) { say(false, '복사하지 못했습니다 — 직접 선택해 복사하세요.'); } };
    g('lpCopyInv').onclick = function () { copy(d.invite); };
    g('lpCopyCode').onclick = function () { copy(d.code); };
    g('lpHideIss').onclick = function () { g('lpIssued').innerHTML = ''; };
  }

  // ── 목록 ──────────────────────────────────────────────
  async function loadCodes() {
    try { var d = await api('GET', '/api/lead-portal-admin/codes'); LP.codes = d.items || []; renderCodes(); }
    catch (e) { g('lpCodes').innerHTML = '<div class="hint">' + esc(errT(e)) + '</div>'; }
  }
  function renderCodes() {
    var f = g('lpFilter').value, q = g('lpFind').value.trim().toLowerCase();
    var cnt = { active: 0, soon: 0, expired: 0, paused: 0 };
    LP.codes.forEach(function (c) { cnt[c.state] = (cnt[c.state] || 0) + 1; });
    g('lpSum').textContent = '사용 중 ' + (cnt.active + cnt.soon) + ' · 7일 내 만료 ' + cnt.soon + ' · 만료 ' + cnt.expired + ' · 정지 ' + cnt.paused;
    var it = LP.codes.filter(function (c) {
      if (f === 'on' && !(c.state === 'active' || c.state === 'soon')) return false;
      if (f && f !== 'on' && c.state !== f) return false;
      if (q && (c.customer_name + ' ' + c.customer_code + ' ' + (c.memo || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    if (!it.length) { g('lpCodes').innerHTML = '<div class="hint" style="margin-top:8px">' + (LP.codes.length ? '조건에 맞는 코드가 없습니다.' : '아직 발급한 접속코드가 없습니다.') + '</div>'; return; }
    g('lpCodes').innerHTML = '<table><thead><tr><th>고객</th><th>코드</th><th class="num">기준 금액</th><th>조건 메모</th><th>범위</th><th>발급일</th><th>만료일</th><th>상태</th><th>마지막 접속</th><th class="num">연락처 공개</th><th class="num">주문(견적)</th><th></th></tr></thead><tbody>'
      + it.map(function (c) {
        var s = STATE[c.state] || [c.state, ''];
        var lab = c.state === 'active' ? s[0] + ' · ' + c.days_left + '일' : (c.state === 'soon' ? c.days_left + '일 남음' : s[0]);
        var act = '<button type="button" class="btn sm ' + (c.state === 'expired' || c.state === 'soon' ? 'lp-gold' : 'ghost') + '" data-act="ext" data-id="' + c.id + '">' + (c.state === 'expired' || c.state === 'soon' ? '연장' : '기한 변경') + '</button>'
          + (c.active ? '<button type="button" class="btn sm ghost" data-act="pause" data-id="' + c.id + '">정지</button>' : '<button type="button" class="btn sm ghost" data-act="resume" data-id="' + c.id + '">재개</button>')
          + '<button type="button" class="btn sm ghost" data-act="memo" data-id="' + c.id + '">메모</button>'
          + '<button type="button" class="btn sm ghost" data-act="scope" data-id="' + c.id + '">범위</button>'
          + '<button type="button" class="btn sm ghost" data-act="reissue" data-id="' + c.id + '">재발급</button>'
          + '<button type="button" class="btn sm ghost" data-act="shelf" data-id="' + c.id + '">매장 재고</button>'
          + '<button type="button" class="btn sm ghost" data-act="log" data-id="' + c.id + '">이력</button>'
          + '<button type="button" class="btn sm lp-red" data-act="del" data-id="' + c.id + '">삭제</button>';
        return '<tr><td><b>' + esc(c.customer_name) + '</b><div class="muted">' + esc(c.customer_code) + '</div></td>'
          + '<td class="mono" style="white-space:nowrap">…' + esc(c.last4) + '</td><td class="num">' + money(c.basis_amount) + '</td><td class="muted lp-memo">' + esc(c.memo || '') + '</td>'
          + '<td>' + (c.scope_states && c.scope_states.length ? esc(c.scope_states.join(', ')) : '전체') + '</td>'
          + '<td style="white-space:nowrap">' + esc(c.created_on) + '</td><td style="white-space:nowrap">' + esc(c.expires_on) + '</td><td><span class="tag ' + s[1] + '">' + esc(lab) + '</span></td>'
          + '<td class="muted">' + (c.last_seen_at ? esc(fmtT(c.last_seen_at)) : '—') + '</td>'
          + '<td class="num">' + c.reveals + '</td><td class="num">' + (c.orders ? c.orders + '건<div class="muted">' + money2(c.orders_total) + '</div>' : '—') + '</td>'
          + '<td><div class="row lp-acts">' + act + '</div></td></tr>';
      }).join('') + '</tbody></table>';
  }
  async function patch(id, body, okT) {
    try { await api('PATCH', '/api/lead-portal-admin/codes/' + id, body); say(true, okT || '저장했습니다.'); loadCodes(); }
    catch (e) { say(false, errT(e)); }
  }
  async function onAct(e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var id = Number(b.dataset.id); var c = LP.codes.filter(function (x) { return x.id === id; })[0]; if (!c) return;
    var a = b.dataset.act;
    if (a === 'ext') {
      var v = prompt(c.customer_name + ' — 새 만료일 (YYYY-MM-DD)\n지금: ' + c.expires_on, c.expires_on);
      if (v == null) return; v = v.trim();
      if (!ymd(v)) { say(false, '날짜 형식은 YYYY-MM-DD 입니다.'); return; }
      return patch(id, { expires_on: v }, '만료일을 ' + v + '로 바꿨습니다.');
    }
    if (a === 'memo') {
      var amt = prompt(c.customer_name + ' — 기준 금액 (MXN, 비우면 없음)', c.basis_amount == null ? '' : String(c.basis_amount)); if (amt == null) return;
      var memo = prompt('조건 메모 (고객에게 안 보임)', c.memo || ''); if (memo == null) return;
      return patch(id, { basis_amount: amt.trim(), memo: memo.trim() });
    }
    if (a === 'scope') {
      var cur = c.scope_states && c.scope_states.length ? c.scope_states.join(', ') : '전체';
      var s = prompt('열람 범위 — 주 이름을 쉼표로(예: Nuevo León, Tamaulipas). 「전체」면 모든 문의.\n사용 가능: ' + (LP.st.states || []).join(', '), cur);
      if (s == null) return; s = s.trim();
      var list = !s || s === '전체' ? [] : s.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      var bad = list.filter(function (x) { return (LP.st.states || []).indexOf(x) < 0; });
      if (bad.length) { say(false, '없는 주: ' + bad.join(', ')); return; }
      return patch(id, { scope_states: list }, '열람 범위를 바꿨습니다.');
    }
    if (a === 'pause') { if (!confirm(c.customer_name + ' 접속을 정지할까요? 열어 둔 화면도 다음 요청부터 막힙니다.')) return; return patch(id, { active: false }, '정지했습니다.'); }
    if (a === 'resume') return patch(id, { active: true }, '재개했습니다.');
    if (a === 'reissue') {
      if (!confirm(c.customer_name + ' 코드를 새로 발급할까요? 지금 코드(…' + c.last4 + ')는 바로 못 쓰게 됩니다.')) return;
      try { var d = await api('POST', '/api/lead-portal-admin/codes/' + id + '/reissue'); showIssued(d, c.customer_name, c.expires_on); say(true, '재발급했습니다 — 새 코드는 지금 한 번만 보입니다.'); loadCodes(); try { g('lpIssued').scrollIntoView({ behavior: 'smooth' }); } catch (_) {} }
      catch (e2) { say(false, errT(e2)); }
      return;
    }
    if (a === 'del') {
      if (!confirm(c.customer_name + ' 접속코드를 삭제할까요? 되돌릴 수 없습니다(공개 기록 · 주문은 남습니다).')) return;
      try { await api('DELETE', '/api/lead-portal-admin/codes/' + id); say(true, '삭제했습니다.'); loadCodes(); } catch (e3) { say(false, errT(e3)); }
      return;
    }
    if (a === 'shelf') { LP.shelfCust = { id: c.customer_id, name: c.customer_name, code: c.customer_code }; g('lpShelfQ').value = c.customer_code + ' · ' + c.customer_name; loadShelf(); try { g('lpShelfBox').scrollIntoView({ behavior: 'smooth' }); } catch (_) {} return; }
    if (a === 'log') {
      try {
        var lg = await api('GET', '/api/lead-portal-admin/codes/' + id + '/log');
        var AK = { issue: '발급', update: '수정', pause: '정지', resume: '재개', reissue: '재발급', delete: '삭제' };
        g('lpLog').innerHTML = '<h3>변경 이력 · ' + esc(c.customer_name) + ' <button type="button" class="btn sm ghost" id="lpLogX">닫기</button></h3><table><thead><tr><th>일시</th><th>내용</th><th>상세</th><th>누가</th></tr></thead><tbody>'
          + lg.items.map(function (x) { return '<tr><td>' + esc(x.at) + '</td><td>' + esc(AK[x.action] || x.action) + '</td><td class="muted">' + esc(logDetail(x.detail)) + '</td><td>' + esc(x.user_name || '') + '</td></tr>'; }).join('') + '</tbody></table>';
        g('lpLogX').onclick = function () { g('lpLog').innerHTML = ''; };
      } catch (e4) { say(false, errT(e4)); }
    }
  }
  function logDetail(d) {
    if (!d) return '';
    var o = [];
    if (d.expires_on) o.push('만료일 ' + (Array.isArray(d.expires_on) ? d.expires_on[0] + ' → ' + d.expires_on[1] : d.expires_on));
    if ('basis_amount' in d) o.push('기준 금액 ' + (Array.isArray(d.basis_amount) ? money(d.basis_amount[0]) + ' → ' + money(d.basis_amount[1]) : money(d.basis_amount)));
    if (d.memo) o.push('메모 수정');
    if ('scope_states' in d) { var s = Array.isArray(d.scope_states) && d.scope_states.length === 2 && (d.scope_states[0] === null || Array.isArray(d.scope_states[0])) ? d.scope_states[1] : d.scope_states; o.push('범위 ' + (s && s.length ? s.join(', ') : '전체')); }
    if ('active' in d) o.push(d.active ? '재개' : '정지');
    if (d.last4) o.push('새 코드 …' + d.last4);
    return o.join(' · ');
  }
  async function loadReveals() {
    try {
      var d = await api('GET', '/api/lead-portal-admin/reveals?limit=100');
      var ST = { nuevo: '신규', contactado: '연락함', derivado: '연결', venta: '판매', descartado: '제외' };
      var CHN = { whatsapp: 'WA', messenger: 'FB', instagram: 'IG' };
      g('lpReveals').innerHTML = d.items.length ? '<table><thead><tr><th>처음 본 일시</th><th>고객(코드)</th><th>문의</th><th>채널</th><th class="num">횟수</th><th>문의 상태(ERP)</th></tr></thead><tbody>'
        + d.items.map(function (r) { return '<tr><td>' + esc(r.first_mx) + '</td><td>' + esc(r.customer_name) + ' <span class="muted">…' + esc(r.code_last4) + '</span></td><td>#' + r.thread_id + ' · ' + esc([r.vehicles, r.parts].filter(Boolean).join(' · ')) + '</td><td><span class="tag ch-' + esc(r.platform) + '">' + esc(CHN[r.platform] || r.platform) + '</span></td><td class="num">' + r.n + '</td><td>' + esc(ST[r.status] || r.status) + '</td></tr>'; }).join('') + '</tbody></table>'
        : '<div class="hint">아직 연락처를 본 고객이 없습니다.</div>';
    } catch (e) { g('lpReveals').innerHTML = '<div class="hint">' + esc(errT(e)) + '</div>'; }
  }

  // ── 고객 매장 재고 ─────────────────────────────────────
  async function loadShelf() {
    var c = LP.shelfCust; if (!c) { g('lpShelf').innerHTML = ''; return; }
    g('lpShelf').innerHTML = '<div class="hint">불러오는 중…</div>';
    try {
      var d = await api('GET', '/api/lead-portal-admin/shelf?customer_id=' + c.id);
      var nC = d.items.filter(function (x) { return x.by.indexOf('고객') === 0; }).length;
      g('lpShelf').innerHTML = '<div class="hint" style="margin:6px 0">' + esc(c.name) + ' · 값 ' + d.items.length + '개 · 고객 입력 ' + nC + ' · Refatrix 입력 ' + (d.items.length - nC) + '</div>'
        + '<table><thead><tr><th>부품번호</th><th>품명</th><th class="num">고객 재고</th><th>마지막 입력</th><th class="num">구매 12개월</th><th class="num">우리 가용</th><th></th></tr></thead><tbody>'
        + d.items.map(function (x) {
          return '<tr><td class="mono">' + esc(x.code) + '</td><td>' + esc(x.name) + '</td><td class="num"><input class="lp-q" data-code="' + esc(x.code) + '" value="' + esc(x.qty) + '" inputmode="numeric"></td>'
            + '<td><span class="tag ' + (x.by.indexOf('고객') === 0 ? 's-on' : 's-soon') + '">' + esc(x.by) + '</span> ' + esc(x.at) + '</td><td class="num">' + x.bought12 + '</td><td class="num">' + (x.avail == null ? '—' : x.avail) + '</td>'
            + '<td><button type="button" class="btn sm ghost" data-hist="' + esc(x.code) + '">이력</button></td></tr>';
        }).join('')
        + '<tr><td><input id="lpShelfCode" placeholder="부품번호" style="width:120px"></td><td class="muted">새로 추가</td><td class="num"><input id="lpShelfQty" class="lp-q-new" inputmode="numeric" style="width:64px"></td><td colspan="4"><button type="button" class="btn sm" id="lpShelfAdd">+ 추가</button></td></tr>'
        + '</tbody></table><div class="hint" style="margin-top:6px">숫자를 고치고 칸을 벗어나면 바로 저장 · 비우면 지움 · 이력이 모두 남습니다.</div>';
      g('lpShelfAdd').onclick = function () { saveShelf(g('lpShelfCode').value.trim(), g('lpShelfQty').value.trim(), true); };
    } catch (e) { g('lpShelf').innerHTML = '<div class="hint">' + esc(errT(e)) + '</div>'; }
  }
  async function saveShelf(code, v, reload) {
    var c = LP.shelfCust; if (!c || !code) return;
    if (v !== '' && !/^\d{1,6}$/.test(v)) { say(false, ERRK.bad_qty, 'lpShelfMsg'); return; }
    try {
      await api('PUT', '/api/lead-portal-admin/shelf', { customer_id: c.id, code: code, qty: v === '' ? null : Number(v) });
      say(true, code + ' 저장했습니다.', 'lpShelfMsg');
      if (reload) loadShelf();
    } catch (e) { say(false, errT(e), 'lpShelfMsg'); }
  }
  async function shelfHist(code) {
    var c = LP.shelfCust; if (!c) return;
    try {
      var d = await api('GET', '/api/lead-portal-admin/shelf/log?customer_id=' + c.id + '&code=' + encodeURIComponent(code));
      g('lpShelfLog').innerHTML = '<h3>' + esc(code) + ' 이력 <button type="button" class="btn sm ghost" id="lpShelfLogX">닫기</button></h3>'
        + (d.items.length ? '<table><thead><tr><th>일시</th><th>변경</th><th>누가</th></tr></thead><tbody>' + d.items.map(function (x) { return '<tr><td>' + esc(x.at) + '</td><td>' + (x.old == null ? '—' : x.old) + ' → ' + (x.new == null ? '지움' : x.new) + '</td><td>' + esc(x.by) + '</td></tr>'; }).join('') + '</tbody></table>' : '<div class="hint">이력이 없습니다.</div>');
      g('lpShelfLogX').onclick = function () { g('lpShelfLog').innerHTML = ''; };
    } catch (e) { say(false, errT(e), 'lpShelfMsg'); }
  }

  function wire() {
    if (!g('p-lp')) return;
    g('lpCustQ').addEventListener('input', function () { LP.cust = null; clearTimeout(LP.timer); LP.timer = setTimeout(function () { searchCust('lpCustQ', 'lpCustList', pickIssueCust); }, 300); });
    g('lpShelfQ').addEventListener('input', function () { clearTimeout(LP.timer2); LP.timer2 = setTimeout(function () { searchCust('lpShelfQ', 'lpShelfList', function (c) { LP.shelfCust = c; g('lpShelfQ').value = c.code + ' · ' + c.name; loadShelf(); }); }, 300); });
    g('lpExp').addEventListener('input', expHint); g('lpExp').addEventListener('change', expHint);
    g('lpScopeMode').addEventListener('change', function () { g('lpScopeBox').classList.toggle('hidden', g('lpScopeMode').value !== 'pick'); });
    g('lpIssue').addEventListener('click', issue);
    g('lpCodes').addEventListener('click', onAct);
    g('lpFilter').addEventListener('change', renderCodes);
    g('lpFind').addEventListener('input', renderCodes);
    g('lpShelf').addEventListener('change', function (e) { var i = e.target.closest('input.lp-q'); if (i) saveShelf(i.dataset.code, i.value.trim(), false); });
    g('lpShelf').addEventListener('click', function (e) { var b = e.target.closest('[data-hist]'); if (b) shelfHist(b.dataset.hist); });
    var tabs = g('tabs');
    if (tabs) tabs.addEventListener('click', function (e) { var b = e.target.closest('.tab'); if (b && b.dataset.p === 'lp') { if (!LP.loaded) load(); else if (LP.st && LP.st.director && LP.st.ready) { loadCodes(); loadReveals(); } } });
  }
  var fmtT = function (t) { return new Date(t).toLocaleString('ko-KR', { timeZone: 'America/Mexico_City', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); };
  wire();
})();
