/* =====================================================================
 * refatrix-devmatch.js — 개발요청 자동 검수 팝업 (0325 · build 20261111xr)
 *   제품 추가 · 제품마스터 수정(화면 · 엑셀 · 플랫폼 API) · 크로스레퍼런스 업로드가 일어나면
 *   서버 스위퍼가 개발요청(개발필요내용)의 경쟁사 코드를 다시 대조한다.
 *   여기서는 「내가 마지막으로 확인한 뒤 새로 매칭된 것」을 팝업으로 보여준다.
 *     RefDevMatch.check({ api, token, delayMs, onSeen })
 *   권한이 없으면(403) 조용히 아무것도 하지 않는다.
 * ===================================================================== */
(function () {
  if (window.RefDevMatch) return;
  var VIA = { ctr: 'CTR 코드', syd: 'SYD 코드', oe: 'OE', xref: '교차참조', master: '크로스레퍼런스 → SYD', manual: '수동' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function css() {
    if (document.getElementById('rdmCss')) return;
    var st = document.createElement('style'); st.id = 'rdmCss';
    st.textContent = '.rdm-ov{position:fixed;inset:0;background:rgba(20,30,25,.45);z-index:9000;display:flex;align-items:center;justify-content:center;padding:16px}'
      + '.rdm-box{background:#fff;border-radius:14px;max-width:760px;width:100%;max-height:86vh;overflow:auto;box-shadow:0 18px 50px rgba(0,0,0,.25);padding:18px 20px;font-family:inherit}'
      + '.rdm-h{font-size:16px;font-weight:800;color:#143D34;margin:0 0 4px}.rdm-s{font-size:12px;color:#6f6a60;margin-bottom:10px}'
      + '.rdm-box table{width:100%;border-collapse:collapse;font-size:12.5px}.rdm-box th{background:#F4F1EA;text-align:left;padding:6px 8px;font-size:11.5px;color:#555}'
      + '.rdm-box td{padding:6px 8px;border-top:1px solid #eee;vertical-align:top}.rdm-ctr{font-weight:800;color:#0F6E56}'
      + '.rdm-via{display:inline-block;font-size:10.5px;padding:1px 6px;border-radius:8px;background:#e9f1ec;color:#143D34;white-space:nowrap}'
      + '.rdm-via.master{background:#f3ecf9;color:#6B4FB0}.rdm-br{display:inline-block;font-size:10.5px;padding:1px 6px;border-radius:8px;background:#fdf3e3;color:#9a6512;margin-right:4px}'
      + '.rdm-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap}'
      + '.rdm-btn{padding:8px 14px;border:none;border-radius:8px;background:#143D34;color:#fff;font-size:13px;font-weight:700;cursor:pointer}'
      + '.rdm-btn.ghost{background:#fff;color:#143D34;border:1px solid #143D34}.rdm-amb{margin-top:12px;background:#fbf3e3;border-radius:10px;padding:8px 10px;font-size:12px;color:#7a5a17}';
    document.head.appendChild(st);
  }
  function render(d, opt) {
    css();
    var old = document.getElementById('rdmOv'); if (old) old.remove();
    var items = d.items || [], amb = d.ambiguous || [];
    var h = '<div class="rdm-box" role="dialog" aria-modal="true">'
      + '<div class="rdm-h">🔎 개발요청 자동 검수 — 새로 매칭된 코드 ' + items.length + '건</div>'
      + '<div class="rdm-s">제품 추가·제품마스터 변경·크로스레퍼런스 업로드 뒤, 개발요청에 기록된 경쟁사 코드를 다시 대조했습니다. 매칭된 요청은 <b>CTR 코드가 붙고 개발완료</b>로 바뀌었습니다(제품·마케팅 › 개발 요청 › 개발필요내용 「매칭결과」 열).</div>';
    if (items.length) {
      h += '<table><thead><tr><th>경쟁사 코드</th><th>→ CTR</th><th>경로</th><th>고객</th><th style="text-align:right">수량</th><th style="text-align:right">재고</th></tr></thead><tbody>'
        + items.map(function (it) {
          return '<tr><td>' + (it.input_brand ? '<span class="rdm-br">' + esc(it.input_brand) + '</span>' : '') + '<b>' + esc(it.input_code) + '</b></td>'
            + '<td class="rdm-ctr">' + esc(it.ctr_code) + (it.product_name ? '<div style="font-weight:400;color:#6f6a60;font-size:11px">' + esc(it.product_name) + '</div>' : '') + '</td>'
            + '<td><span class="rdm-via ' + esc(it.via || '') + '">' + esc(VIA[it.via] || it.via || '-') + '</span></td>'
            + '<td>' + esc(it.customer_name || '불특정') + '</td>'
            + '<td style="text-align:right">' + (it.qty == null ? '-' : it.qty) + '</td>'
            + '<td style="text-align:right' + (it.stock_qty != null && it.stock_qty <= 0 ? ';color:#B23A2E;font-weight:700' : '') + '">' + (it.stock_qty == null ? '-' : it.stock_qty) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    if (amb.length) {
      h += '<div class="rdm-amb">⚠ <b>후보가 여러 제품이라 자동 완료하지 않은 ' + amb.length + '건</b> — 개발요청 화면에서 확인 후 수동 개발완료하세요:<br>'
        + amb.slice(0, 12).map(function (a) { return (a.input_brand ? esc(a.input_brand) + ' ' : '') + '<b>' + esc(a.input_code) + '</b> → ' + (a.candidates || []).map(esc).join(' / ') + (a.customer_name ? ' (' + esc(a.customer_name) + ')' : ''); }).join(' · ')
        + (amb.length > 12 ? ' 외 ' + (amb.length - 12) + '건' : '') + '</div>';
    }
    h += '<div class="rdm-btns">'
      + (opt.hideOpen ? '' : '<button type="button" class="rdm-btn ghost" id="rdmOpen">개발요청 화면 열기</button>')
      + '<button type="button" class="rdm-btn ghost" id="rdmLater">나중에</button>'
      + '<button type="button" class="rdm-btn" id="rdmOk">확인</button></div></div>';
    var ov = document.createElement('div'); ov.className = 'rdm-ov'; ov.id = 'rdmOv'; ov.innerHTML = h;
    document.body.appendChild(ov);
    function close() { ov.remove(); }
    function seen() {
      try {
        fetch(opt.api + '/api/dev-requests/auto-matches/seen', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opt.token }, body: '{}' })
          .then(function () { if (typeof opt.onSeen === 'function') opt.onSeen(); }).catch(function () {});
      } catch (e) {}
    }
    document.getElementById('rdmLater').addEventListener('click', close);
    document.getElementById('rdmOk').addEventListener('click', function () { seen(); close(); });
    var op = document.getElementById('rdmOpen');
    if (op) op.addEventListener('click', function () { seen(); location.href = 'refatrix-devrequest.html'; });
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
  }
  var timer = null;
  function check(opt) {
    opt = opt || {};
    if (!opt.api || !opt.token) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      fetch(opt.api + '/api/dev-requests/auto-matches', { headers: { Authorization: 'Bearer ' + opt.token } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || !d.ready) return;
          if (!(d.items || []).length && !(opt.showAmbiguous && (d.ambiguous || []).length)) return;
          render(d, opt);
        }).catch(function () {});
    }, Math.max(0, Number(opt.delayMs) || 0));
  }
  window.RefDevMatch = { check: check, _render: render };
})();
