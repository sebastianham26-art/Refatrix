/* =====================================================================
 * Refatrix ERP · refatrix-leadwa.js — 고객등록 › 웹 가입 신청 WhatsApp 알림 패널 (0268)
 *
 *   디렉터 지시(2026-10-12):
 *     "① 가입신청이 접수되면 디렉터에게 발송 ② 담당자를 지정하면 담당자에게 발송
 *      모두 템플릿부터 만들 수 있도록" → "내가 Meta에서 템플릿을 만들수 있도록 가이드"
 *
 *   ★ 별 파일로 뺀 이유: refatrix-customers.html 은 이미 2천 줄이 넘는다. 패널을 거기
 *     밀어 넣으면 다음 사람이 이 기능을 찾지 못하고, 한 화면을 고치다 다른 탭을 깬다.
 *     refatrix-custform.js 와 같은 방식이다.
 *
 *   ★ 템플릿 본문·이름·샘플을 **여기에 쓰지 않는다.** 서버의 /template-guide 가 준 것을
 *     그대로 그린다 — 화면에 하드코딩하면 템플릿을 바꾸는 날 코드와 안내가 갈라지고,
 *     디렉터는 화면 안내대로 만들었는데 안 오는 상황을 만난다.
 *
 *   쓰는 쪽: RefLeadWa.render({ api, token, isDirector, userId })
 * ===================================================================== */
(function () {
  'use strict';
  var S = { api: '', token: '', isDirector: false, userId: null };
  var $ = function (id) { return document.getElementById(id); };
  var auth = function () { return { authorization: 'Bearer ' + S.token }; };
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /** onclick 속성에 안전하게 넣을 문자열 리터럴. */
  function jsLit(v) { return esc(JSON.stringify(String(v == null ? '' : v))); }

  function pill(bg, fg, t, tip) {
    return '<span class="pill" title="' + esc(tip || '') + '" style="background:' + bg + ';color:' + fg
      + ';font-weight:700;font-size:10.5px;padding:1px 7px;border-radius:6px">' + t + '</span>';
  }
  var ok = function (t, tip) { return pill('#e4f0eb', '#0F6E56', t, tip); };
  var bad = function (t, tip) { return pill('#fbe9e4', '#9a3b12', t, tip); };
  var warn = function (t, tip) { return pill('#f6eedd', '#8a5a00', t, tip); };

  /** 클립보드 — 권한이 없는 환경(사내 정책·구형 브라우저)에서도 복사가 되게 폴백을 둔다. */
  function copy(txt, btn) {
    function done() {
      if (!btn) return;
      var o = btn.getAttribute('data-label') || btn.textContent;
      btn.setAttribute('data-label', o);
      btn.textContent = '복사됨 ✔';
      setTimeout(function () { btn.textContent = o; }, 1200);
    }
    function fallback() {
      var t = document.createElement('textarea');
      t.value = txt; t.style.position = 'fixed'; t.style.left = '-9999px';
      document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); done(); }
      catch (e) { alert('복사하지 못했습니다. 아래 상자에서 직접 선택해 복사해 주세요.'); }
      document.body.removeChild(t);
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(done, fallback); return;
      }
    } catch (e) { /* 폴백으로 */ }
    fallback();
  }

  // ── 조각들 ─────────────────────────────────────────────────────────
  function statusRow(d) {
    var h = '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">';
    h += d.api_ready ? ok('WhatsApp 연결됨') : bad('토큰·발신번호 없음', '관리 › 외부 서비스 키 › WhatsApp');
    h += d.enabled ? ok('알림 켜짐') : bad('전체 꺼짐', '환경변수 LEAD_WA_ENABLED=0');
    h += d.webhook ? ok('웹훅 연결됨', '도착·읽음·실패 사유를 받습니다')
                   : warn('웹훅 미설정', '전달 결과를 알 수 없어 항상 템플릿으로 보냅니다');
    h += '</div>';
    if (!d.api_ready) {
      h += '<div class="banner warn" style="margin-top:8px"><b>아직 보낼 수 없습니다</b> — '
        + '관리 › 외부 서비스 키 › WhatsApp 에서 <span class="mono">영구 토큰</span>과 '
        + '<span class="mono">발신 전화번호 ID</span>를 넣어 주세요.</div>';
    }
    return h;
  }

  function switches(d) {
    function sw(id, on, label, desc) {
      return '<label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer;margin-top:6px">'
        + '<input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + ' style="margin-top:3px">'
        + '<span><b style="font-size:13px">' + label + '</b><br>'
        + '<span class="hint" style="margin:0">' + desc + '</span></span></label>';
    }
    return '<div style="margin-top:12px;padding:10px 12px;border:1px solid var(--line);border-radius:9px">'
      + '<div style="font-weight:700;font-size:12.5px;color:var(--brand)">보낼 알림 고르기</div>'
      + sw('lwRecv', d.settings.notify_received, '① 신청이 접수되면', '받는 사람(아래 명단) 전원에게 보냅니다.')
      + sw('lwAsgn', d.settings.notify_assigned, '② 담당자를 지정하면', '지정된 그 담당자에게만 보냅니다.')
      + '<div style="margin-top:8px"><button class="btn sm" id="lwSave">저장</button> '
      + '<span class="hint" id="lwSaveMsg" style="margin:0"></span></div></div>';
  }

  function targets(d) {
    var list = d.targets || [];
    var h = '<div style="margin-top:12px"><div style="font-weight:700;font-size:12.5px;color:var(--brand)">'
      + '받는 사람 (' + list.length + '명)</div>';
    if (!list.length) {
      return h + '<div class="hint">없습니다 — 관리 › 연동관리 › 팝업 알림 대상에서 지정하세요'
        + '(디렉터는 항상 포함됩니다).</div></div>';
    }
    h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">';
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var lbl = esc(t.name) + (t.role === 'director' ? ' (디렉터)' : '') + ' · ' + (t.lang === 'es' ? 'ES' : 'KO');
      var win = t.window_open === true ? '열림' : (t.window_open === false ? '닫힘' : '모름');
      h += t.has_phone
        ? ok(lbl + ' · ' + esc(t.wa_phone_masked || ''), '24시간 창: ' + win)
        : bad(lbl + ' · 번호 없음', '관리 › 사용자 에서 WhatsApp 번호를 넣어야 받습니다');
    }
    h += '</div>';
    // 조용히 빼지 않는다 — 안 보여 주면 「왜 나는 안 와요」가 원인 불명으로 남는다.
    if (d.no_phone_count > 0) {
      h += '<div class="banner warn" style="margin-top:8px"><b>' + d.no_phone_count
        + '명은 WhatsApp 번호가 없어 받지 못합니다</b> — 관리 › 사용자 에서 그 사람의 '
        + '<span class="mono">WhatsApp 번호</span>를 넣어 주세요. '
        + '번호를 채우면 다음 점검(60초)에서 밀린 알림이 나갑니다.</div>';
    }
    return h + '</div>';
  }

  /** 🧩 Meta 템플릿 만들기 — 서버가 준 안내를 그대로 그린다(여기서 본문을 만들지 않는다). */
  function guideBox(d, g) {
    var h = '<div style="margin-top:14px;padding:11px 13px;border:1px dashed #b8893b;border-radius:9px;background:#fffdf4">'
      + '<div style="font-weight:800;font-size:13px;color:#7a6212">🧩 Meta 에서 템플릿 만들기 (한 번만)</div>'
      + '<div class="hint" style="margin-top:4px">' + esc(g.where || '') + '<br>' + esc(g.note || '') + '</div>';
    var th = function (t, nowrap) {
      return '<th style="text-align:left;color:#6f6a60;font-weight:600;padding:2px 10px 2px 0'
        + (nowrap ? ';white-space:nowrap' : '') + ';vertical-align:top">' + t + '</th>';
    };
    var items = g.items || [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      h += '<div style="margin-top:10px;padding-top:10px;border-top:1px solid #eadfc0">'
        + '<div style="font-weight:700;font-size:12.5px">' + esc(it.title || '') + '</div>'
        + '<table style="margin:6px 0;font-size:12.5px"><tbody>'
        + '<tr>' + th('이름', true) + '<td style="padding:2px 0"><span class="mono"><b>' + esc(it.name) + '</b></span> '
        + '<button class="btn ghost sm" onclick="RefLeadWa.copy(' + jsLit(it.name) + ',this)">복사</button></td></tr>'
        + '<tr>' + th('카테고리', true) + '<td style="padding:2px 0">' + esc(it.category) + '</td></tr>'
        + '<tr>' + th('언어', true) + '<td style="padding:2px 0">' + esc(it.language_label)
        + ' <span class="hint" style="margin:0">(' + esc(it.language) + ')</span></td></tr>'
        + '<tr>' + th('헤더 · 버튼', true) + '<td style="padding:2px 0">' + esc(it.header) + ' · ' + esc(it.buttons) + '</td></tr>'
        + '<tr>' + th('본문') + '<td style="padding:2px 0">'
        + '<textarea readonly rows="5" style="font-family:ui-monospace,monospace;font-size:12px">' + esc(it.body) + '</textarea>'
        + '<button class="btn sm" style="margin-top:4px" onclick="RefLeadWa.copy(' + jsLit(it.body) + ',this)">본문 복사</button></td></tr>'
        + '<tr>' + th('{{1}} 샘플') + '<td style="padding:2px 0"><span class="mono" style="font-size:12px">' + esc(it.sample) + '</span> '
        + '<button class="btn ghost sm" onclick="RefLeadWa.copy(' + jsLit(it.sample) + ',this)">복사</button>'
        + '<div class="hint" style="margin:2px 0 0">' + esc(it.sample_hint || '') + '</div></td></tr>'
        + '</tbody></table></div>';
    }
    h += '<div class="hint" style="margin-top:8px">' + esc(g.after || '') + '</div>';
    h += '<div class="hint" style="margin-top:4px">지금 ERP 가 쓰는 이름: <span class="mono">' + esc(d.template) + '</span>'
      + (d.template_set ? '' : ' (기본값)') + ' · <span class="mono">' + esc(d.assign_template) + '</span>'
      + (d.assign_template_set ? '' : ' (기본값)')
      + ' · 언어 <span class="mono">' + esc(d.template_lang) + '</span></div>';
    return h + '</div>';
  }

  function tools() {
    return '<div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<select id="lwKind" style="width:auto"><option value="received">① 접수 알림</option>'
      + '<option value="assigned">② 담당자 지정 알림</option></select>'
      + '<select id="lwLang" style="width:auto"><option value="ko">한국어</option><option value="es">Español</option></select>'
      + '<button class="btn ghost sm" id="lwPrev">문구 미리보기</button>'
      + '<button class="btn sm" id="lwTest">나에게 시험 발송</button>'
      + '<span class="hint" id="lwTestMsg" style="margin:0"></span></div>'
      + '<div id="lwPrevBox" class="hidden" style="margin-top:8px"></div>';
  }

  function recent(d) {
    var rows = d.recent || [];
    var h = '<div style="margin-top:14px"><div style="font-weight:700;font-size:12.5px;color:var(--brand)">최근 발송</div>';
    if (!rows.length) return h + '<div class="hint">아직 발송 기록이 없습니다.</div></div>';
    h += '<table style="margin-top:6px;font-size:12.5px;width:100%"><thead><tr>'
      + '<th style="text-align:left">시각</th><th style="text-align:left">신청</th><th style="text-align:left">종류</th>'
      + '<th style="text-align:left">받는 사람</th><th style="text-align:left">결과</th></tr></thead><tbody>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var st = r.status === 'failed' ? bad('실패', r.error || '')
        : r.status === 'skipped' ? warn('건너뜀', r.error || '')
        : r.status === 'sending' ? warn('보내는 중', '')
        : ok(r.status === 'sent_template' ? '템플릿 전송' : '문구 전송', '');
      // 웹훅이 알려 준 **실제 전달 결과** — 「보냈다」와 「도착했다」는 다르다.
      var dlv = r.dlv_status
        ? ' ' + (r.dlv_status === 'failed' ? bad('미도착', r.dlv_reason || '')
            : ok(r.dlv_status === 'read' ? '읽음' : (r.dlv_status === 'delivered' ? '도착' : r.dlv_status), ''))
        : '';
      h += '<tr><td>' + esc(String(r.updated_at || '').slice(0, 16).replace('T', ' ')) + '</td>'
        + '<td>' + esc(r.empresa || ('#' + r.lead_id)) + '</td>'
        + '<td>' + (r.kind === 'assigned' ? '담당자 지정' : '접수') + '</td>'
        + '<td>' + esc(r.user_name || ('#' + r.user_id)) + ' <span class="hint" style="margin:0">'
        + esc(r.to_masked || '') + '</span></td>'
        + '<td>' + st + dlv + (r.attempts > 1 ? ' <span class="hint" style="margin:0">' + r.attempts + '회</span>' : '')
        + '</td></tr>';
    }
    return h + '</tbody></table></div>';
  }

  // ── 본체 ───────────────────────────────────────────────────────────
  async function render(cfg) {
    if (cfg) { S.api = cfg.api || S.api; S.token = cfg.token || S.token; S.isDirector = !!cfg.isDirector; S.userId = cfg.userId || S.userId; }
    var card = $('leadWaCard'), box = $('leadWaBody');
    if (!card || !box) return;
    if (!S.isDirector) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    box.innerHTML = '<div class="hint">불러오는 중…</div>';

    var d, g;
    try {
      var r = await Promise.all([
        fetch(S.api + '/api/crm-lead-wa/status', { headers: auth() }).then(function (x) { return x.json(); }),
        fetch(S.api + '/api/crm-lead-wa/template-guide', { headers: auth() }).then(function (x) { return x.json(); }),
      ]);
      d = r[0]; g = r[1];
    } catch (e) { box.innerHTML = '<div class="hint">불러오지 못했습니다.</div>'; return; }

    if (d && d.migrated === false) {
      box.innerHTML = '<div class="banner warn"><b>마이그레이션 대기</b> — Railway 콘솔에서 '
        + '<span class="mono">npm run migrate</span> 로 0268 을 적용해야 이 알림이 동작합니다.</div>';
      return;
    }
    if (!d || d.error) {
      box.innerHTML = '<div class="hint">' + esc((d && (d.note || d.error)) || '불러오지 못했습니다.') + '</div>';
      return;
    }

    box.innerHTML = statusRow(d) + switches(d) + targets(d) + guideBox(d, g || {}) + tools() + recent(d);

    $('lwSave').onclick = async function () {
      var m = $('lwSaveMsg'); m.textContent = '저장 중…';
      var res = await fetch(S.api + '/api/crm-lead-wa/settings', {
        method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, auth()),
        body: JSON.stringify({ notify_received: $('lwRecv').checked, notify_assigned: $('lwAsgn').checked }),
      });
      var j = await res.json().catch(function () { return {}; });
      m.textContent = (res.ok && !j.error) ? '저장했습니다.' : ('실패: ' + (j.note || j.error || res.status));
    };

    $('lwPrev').onclick = async function () {
      var b = $('lwPrevBox'); b.classList.remove('hidden'); b.innerHTML = '<div class="hint">불러오는 중…</div>';
      var u = S.api + '/api/crm-lead-wa/preview?kind=' + $('lwKind').value + '&lang=' + $('lwLang').value;
      var res = await fetch(u, { headers: auth() });
      var j = await res.json().catch(function () { return {}; });
      if (!res.ok || j.error) {
        b.innerHTML = '<div class="hint">' + esc(j.note || j.error || '미리 볼 신청이 없습니다.') + '</div>'; return;
      }
      b.innerHTML = '<div style="padding:10px 12px;border:1px solid var(--line);border-radius:9px">'
        + '<div class="hint" style="margin:0 0 6px">「' + esc(j.empresa || ('#' + j.lead_id))
        + '」 · 템플릿 <span class="mono">' + esc(j.template) + '</span></div>'
        + '<div style="font-weight:700;font-size:12px;color:#6f6a60">창 밖 — 템플릿 {{1}} 에 들어가는 값</div>'
        + '<div class="mono" style="font-size:12px;background:#f7f5f0;padding:6px 8px;border-radius:6px;margin:3px 0 8px">'
        + esc(j.headline) + '</div>'
        + '<div style="font-weight:700;font-size:12px;color:#6f6a60">창이 열려 있을 때 — 자유 문구</div>'
        + '<pre style="white-space:pre-wrap;font-size:12px;background:#f7f5f0;padding:6px 8px;border-radius:6px;margin:3px 0 0">'
        + esc(j.text) + '</pre></div>';
    };

    $('lwTest').onclick = async function () {
      var m = $('lwTestMsg');
      if (!window.confirm('가장 최근 가입신청의 알림을 나에게 실제로 보냅니다.\n\n계속할까요?')) return;
      m.textContent = '보내는 중…';
      var kind = $('lwKind').value;
      var pv = await fetch(S.api + '/api/crm-lead-wa/preview?kind=' + kind, { headers: auth() })
        .then(function (x) { return x.json(); }).catch(function () { return {}; });
      if (!pv.lead_id) { m.textContent = '미리 볼 가입신청이 없습니다.'; return; }
      var body = { lead_id: pv.lead_id, kind: kind };
      // 시험은 **나에게만** 보낸다 — 버튼 한 번으로 팀 전원에게 가면 아무도 누르지 않는다.
      if (S.userId) body.user_id = S.userId;
      var res = await fetch(S.api + '/api/crm-lead-wa/send', {
        method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth()),
        body: JSON.stringify(body),
      });
      var j = await res.json().catch(function () { return {}; });
      if (!res.ok || j.error) { m.textContent = '실패: ' + (j.note || j.error || res.status); return; }
      var one = (j.results || [])[0] || {};
      m.textContent = one.ok ? '보냈습니다 — 휴대폰을 확인하세요.'
        : ('실패: ' + (one.error === 'no_wa_phone' ? '내 WhatsApp 번호가 없습니다(관리 › 사용자)' : (one.error || '원인 불명')));
      render();
    };
  }

  window.RefLeadWa = { render: render, copy: copy };
})();
