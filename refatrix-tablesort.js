/*!
 * refatrix-tablesort.js — 표 제목(타이틀) 클릭 정렬 공용 모듈
 * ------------------------------------------------------------------
 * 사용법
 *   1) 페이지의 인라인 스크립트보다 먼저 이 파일을 로드한다.
 *        script src="refatrix-tablesort.js?v=ts20260825"
 *   2) 정렬을 켤 <table> 에 고유 키를 준다.
 *        <table data-sort="funnel:done"> ... </table>
 *   3) 표를 그린 직후 한 번 호출한다.
 *        $('body').innerHTML = h;  RTSort.apply($('body'));
 *
 * 동작
 *   · <th> 클릭 → 오름차순(▲) → 다시 클릭 → 내림차순(▼) 토글.
 *   · 정렬 상태는 data-sort 키 단위로 메모리에 유지 → 행 펼침·필터 변경 등으로
 *     표가 다시 그려져도 같은 정렬이 그대로 재적용된다(페이지 새로고침 시 초기화).
 *   · <tr class="sub"> (펼침 상세행)은 바로 위 본행에 붙어 함께 이동한다.
 *   · 값이 비었거나(-, —, 공백) 숫자로 읽히지 않는 칸은 오름/내림 상관없이 항상 뒤로 보낸다.
 *
 * 열 타입 판별 (정확도 우선, 자동추론은 최소화)
 *   ① <th data-type="num|date|text">   → 명시값 우선
 *   ② <th class="r"> (우측정렬)         → 숫자
 *   ③ 값 다수가 YYYY-MM-DD 형태         → 날짜
 *   ④ 그 외                              → 텍스트(한국어 로캘, 숫자 자연정렬)
 *   · 정렬에서 빼려면 <th data-nosort>  (버튼·막대그래프 열 등)
 *   · 칸 자체에 정렬값을 강제하려면 <td data-sv="123">
 */
(function (global) {
  'use strict';

  var STATE = {};              // { 'funnel:done': {col:3, dir:'asc'} }
  var styled = false;

  var DATE_RE = /\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?/;
  var NUM_RE = /-?\d[\d,]*(?:\.\d+)?/;

  function ensureStyle() {
    if (styled) return;
    styled = true;
    try {
      var s = document.createElement('style');
      s.id = 'rts-style';
      s.textContent =
        'th[data-rts]{cursor:pointer;user-select:none;-webkit-user-select:none}' +
        'th[data-rts]:hover{background:rgba(0,0,0,.05)}' +
        'th[data-rts] .rts-ind{margin-left:4px;font-size:.85em;opacity:.32;font-weight:400}' +
        'th[data-rts-active] .rts-ind{opacity:1}';
      (document.head || document.documentElement).appendChild(s);
    } catch (e) { /* noop */ }
  }

  // ---------- 값 추출 ----------
  function rawText(td) {
    if (!td) return '';
    var v = td.getAttribute && td.getAttribute('data-sv');
    if (v != null) return String(v);
    return String(td.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function toNum(s) {
    if (s == null) return null;
    var t = String(s).replace(/[−–—]/g, '-');   // −, –, — → -
    var m = t.match(NUM_RE);
    if (!m) return null;
    var n = parseFloat(m[0].replace(/,/g, ''));
    return isNaN(n) ? null : n;
  }
  function toDate(s) {
    if (s == null) return null;
    var m = String(s).match(DATE_RE);
    return m ? m[0] : null;
  }

  // ---------- 행 묶음(본행 + 펼침 상세행) ----------
  function isSubRow(tr) {
    if (!tr) return false;
    if (tr.hasAttribute && tr.hasAttribute('data-subrow')) return true;
    return /(^|\s)sub(\s|$)/.test(tr.className || '');
  }
  function groupsOf(tbody) {
    var out = [], rows = tbody.rows, i, tr;
    for (i = 0; i < rows.length; i++) {
      tr = rows[i];
      if (out.length && isSubRow(tr)) out[out.length - 1].push(tr);
      else out.push([tr]);
    }
    return out;
  }
  function cellOf(group, idx) {
    var cells = group[0].cells;
    return idx < cells.length ? cells[idx] : null;
  }

  // ---------- 열 타입 ----------
  function hasClass(el, c) { return new RegExp('(^|\\s)' + c + '(\\s|$)').test((el && el.className) || ''); }

  function detectType(th, idx, groups) {
    var explicit = th.getAttribute('data-type');
    if (explicit === 'num' || explicit === 'date' || explicit === 'text') return explicit;
    if (hasClass(th, 'r')) return 'num';
    var tot = 0, dn = 0, i, s;
    for (i = 0; i < groups.length; i++) {
      s = rawText(cellOf(groups[i], idx));
      if (!s) continue;
      tot++;
      if (DATE_RE.test(s)) dn++;
    }
    if (tot > 0 && dn / tot >= 0.6) return 'date';
    return 'text';
  }

  // ---------- 정렬 ----------
  function sortTable(table, idx, dir) {
    var tbody = table.tBodies && table.tBodies[0];
    if (!tbody) return;
    var head = table.tHead;
    if (!head || !head.rows.length) return;
    var hrow = head.rows[head.rows.length - 1];
    var th = hrow.cells[idx];
    if (!th) return;

    var groups = groupsOf(tbody);
    if (groups.length < 2) return;

    var type = detectType(th, idx, groups);
    var sign = (dir === 'desc') ? -1 : 1;

    var deco = groups.map(function (g, i) {
      var s = rawText(cellOf(g, idx));
      var v;
      if (type === 'num') v = toNum(s);
      else if (type === 'date') v = toDate(s);
      else v = (s === '' || s === '-' || s === '—' || s === '–') ? null : s;
      return { g: g, v: v, i: i };
    });

    deco.sort(function (a, b) {
      // 빈 값은 방향과 무관하게 항상 뒤
      if (a.v == null && b.v == null) return a.i - b.i;
      if (a.v == null) return 1;
      if (b.v == null) return -1;
      var r;
      if (type === 'num') r = a.v - b.v;
      else if (type === 'date') r = (a.v < b.v) ? -1 : (a.v > b.v ? 1 : 0);
      else r = String(a.v).localeCompare(String(b.v), 'ko', { numeric: true, sensitivity: 'base' });
      if (r === 0) return a.i - b.i;          // 동점 → 원래 순서 유지(안정정렬)
      return r * sign;
    });

    var frag = document.createDocumentFragment();
    deco.forEach(function (d) {
      for (var k = 0; k < d.g.length; k++) frag.appendChild(d.g[k]);
    });
    tbody.appendChild(frag);
  }

  // ---------- 헤더 배선 ----------
  function decorate(table, key) {
    var head = table.tHead;
    if (!head || !head.rows.length) return;
    var hrow = head.rows[head.rows.length - 1];
    var st = STATE[key];

    for (var c = 0; c < hrow.cells.length; c++) {
      var th = hrow.cells[c];

      // 기존 표시자 제거(재렌더·재적용 대비)
      var olds = th.querySelectorAll ? th.querySelectorAll('.rts-ind') : [];
      for (var o = 0; o < olds.length; o++) olds[o].parentNode.removeChild(olds[o]);

      if (th.hasAttribute('data-nosort')) {
        th.removeAttribute('data-rts');
        th.removeAttribute('data-rts-active');
        continue;
      }

      if (!th.__rtsBound) {
        th.__rtsBound = true;
        (function (thEl, colIdx) {
          thEl.addEventListener('click', function () { onHeaderClick(table, key, colIdx); });
        })(th, c);
      }
      th.setAttribute('data-rts', '1');

      var active = !!(st && st.col === c);
      if (active) th.setAttribute('data-rts-active', '1');
      else th.removeAttribute('data-rts-active');

      var ind = document.createElement('span');
      ind.className = 'rts-ind';
      ind.textContent = active ? (st.dir === 'asc' ? '▲' : '▼') : '⇅';
      th.appendChild(ind);
      if (!th.getAttribute('title')) th.setAttribute('title', '클릭하면 이 열로 정렬합니다 (다시 클릭 = 반대 방향)');
    }
  }

  function onHeaderClick(table, key, idx) {
    var st = STATE[key];
    if (st && st.col === idx) st.dir = (st.dir === 'asc' ? 'desc' : 'asc');
    else STATE[key] = { col: idx, dir: 'asc' };
    decorate(table, key);
    sortTable(table, STATE[key].col, STATE[key].dir);
  }

  // ---------- 공개 API ----------
  function apply(root) {
    ensureStyle();
    var scope = root || document;
    var list = [];
    if (scope.tagName === 'TABLE' && scope.hasAttribute('data-sort')) list = [scope];
    else if (scope.querySelectorAll) list = scope.querySelectorAll('table[data-sort]');
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var key = t.getAttribute('data-sort') || '';
      decorate(t, key);
      var st = STATE[key];
      if (st) sortTable(t, st.col, st.dir);
    }
    return list.length;
  }

  function clear(key) {
    if (key == null) { STATE = {}; return; }
    delete STATE[key];
  }

  global.RTSort = {
    apply: apply,
    clear: clear,
    state: function () { return STATE; },
    // 테스트용 내부 헬퍼
    _internal: { toNum: toNum, toDate: toDate, detectType: detectType, groupsOf: groupsOf, sortTable: sortTable }
  };
})(typeof window !== 'undefined' ? window : this);
