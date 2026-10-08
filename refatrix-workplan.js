/* =====================================================================
   Refatrix ERP · refatrix-workplan.js — 직원 업무일지 (0263, build wp-1008a)
   일정 화면(refatrix-board.html)에 붙는다.
     · 날짜 모달 맨 위: 🌅 오늘 할 일(아침, 체크리스트) / 🌙 오늘 한 일(마감 전, 완료·일부·못함 + 계획 외)
     · 달력 칸 표식(본인) · 👥 팀 업무 탭(전 직원 공유) · 디렉터 설정/발송 카드
   board.html 의 전역(session·$·esc·auth·isDirector·dmDate·calRange·renderCal·showTab)을 쓴다.
   이벤트는 전부 addEventListener(위임) — 인라인 onclick 없음.
   ===================================================================== */
(function () {
  'use strict';
  var BUILD = 'wp-1008b';
  try { console.log('[workplan] build ' + BUILD); } catch (_) {}
  var WP_LAUNCH = '2026-10-08';   // 이 날 이전의 빈 날짜는 「미작성」으로 표시하지 않는다(도입일)
  var STAT = { done: { t: '완료', c: 'on' }, partial: { t: '일부', c: 'part' }, missed: { t: '못함', c: 'miss' } };
  var CYCLE = ['', 'done', 'partial', 'missed'];

  // ── 스타일 ──
  var css = ''
    + '.wpbox{border:1.5px solid var(--brand);border-radius:12px;margin-bottom:14px;overflow:hidden;background:#fff}'
    + '.wptabs{display:flex;background:#faf8f3;border-bottom:1px solid var(--line)}'
    + '.wptab{flex:1;padding:9px 8px;text-align:center;font-size:13px;font-weight:800;color:var(--muted);cursor:pointer;border:none;background:none;font-family:inherit}'
    + '.wptab.on{background:#fff;color:var(--brand);box-shadow:inset 0 -3px 0 var(--brand)}'
    + '.wptab small{display:block;font-size:10.5px;font-weight:600;color:var(--muted);margin-top:1px}'
    + '.wpb{padding:11px 13px}'
    + '.wpst{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);margin-bottom:6px}'
    + '.wpp{font-size:10.5px;font-weight:700;padding:1px 8px;border-radius:999px;background:#f1eee7;color:var(--muted);white-space:nowrap}'
    + '.wpp.ok{background:var(--income-bg);color:var(--income)}.wpp.late{background:var(--expense-bg);color:var(--expense)}'
    + '.wpp.carry{background:#fbf6ea;color:#8a6512}.wpp.add{background:#e6f1fb;color:#0c447c}'
    + '.wpli{display:flex;align-items:center;gap:7px;padding:5px 0;border-bottom:1px dashed var(--line)}'
    + '.wpli:last-child{border-bottom:none}'
    + '.wpli input.wpt{flex:1;border:1px solid transparent;background:transparent;padding:5px 6px;font-size:13.5px}'
    + '.wpli input.wpt:hover,.wpli input.wpt:focus{border-color:var(--line);background:#fff}'
    + '.wpli .wpx{border:none;background:none;color:#b7b2a6;cursor:pointer;font-size:15px;padding:2px 6px}'
    + '.wpli .wpx:hover{color:var(--expense)}'
    + '.wpli .tt{flex:1;font-size:13.5px}'
    + '.wpadd{display:flex;gap:6px;margin-top:8px}.wpadd input{flex:1}'
    + '.wpchk{min-width:52px;height:26px;border:2px solid var(--line);border-radius:7px;cursor:pointer;font-size:11.5px;font-weight:800;color:var(--muted);background:#fff;font-family:inherit;flex:0 0 auto}'
    + '.wpchk.on{background:var(--income);border-color:var(--income);color:#fff}'
    + '.wpchk.part{background:var(--gold);border-color:var(--gold);color:#fff}'
    + '.wpchk.miss{background:#fff;border-color:#e7b6af;color:var(--expense)}'
    + '.wpnote{margin:2px 0 5px 59px}.wpnote input{font-size:12px;padding:5px 8px;background:#fafcfb}'
    + '.wpsub{font-size:12.5px;font-weight:800;color:var(--brand);margin:10px 0 4px}'
    + '.wpbtns{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}'
    + '.wpteamlink{display:flex;justify-content:flex-end;margin:-4px 0 10px}'
    + '.wpteamlink button{font-size:11.5px}'
    + '.wpmk{display:inline-block;margin-top:3px;font-size:10.5px;font-weight:800;border-radius:5px;padding:1px 5px;line-height:1.4;white-space:nowrap}'
    + '.wpmk.ok{background:var(--income-bg);color:var(--income)}.wpmk.mid{background:#fbf6ea;color:#8a6512}'
    + '.wpmk.plan{background:#e6f1fb;color:#0c447c}.wpmk.bad{background:var(--expense-bg);color:var(--expense)}'
    + '.cgcell.week .wpmk{margin:0 0 0 6px}'
    + '.wpkpi{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}'
    + '.wpkpi div{flex:1;min-width:120px;border:1px solid var(--line);border-radius:10px;padding:9px 12px}'
    + '.wpkpi b{display:block;font-size:20px;color:var(--brand)}.wpkpi span{font-size:11px;color:var(--muted)}'
    + '.wptbl{width:100%;border-collapse:collapse;font-size:12.5px}'
    + '.wptbl th{text-align:left;font-size:11px;color:var(--muted);font-weight:700;padding:7px 8px;border-bottom:1px solid var(--line);background:#faf8f3}'
    + '.wptbl td{padding:9px 8px;border-bottom:1px solid #f0ece2;vertical-align:top}'
    + '.wptbl .nm{font-weight:800;color:var(--brand);white-space:nowrap}'
    + '.wpbar{height:7px;border-radius:99px;background:#eee;overflow:hidden;width:80px;display:inline-block;vertical-align:middle;margin-right:6px}'
    + '.wpbar i{display:block;height:100%;background:var(--income)}'
    + '.wpit{line-height:1.6}.wpit .d{color:var(--income);font-weight:700}.wpit .p{color:#8a6512;font-weight:700}.wpit .m{color:var(--expense);font-weight:700}'
    + '.wpit .n{color:var(--muted)}.wpit .x{color:var(--muted)}'
    + '.wpadm{border-top:1px solid var(--line);margin-top:18px;padding-top:14px}'
    + '.wpadm h3{font-size:14px;color:var(--brand);margin:0 0 4px;cursor:pointer;user-select:none}'
    + '.wpset{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;margin-top:10px}'
    + '.wpset .bx{border:1px solid var(--line);border-radius:10px;padding:12px}'
    + '.wpset .bx h4{margin:0 0 6px;font-size:13px;color:var(--brand)}'
    + '.wptm{display:flex;gap:4px;align-items:center}.wptm select{width:auto}'
    + '.wpdays{display:flex;gap:4px;flex-wrap:wrap}'
    + '.wpdays button{border:1px solid var(--line);border-radius:6px;padding:4px 9px;font-size:12px;font-weight:700;color:var(--muted);background:#fff;cursor:pointer;font-family:inherit}'
    + '.wpdays button.on{background:var(--brand);color:#fff;border-color:var(--brand)}'
    + '.wpusers{max-height:180px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:6px 9px;font-size:12.5px}'
    + '.wpusers label{display:flex;align-items:center;gap:6px;margin:3px 0;font-weight:500;color:var(--ink);font-size:12.5px}'
    + '.wpusers input{width:auto}'
    + '.wplog{width:100%;border-collapse:collapse;font-size:11.5px;margin-top:6px}'
    + '.wplog td,.wplog th{padding:4px 6px;border-bottom:1px solid #f0ece2;text-align:left}'
    + '.wpprev{max-width:100%;border:1px solid var(--line);border-radius:8px;margin-top:8px;display:block}'
    /* 0266 · 코멘트 · 디렉터 코멘트 · 팀 카드 · 직원 선택 */
    + '.wpmk.dir{background:#fdf3dc;color:#8a6512;margin-left:3px}.wpmk.dir.seen{background:#f1eee7;color:var(--muted)}'
    + '.wpinbox{border:1.5px solid var(--gold);background:#fffaf0;border-radius:12px;padding:11px 13px;margin-bottom:12px}'
    + '.wpinbox h4{margin:0 0 6px;font-size:13.5px;color:#8a6512;display:flex;align-items:center;gap:6px;flex-wrap:wrap}'
    + '.wpinbox .wd{font-size:11.5px;color:var(--muted);font-weight:700;margin:8px 0 3px}'
    + '.wpinbox .dc{white-space:pre-wrap;font-size:13px;line-height:1.5;background:#fff;border:1px solid #ecd9b0;border-radius:8px;padding:7px 10px;margin:3px 0}'
    + '.wpinbox .ic{font-size:12.5px;margin:4px 0}.wpinbox .ic b{color:var(--ink);font-weight:600}'
    + '.wpdir{margin:3px 0 4px;background:#fffaf0;border:1px solid #ecd9b0;border-left:4px solid var(--gold);border-radius:7px;padding:5px 9px;font-size:12.5px;white-space:pre-wrap;line-height:1.45}'
    + '.wpdir .who{font-size:10.5px;font-weight:800;color:#8a6512;margin-right:4px}'
    + '.wpdir a{font-size:11px;color:var(--brand-soft);cursor:pointer;text-decoration:underline;margin-left:6px}'
    + '.wpcmt{font-size:12px;color:#3a5a50;background:#f2f7f4;border-radius:7px;padding:4px 9px;margin:3px 0 2px;white-space:pre-wrap}'
    + '.wpcmt .who{font-size:10.5px;font-weight:800;color:var(--income);margin-right:4px}'
    + '.wpdirbtn{border:1px dashed #d8c08a;background:#fff;color:#8a6512;border-radius:999px;font-size:11px;font-weight:700;padding:1px 9px;cursor:pointer;font-family:inherit;margin:2px 0}'
    + '.wpdired{display:flex;gap:6px;margin:4px 0;align-items:flex-start}.wpdired textarea{min-height:38px;font-size:12.5px;padding:6px 8px;flex:1}'
    + '.wpcard{border:1px solid var(--line);border-radius:12px;margin-bottom:12px;overflow:hidden;background:#fff}'
    + '.wpch{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 13px;background:#faf8f3;border-bottom:1px solid var(--line)}'
    + '.wpch .nm{font-size:14px;font-weight:800;color:var(--brand);margin-right:4px}'
    + '.wpcols{display:grid;grid-template-columns:1fr 1fr}'
    + '@media(max-width:720px){.wpcols{grid-template-columns:1fr}.wpcols .wpcol+.wpcol{border-left:none;border-top:1px solid var(--line)}}'
    + '.wpcol{padding:9px 13px;min-width:0}.wpcol+.wpcol{border-left:1px solid var(--line)}'
    + '.wpcolh{font-size:12px;font-weight:800;color:var(--brand);margin-bottom:5px;display:flex;gap:6px;align-items:center}'
    + '.wpcolh span{font-weight:600;color:var(--muted);font-size:11px}'
    + '.wpol{margin:0;padding-left:20px;font-size:13px;line-height:1.55}.wpol li{margin:2px 0}'
    + '.wpul{list-style:none;margin:0;padding:0;font-size:13px}.wpul li{padding:5px 0;border-bottom:1px dashed #efe9dc}.wpul li:last-child{border-bottom:none}'
    + '.wpbd{display:inline-block;min-width:34px;text-align:center;font-size:10.5px;font-weight:800;border-radius:5px;padding:1px 5px;margin-right:6px}'
    + '.wpbd.done{background:var(--income);color:#fff}.wpbd.partial{background:var(--gold);color:#fff}.wpbd.missed{background:#fff;color:var(--expense);border:1px solid #e7b6af}'
    + '.wpdaycm{padding:8px 13px;border-top:1px solid var(--line);background:#fffdf7}'
    + '.wppick{border:1px solid var(--line);border-radius:10px;padding:9px 12px;margin-bottom:12px;background:#fafcfb}'
    + '.wppick .row1{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px}'
    + '.wppick .lst{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:8px}'
    + '.wppick .lst label{display:flex;align-items:center;gap:5px;font-size:12.5px;font-weight:500;color:var(--ink);margin:0}'
    + '.wppick .lst input{width:auto}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  // ── 공통 ──
  function api(path, opt) {
    opt = opt || {};
    var h = Object.assign({}, auth(), opt.body ? { 'Content-Type': 'application/json' } : {});
    return fetch(session.api + path, { method: opt.method || 'GET', headers: h, body: opt.body ? JSON.stringify(opt.body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.__status = r.status; j.__ok = r.ok; return j; }); });
  }
  function msg(id, ok, text) { var m = $(id); if (!m) return; m.className = 'msg ' + (ok ? 'ok' : 'err'); m.textContent = text; }
  function md(ymd) { var p = ymd.split('-'); return Number(p[1]) + '/' + Number(p[2]); }
  function dowK(ymd) { return ['일', '월', '화', '수', '목', '금', '토'][new Date(ymd + 'T00:00:00').getDay()]; }
  function addD(ymd, n) { var d = new Date(ymd + 'T00:00:00'); d.setDate(d.getDate() + n); return cYmd(d); }
  function errText(j, dflt) { return (j && j.message) || (j && j.error === 'migration_required' ? '서버에서 npm run migrate 를 실행하세요 (0263·0266).' : dflt); }

  // ═════════ 달력 표식 ═════════
  var W = { marks: {}, enabled: false, today: null, workdays: null };
  window.wpLoadMarks = function (from, to) {
    var f = cYmd(from), t = cYmd(to);
    var need = W.workdays ? Promise.resolve() : api('/api/workplan/settings').then(function (j) { if (j.__ok) { W.workdays = j.settings.workdays; W.today = j.today; } });
    return need.then(function () { return api('/api/workplan/marks?from=' + f + '&to=' + t); })
      .then(function (j) { if (!j.__ok) { W.enabled = false; W.marks = {}; return; } W.enabled = !!j.enabled; W.today = j.today; W.marks = j.marks || {}; })
      .catch(function () { W.enabled = false; });
  };
  window.wpMark = function (key) {
    var m0 = W.marks[key];
    var dm = m0 && m0.dir ? '<span class="wpmk dir' + (m0.dir === 'seen' ? ' seen' : '') + '" title="디렉터 코멘트' + (m0.dir === 'seen' ? ' (확인함)' : ' — 눌러서 확인') + '">💬' + (m0.dir === 'seen' ? '' : ' 코멘트') + '</span>' : '';
    return wpMarkWork(key) + dm;
  };
  function wpMarkWork(key) {
    if (!W.enabled || !W.today) return '';
    var m = W.marks[key];
    var past = key < W.today;
    var work = !W.workdays || W.workdays.indexOf(new Date(key + 'T00:00:00').getDay()) >= 0;
    if (m && m.done_saved) {
      var sc = m.done + m.partial * 0.5, full = m.total && sc === m.total;
      var label = m.total ? ((sc % 1 ? sc.toFixed(1) : sc) + '/' + m.total) : '한 일';
      return '<span class="wpmk ' + (full ? 'ok' : 'mid') + '" title="오늘 한 일 작성 · 완료(일부=½) / 계획">' + (full ? '✅ ' : '한 일 ') + label + '</span>';
    }
    if (m && m.plan) return past ? '<span class="wpmk bad" title="할 일만 작성 — 한 일 미작성">한 일 미작성</span>'
      : '<span class="wpmk plan" title="오늘 할 일 작성">🌅 할 일 ' + m.total + '</span>';
    if (past && work && key >= WP_LAUNCH) return '<span class="wpmk bad" title="업무일지 미작성">미작성</span>';
    return '';
  }
  function refreshGrid() { try { var r = calRange(); renderCal(r.from, r.to); } catch (_) {} }

  // ═════════ 날짜 모달 ═════════
  var D = null;          // /api/workplan/me 응답
  var tab = 'plan';
  var plan = [];         // [{id,title,carried,carry_count,added_late}]
  var marks = {};        // id → {status,note}
  var base = '';
  function snap() { return JSON.stringify({ p: plan.map(function (x) { return [x.id, x.title]; }), m: marks, e: (extraInput() || {}).value || (D && D.day.extra_done) || '' }); }
  window.wpDirty = function () { return !!(D && D.enabled && base && snap() !== base); };

  window.wpLoadDay = function (key) {
    var box = $('wpBox'); if (!box) return;
    box.innerHTML = ''; D = null; base = '';
    api('/api/workplan/me?date=' + key).then(function (j) {
      if (typeof dmDate !== 'undefined' && dmDate !== key) return;
      var b = $('wpBox'); if (!b) return;
      if (!j.__ok) {
        if (j.__status === 503) b.innerHTML = '<div class="hint" style="margin-bottom:10px">업무일지: ' + esc(errText(j, '')) + '</div>';
        return;
      }
      INBOX = j.inbox || [];
      if (!j.enabled) {   // 디렉터·대상 아닌 계정 — (받은 코멘트) + 팀 업무 바로가기
        b.innerHTML = inboxHtml() + '<div class="wpteamlink"><button class="btn ghost sm" type="button" data-wp="team" data-date="' + key + '">👥 이 날 팀 업무 보기</button></div>';
        return;
      }
      D = j;
      plan = j.items.map(mapItem);
      marks = {};
      j.items.forEach(function (i) { if (i.status !== 'open') marks[i.id] = { status: i.status, note: i.note || '' }; else marks[i.id] = { status: '', note: i.note || '' }; });
      // 기본 탭: 할 일을 이미 썼고(또는 지난 날짜) 한 일 마감 2시간 전부터는 「오늘 한 일」
      var doneMin = hm2min(j.settings.done_deadline);
      tab = (j.date < j.today && j.day.plan_saved_at) || (j.date === j.today && j.day.plan_saved_at && j.now_min >= doneMin - 120) || j.day.done_saved_at ? 'done' : 'plan';
      if (!j.can_plan && j.can_done) tab = 'done';
      render();
      base = snap();
    }).catch(function () {});
  };
  var INBOX = [];
  function mapItem(i) { return { id: i.id, title: i.title, carried: i.carried, carry_count: i.carry_count, added_late: i.added_late, dir_comment: i.dir_comment || '' }; }
  function dateLab(ymd) { return md(ymd) + '(' + dowK(ymd) + ')'; }
  // 📌 디렉터 코멘트 — 다음 근무일 일정표 맨 위
  function inboxHtml() {
    if (!INBOX.length) return '';
    var unseen = INBOX.some(function (x) { return !x.seen_at; });
    var h = '<div class="wpinbox"><h4>📌 디렉터 코멘트' + (unseen ? ' <span class="wpp late">새 코멘트</span>' : ' <span class="wpp ok">확인함</span>') + '</h4>';
    INBOX.forEach(function (x) {
      h += '<div class="wd">' + esc(dateLab(x.work_date)) + ' 업무에 대해</div>';
      if (x.day_comment) h += '<div class="dc">' + esc(x.day_comment) + '</div>';
      x.items.forEach(function (i) {
        var st = STAT[i.status];
        h += '<div class="ic">' + (st ? '<span class="wpbd ' + i.status + '">' + st.t + '</span>' : '') + '<b>' + esc(i.title) + '</b>'
          + '<div class="wpdir"><span class="who">디렉터</span>' + esc(i.dir_comment) + '</div></div>';
      });
    });
    if (unseen) h += '<div class="wpbtns" style="margin-top:6px"><button type="button" class="btn sm" data-wp="seen">확인했습니다</button></div>';
    return h + '</div>';
  }
  // 새 할 일 칸은 id 없음(DraftKeeper 가 방금 추가한 글을 되살리지 않게) · 계획 외 한 일은 날짜별 id(모바일 앱 전환 시 그 날짜에만 복원)
  function newInput() { return document.querySelector('#wpBox [data-wpin="new"]'); }
  function extraInput() { return document.querySelector('#wpBox [data-wpin="extra"]'); }
  function hm2min(s) { var p = String(s || '').split(':'); return Number(p[0]) * 60 + Number(p[1] || 0); }

  function render() {
    var b = $('wpBox'); if (!b || !D) return;
    var j = D, d = j.day;
    var planSub = d.plan_saved_at ? ('✔ ' + d.plan_hm + (d.plan_late ? ' 지연' : '')) : ('마감 ' + j.settings.plan_deadline);
    var doneSub = d.done_saved_at ? ('✔ ' + d.done_hm + (d.done_late ? ' 지연' : '')) : ('마감 ' + j.settings.done_deadline);
    var h = inboxHtml() + '<div class="wpbox"><div class="wptabs">'
      + '<button type="button" class="wptab' + (tab === 'plan' ? ' on' : '') + '" data-wp="tab" data-tab="plan">🌅 오늘 할 일<small>' + esc(planSub) + '</small></button>'
      + '<button type="button" class="wptab' + (tab === 'done' ? ' on' : '') + '" data-wp="tab" data-tab="done">🌙 오늘 한 일<small>' + esc(doneSub) + '</small></button>'
      + '</div><div class="wpb">' + (tab === 'plan' ? planHtml() : doneHtml()) + '<div class="msg" id="wp-msg"></div></div></div>'
      + '<div class="wpteamlink"><button class="btn ghost sm" type="button" data-wp="team" data-date="' + esc(j.date) + '">👥 이 날 팀 업무 보기</button></div>';
    b.innerHTML = h;
  }
  function pills(i) {
    return (i.carried ? ' <span class="wpp carry">' + (i.carry_count >= 2 ? i.carry_count + '회 이월' : '이월') + '</span>' : '')
      + (i.added_late ? ' <span class="wpp add">추가</span>' : '');
  }
  function planHtml() {
    var j = D, d = j.day, edit = j.can_plan;
    var h = '<div class="wpst">';
    if (d.plan_saved_at) h += '<span class="wpp ' + (d.plan_late ? 'late' : 'ok') + '">' + esc(d.plan_hm) + ' 작성' + (d.plan_late ? ' · 지연' : '') + '</span>';
    else if (j.date < j.today) h += '<span class="wpp late">미작성 — 지금 쓰면 지연으로 남습니다</span>';
    if (!j.workday) h += '<span class="wpp">근무일 아님</span>';
    if (edit) h += '<span>한 줄 = 한 항목 · 어제 못 끝낸 일은 자동으로 올라옵니다(지울 수 있음)</span>';
    else h += '<span>지난 날짜 — 읽기 전용</span>';
    h += '</div><div id="wp-plan">';
    if (!plan.length) h += '<div class="hint">' + (edit ? '아직 할 일이 없습니다. 아래에 적으세요.' : '적은 할 일이 없습니다.') + '</div>';
    plan.forEach(function (i, k) {
      h += '<div class="wpli">' + (edit
        ? '<input class="wpt" type="text" maxlength="300" data-wp="title" data-k="' + k + '" value="' + esc(i.title) + '">' + pills(i) + '<button type="button" class="wpx" data-wp="del" data-k="' + k + '" title="빼기">✕</button>'
        : '<span class="tt">' + esc(i.title) + pills(i) + '</span>') + '</div>';
    });
    h += '</div>';
    if (edit) {
      h += '<div class="wpadd"><input data-wpin="new" type="text" maxlength="300" placeholder="할 일 입력 후 Enter (한 줄 = 한 항목)"><button type="button" class="btn sm ghost" data-wp="add">추가</button></div>'
        + '<div class="wpbtns"><button type="button" class="btn" id="wp-savePlan" data-wp="savePlan">할 일 저장</button>'
        + '<span class="hint">' + (d.plan_saved_at ? j.settings.plan_deadline + ' 이후 추가한 항목은 「추가」로 표시됩니다.' : '') + '</span></div>';
    }
    return h;
  }
  function doneHtml() {
    var j = D, d = j.day, edit = j.can_done;
    var h = '<div class="wpst">';
    if (j.date > j.today) return h + '<span>아직 오지 않은 날짜입니다 — 한 일은 그날 적어 주세요.</span></div>';
    var n = plan.length, c = { done: 0, partial: 0, missed: 0 };
    plan.forEach(function (i) { var s = (marks[i.id] || {}).status; if (c[s] != null) c[s]++; });
    if (d.done_saved_at) h += '<span class="wpp ' + (d.done_late ? 'late' : 'ok') + '">' + esc(d.done_hm) + ' 작성' + (d.done_late ? ' · 지연' : '') + '</span>';
    if (n) h += '<b style="color:var(--brand)">계획 ' + n + '건 중 완료 ' + c.done + ' · 일부 ' + c.partial + ' · 못함 ' + c.missed + '</b>';
    if (edit) h += '<span>버튼을 누를 때마다 완료 → 일부 → 못함 · 표시 안 한 항목은 「못함」으로 저장</span>';
    else h += '<span>지난 날짜 — 읽기 전용</span>';
    h += '</div>';
    if (!n) h += '<div class="hint">' + (d.plan_saved_at ? '할 일이 없습니다.' : '아침에 적은 할 일이 없습니다 — 한 일은 아래 「계획에 없던 한 일」에 적으세요.') + '</div>';
    plan.forEach(function (i, k) {
      var m = marks[i.id] || { status: '', note: '' };
      var sc = STAT[m.status];
      h += '<div class="wpli"><button type="button" class="wpchk ' + (sc ? sc.c : '') + '" data-wp="cycle" data-id="' + i.id + '"' + (edit ? '' : ' disabled') + '>' + (sc ? sc.t : '—') + '</button>'
        + '<span class="tt"' + (m.status === 'done' ? ' style="color:var(--muted);text-decoration:line-through"' : '') + '>' + esc(i.title) + pills(i) + '</span></div>';
      // 항목마다 코멘트(0266) — 상태와 상관없이 늘 적을 수 있다
      var ph = m.status === 'partial' ? '코멘트 — 어디까지 했는지' : (m.status === 'missed' || !m.status ? '코멘트 — 못 한 이유 (내일로 이월됩니다)' : '코멘트 — 결과·특이사항');
      if (edit) h += '<div class="wpnote"><input type="text" maxlength="500" data-wp="note" data-id="' + i.id + '" placeholder="' + ph + '" value="' + esc(m.note || '') + '"></div>';
      else if (m.note) h += '<div class="wpnote"><div class="wpcmt"><span class="who">내 코멘트</span>' + esc(m.note) + '</div></div>';
      if (i.dir_comment) h += '<div class="wpnote"><div class="wpdir"><span class="who">디렉터</span>' + esc(i.dir_comment) + '</div></div>';
    });
    h += '<div class="wpsub">➕ 계획에 없던 한 일</div>';
    if (edit) h += '<textarea id="wp-extra-' + esc(j.date) + '" data-wpin="extra" maxlength="4000" placeholder="예: 창고 요청으로 반품 입고 검수 · 재고 문의 고객 3명 응대">' + esc(d.extra_done || '') + '</textarea>'
      + '<div class="wpbtns"><button type="button" class="btn" id="wp-saveDone" data-wp="saveDone">한 일 저장 (마감)</button><span class="hint">저장 후에도 오늘 23:59까지 고칠 수 있습니다.</span></div>';
    else h += '<div style="white-space:pre-wrap;font-size:13px">' + (d.extra_done ? esc(d.extra_done) : '<span class="hint">없음</span>') + '</div>';
    if (d.dir_comment) h += '<div class="wpsub">🧭 디렉터 종합 코멘트</div><div class="wpdir">' + esc(d.dir_comment) + '</div>';
    return h;
  }
  function syncInputs() {
    document.querySelectorAll('#wpBox input[data-wp="title"]').forEach(function (el) { var k = Number(el.getAttribute('data-k')); if (plan[k]) plan[k].title = el.value; });
    document.querySelectorAll('#wpBox input[data-wp="note"]').forEach(function (el) { var id = Number(el.getAttribute('data-id')); if (marks[id]) marks[id].note = el.value; });
    var ex = extraInput(); if (ex && D) D.day.extra_done = ex.value;
  }
  function addNew() {
    var el = newInput(); if (!el) return;
    var lines = String(el.value || '').split(/\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!lines.length) return;
    syncInputs();
    lines.forEach(function (t) { plan.push({ id: null, title: t, carried: false, carry_count: 0, added_late: false }); });
    render(); var n = newInput(); if (n) n.focus();
  }
  function savePlan() {
    syncInputs();
    var items = plan.map(function (i) { return { id: i.id, title: i.title }; }).filter(function (i) { return String(i.title || '').trim(); });
    var btn = $('wp-savePlan'); if (btn) btn.disabled = true;
    api('/api/workplan/plan/' + D.date, { method: 'PUT', body: { items: items } }).then(function (j) {
      if (!j.__ok) { if (btn) btn.disabled = false; msg('wp-msg', false, errText(j, '저장하지 못했습니다.')); return; }
      applySaved(j); msg('wp-msg', true, '할 일을 저장했습니다.');
    }).catch(function () { if (btn) btn.disabled = false; msg('wp-msg', false, '저장하지 못했습니다.'); });
  }
  function saveDone() {
    syncInputs();
    var items = plan.filter(function (i) { return i.id; }).map(function (i) { var m = marks[i.id] || {}; return { id: i.id, status: m.status || 'missed', note: m.note || '' }; });
    var btn = $('wp-saveDone'); if (btn) btn.disabled = true;
    api('/api/workplan/done/' + D.date, { method: 'PUT', body: { items: items, extra_done: (D.day.extra_done || '') } }).then(function (j) {
      if (!j.__ok) { if (btn) btn.disabled = false; msg('wp-msg', false, errText(j, '저장하지 못했습니다.')); return; }
      applySaved(j); msg('wp-msg', true, '한 일을 저장했습니다. 수고하셨습니다!');
    }).catch(function () { if (btn) btn.disabled = false; msg('wp-msg', false, '저장하지 못했습니다.'); });
  }
  function applySaved(j) {
    D.day = j.day; D.items = j.items;
    W.enabled = true; W.today = W.today || D.today;   // 달력 표식이 아직 안 불러졌어도 저장 결과는 바로 반영
    D.can_plan = D.date >= D.today || !j.day.plan_saved_at;
    D.can_done = D.date <= D.today && (D.date === D.today || !j.day.done_saved_at);
    plan = j.items.map(mapItem);
    marks = {}; j.items.forEach(function (i) { marks[i.id] = { status: i.status === 'open' ? '' : i.status, note: i.note || '' }; });
    W.marks[D.date] = { total: j.sum.total, done: j.sum.done, partial: j.sum.partial, plan: j.sum.plan_written, done_saved: j.sum.done_written };
    render(); base = snap(); refreshGrid();
  }

  // 모달 이벤트(위임)
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-wp]') : null;
    if (!t) return;
    var act = t.getAttribute('data-wp');
    if (act === 'tab') { syncInputs(); tab = t.getAttribute('data-tab'); render(); return; }
    if (act === 'add') { addNew(); return; }
    if (act === 'del') { syncInputs(); plan.splice(Number(t.getAttribute('data-k')), 1); render(); return; }
    if (act === 'savePlan') { savePlan(); return; }
    if (act === 'seen') {
      t.disabled = true;
      api('/api/workplan/inbox/seen', { method: 'POST', body: { dates: INBOX.map(function (x) { return x.work_date; }) } }).then(function (r) {
        if (!r.__ok) { t.disabled = false; return; }
        INBOX.forEach(function (x) { x.seen_at = x.seen_at || new Date().toISOString(); });
        Object.keys(W.marks).forEach(function (k) { if (W.marks[k].dir === 'new') W.marks[k].dir = 'seen'; });
        var b = $('wpBox');
        if (D) { syncInputs(); render(); } else if (b) { var ib = b.querySelector('.wpinbox'); if (ib) ib.outerHTML = inboxHtml(); }
        refreshGrid();
      });
      return;
    }
    if (act === 'saveDone') { saveDone(); return; }
    if (act === 'cycle') {
      if (!D || !D.can_done) return;
      syncInputs();
      var id = Number(t.getAttribute('data-id')); var m = marks[id] || (marks[id] = { status: '', note: '' });
      m.status = CYCLE[(CYCLE.indexOf(m.status) + 1) % CYCLE.length]; render(); return;
    }
    if (act === 'team') {
      var dt = t.getAttribute('data-date');
      if (window.wpDirty() && !confirm('저장하지 않은 업무일지가 있습니다. 저장하지 않고 이동할까요?')) return;
      if ($('dayModal')) $('dayModal').style.display = 'none';
      openTeam(dt); return;
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.target && e.target.getAttribute && e.target.getAttribute('data-wpin') === 'new' && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addNew(); }
  });

  // ═════════ 팀 업무 ═════════
  var T = { date: null, data: null };
  function openTeam(date) {
    showTab('team');
    try { history.replaceState(null, '', '#tab=team'); } catch (_) {}
    loadTeam(date || T.date || W.today || cYmd(new Date()));
  }
  window.wpOpenTeam = function () { loadTeam(T.date || W.today || cYmd(new Date())); };
  function loadTeam(date) {
    T.date = date;
    $('wpTitle').textContent = md(date) + '(' + dowK(date) + ')';
    $('wpTeamBody').innerHTML = '<div class="hint">불러오는 중…</div>';
    api('/api/workplan/team?date=' + date).then(function (j) {
      if (T.date !== date) return;
      if (!j.__ok) { $('wpTeamBody').innerHTML = '<div class="hint">' + esc(errText(j, '불러오지 못했습니다.')) + '</div>'; return; }
      T.data = j; W.today = j.today;
      var hh = Math.floor(j.now_min / 60), mm = j.now_min % 60;
      $('wpAsOf').textContent = j.date === j.today ? ('멕시코 ' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ' 기준') : '';
      $('wpTeamBody').innerHTML = teamHtml(j);
    }).catch(function () { $('wpTeamBody').innerHTML = '<div class="hint">불러오지 못했습니다.</div>'; });
    if (isDirector) loadAdmin();
  }
  // ── 팀 카드(0266): 왼쪽 「할 일」 목록 · 오른쪽 「한 일」 목록(결과 + 직원 코멘트 + 디렉터 코멘트) ──
  var CE = {};   // 디렉터 코멘트 편집 중인 칸: key → true  (key = uid:itemId | uid:day)
  function pillsT(i) {
    return (i.carried ? ' <span class="wpp carry">' + (i.carry_count >= 2 ? i.carry_count + '회 이월' : '이월') + '</span>' : '')
      + (i.added_late ? ' <span class="wpp add">추가</span>' : '');
  }
  function dirBlock(m, item) {
    var key = m.user_id + ':' + (item ? item.id : 'day');
    var text = item ? item.dir_comment : m.day.dir_comment;
    var dir = T.data && T.data.is_director;
    if (dir && CE[key]) {
      return '<div class="wpdired"><textarea maxlength="1000" data-wpc="text" data-key="' + key + '" placeholder="' + (item ? '이 항목에 대한 코멘트' : '오늘 업무 전체에 대한 코멘트') + ' — 다음 근무일 직원 일정표에 표시">' + esc(text || '') + '</textarea>'
        + '<div style="display:flex;flex-direction:column;gap:4px"><button type="button" class="btn sm" data-wpc="save" data-key="' + key + '" data-uid="' + m.user_id + '" data-item="' + (item ? item.id : '') + '">저장</button>'
        + '<button type="button" class="btn ghost sm" data-wpc="cancel" data-key="' + key + '">취소</button></div></div>';
    }
    if (text) return '<div class="wpdir"><span class="who">디렉터</span>' + esc(text) + (dir ? '<a data-wpc="edit" data-key="' + key + '">수정</a>' : '') + '</div>';
    return dir ? '<button type="button" class="wpdirbtn" data-wpc="edit" data-key="' + key + '">💬 ' + (item ? '코멘트' : '종합 코멘트') + '</button>' : '';
  }
  function memberCard(m, j) {
    var d = m.day, s = m.sum;
    var head = '<div class="wpch"><span class="nm">' + esc(m.name) + '</span>'
      + (d.plan_saved_at ? '<span class="wpp ' + (d.plan_late ? 'late' : 'ok') + '">할 일 ' + esc(d.plan_hm) + (d.plan_late ? ' 지연' : '') + '</span>' : '<span class="wpp late">할 일 미작성</span>')
      + (d.done_saved_at ? '<span class="wpp ' + (d.done_late ? 'late' : 'ok') + '">한 일 ' + esc(d.done_hm) + (d.done_late ? ' 지연' : '') + '</span>'
        + '<span class="wpbar" style="margin-left:4px"><i style="width:' + (s.rate || 0) + '%"></i></span><b style="font-size:12px;color:var(--brand)">' + (s.score % 1 ? s.score.toFixed(1) : s.score) + '/' + s.total + '</b>'
        : '<span class="wpp">한 일 작성 전</span>');
    var hasDir = d.dir_comment || m.items.some(function (i) { return i.dir_comment; });
    if (j.is_director && hasDir) head += d.dir_seen_at ? '<span class="wpp ok" style="margin-left:auto">💬 직원 확인함</span>'
      : '<span class="wpp carry" style="margin-left:auto">💬 ' + (d.dir_show_date ? esc(dateLab(d.dir_show_date)) + ' 일정표에 표시 · ' : '') + '미확인</span>';
    head += '</div>';
    // 왼쪽: 할 일
    var left = '<div class="wpcol"><div class="wpcolh">🌅 할 일 <span>' + m.items.length + '건</span></div>';
    if (!m.items.length) left += '<div class="hint">' + (d.plan_saved_at ? '할 일 없음' : '아직 적지 않았습니다') + '</div>';
    else left += '<ol class="wpol">' + m.items.map(function (i) {
      return '<li>' + esc(i.title) + pillsT(i) + (d.done_saved_at ? '' : dirBlock(m, i)) + '</li>';
    }).join('') + '</ol>';
    left += '</div>';
    // 오른쪽: 한 일
    var right = '<div class="wpcol"><div class="wpcolh">🌙 한 일' + (d.done_saved_at ? ' <span>완료 ' + s.done + ' · 일부 ' + s.partial + ' · 못함 ' + s.missed + '</span>' : '') + '</div>';
    if (!d.done_saved_at) right += '<div class="hint">' + (j.date > j.today ? '아직 오지 않은 날입니다' : '아직 작성 전') + '</div>';
    else {
      right += '<ul class="wpul">' + m.items.map(function (i) {
        var st = STAT[i.status] || { t: '—' };
        return '<li><span class="wpbd ' + i.status + '">' + st.t + '</span>' + esc(i.title)
          + (i.note ? '<div class="wpcmt"><span class="who">' + esc(m.name) + '</span>' + esc(i.note) + '</div>' : '')
          + dirBlock(m, i) + '</li>';
      }).join('') + '</ul>';
      if (d.extra_done) right += '<div class="wpcolh" style="margin-top:8px">➕ 계획에 없던 한 일</div><div style="white-space:pre-wrap;font-size:13px">' + esc(d.extra_done) + '</div>';
    }
    right += '</div>';
    var dayCm = (d.dir_comment || j.is_director) ? '<div class="wpdaycm"><div class="wpcolh">🧭 디렉터 종합 코멘트</div>' + dirBlock(m, null) + '</div>' : '';
    return '<div class="wpcard" data-uid="' + m.user_id + '">' + head + '<div class="wpcols">' + left + right + '</div>' + dayCm + '</div>';
  }
  function teamHtml(j) {
    var k = j.kpi;
    var h = '<div class="wpkpi">'
      + '<div><b>' + k.plan_written + ' / ' + k.members + '</b><span>오늘 할 일 작성</span></div>'
      + '<div><b>' + k.done_written + ' / ' + k.members + '</b><span>오늘 한 일 작성</span></div>'
      + '<div><b>' + (k.rate == null ? '—' : k.rate + '%') + '</b><span>계획 완료율 (한 일 작성자)</span></div>'
      + '<div><b>' + k.plan_missing.length + '</b><span>할 일 미작성' + (k.plan_missing.length ? ' — ' + esc(k.plan_missing.join(', ')) : '') + '</span></div>'
      + '</div>';
    if (!j.workday) h += '<div class="hint" style="margin-bottom:8px">근무일이 아닌 날입니다(설정 기준).</div>';
    if (!j.members.length) return h + '<div class="hint">업무일지를 사용하는 직원이 없습니다.' + (j.is_director ? ' 위 「직원 선택」에서 고르세요.' : '') + '</div>';
    if (j.is_director) h += '<div class="hint" style="margin-bottom:8px">💬 코멘트는 그 직원과 디렉터만 봅니다 · 다음 근무일에 직원 일정표 맨 위에 표시됩니다.</div>';
    return h + j.members.map(function (m) { return memberCard(m, j); }).join('');
  }
  function rerenderTeam() { if (T.data) $('wpTeamBody').innerHTML = teamHtml(T.data); }
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-wpc]') : null;
    if (!t || !T.data) return;
    var a = t.getAttribute('data-wpc'), key = t.getAttribute('data-key');
    if (a === 'edit') { CE[key] = true; rerenderTeam(); var ta = document.querySelector('#wpTeamBody textarea[data-key="' + key + '"]'); if (ta) ta.focus(); return; }
    if (a === 'cancel') { delete CE[key]; rerenderTeam(); return; }
    if (a === 'save') {
      var ta2 = document.querySelector('#wpTeamBody textarea[data-key="' + key + '"]');
      var body = ta2 ? ta2.value : '';
      var uid = Number(t.getAttribute('data-uid')), item = t.getAttribute('data-item');
      t.disabled = true;
      api('/api/workplan/comment', { method: 'PUT', body: { user_id: uid, date: T.data.date, item_id: item ? Number(item) : null, body: body } }).then(function (r) {
        if (!r.__ok) { t.disabled = false; alertBox(errText(r, '저장하지 못했습니다.')); return; }
        // 화면 상태 갱신(서버가 표시 날짜·확인 초기화를 정한다)
        T.data.members.forEach(function (m) {
          if (m.user_id !== uid) return;
          if (item) m.items.forEach(function (i) { if (i.id === Number(item)) i.dir_comment = body.trim(); });
          else m.day.dir_comment = body.trim();
          m.day.dir_show_date = r.show_date; m.day.dir_seen_at = null;
        });
        delete CE[key]; rerenderTeam();
      }).catch(function () { t.disabled = false; alertBox('저장하지 못했습니다.'); });
    }
  });
  function alertBox(text) { var b = $('wpTeamBody'); if (!b) return; var d = document.createElement('div'); d.className = 'msg err'; d.textContent = text; b.insertBefore(d, b.firstChild); setTimeout(function () { try { d.remove(); } catch (_) {} }, 5000); }

  // ── 디렉터: 업무일지 사용 직원 선택(0266 — 기본 꺼짐, 고른 직원만) ──
  var PK = { open: false };
  function renderPick() {
    var el = $('wpPick'); if (!el) return;
    if (!isDirector || !A.users.length) { el.innerHTML = ''; return; }
    var staff = A.users.filter(function (u) { return !u.director; });
    var on = staff.filter(function (u) { return u.enabled; });
    var h = '<div class="wppick"><div class="row1"><b style="color:var(--brand)">👥 업무일지 사용 직원 ' + on.length + '명</b>'
      + '<span class="hint">' + (on.length ? esc(on.map(function (u) { return u.name; }).join(', ')) : '아직 아무도 없습니다') + '</span>'
      + '<button type="button" class="btn ghost sm" style="margin-left:auto" data-wpp="toggle">' + (PK.open ? '닫기' : '직원 선택') + '</button></div>';
    if (PK.open) {
      h += '<div class="lst">' + staff.map(function (u) {
        return '<label><input type="checkbox" data-wpa="target" value="' + u.id + '"' + (u.enabled ? ' checked' : '') + '> ' + esc(u.name)
          + ' <span class="hint">' + (u.has_phone ? '📱' : '번호 없음') + '</span></label>';
      }).join('') + '</div><div class="hint" style="margin-top:6px">체크한 직원만 일정표에 업무일지 칸이 생기고, 알림·요약 대상이 됩니다(즉시 반영). 디렉터는 대상이 아닙니다.</div>';
    }
    el.innerHTML = h + '</div>';
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-wpp]') : null;
    if (!t) return;
    PK.open = !PK.open; renderPick();
  });
  function bindTeamNav() {
    var on = function (id, fn) { var el = $(id); if (el) el.addEventListener('click', fn); };
    on('wpTeamBtn', function () { openTeam(W.today || cYmd(new Date())); });
    on('wpBackBtn', function () { showTab('cal'); try { history.replaceState(null, '', '#tab=cal'); } catch (_) {} });
    on('wpPrev', function () { if (T.date) loadTeam(addD(T.date, -1)); });
    on('wpNext', function () { if (T.date) loadTeam(addD(T.date, 1)); });
    on('wpToday', function () { loadTeam(W.today || cYmd(new Date())); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindTeamNav); else bindTeamNav();

  // ═════════ 디렉터 설정 · 발송 ═════════
  var A = { s: null, users: [], open: false };
  var HOURS = []; for (var hh = 0; hh < 24; hh++) HOURS.push(String(hh).padStart(2, '0'));
  var MINS = []; for (var mi = 0; mi < 60; mi += 5) MINS.push(String(mi).padStart(2, '0'));
  function tmSel(key, val) {
    var p = String(val || '00:00').split(':');
    var mins = MINS.indexOf(p[1]) >= 0 ? MINS : MINS.concat([p[1]]).sort();
    return '<span class="wptm"><select data-wpk="' + key + '" data-part="h">' + HOURS.map(function (x) { return '<option' + (x === p[0] ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select>:'
      + '<select data-wpk="' + key + '" data-part="m">' + mins.map(function (x) { return '<option' + (x === p[1] ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select></span>';
  }
  function loadAdmin() {
    Promise.all([api('/api/workplan/settings'), api('/api/workplan/users'), api('/api/workplan/wa/status')]).then(function (r) {
      if (!r[0].__ok) { $('wpAdmin').innerHTML = ''; return; }
      A.s = r[0].settings; A.next = r[0].next || []; A.ready = r[0].wa_ready;
      A.users = (r[1].items || []); A.st = r[2].__ok ? r[2] : null;
      W.workdays = A.s.workdays;
      renderAdmin(); renderPick();
    });
  }
  var KIND = { remind_plan: '할 일 알림', remind_done: '한 일 알림', sum_plan: '아침 요약', sum_done: '저녁 요약' };
  function renderAdmin() {
    var s = A.s, DW = ['일', '월', '화', '수', '목', '금', '토'];
    var h = '<div class="wpadm"><h3 data-wpa="toggle">⚙ 업무일지 설정 · WhatsApp ' + (A.open ? '▾' : '▸') + ' <span class="hint" style="font-weight:500">디렉터 전용</span></h3>';
    if (!A.open) { $('wpAdmin').innerHTML = h + '</div>'; return; }
    h += '<div class="wpset">'
      + '<div class="bx"><h4>⏰ 작성 마감</h4><label>오늘 할 일 마감</label>' + tmSel('plan_deadline', s.plan_deadline)
      + '<label>오늘 한 일 마감</label>' + tmSel('done_deadline', s.done_deadline)
      + '<label>근무일</label><div class="wpdays">' + DW.map(function (n, i) { return '<button type="button" data-wpa="day" data-d="' + i + '" class="' + (s.workdays.indexOf(i) >= 0 ? 'on' : '') + '">' + n + '</button>'; }).join('') + '</div></div>'
      + '<div class="bx"><h4>📲 직원 알림 (미작성자만)</h4>'
      + '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-wpk="remind_enabled" style="width:auto"' + (s.remind_enabled ? ' checked' : '') + '> 사용</label>'
      + '<label>할 일 알림</label>' + tmSel('remind_plan_at', s.remind_plan_at)
      + '<label>한 일 알림</label>' + tmSel('remind_done_at', s.remind_done_at)
      + '<label>Meta 승인 템플릿 이름 (24시간 창 밖용)</label><input type="text" data-wpk="remind_template" value="' + esc(s.remind_template || '') + '" placeholder="예: recordatorio_bitacora">'
      + '<div class="hint">변수 4개: {{1}} 이름 · {{2}} 무엇 · {{3}} 날짜 · {{4}} 마감시각. 비워 두면 직원이 최근 24시간 안에 회사 번호로 메시지를 보낸 경우에만 도착합니다.</div>'
      + '<label>템플릿 언어</label><input type="text" data-wpk="remind_template_lang" value="' + esc(s.remind_template_lang || 'es_MX') + '" style="width:110px"></div>'
      + '<div class="bx"><h4>📊 디렉터 요약 (이미지)</h4>'
      + '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-wpk="summary_enabled" style="width:auto"' + (s.summary_enabled ? ' checked' : '') + '> 사용</label>'
      + '<label>아침 요약 (계획)</label>' + tmSel('summary_plan_at', s.summary_plan_at)
      + '<label>저녁 요약 (실적)</label>' + tmSel('summary_done_at', s.summary_done_at)
      + '<label>받는 사람 (휴대폰 등록된 사용자 · 아무도 안 고르면 디렉터 번호 환경변수)</label><div class="wpusers">'
      + A.users.map(function (u) { return '<label><input type="checkbox" data-wpa="rcpt" value="' + u.id + '"' + (s.summary_user_ids.indexOf(u.id) >= 0 ? ' checked' : '') + (u.has_phone ? '' : ' disabled') + '> ' + esc(u.name) + ' <span class="hint">' + (u.has_phone ? esc(u.phone_masked) : '번호 없음') + '</span></label>'; }).join('')
      + '</div></div>'
      + '</div>'
      + '<div class="wpbtns"><button type="button" class="btn" data-wpa="save">설정 저장</button><span class="hint">' + (A.next.length ? '다음 자동 발송: ' + A.next.map(function (n) { return md(n.date) + ' ' + n.at + ' ' + KIND[n.kind]; }).join(' · ') : '') + '</span></div>'
      + '<div class="msg" id="wpa-msg"></div>'
      + '<div class="wpbtns" style="margin-top:14px"><b style="color:var(--brand);font-size:13px">' + esc(md(T.date || '')) + ' 요약</b>'
      + '<button type="button" class="btn ghost sm" data-wpa="prev" data-k="sum_plan">👁 아침 요약 미리보기</button>'
      + '<button type="button" class="btn ghost sm" data-wpa="prev" data-k="sum_done">👁 저녁 요약 미리보기</button>'
      + '<button type="button" class="btn sm" data-wpa="send" data-k="sum_plan"' + (A.ready ? '' : ' disabled title="WhatsApp 환경변수 없음"') + '>📲 아침 요약 지금 발송</button>'
      + '<button type="button" class="btn sm" data-wpa="send" data-k="sum_done"' + (A.ready ? '' : ' disabled title="WhatsApp 환경변수 없음"') + '>📲 저녁 요약 지금 발송</button></div>'
      + '<div id="wpa-prev"></div>';
    if (A.st) {
      h += '<div style="margin-top:12px;font-size:12.5px;font-weight:800;color:var(--brand)">최근 7일 발송 기록' + (A.st.wa_ready ? '' : ' <span class="wpp late">WhatsApp 미설정</span>') + '</div>';
      h += A.st.log.length ? '<table class="wplog"><tr><th>날짜</th><th>종류</th><th>받는 사람</th><th>상태</th><th>시도</th></tr>'
        + A.st.log.slice(0, 40).map(function (l) {
          return '<tr><td>' + esc(md(l.work_date)) + '</td><td>' + esc(KIND[l.kind] || l.kind) + '</td><td>' + esc(l.name || '') + ' <span class="hint">' + esc(l.to_masked || '') + '</span></td>'
            + '<td' + (l.error ? ' title="' + esc(l.error) + '"' : '') + '>' + (l.sent_at ? '<span class="wpp ok">' + esc(l.status.replace('sent_', '')) + '</span>' : '<span class="wpp late">실패</span> <span class="hint">' + esc((l.error || '').slice(0, 60)) + '</span>') + '</td><td>' + l.attempts + '</td></tr>';
        }).join('') + '</table>' : '<div class="hint">아직 발송 기록이 없습니다.</div>';
    }
    $('wpAdmin').innerHTML = h + '</div>';
  }
  function readAdmin() {
    var s = Object.assign({}, A.s);
    document.querySelectorAll('#wpAdmin select[data-wpk]').forEach(function (el) {
      var k = el.getAttribute('data-wpk'), part = el.getAttribute('data-part');
      var cur = String(s[k] || '00:00').split(':');
      if (part === 'h') cur[0] = el.value; else cur[1] = el.value;
      s[k] = cur[0] + ':' + cur[1];
    });
    document.querySelectorAll('#wpAdmin input[type=checkbox][data-wpk]').forEach(function (el) { s[el.getAttribute('data-wpk')] = el.checked; });
    document.querySelectorAll('#wpAdmin input[type=text][data-wpk]').forEach(function (el) { s[el.getAttribute('data-wpk')] = el.value.trim(); });
    s.summary_user_ids = []; document.querySelectorAll('#wpAdmin input[data-wpa="rcpt"]:checked').forEach(function (el) { s.summary_user_ids.push(Number(el.value)); });
    return s;
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-wpa]') : null;
    if (!t || !A.s) return;
    var a = t.getAttribute('data-wpa');
    if (a === 'toggle') { A.open = !A.open; renderAdmin(); return; }
    if (a === 'day') {
      A.s = readAdmin(); var d = Number(t.getAttribute('data-d'));
      var i = A.s.workdays.indexOf(d); A.s.workdays = A.s.workdays.slice(); if (i >= 0) A.s.workdays.splice(i, 1); else A.s.workdays.push(d);
      A.s.workdays.sort(); renderAdmin(); return;
    }
    if (a === 'save') {
      var body = readAdmin();
      api('/api/workplan/settings', { method: 'PUT', body: body }).then(function (j) {
        if (!j.__ok) { msg('wpa-msg', false, errText(j, '저장하지 못했습니다.') + (j.field ? ' (' + j.field + ')' : '')); return; }
        A.s = j.settings; A.next = j.next || []; W.workdays = A.s.workdays; renderAdmin(); msg('wpa-msg', true, '설정을 저장했습니다.');
      });
      return;
    }
    if (a === 'prev') {
      var k = t.getAttribute('data-k');
      $('wpa-prev').innerHTML = '<div class="hint">이미지 만드는 중…</div>';
      fetch(session.api + '/api/workplan/preview?kind=' + k + '&date=' + T.date, { headers: auth() }).then(function (r) {
        if (!r.ok) throw new Error('x'); return r.blob();
      }).then(function (b) {
        var u = URL.createObjectURL(b); $('wpa-prev').innerHTML = '<img class="wpprev" alt="요약 미리보기" src="' + u + '">';
      }).catch(function () { $('wpa-prev').innerHTML = '<div class="hint">미리보기를 만들지 못했습니다.</div>'; });
      return;
    }
    if (a === 'send') {
      var kk = t.getAttribute('data-k');
      if (!confirm(md(T.date) + ' ' + KIND[kk] + '을(를) 지금 받는 사람에게 보낼까요?')) return;
      t.disabled = true;
      api('/api/workplan/wa/send', { method: 'POST', body: { kind: kk, date: T.date } }).then(function (j) {
        t.disabled = false;
        if (!j.__ok) { msg('wpa-msg', false, errText(j, '발송하지 못했습니다.')); return; }
        var okN = (j.results || []).filter(function (x) { return x.ok; }).length;
        msg('wpa-msg', okN > 0, okN + '명에게 보냈습니다' + ((j.results || []).some(function (x) { return x.error; }) ? ' · 실패: ' + j.results.filter(function (x) { return x.error; }).map(function (x) { return x.error; }).join(' / ') : ''));
        loadAdmin();
      }).catch(function () { t.disabled = false; msg('wpa-msg', false, '발송하지 못했습니다.'); });
    }
  });
  document.addEventListener('change', function (e) {
    var t = e.target; if (!t || !t.getAttribute) return;
    if (t.getAttribute('data-wpa') === 'target') {
      var id = Number(t.value), on = t.checked;
      api('/api/workplan/users/' + id, { method: 'PUT', body: { enabled: on } }).then(function (j) {
        if (!j.__ok) { t.checked = !on; msg('wpa-msg', false, errText(j, '바꾸지 못했습니다.')); return; }
        A.users.forEach(function (u) { if (u.id === id) u.enabled = on; });
        renderPick();
        if (T.date) loadTeam(T.date);
      });
    }
  });
})();
