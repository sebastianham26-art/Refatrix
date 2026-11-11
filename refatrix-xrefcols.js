/* =====================================================================
 * refatrix-xrefcols.js — 견적 엑셀 「경쟁사 코드 열」 (0325b · build 20261111xc)
 *   브랜드(BAW · GROB · VAZLO · KYB · MOOG)를 체크하면 엑셀 맨 뒤(또는 지정 위치)에 브랜드별 열을 붙인다.
 *   코드 = 크로스레퍼런스 마스터(CTR 의 SYD 와 같은 행) + 제품 교차참조.
 *     RefXrefCols.picker(containerEl)            체크박스 그리기(선택은 브라우저에 기억)
 *     RefXrefCols.selected()                     ['BAW','KYB'…]
 *     RefXrefCols.load(api, token, ctrCodes)     → Promise<{ brands, get(ctr, brand) → 'A / B' }>
 * ===================================================================== */
(function () {
  if (window.RefXrefCols) return;
  var BRANDS = ['BAW', 'GROB', 'VAZLO', 'KYB', 'MOOG'];
  var KEY = 'rfx_xref_cols';
  var sel = [];
  try { sel = JSON.parse(localStorage.getItem(KEY) || '[]').filter(function (b) { return BRANDS.indexOf(b) >= 0; }); } catch (e) { sel = []; }
  var boxes = [];
  function save() { try { localStorage.setItem(KEY, JSON.stringify(sel)); } catch (e) {} }
  function sync() { boxes.forEach(function (el) { el.querySelectorAll('input[data-xb]').forEach(function (i) { i.checked = sel.indexOf(i.getAttribute('data-xb')) >= 0; }); }); }
  function picker(el, opt) {
    if (!el) return;
    opt = opt || {};
    el.innerHTML = (opt.label == null ? '<span style="font-weight:700">📑 엑셀에 경쟁사 코드</span>' : opt.label)
      + BRANDS.map(function (b) {
        return '<label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;white-space:nowrap" title="엑셀 다운로드 때 ' + b + ' 코드 열을 추가합니다">'
          + '<input type="checkbox" data-xb="' + b + '" style="width:auto;margin:0"' + (sel.indexOf(b) >= 0 ? ' checked' : '') + '> ' + b + '</label>';
      }).join('');
    el.querySelectorAll('input[data-xb]').forEach(function (i) {
      i.addEventListener('change', function () {
        var b = i.getAttribute('data-xb');
        sel = sel.filter(function (x) { return x !== b; });
        if (i.checked) sel.push(b);
        sel.sort(function (a, c) { return BRANDS.indexOf(a) - BRANDS.indexOf(c); });
        save(); sync();
      });
    });
    if (boxes.indexOf(el) < 0) boxes.push(el);
  }
  function selected() { return sel.slice(); }
  function empty() { return { brands: [], get: function () { return ''; } }; }
  function load(api, token, codes) {
    var brands = selected();
    var list = [];
    var seen = {};
    (codes || []).forEach(function (c) { c = String(c == null ? '' : c).trim(); if (c && !seen[c]) { seen[c] = 1; list.push(c); } });
    if (!brands.length || !list.length) return Promise.resolve({ brands: brands, get: function () { return ''; } });
    return fetch(api + '/api/xref-master/codes-for', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ codes: list, brands: brands })
    }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        var items = (d && d.items) || {};
        return { brands: brands, get: function (ctr, b) { var x = items[String(ctr == null ? '' : ctr).trim()]; return x && x[b] ? x[b].join(' / ') : ''; } };
      });
  }
  window.RefXrefCols = { BRANDS: BRANDS, picker: picker, selected: selected, load: load, empty: empty };
})();
