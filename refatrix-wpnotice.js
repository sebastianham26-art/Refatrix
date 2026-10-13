/* =====================================================================
   Refatrix ERP · refatrix-wpnotice.js — 디렉터 코멘트 팝업 (build wpn-1013a)
   업무일지에 디렉터 코멘트가 달리면(표시 날짜 = 다음 근무일이 된 것부터) 그 직원 화면에 팝업.
     · [확인했습니다] → 확인 처리(디렉터 화면에 「직원 확인함」) · 다시 안 뜸
     · [나중에]       → 이 브라우저 세션 동안만 숨김(새 코멘트가 오면 다시 뜸)
   단독 스크립트 — 다른 화면 전역에 기대지 않음. 로그인 세션(sessionStorage refatrix_session)만 읽는다.
   포털(refatrix-portal.html) · 일정(refatrix-board.html)에 포함. 다른 팝업(공지·메모·기기승인)이 떠 있으면 닫힐 때까지 기다린다.
   ===================================================================== */
(function () {
  'use strict';
  if (window.__wpNotice) return; window.__wpNotice = true;
  var BUILD = 'wpn-1013a';
  try { console.log('[wpnotice] build ' + BUILD); } catch (_) {}
  var POLL_MS = 180000, FIRST_MS = 2500, BUSY_RETRY_MS = 4000;
  var SNOOZE_KEY = 'wpnotice_snooze';
  var OTHER_MODALS = ['noticePopModal', 'calMemoPopModal', 'devApprModal', 'dayModal'];
  var DOW = ['일', '월', '화', '수', '목', '금', '토'];
  var shown = null, timer = null, busy = false;

  function sess() { try { var o = JSON.parse(sessionStorage.getItem('refatrix_session') || 'null'); return o && o.token ? o : null; } catch (_) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function lab(ymd) { var p = String(ymd).split('-'); var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); return Number(p[1]) + '/' + Number(p[2]) + '(' + DOW[d.getDay()] + ')'; }
  function sig(items) { return items.map(function (x) { return x.work_date + '@' + (x.day_comment_at || '') + '#' + x.items.map(function (i) { return i.id + ':' + (i.dir_comment_at || ''); }).join(','); }).join('|'); }
  function snoozed(s) { try { return sessionStorage.getItem(SNOOZE_KEY) === s; } catch (_) { return false; } }
  function otherOpen() {
    return OTHER_MODALS.some(function (id) { var el = document.getElementById(id); if (!el) return false; var d = el.style.display; return d === 'flex' || d === 'block'; });
  }
  var ST = { done: ['완료', '#0F6E56', '#fff'], partial: ['일부', '#B8893B', '#fff'], missed: ['못함', '#fff', '#B23A2E'], open: ['—', '#f1eee7', '#6F6A60'] };

  function css() {
    if (document.getElementById('wpnStyle')) return;
    var st = document.createElement('style'); st.id = 'wpnStyle';
    st.textContent = ''
      + '#wpnModal{position:fixed;inset:0;background:rgba(20,30,26,.55);z-index:230;display:none;align-items:flex-start;justify-content:center;padding:48px 16px;overflow:auto}'
      + '#wpnModal .bx{background:#fff;border-radius:14px;max-width:560px;width:100%;box-shadow:0 12px 40px rgba(20,30,26,.3);overflow:hidden;font-family:"IBM Plex Sans KR",system-ui,-apple-system,"Malgun Gothic",sans-serif;color:#1C1B19}'
      + '#wpnModal .hd{padding:14px 18px;border-bottom:1px solid #ecd9b0;background:#fffaf0}'
      + '#wpnModal .hd b{font-size:16px;font-weight:800;color:#8a6512}'
      + '#wpnModal .hd small{display:block;font-size:11.5px;color:#6F6A60;margin-top:2px}'
      + '#wpnModal .ls{max-height:60vh;overflow:auto;padding:4px 18px 10px}'
      + '#wpnModal .wd{font-size:12px;font-weight:800;color:#6F6A60;margin:12px 0 4px}'
      + '#wpnModal .dc{white-space:pre-wrap;font-size:13.5px;line-height:1.55;background:#fffaf0;border:1px solid #ecd9b0;border-left:4px solid #B8893B;border-radius:8px;padding:8px 11px;margin:4px 0}'
      + '#wpnModal .it{margin:8px 0 4px;font-size:13px;font-weight:700}#wpnModal .it .dc{font-weight:400}'
      + '#wpnModal .bd{display:inline-block;min-width:34px;text-align:center;font-size:10.5px;font-weight:800;border-radius:5px;padding:1px 5px;margin-right:6px;border:1px solid transparent}'
      + '#wpnModal .nt{font-size:12px;color:#3a5a50;background:#f2f7f4;border-radius:7px;padding:4px 9px;margin:3px 0;white-space:pre-wrap;font-weight:400}'
      + '#wpnModal .ft{display:flex;gap:8px;justify-content:flex-end;align-items:center;padding:12px 18px;border-top:1px solid #E6E1D6}'
      + '#wpnModal .ft .hint{margin-right:auto;font-size:11px;color:#6F6A60;flex:1 1 auto;min-width:0}'
      + '#wpnModal button{white-space:nowrap;flex:0 0 auto;border:none;border-radius:8px;padding:9px 16px;cursor:pointer;font-size:13.5px;font-weight:700;font-family:inherit}'
      + '#wpnModal .ok{background:#143D34;color:#fff}#wpnModal .later{background:#fff;color:#143D34;border:1px solid #143D34}'
      + '#wpnModal button:disabled{opacity:.6;cursor:default}';
    document.head.appendChild(st);
  }
  function modal() {
    var m = document.getElementById('wpnModal');
    if (m) return m;
    css();
    m = document.createElement('div'); m.id = 'wpnModal';
    m.innerHTML = '<div class="bx" role="dialog" aria-modal="true" aria-labelledby="wpnTitle">'
      + '<div class="hd"><b id="wpnTitle">📌 디렉터 코멘트</b><small>Comentario del director · 업무일지에 대한 코멘트입니다</small></div>'
      + '<div class="ls" id="wpnList"></div>'
      + '<div class="ft"><span class="hint">일정 화면에서 다시 볼 수 있어요</span>'
      + '<button type="button" class="later" id="wpnLater">나중에</button><button type="button" class="ok" id="wpnOk">확인했습니다</button></div></div>';
    (document.body || document.documentElement).appendChild(m);
    document.getElementById('wpnOk').addEventListener('click', confirmSeen);
    document.getElementById('wpnLater').addEventListener('click', later);
    return m;
  }
  function render(items) {
    var h = '';
    items.forEach(function (x) {
      h += '<div class="wd">' + esc(lab(x.work_date)) + ' 업무에 대해</div>';
      if (x.day_comment) h += '<div class="dc">' + esc(x.day_comment) + '</div>';
      x.items.forEach(function (i) {
        var s = ST[i.status] || ST.open;
        h += '<div class="it"><span class="bd" style="background:' + s[1] + ';color:' + s[2] + (i.status === 'missed' ? ';border-color:#e7b6af' : '') + '">' + s[0] + '</span>' + esc(i.title)
          + (i.note ? '<div class="nt">내 코멘트: ' + esc(i.note) + '</div>' : '')
          + '<div class="dc">' + esc(i.dir_comment) + '</div></div>';
      });
    });
    return h;
  }
  function open(items) {
    var m = modal();
    document.getElementById('wpnList').innerHTML = render(items);
    var n = items.reduce(function (a, x) { return a + (x.day_comment ? 1 : 0) + x.items.length; }, 0);
    document.getElementById('wpnTitle').textContent = '📌 디렉터 코멘트' + (n > 1 ? ' ' + n + '건' : '');
    var ok = document.getElementById('wpnOk'); ok.disabled = false; ok.textContent = '확인했습니다';
    m.style.display = 'flex';
    try { ok.focus(); } catch (_) {}
  }
  function close() { var m = document.getElementById('wpnModal'); if (m) m.style.display = 'none'; }
  function isOpen() { var m = document.getElementById('wpnModal'); return !!(m && m.style.display === 'flex'); }

  function check() {
    if (busy || isOpen()) return;
    var s = sess(); if (!s) return;
    if (otherOpen()) { clearTimeout(timer); timer = setTimeout(check, BUSY_RETRY_MS); return; }
    busy = true;
    fetch(String(s.api || '').replace(/\/+$/, '') + '/api/workplan/inbox/unseen', { headers: { Authorization: 'Bearer ' + s.token } })
      .then(function (r) { return r.ok ? r.json() : { items: [] }; })
      .then(function (j) {
        var items = (j && j.items) || [];
        if (!items.length) { shown = null; return; }
        var g = sig(items);
        if (snoozed(g)) return;
        if (otherOpen()) { clearTimeout(timer); timer = setTimeout(check, BUSY_RETRY_MS); return; }
        shown = { items: items, sig: g };
        open(items);
      })
      .catch(function () {})
      .then(function () { busy = false; });
  }
  function confirmSeen() {
    var s = sess(); if (!s || !shown) { close(); return; }
    var ok = document.getElementById('wpnOk'); ok.disabled = true; ok.textContent = '처리 중…';
    var dates = shown.items.map(function (x) { return x.work_date; });
    fetch(String(s.api || '').replace(/\/+$/, '') + '/api/workplan/inbox/seen', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.token }, body: JSON.stringify({ dates: dates }),
    }).then(function (r) {
      if (!r.ok) throw new Error('x');
      shown = null; close();
      try { sessionStorage.removeItem(SNOOZE_KEY); } catch (_) {}
      try { if (typeof window.wpOnSeen === 'function') window.wpOnSeen(dates); } catch (_) {}   // 일정 화면 표식·박스 갱신
    }).catch(function () { ok.disabled = false; ok.textContent = '다시 시도'; });
  }
  function later() {
    if (shown) { try { sessionStorage.setItem(SNOOZE_KEY, shown.sig); } catch (_) {} }
    close();
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isOpen()) later(); });

  window.wpNoticeCheck = check;   // 테스트·다른 화면에서 즉시 확인용
  function start() {
    setTimeout(check, FIRST_MS);
    setInterval(check, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') setTimeout(check, 800); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
