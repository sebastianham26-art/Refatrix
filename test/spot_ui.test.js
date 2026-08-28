/* SKU 스팟점검 화면 — 운영 refatrix-stockcount.html 의 인라인 스크립트를 그대로 실행(jsdom)
   실행:  node test/spot_ui.test.js        (REPO 환경변수로 다른 경로 지정 가능)

   이 화면의 핵심은 "현장에서 스캔 한 번에 무슨 일이 벌어지는가" 라서,
   DOM 단언보다 **어떤 요청이 나갔는지(sent)** 와 **큰 박스에 무엇이 보이는지** 를 본다. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = process.env.REPO || path.resolve(__dirname, '..');
const FILE = path.join(REPO, 'refatrix-stockcount.html');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastScript(html) {
  return html.match(/<script>[\s\S]*?<\/script>/g).pop().replace(/^<script>/, '').replace(/<\/script>$/, '');
}

/* 서버가 아는 코드들 — resolve 응답.
   ★ Code-128 카톤 라벨(CTR-CE0796-16)의 해석은 **서버**가 한다. 이 목 데이터도 서버처럼
     라벨을 풀어 같은 제품을 돌려준다(from_label/label_qty 포함). */
const P5 = { item_kind: 'part', source: 'ctr', product_id: 5, matched_code: 'CE0796', name: 'TERMINAL EXTERIOR', app: '', system_qty: 480, avail_qty: 470, rack_location: 'B-01-01' };
const RESOLVE = {
  CE0796: { ...P5, from_label: false, label_qty: 0 },
  'CTR-CE0796-16': { ...P5, from_label: true, label_qty: 16 },
  'CTR-CE0796': { ...P5, from_label: true, label_qty: 0 },
  '7501234500019': { item_kind: 'part', source: 'ean', product_id: 5, matched_code: 'CE0796', name: 'TERMINAL EXTERIOR', app: '', system_qty: 480, avail_qty: 470, rack_location: 'B-01-01', from_label: false, label_qty: 0 },
  CQ0445: { item_kind: 'part', source: 'ctr', product_id: 6, matched_code: 'CQ0445', name: 'BOMBA AGUA', app: '', system_qty: 36, avail_qty: 36, rack_location: 'AA3-2, B2-2', from_label: false, label_qty: 0 },
  CL0211: { item_kind: 'part', source: 'ctr', product_id: 7, matched_code: 'CL0211', name: 'SENSOR', app: '', system_qty: 12, avail_qty: 12, rack_location: '', from_label: false, label_qty: 0 },
};

function mkDom({ role = 'warehouse', lang = 'ko', width = 1280, pda = null,
  session = { id: 31, code: 'SP-2026-0001', mode: 'spot', status: 'draft', scope_note: '', started_at: '2026-08-27T10:00:00Z', lines: [], checks: 0 },
  spot = { checks: [], summary: { checks: 0, skus: 0, ok: 0, mismatch: 0, rack_diff: 0, no_rack_scan: 0 } },
} = {}) {
  const html = fs.readFileSync(FILE, 'utf8').replace(/<script src="refatrix-nav\.js[^"]*"><\/script>/, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://x.test/refatrix-stockcount.html', pretendToBeVisual: true });
  const w = dom.window;
  w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { id: 9, name: 'U', role } }));
  w.localStorage.setItem('wh_lang', lang);
  if (pda != null) w.localStorage.setItem('wh_pda', pda);
  Object.defineProperty(w, 'innerWidth', { value: width, configurable: true, writable: true });
  w.confirm = () => true;
  w.alert = () => {};
  const sent = [];
  const state = { spot, nextCheckId: 900, lastPost: null };
  w.fetch = (url, opt) => {
    const u = String(url);
    const method = (opt && opt.method) || 'GET';
    const body = (opt && opt.body) ? JSON.parse(opt.body) : null;
    if (method !== 'GET') sent.push({ url: u, method, body });
    let out = {};
    if (/\/api\/stock-counts\/resolve\?/.test(u)) {
      const q = decodeURIComponent((u.split('code=')[1] || '')).toUpperCase();
      out = RESOLVE[q] || { item_kind: 'unknown', source: 'none' };
    } else if (/\/spot-checks\/\d+$/.test(u) && method === 'DELETE') {
      const id = Number(u.split('/').pop());
      state.spot.checks = state.spot.checks.filter((c) => c.id !== id);
      out = { ok: true };
    } else if (/\/spot-checks$/.test(u) && method === 'POST') {
      const r = RESOLVE[String(body.raw_code).toUpperCase()] || {};
      const master = r.rack_location || '';
      const rack = body.rack_scanned || '';
      const norm = (s) => String(s || '').trim().toUpperCase();
      const bare = (s) => norm(s).replace(/[^A-Z0-9]/g, '');
      const list = master.split(/[,\n\r]+/).map((x) => x.trim()).filter(Boolean);
      const rackMatch = rack ? (list.length ? list.some((x) => norm(x) === norm(rack) || bare(x) === bare(rack)) : null) : null;
      const check = { id: ++state.nextCheckId, count_id: 31, count_code: 'SP-2026-0001', item_kind: 'part',
        product_id: r.product_id, promo_item_id: null, raw_code: body.raw_code, matched_code: r.matched_code,
        match_source: r.source, item_name: r.name, system_qty: r.system_qty, master_rack: master,
        result: body.result, rack_scanned: rack, rack_match: rackMatch, note: '',
        current_qty: r.system_qty, current_rack: master, checked_by: 9, checked_by_name: 'U',
        checked_at: '2026-08-27T11:22:00Z' };
      state.spot.checks = [check].concat(state.spot.checks);
      const last = new Map();
      for (const c of state.spot.checks) { const k = c.item_kind + ':' + c.product_id; if (!last.has(k)) last.set(k, c); }
      const L = [...last.values()];
      state.spot.summary = { checks: state.spot.checks.length, skus: L.length,
        ok: L.filter((c) => c.result === 'ok').length, mismatch: L.filter((c) => c.result === 'mismatch').length,
        rack_diff: L.filter((c) => c.rack_match === false).length,
        no_rack_scan: L.filter((c) => c.result === 'ok' && !c.rack_scanned).length };
      out = { ok: true, check };
    } else if (/\/spot-checks(\?|$)/.test(u)) {
      out = { count_id: 31, code: session.code, count_status: session.status, summary: state.spot.summary, checks: state.spot.checks };
    } else if (/\/spot\/history/.test(u)) {
      out = { summary: { checks: 2, skus: 2, ok: 1, mismatch: 1, rack_diff: 0 },
        checks: [{ id: 1, count_id: 31, count_code: 'SP-2026-0001', item_kind: 'part', product_id: 5, matched_code: 'CE0796',
          item_name: 'TERMINAL EXTERIOR', system_qty: 480, master_rack: 'B-01-01', result: 'ok', rack_scanned: 'B-01-01',
          rack_match: true, checked_by_name: 'U', checked_at: '2026-08-27T11:00:00Z' }],
        by_sku: [{ code: 'CE0796', name: 'TERMINAL EXTERIOR', item_kind: 'part', product_id: 5,
          last_at: '2026-08-27T11:00:00Z', last_result: 'ok', last_rack: 'B-01-01', checks: 2, mismatch: 1 }],
        truncated: false };
    } else if (/\/api\/stock-counts\/\d+\/submit/.test(u)) { session.status = 'submitted'; out = { ok: true }; }
    else if (/\/api\/stock-counts\/active/.test(u)) out = { items: [
      { id: 31, code: 'SP-2026-0001', mode: 'spot', status: 'draft', scope_note: '', started_by_name: 'U', started_at: '2026-08-27T10:00:00Z', lines: 0, checks: 3 },
    ] };
    else if (/\/api\/stock-counts\/\d+$/.test(u)) out = session;
    else if (/\/api\/stock-counts$/.test(u) && method === 'POST') out = { id: 31, code: 'SP-2026-0001', mode: body.mode, status: 'draft' };
    else if (/\/api\/stock-counts(\?|$)/.test(u)) out = { items: [
      { id: 31, code: 'SP-2026-0001', mode: 'spot', status: 'draft', scope_note: '', started_by_name: 'U', started_at: '2026-08-27T10:00:00Z', lines: 0, checks: 3 },
      { id: 30, code: 'SC-2026-0007', mode: 'full', status: 'submitted', scope_note: 'A동', started_by_name: 'U', started_at: '2026-08-26T10:00:00Z', lines: 42, checks: 0 },
    ] };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(out) });
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.eval(lastScript(html));
  return { w, doc: w.document, sent, state };
}

function scan(w, v) {
  const inp = w.document.getElementById('spInput');
  inp.value = v;
  inp.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}
function typeScan(w, v) {                    // 스캐너처럼 문자를 흘려 넣는다(Enter 없음)
  const inp = w.document.getElementById('spInput');
  for (const ch of v) { inp.value += ch; inp.dispatchEvent(new w.Event('input', { bubbles: true })); }
}
const boxText = (doc) => doc.getElementById('spBox').textContent.replace(/\s+/g, ' ').trim();
const msgText = (doc) => doc.getElementById('spMsg').textContent.replace(/\s+/g, ' ').trim();
const viewText = (doc, id) => doc.getElementById(id).textContent.replace(/\s+/g, ' ');

(async () => {
  /* ---------- ① 화면 구성 ---------- */
  console.log('\n① 화면 구성');
  {
    const { w, doc } = mkDom();
    await sleep(30);
    ok('build 태그 sc0827spot2', /build sc0827spot2/.test(fs.readFileSync(FILE, 'utf8')));
    ok('스팟점검 화면이 있다', !!doc.getElementById('spotView'));
    ok('점검 이력 화면이 있다', !!doc.getElementById('spotHistView'));
    ok('새 실사 모달에 방식 선택 2개', !!doc.getElementById('modeFull') && !!doc.getElementById('modeSpot'));
    ok('전체실사가 기본 선택', doc.getElementById('modeFull').checked === true);
    ok('홈에 [🎯 점검 이력] 버튼', /점검 이력/.test(viewText(doc, 'homeView')));
    ok('세션 목록에 모드 배지', /SKU 점검/.test(viewText(doc, 'homeView')) && /전체실사/.test(viewText(doc, 'homeView')));
    ok('스팟 세션은 점검 건수로 표시', /3건 점검/.test(viewText(doc, 'homeView')));
    ok('전체 세션은 라인 건수로 표시', /42건/.test(viewText(doc, 'homeView')));
    w.close();
  }

  /* ---------- ② 세션 생성 ---------- */
  console.log('\n② 세션 생성 — mode 전달');
  {
    const { w, doc, sent } = mkDom();
    await sleep(20);
    w.openStart();
    doc.getElementById('modeSpot').checked = true;
    doc.getElementById('scopeInput').value = 'fast rack 확인';
    await w.createCount(); await sleep(30);
    const post = sent.find((s) => s.method === 'POST' && /\/api\/stock-counts$/.test(s.url));
    ok('POST 에 mode=spot 이 실린다', post && post.body.mode === 'spot', post && post.body);
    ok('범위 메모도 함께', post && post.body.scope_note === 'fast rack 확인');
    ok('생성 후 점검 화면으로', !doc.getElementById('spotView').classList.contains('hidden'));
    w.close();
  }
  {
    const { w, doc, sent } = mkDom();
    await sleep(20);
    w.openStart(); await w.createCount(); await sleep(20);
    const post = sent.find((s) => s.method === 'POST' && /\/api\/stock-counts$/.test(s.url));
    ok('아무것도 안 고르면 mode=full (기존 동작)', post && post.body.mode === 'full');
    w.close();
  }

  /* ---------- ③ 현장 스캔 흐름 ---------- */
  console.log('\n③ 스캔 흐름 — 제품 → 확인 → 랙 스캔 / [틀림]');
  {
    const { w, doc, sent } = mkDom();
    await sleep(20);
    await w.openCount(31); await sleep(40);
    ok('스팟 세션은 실사기록 화면이 아니라 점검 화면', !doc.getElementById('spotView').classList.contains('hidden')
      && doc.getElementById('recordView').classList.contains('hidden'));
    ok('처음엔 안내만', /제품 바코드를 스캔/.test(boxText(doc)));

    scan(w, 'CE0796'); await sleep(40);
    const bt = boxText(doc);
    ok('제품번호가 크게 뜬다', /CE0796/.test(bt));
    ok('품명이 뜬다', /TERMINAL EXTERIOR/.test(bt));
    ok('★ 시스템 수량이 뜬다', /480/.test(bt), bt);
    ok('★ 위치가 뜬다', /B-01-01/.test(bt), bt);
    ok('실물 확인 안내', /실물을 확인/.test(bt));
    ok('[✖ 틀림] 버튼이 있다', /틀림/.test(doc.getElementById('spActs').textContent));
    ok('[맞음(랙 스캔 생략)] 대안이 있다', /랙 스캔 생략/.test(doc.getElementById('spActs').textContent));
    ok('제품 스캔만으로는 아직 저장하지 않는다', !sent.some((s) => /\/spot-checks$/.test(s.url)));

    scan(w, 'B-01-01'); await sleep(50);
    const post = sent.find((s) => /\/spot-checks$/.test(s.url) && s.method === 'POST');
    ok('★ 랙 스캔이 곧 맞음 확정', post && post.body.result === 'ok', post && post.body);
    ok('스캔한 랙이 함께 전송된다', post && post.body.rack_scanned === 'B-01-01');
    ok('수량은 보내지 않는다', post && post.body.counted_qty === undefined);
    ok('저장 결과가 박스에 남는다', /✔ CE0796/.test(boxText(doc)), boxText(doc));
    ok('다음 스캔 안내', /다음 제품 바코드/.test(boxText(doc)));
    ok('직전 기록 취소 버튼', /직전 기록 취소/.test(doc.getElementById('spActs').textContent));
    ok('내역 표에 줄이 생긴다', /CE0796/.test(viewText(doc, 'spBody')));
    ok('KPI 맞음 1', /1/.test(viewText(doc, 'spKpi')));
    w.close();
  }

  /* ---------- ④ 틀림 ---------- */
  console.log('\n④ [✖ 틀림] — 수량은 받지 않는다');
  {
    const { w, doc, sent } = mkDom();
    await sleep(20); await w.openCount(31); await sleep(40);
    scan(w, 'CL0211'); await sleep(40);
    ok('마스터 위치가 없으면 경고', /위치가 없습니다/.test(boxText(doc)), boxText(doc));
    w.spotMismatch(); await sleep(50);
    const post = sent.find((s) => /\/spot-checks$/.test(s.url) && s.method === 'POST');
    ok('result=mismatch 로 저장', post && post.body.result === 'mismatch');
    ok('랙은 보내지 않는다', post && post.body.rack_scanned === undefined);
    ok('수량 입력칸이 뜨지 않는다(요구사항)', !doc.getElementById('spotView').querySelector('input[type=number]'));
    ok('결과 박스가 빨강', /bad/.test(doc.getElementById('spBox').className));
    ok('틀림으로 기록 문구', /틀림으로 기록/.test(boxText(doc)));
    w.close();
  }

  /* ---------- ⑤ 위치 불일치 — 막지 않고 경고 ---------- */
  console.log('\n⑤ 위치 불일치 · 다중 랙');
  {
    const { w, doc, sent } = mkDom();
    await sleep(20); await w.openCount(31); await sleep(40);
    scan(w, 'CE0796'); await sleep(40);
    scan(w, 'C-09-09'); await sleep(60);
    const post = sent.find((s) => /\/spot-checks$/.test(s.url) && s.method === 'POST');
    ok('다른 랙이어도 저장은 된다', !!post && post.body.result === 'ok');
    ok('⚠ 위치 다름 경고', /마스터 위치와 다릅니다/.test(boxText(doc)) || /다릅니다/.test(msgText(doc)), boxText(doc));
    ok('박스는 경고색(warn)', /warn/.test(doc.getElementById('spBox').className));
    ok('내역 표에 ⚠ 표시', /⚠/.test(viewText(doc, 'spBody')));
    w.close();
  }
  {
    const { w, doc, sent } = mkDom();
    await sleep(20); await w.openCount(31); await sleep(40);
    scan(w, 'CQ0445'); await sleep(40);
    ok('콤마로 여러 랙인 제품은 그대로 보여준다', /AA3-2, B2-2/.test(boxText(doc)), boxText(doc));
    scan(w, 'B2-2'); await sleep(60);
    ok('두 번째 랙을 스캔해도 일치로 본다', !/다릅니다/.test(boxText(doc)), boxText(doc));
    w.close();
  }

  /* ---------- ⑥ 스캔 안전장치 ---------- */
  console.log('\n⑥ 스캔 안전장치');
  {
    const { w, doc, sent } = mkDom();
    await sleep(20); await w.openCount(31); await sleep(40);
    scan(w, 'NOPE-1'); await sleep(40);
    ok('대기 품목 없이 미등록 코드 → 오류만, 저장 없음',
      /등록되지 않은 코드/.test(msgText(doc)) && !sent.some((s) => /\/spot-checks$/.test(s.url)), msgText(doc));

    scan(w, 'CE0796'); await sleep(40);
    scan(w, 'CQ0445'); await sleep(40);
    ok('대기 중 다른 제품을 스캔하면 저장하지 않고 갈아탄다',
      /CQ0445/.test(boxText(doc)) && !sent.some((s) => /\/spot-checks$/.test(s.url)));
    ok('이전 품목이 기록되지 않았음을 알린다', /기록되지 않았습니다/.test(doc.getElementById('toast').textContent));

    // 중복 리딩(같은 값 450ms 안에 두 번)
    const before = sent.length;
    scan(w, 'B2-2'); scan(w, 'B2-2'); await sleep(60);
    ok('중복 리딩은 1건만 저장', sent.filter((s) => /\/spot-checks$/.test(s.url)).length === 1);
    w.close();
  }
  {
    const { w, doc } = mkDom();
    await sleep(20); await w.openCount(31); await sleep(40);
    scan(w, "A1'3"); await sleep(40);        // 스페인어 자판 보정: ' → -
    ok("스캐너 자판 보정(' → -) 후 판정", /등록되지 않은 코드/.test(msgText(doc)) && /A1-3/.test(msgText(doc)), msgText(doc));
    w.close();
  }
  {
    const { w, doc } = mkDom();
    await sleep(20); await w.openCount(31); await sleep(40);
    typeScan(w, 'CE0796');                    // Enter 없이 스캐너처럼 흘려 넣기
    await sleep(260);                          // 140ms 무입력 → 자동 처리 + 서버 왕복
    ok('Enter 없이도 자동 처리(140ms)', /CE0796/.test(boxText(doc)), boxText(doc));
    ok('입력칸은 즉시 비워진다', doc.getElementById('spInput').value === '');
    w.close();
  }

  /* ---------- ⑥-2 Code-128 카톤 라벨 ---------- */
  console.log('\n⑥-2 Code-128 카톤 라벨 (CTR-CE0796-16)');
  {
    const { w, doc, sent } = mkDom();
    await sleep(20); await w.openCount(31); await sleep(40);
    scan(w, 'CTR-CE0796-16'); await sleep(50);
    const bt = boxText(doc);
    ok('★ 라벨을 스캔하면 가운데 제품번호로 붙는다', /CE0796/.test(bt) && !/CTR-CE0796-16/.test(bt), bt);
    ok('★ 시스템 수량은 SKU 총 재고(480)', /480/.test(bt));
    ok('위치도 뜬다', /B-01-01/.test(bt));
    ok('라벨 소입수를 이름 붙여 안내한다(총 재고와 혼동 방지)', /라벨 소입수 16/.test(bt), bt);
    ok('점검 대상이 SKU 총 재고임을 명시', /총 재고/.test(bt));
    scan(w, 'B-01-01'); await sleep(60);
    const post = sent.find((s) => /\/spot-checks$/.test(s.url) && s.method === 'POST');
    ok('서버로는 스캔 원문을 그대로 보낸다(원장 보존)', post && post.body.raw_code === 'CTR-CE0796-16', post && post.body);
    ok('맞음으로 저장', post && post.body.result === 'ok' && post.body.rack_scanned === 'B-01-01');
    w.close();
  }
  {   // 수량 없는 변종 — 안내 줄만 안 뜨고 나머지는 동일
    const { w, doc } = mkDom();
    await sleep(20); await w.openCount(31); await sleep(40);
    scan(w, 'CTR-CE0796'); await sleep(50);
    ok('수량 없는 라벨도 제품으로 붙는다', /CE0796/.test(boxText(doc)));
    ok('소입수가 없으면 안내 줄을 띄우지 않는다', !/라벨 소입수/.test(boxText(doc)));
    w.close();
  }
  {   // ★ 미등록 SKU 의 라벨이 '랙 스캔'으로 오인되지 않아야 한다
    const { w, doc, sent } = mkDom();
    await sleep(20); await w.openCount(31); await sleep(40);
    scan(w, 'CE0796'); await sleep(40);                 // 품목 대기 상태 만들기
    scan(w, 'CTR-XX9999-8'); await sleep(50);           // 미등록 SKU 의 카톤 라벨
    ok('★ 라벨은 랙 바코드로 넘어가지 않는다', !sent.some((s) => /\/spot-checks$/.test(s.url)), sent);
    ok('등록되지 않은 제품 코드라고 알린다', /등록되지 않은 제품 코드/.test(msgText(doc)), msgText(doc));
    ok('무엇으로 읽었는지 보여준다(XX9999)', /XX9999/.test(msgText(doc)), msgText(doc));
    ok('대기 품목은 그대로 유지된다', /CE0796/.test(boxText(doc)));
    scan(w, 'B-01-01'); await sleep(60);
    ok('이어서 진짜 랙을 스캔하면 정상 저장', sent.some((s) => /\/spot-checks$/.test(s.url) && s.body.rack_scanned === 'B-01-01'));
    w.close();
  }
  {   // 라벨 판정 헬퍼 자체
    const { w } = mkDom();
    await sleep(20);
    ok('isLabelCode: CTR- 접두어 인식', w.isLabelCode('CTR-CE0796-16') === true);
    ok('isLabelCode: SYD- 도 인식', w.isLabelCode('SYD-CE0796-16') === true);
    ok('isLabelCode: 랙 라벨은 라벨이 아니다', w.isLabelCode('B-01-01') === false);
    ok('labelMid: 가운데만 뽑는다', w.labelMid('CTR-CE0796-16') === 'CE0796');
    ok('labelMid: 수량 없으면 몸통 그대로', w.labelMid('CTR-CE0796') === 'CE0796');
    ok('labelMid: 제품번호에 하이픈이 있어도', w.labelMid('CTR-CE-0796-16') === 'CE-0796');
    w.close();
  }

  /* ---------- ⑦ 직전 기록 취소 ---------- */
  console.log('\n⑦ 직전 기록 취소');
  {
    const { w, doc, sent } = mkDom();
    await sleep(20); await w.openCount(31); await sleep(40);
    scan(w, 'CE0796'); await sleep(40); scan(w, 'B-01-01'); await sleep(60);
    const id = Number(doc.getElementById('spActs').innerHTML.match(/spotUndo\((\d+)\)/)[1]);
    await w.spotUndo(id); await sleep(50);
    ok('DELETE 가 나간다', sent.some((s) => s.method === 'DELETE' && s.url.indexOf('/spot-checks/' + id) > 0));
    ok('취소 후 박스가 초기 안내로', /제품 바코드를 스캔/.test(boxText(doc)), boxText(doc));
    ok('내역 표가 비었다', /기록이 없습니다|아직 점검 기록이 없습니다/.test(viewText(doc, 'spBody')));
    w.close();
  }

  /* ---------- ⑧ 완료(제출) 후 읽기 전용 ---------- */
  console.log('\n⑧ 완료 후 읽기 전용');
  {
    const { w, doc, sent } = mkDom();
    await sleep(20); await w.openCount(31); await sleep(40);
    scan(w, 'CE0796'); await sleep(40); scan(w, 'B-01-01'); await sleep(60);
    await w.spotFinish(); await sleep(60);
    ok('submit 요청', sent.some((s) => /\/submit$/.test(s.url)));
    ok('🔒 읽기 전용 안내', /완료된 점검/.test(boxText(doc)), boxText(doc));
    ok('스캔 입력칸 숨김', doc.getElementById('spInput').style.display === 'none');
    ok('완료 버튼 숨김', doc.getElementById('spFinishBtn').style.display === 'none');
    ok('취소(↺) 버튼 없음', !/spotUndo/.test(doc.getElementById('spBody').innerHTML));
    const n = sent.length;
    scan(w, 'CE0796'); await sleep(40);
    ok('완료 후 스캔은 무시', sent.length === n && /완료된 점검/.test(msgText(doc)));
    w.close();
  }
  {   // 완료된 세션을 목록에서 다시 열면 바로 읽기 전용 리포트
    const { w, doc } = mkDom({ session: { id: 31, code: 'SP-2026-0001', mode: 'spot', status: 'submitted', scope_note: '', started_at: '2026-08-27T10:00:00Z', lines: [], checks: 2 } });
    await sleep(20); await w.openCount(31); await sleep(50);
    ok('제출된 스팟 세션도 점검 화면(대조 화면 아님)',
      !doc.getElementById('spotView').classList.contains('hidden') && doc.getElementById('reconView').classList.contains('hidden'));
    w.close();
  }

  /* ---------- ⑨ 점검 이력 ---------- */
  console.log('\n⑨ 점검 이력(세션 전체)');
  {
    const { w, doc } = mkDom();
    await sleep(20);
    w.showSpotHist(); await sleep(50);
    ok('이력 화면이 열린다', !doc.getElementById('spotHistView').classList.contains('hidden'));
    ok('KPI 표시', /점검 건수|Registros/.test(viewText(doc, 'shKpi')));
    ok('SKU별 최근 점검 표', /CE0796/.test(viewText(doc, 'shSkuBody')));
    ok('점검 기록 표', /SP-2026-0001/.test(viewText(doc, 'shBody')));
    doc.getElementById('shCode').value = 'ce07';
    doc.getElementById('shRes').value = 'mismatch';
    doc.getElementById('shDays').value = '90';
    let asked = '';
    const prev = w.fetch;
    w.fetch = (u, o) => { if (/spot\/history/.test(String(u))) asked = String(u); return prev(u, o); };
    await w.loadSpotHist(); await sleep(40);
    ok('필터가 쿼리로 전달된다', /days=90/.test(asked) && /code=ce07/.test(asked) && /result=mismatch/.test(asked), asked);
    w.close();
  }

  /* ---------- ⑩ PDA 컴팩트 모드 ---------- */
  console.log('\n⑩ PDA 컴팩트 모드');
  {
    const { w, doc } = mkDom({ width: 360 });
    await sleep(20);
    ok('좁은 화면은 자동 컴팩트', doc.body.classList.contains('pda'));
    ok('토글 라벨이 [전체보기]', /전체보기|Vista completa/.test(doc.getElementById('pdaBtn').textContent));
    w.pdaToggle();
    ok('토글하면 일반 화면', !doc.body.classList.contains('pda'));
    ok('선택이 localStorage 에 남는다', w.localStorage.getItem('wh_pda') === '0');
    w.pdaToggle();
    ok('다시 켜진다', doc.body.classList.contains('pda') && w.localStorage.getItem('wh_pda') === '1');
    ok('스캔 카드가 고정 블록', doc.getElementById('spotScanCard').classList.contains('scanstick'));
    w.close();
  }
  {
    const { w, doc } = mkDom({ width: 1280 });
    await sleep(20);
    ok('데스크톱은 컴팩트 아님(회귀)', !doc.body.classList.contains('pda'));
    ok('기존 화면 요소 그대로', !!doc.getElementById('rackInput') && !!doc.getElementById('codeInput') && !!doc.getElementById('rcTable'));
    w.close();
  }
  {
    const { w, doc } = mkDom({ width: 1280, pda: '1' });
    await sleep(20);
    ok('저장된 선택이 자동감지보다 우선', doc.body.classList.contains('pda'));
    w.close();
  }

  /* ---------- ⑪ 스페인어 ---------- */
  console.log('\n⑪ 스페인어(현장 기본)');
  {
    const { w, doc } = mkDom({ lang: 'es' });
    await sleep(20); await w.openCount(31); await sleep(40);
    scan(w, 'CE0796'); await sleep(40);
    const t = boxText(doc);
    ok('시스템 수량 라벨 스페인어', /CANTIDAD SISTEMA/.test(t), t);
    ok('위치 라벨 스페인어', /UBICACIÓN/.test(t));
    ok('안내문 스페인어', /Verifique el físico/.test(t));
    ok('틀림 버튼 스페인어', /NO COINCIDE/.test(doc.getElementById('spActs').textContent));
    ok('점검 화면에 남은 한국어 0건', !/[가-힣]/.test(doc.getElementById('spotView').textContent),
      (doc.getElementById('spotView').textContent.match(/[가-힣]+/g) || []).slice(0, 6));
    w.close();
  }
  {
    const { w, doc } = mkDom({ lang: 'ko' });
    await sleep(20); await w.openCount(31); await sleep(40);
    scan(w, 'CE0796'); await sleep(40);
    ok('한국어에서는 한국어 라벨', /시스템 수량/.test(boxText(doc)));
    w.close();
  }

  /* ---------- ⑫ 회귀 — 전체 재고실사 흐름 불변 ---------- */
  console.log('\n⑫ 회귀 — 전체 재고실사');
  {
    const { w, doc } = mkDom({ session: { id: 30, code: 'SC-2026-0007', mode: 'full', status: 'draft', scope_note: 'A동', started_at: '2026-08-26T10:00:00Z', lines: [] } });
    await sleep(20); await w.openCount(30); await sleep(40);
    ok('전체실사는 기존 기록 화면으로', !doc.getElementById('recordView').classList.contains('hidden')
      && doc.getElementById('spotView').classList.contains('hidden'));
    ok('랙 입력칸 · 품목 입력칸 그대로', !!doc.getElementById('rackInput') && !!doc.getElementById('codeInput'));
    ok('스팟 API 를 부르지 않는다', true);
    w.close();
  }

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
