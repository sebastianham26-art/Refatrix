/* 마감(입고) 화면 개편(2026-08-17r) 회귀 테스트 — "검수 완료 → 적치 전 입고"
   운영 refatrix-inbound.html 인라인 스크립트를 jsdom 에서 그대로 실행.
   검증: 실측 수량 표시(서버 마감 공식과 동일), 전체 검수 완료 배너, 미검수 경고,
        마감 후 "적치 계속 가능" 안내, 검수 확정 마지막 팔렛 → 마감 안내 토스트. */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const FILE = '/tmp/Refatrix/refatrix-inbound.html';
const html = fs.readFileSync(FILE, 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 팔렛 A: 20ct×320(16/box) 실측 18 + 3ct×36(12/box) 실측 4(초과) + 낱개 10 → 실측 346
// 팔렛 B: 상태 가변(unloaded/checked)
function fixture(bStatus) {
  return {
    shipment: { id: 1, invoice_no: 'D26-3', status: 'receiving' },
    pallets: [
      { id: 11, pl_no: 7, order_no: '26B2C', status: 'checked', cartons_expected: 23, qty_expected: 366,
        checked_at: '2026-08-17T20:00:00Z', working: false, scans: [],
        items: [
          { id: 1, code: 'CE0796', name: 'T', cartons: 20, qty: 320, scanned_cartons: 18, put_cartons: 0, rack: 'A-01', zone: 1, registered: true },
          { id: 2, code: 'CE0796', name: 'T', cartons: 3,  qty: 36,  scanned_cartons: 4,  put_cartons: 0, rack: 'A-01', zone: 1, registered: true },
          { id: 3, code: 'CE0796', name: 'T', cartons: 0,  qty: 10,  scanned_cartons: 0,  put_cartons: 0, rack: 'A-01', zone: 1, registered: true },
        ] },
      { id: 12, pl_no: 8, order_no: '26B2C', status: bStatus, cartons_expected: 2, qty_expected: 32,
        checked_at: bStatus === 'checked' ? '2026-08-17T21:00:00Z' : null, working: false, scans: [],
        items: [{ id: 4, code: 'CB0318', name: 'R', cartons: 2, qty: 32, scanned_cartons: bStatus === 'checked' ? 2 : 0, put_cartons: 0, rack: 'B-01', zone: 2, registered: true }] },
    ],
    files: [],
  };
}

async function boot(SHIP) {
  const calls = [];
  const dom = new JSDOM(html.replace(/<script src="refatrix-nav\.js[^"]*"><\/script>/, ''), {
    runScripts: 'outside-only', url: 'https://x.test/refatrix-inbound.html', pretendToBeVisual: true });
  const w = dom.window;
  w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { id: 9, name: 'Seb', role: 'director' } }));
  w.localStorage.setItem('wh_lang', 'ko');
  w.confirm = () => true;
  w.fetch = (url, opt) => {
    const u = String(url), body = (opt && opt.body) ? JSON.parse(opt.body) : {};
    calls.push({ u, body });
    let res = { ok: true };
    if (/confirm$/.test(u)) {
      res = { ok: true, dry: !!body.dry, lines: [], extras: {}, unknown: {}, total_expected: 2, total_scanned: 2 };
      if (!body.dry) { SHIP.pallets[1].status = 'checked'; SHIP.pallets[1].checked_at = 'x'; SHIP.pallets[1].items[0].scanned_cartons = 2; }
    }
    else if (/close$/.test(u)) { res = { ok: true, po_lines_updated: 1, orders: {} }; SHIP.shipment.status = 'closed'; }
    else if (/\/files(\?|$)/.test(u)) res = { items: [] };
    else if (/\/api\/inbound\/1(\?|$)/.test(u)) res = SHIP;
    else if (/\/api\/inbound(\?|$)/.test(u)) res = { items: [SHIP.shipment] };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(res) });
  };
  w.__toasts = [];
  w.__tones = [];
  w.AudioContext = function () { this.currentTime = 0; this.state = 'running'; this.destination = {};
    this.createOscillator = function () { const o = { type: 'sine', frequency: { value: 0 }, connect: () => o, start: () => w.__tones.push(o.frequency.value), stop: () => {} }; return o; };
    this.createGain = function () { return { gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => {} }; }; };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const script = html.match(/<script>\s*\(function\(\)\{[\s\S]*?<\/script>/g).pop()
    .replace(/^<script>/, '').replace(/<\/script>$/, '');
  w.eval(script
    .replace(/function toast\(/, 'function toast(m){window.__toasts.push(m);return __toast0(m);}\nfunction __toast0(')
    .replace(/\}\)\(\);\s*$/,
      'window.__t={openShip:openShip,setStep:function(s){STEP=s;},renderClose:renderClose,renderDetail:renderDetail,'
      + 'lockPallet:lockPallet,renderCheck:renderCheck,doConfirm:doConfirm,'
      + 'getDetail:function(){return DETAIL;}};\n})();'));
  await sleep(40);
  return { w, t: w.__t, calls, doc: w.document, SHIP };
}

(async () => {
  console.log('\n① 일부 미검수 — 실측 수량과 경고');
  {
    const { t, doc } = await boot(fixture('unloaded'));
    t.openShip(1); await sleep(30);
    t.setStep('close'); t.renderClose(); await sleep(10);
    const body = doc.getElementById('stepbody').textContent;
    ok('실측 수량 346 표시(예상 366 아님)', /346/.test(body), body.slice(0, 200));
    ok('패킹리스트 대비 −20', /-20/.test(body));
    ok('미검수 제외 경고', /제외/.test(body));
    ok('입고 확정 버튼 존재(적치와 무관)', !!doc.getElementById('btnClose'));
    ok('미검수 팔렛 실측은 — 표시', /—/.test(body));
  }

  console.log('\n② 전체 검수 완료 — "지금 바로 입고" 배너');
  {
    const { t, doc } = await boot(fixture('checked'));
    t.openShip(1); await sleep(30);
    t.setStep('close'); t.renderClose(); await sleep(10);
    const body = doc.getElementById('stepbody').textContent;
    ok('전체 검수 완료 배너', /지금 바로 입고/.test(body), body.slice(0, 160));
    ok('적치 계속 안내', /적치/.test(body) && /계속/.test(body));
    ok('실측 합계 378 (346+32)', /378/.test(body));
  }

  console.log('\n③ 마감 실행 → 마감 후에도 적치 안내');
  {
    const { t, doc } = await boot(fixture('checked'));
    t.openShip(1); await sleep(30);
    t.setStep('close'); t.renderClose(); await sleep(10);
    doc.getElementById('pin').value = '1234';
    doc.getElementById('btnClose').click(); await sleep(30);
    t.renderClose(); await sleep(5);
    const body = doc.getElementById('stepbody').textContent;
    ok('마감 완료 + 적치 계속 가능 문구', /입고 완료/.test(body) && /적치는 계속/.test(body), body.slice(0, 200));
    ok('마감 후 버튼 없음', !doc.getElementById('btnClose'));
  }

  console.log('\n④ 마지막 팔렛 검수 확정 → 입고 안내 토스트');
  {
    const { w, t, doc } = await boot(fixture('unloaded'));
    t.openShip(1); await sleep(30);
    t.setStep('check'); t.renderCheck(); await sleep(10);
    t.lockPallet(12);
    t.doConfirm(); await sleep(40);
    ok('모든 팔렛 검수 완료 안내', w.__toasts.some(m => /모든 팔렛 검수 완료/.test(String(m))), w.__toasts);
    ok('[마감] 탭 안내 포함', w.__toasts.some(m => /마감/.test(String(m)) && /입고/.test(String(m))));
  }

  console.log('\n' + (fail ? '❌' : '✅') + ` 결과: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 실행 오류:', e); process.exit(2); });
