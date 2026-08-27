/* 창고 위치변경 화면 — 운영 refatrix-relocate.html 의 인라인 스크립트를 그대로 실행(jsdom)
   실행:  node test/relocate_ui.test.js        (REPO 환경변수로 다른 경로 지정 가능) */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = process.env.REPO || path.resolve(__dirname, '..');
const FILE = path.join(REPO, 'refatrix-relocate.html');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastScript(html) {
  return html.match(/<script>[\s\S]*?<\/script>/g).pop().replace(/^<script>/, '').replace(/<\/script>$/, '');
}

const RACKS = [
  { rack: 'B-01-01', products: 12, group: 'B', kind: 'carton', kind_set: true, note: null, zone: 2 },
  { rack: 'B-01-02', products: 3, group: 'B', kind: 'carton', kind_set: false, note: null, zone: 2 },
  { rack: 'FM-01', products: 0, group: 'FM', kind: 'fast', kind_set: true, note: null, zone: null },
  { rack: 'FM-02', products: 1, group: 'FM', kind: 'fast', kind_set: true, note: null, zone: null },
];
const PROD = {
  'CTR-CE0796-16': { product: { id: 5, code: 'CE0796', name: 'TERMINAL EXTERIOR', rack: 'B-01-01', rack_kind: 'carton', stock_qty: 480 }, label: { raw: 'CTR-CE0796-16', code: 'CE0796', qty: 16, prefix: 'CTR' } },
  'CE0152': { product: { id: 6, code: 'CE0152', name: 'TERMINAL', rack: 'B-01-02', rack_kind: 'carton', stock_qty: 96 }, label: { raw: 'CE0152', code: 'CE0152', qty: 0, prefix: '' } },
  'CTR-CE0154-8': { product: { id: 7, code: 'CE0154', name: 'GUIA', rack: 'C-09-09', rack_kind: 'carton', stock_qty: 40 }, label: { raw: 'CTR-CE0154-8', code: 'CE0154', qty: 8, prefix: 'CTR' } },
};

function mkDom({ role = 'warehouse', lang = 'ko', width = 1280, racks = RACKS, moves = [], pda = null } = {}) {
  const html = fs.readFileSync(FILE, 'utf8').replace(/<script src="refatrix-nav\.js[^"]*"><\/script>/, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://x.test/refatrix-relocate.html', pretendToBeVisual: true });
  const w = dom.window;
  w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { id: 9, name: 'U', role } }));
  w.localStorage.setItem('wh_lang', lang);
  if (pda != null) w.localStorage.setItem('wh_pda', pda);
  Object.defineProperty(w, 'innerWidth', { value: width, configurable: true, writable: true });
  const sent = [];
  w.fetch = (url, opt) => {
    const u = String(url);
    if (opt && opt.method) sent.push({ url: u, method: opt.method, body: opt.body ? JSON.parse(opt.body) : null });
    let body = {};
    if (/\/api\/warehouse\/racks/.test(u)) body = { racks, default_kind: 'carton', totals: { racks: racks.length, fast: 2, carton: 2, unset: 1 } };
    else if (/\/relocate\/lookup/.test(u)) {
      const q = decodeURIComponent((u.split('q=')[1] || '')).toUpperCase();
      const hit = PROD[q];
      if (!hit) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'product_not_found' }) });
      body = hit;
    } else if (/\/rack-moves\/summary/.test(u)) body = { days: 90, rows: [{ rack: 'FM-01', product_code: 'CE0796', product_name: 'TERMINAL', cartons: 3, qty_ea: 48, last_at: '2026-08-27T10:00:00Z' }], count: 1 };
    else if (/\/rack-moves\/\d+\/undo/.test(u)) body = { ok: true, undo_id: 99 };
    else if (/\/rack-moves/.test(u) && (!opt || opt.method !== 'POST')) body = { moves, count: moves.length };
    else if (/\/rack-moves/.test(u)) body = { ok: true, moved: [{ id: 42, code: 'CE0796', from_rack: 'B-01-01', to_rack: 'FM-01', cartons: 1, per_carton: 16, qty_ea: 16, master_updated: true }], totals: { lines: 1, cartons: 1, qty_ea: 16, master_updated: 1 } };
    else if (/\/rack-kinds/.test(u)) body = { ok: true, set: 1, cleared: 0 };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.URL.createObjectURL = () => 'blob:x';
  w.eval(lastScript(html));
  return { w, doc: w.document, sent };
}

function scan(w, v) {
  const inp = w.document.getElementById('relIn');
  inp.value = v;
  inp.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}
const txt = (doc) => doc.body.textContent.replace(/\s+/g, ' ');

(async () => {
  /* ---------- ① 부팅 ---------- */
  console.log('\n① 화면 구성');
  {
    const { w, doc } = mkDom({});
    await sleep(30);
    ok('build 훅 노출', w.__REL__ && w.__REL__.build === 'rel-0827a', w.__REL__ && w.__REL__.build);
    ok('탭 3개(위치변경·이동 기록·랙 유형)', doc.querySelectorAll('.tab').length === 3);
    ok('3단계 안내가 보인다', doc.querySelectorAll('.step').length === 3);
    ok('스캔 입력칸이 있다', !!doc.getElementById('relIn'));
    ok('① 단계가 현재 단계', doc.querySelectorAll('.step')[0].className.indexOf('cur') >= 0);
    ok('안내에 재고 총량 불변이 명시된다', /재고 총량은 바뀌지 않습니다/.test(txt(doc)));
    ok('저장 버튼은 처음엔 비활성', doc.getElementById('btnSave').disabled === true);
  }

  /* ---------- ② 3단 스캔 → 자동 저장 ---------- */
  console.log('\n② 카톤 라벨 → 기존 위치 → 새 위치');
  {
    const { w, doc, sent } = mkDom({});
    await sleep(30);
    scan(w, 'CTR-CE0796-16');
    await sleep(40);
    ok('① 제품번호를 읽는다', /CE0796/.test(txt(doc)));
    ok('① 품명도 보여준다', /TERMINAL EXTERIOR/.test(txt(doc)));
    ok('① 소입수량 16 EA 를 이동 수량으로 잡는다', /16 EA/.test(txt(doc)));
    ok('① 단계 완료 표시', doc.querySelectorAll('.step')[0].className.indexOf('done') >= 0);
    ok('아직 저장하지 않는다', sent.filter((s) => s.method === 'POST').length === 0);

    scan(w, 'B-01-01');
    await sleep(30);
    ok('② 기존 위치가 잡힌다', doc.querySelectorAll('.step')[1].className.indexOf('done') >= 0);
    ok('② 경로 표시에 출발 랙', /B-01-01/.test(txt(doc)));
    ok('② 아직 저장 전', sent.filter((s) => s.method === 'POST').length === 0);

    scan(w, 'FM-01');
    await sleep(60);
    const post = sent.filter((s) => s.method === 'POST' && /rack-moves/.test(s.url))[0];
    ok('③ 새 위치 스캔에서 자동 저장', !!post, sent.map((s) => s.url));
    ok('저장 payload: from_rack', post && post.body.from_rack === 'B-01-01', post && post.body);
    ok('저장 payload: to_rack', post && post.body.to_rack === 'FM-01');
    ok('저장 payload: 라벨 수량이 이동 수량', post && post.body.lines[0].per_carton === 16 && post.body.lines[0].cartons === 1);
    ok('저장 payload: 제품 id 와 라벨 원문', post && post.body.lines[0].product_id === 5 && /CTR-CE0796-16/.test(post.body.lines[0].label));
    ok('기본값으로 제품마스터 위치도 갱신', post && post.body.update_master === true);
    ok('저장 후 이번 작업 목록에 남는다', /이번 작업에서 저장한 이동/.test(txt(doc)));
  }

  /* ---------- ③ 경로 고정 — 다음 박스는 라벨 1스캔 ---------- */
  console.log('\n③ 경로 고정(연속 이동)');
  {
    const { w, doc, sent } = mkDom({});
    await sleep(30);
    scan(w, 'CTR-CE0796-16'); await sleep(40);
    scan(w, 'B-01-01'); await sleep(20);
    scan(w, 'FM-01'); await sleep(60);
    const n1 = sent.filter((s) => s.method === 'POST').length;
    scan(w, 'CTR-CE0796-16'); await sleep(80);
    const posts = sent.filter((s) => s.method === 'POST');
    ok('경로가 유지되어 라벨 1스캔으로 다시 저장된다', posts.length === n1 + 1, posts.length);
    ok('두 번째 저장도 같은 경로', posts[posts.length - 1].body.from_rack === 'B-01-01' && posts[posts.length - 1].body.to_rack === 'FM-01');
    ok('경로 표시가 화면에 남는다', /경로 지우기/.test(txt(doc)));
  }

  /* ---------- ④ 경고 ---------- */
  console.log('\n④ 확인이 필요한 상황');
  {
    const { w, doc } = mkDom({});
    await sleep(30);
    scan(w, 'CTR-CE0154-8'); await sleep(40);      // 마스터 위치 C-09-09
    scan(w, 'B-01-01'); await sleep(30);
    ok('마스터 위치와 다른 랙을 스캔하면 경고', /제품마스터 위치와 다릅니다/.test(txt(doc)), txt(doc).slice(0, 200));
  }
  {
    const { w, doc, sent } = mkDom({});
    await sleep(30);
    scan(w, 'CTR-CE0796-16'); await sleep(40);
    scan(w, 'B-01-01'); await sleep(20);
    scan(w, 'B-01-02'); await sleep(60);            // fast 아님
    ok('도착이 fast moving rack 이 아니면 경고', /fast moving rack 으로 지정되어 있지 않습니다/.test(txt(doc)));
    ok('경고해도 이동은 저장된다(작업이 멈추지 않는다)', sent.filter((s) => s.method === 'POST').length === 1);
  }
  {
    const { w, doc, sent } = mkDom({});
    await sleep(30);
    scan(w, 'CE0152'); await sleep(40);             // 라벨에 수량 없음
    ok('소입수량이 없으면 경고', /소입수량이 없습니다/.test(txt(doc)));
    scan(w, 'B-01-02'); await sleep(20);
    scan(w, 'FM-01'); await sleep(60);
    ok('수량이 없으면 자동 저장하지 않는다', sent.filter((s) => s.method === 'POST').length === 0);
    ok('저장 버튼도 비활성', doc.getElementById('btnSave').disabled === true);
    const qp = doc.getElementById('qPer');
    qp.value = '12'; qp.dispatchEvent(new w.Event('change', { bubbles: true }));
    await sleep(30);
    ok('수량을 직접 넣으면 저장 가능해진다', doc.getElementById('btnSave').disabled === false);
    doc.getElementById('btnSave').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    const p = sent.filter((s) => s.method === 'POST')[0];
    ok('손입력 수량이 payload 에 실린다', p && p.body.lines[0].per_carton === 12, p && p.body.lines[0]);
  }
  {
    const { w, doc } = mkDom({});
    await sleep(30);
    scan(w, 'ZZ-NOPE-9'); await sleep(40);
    ok('제품도 랙도 아니면 오류 표시', /등록되지 않은 코드입니다/.test(txt(doc)));
  }

  /* ---------- ⑤ 스캔 위생 ---------- */
  console.log('\n⑤ 스캔 위생');
  {
    const { w } = mkDom({});
    await sleep(30);
    const R = w.__REL__;
    ok('스페인어 자판 보정: A’01’03 → A-01-03', R.normScan("A'01'03") === 'A-01-03', R.normScan("A'01'03"));
    ok('CTR 라벨 파서: 제품번호/소입수량 분리', R.parseLabel('CTR-CE0796-16').code === 'CE0796' && R.parseLabel('CTR-CE0796-16').qty === 16);
    ok('접두어 없는 값은 그대로', R.parseLabel('CE0796').code === 'CE0796' && R.parseLabel('CE0796').qty === 0);
    ok('랙 매칭은 구분자 표기를 무시한다(B0101 → B-01-01)', !!R.findRack('B0101'), R.findRack('B0101'));
    ok('랙 매칭은 대소문자를 무시한다', !!R.findRack('fm-01'));
    ok('숫자만 8자리 이상은 부속 바코드로 본다', R.looksCompanion('7501234567890') === true);
    ok('랙 번호는 부속 바코드가 아니다', R.looksCompanion('B-01-01') === false);
  }
  {
    const { w, sent } = mkDom({});
    await sleep(30);
    scan(w, 'CTR-CE0796-16'); await sleep(40);
    scan(w, 'B-01-01'); await sleep(10);
    scan(w, 'B-01-01'); await sleep(30);            // 450ms 안의 재리딩
    ok('같은 값 연속 리딩은 무시된다', w.__REL__.state().to === null, w.__REL__.state());
    ok('중복 리딩이 저장을 유발하지 않는다', sent.filter((s) => s.method === 'POST').length === 0);
  }

  /* ---------- ⑥ 랙 유형 탭 ---------- */
  console.log('\n⑥ 랙 유형 탭');
  {
    const { w, doc, sent } = mkDom({ role: 'director' });
    await sleep(30);
    doc.querySelectorAll('.tab')[2].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    ok('랙 목록이 나온다', doc.querySelectorAll('select.ksel').length === 4, doc.querySelectorAll('select.ksel').length);
    ok('앞머리 그룹 구분줄', doc.querySelectorAll('tr.gsep').length === 2);
    ok('미지정 랙은 기본(카톤)으로 표시', doc.querySelector('select.ksel[data-rack="B-01-02"]').value === '');
    const sel = doc.querySelector('select.ksel[data-rack="B-01-02"]');
    sel.value = 'fast'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    await sleep(20);
    ok('변경 건수 배지', /변경 1/.test(doc.getElementById('kDirty').textContent));
    doc.getElementById('btnSaveKinds').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    const put = sent.filter((s) => s.method === 'PUT')[0];
    ok('변경분만 전송한다', put && put.body.map.length === 1 && put.body.map[0].rack === 'B-01-02' && put.body.map[0].kind === 'fast', put && put.body);
  }
  {
    const { w, doc } = mkDom({ role: 'warehouse' });
    await sleep(30);
    doc.querySelectorAll('.tab')[2].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    ok('비디렉터는 드롭다운 비활성', [...doc.querySelectorAll('select.ksel')].every((s) => s.disabled));
    ok('비디렉터는 저장 비활성 + 안내', doc.getElementById('btnSaveKinds').disabled === true && /디렉터만 저장/.test(txt(doc)));
    ok('비디렉터에게는 랙 추가 칸이 없다', !doc.getElementById('btnAddRack'));
  }

  /* ---------- ⑦ 이동 기록 탭 ---------- */
  console.log('\n⑦ 이동 기록 탭');
  {
    const moves = [
      { id: 2, product_id: 5, product_code: 'CE0796', product_name: 'TERMINAL', from_rack: 'B-01-01', to_rack: 'FM-01', from_kind: 'carton', to_kind: 'fast', cartons: 3, per_carton: 16, qty_ea: 48, master_updated: true, note: null, moved_at: '2026-08-27T10:00:00Z', moved_by_name: '창고A' },
      { id: 1, product_id: 6, product_code: 'CE0152', product_name: 'T2', from_rack: null, to_rack: 'FM-02', from_kind: null, to_kind: 'fast', cartons: 1, per_carton: 12, qty_ea: 12, master_updated: false, note: null, moved_at: '2026-08-26T10:00:00Z', moved_by_name: '창고B' },
    ];
    const { w, doc } = mkDom({ moves });
    await sleep(30);
    doc.querySelectorAll('.tab')[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    const t = txt(doc);
    ok('기록 2건 표시', /CE0796/.test(t) && /CE0152/.test(t));
    ok('합계 카톤 4 · 60 EA', /4/.test(t) && /60/.test(t));
    ok('출발지 없는 이동은 —', /—/.test(t));
    ok('작업자 이름 표시', /창고A/.test(t) && /창고B/.test(t));
    ok('랙별 누적 표가 함께 나온다', /랙별 누적 이동/.test(t));
    ok('CSV 버튼', !!doc.getElementById('btnCsv'));
  }

  /* ---------- ⑧ PDA 컴팩트 모드 ---------- */
  console.log('\n⑧ PDA 컴팩트 모드');
  {
    const { w, doc } = mkDom({ width: 360 });
    await sleep(40);
    ok('좁은 화면에서 자동 컴팩트', doc.body.classList.contains('pda'));
    ok('토글 버튼이 생긴다', !!doc.getElementById('pdaBtn'));
    doc.getElementById('pdaBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    ok('토글로 전체보기 전환', !doc.body.classList.contains('pda'));
    ok('선택을 localStorage 에 기억', w.localStorage.getItem('wh_pda') === '0');
  }
  {
    const { doc } = mkDom({ width: 1280 });
    await sleep(40);
    ok('데스크톱은 컴팩트 아님(회귀)', !doc.body.classList.contains('pda'));
  }
  {
    const { doc } = mkDom({ width: 1280, pda: '1' });
    await sleep(40);
    ok('저장한 선택이 자동감지보다 우선', doc.body.classList.contains('pda'));
  }

  /* ---------- ⑨ 스페인어 ---------- */
  console.log('\n⑨ 스페인어 화면');
  {
    const { w, doc } = mkDom({ lang: 'es' });
    await sleep(30);
    scan(w, 'CTR-CE0796-16'); await sleep(40);
    scan(w, 'B-01-01'); await sleep(20);
    const nodes = [];
    const walk = (n) => { if (n.nodeType === 3) nodes.push(n.nodeValue); else if (!/^(SCRIPT|STYLE)$/.test(n.nodeName)) n.childNodes.forEach(walk); };
    walk(doc.body);
    const ko = nodes.filter((s) => /[가-힣]/.test(s)).map((s) => s.trim()).filter(Boolean)
      .filter((s) => s !== '🌐 한국어' && s !== '한국어');
    ok('스페인어 화면에 남은 한국어 없음(언어 버튼 제외)', ko.length === 0, ko.slice(0, 6));
    ok('스페인어 안내문', /Escanee/.test(txt(doc)));
  }

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
