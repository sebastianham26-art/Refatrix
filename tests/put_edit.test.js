/* 적치 수정(2026-08-17p) 회귀 테스트 — 이미 적재한 박스의 위치 변경·빼기
   운영 refatrix-inbound.html 인라인 스크립트를 jsdom 에서 그대로 실행.
   검증: ✎ 편집기 → [−1 빼기]=음수 delta 전송, [+1], [위치 적용]=rack 변경(+마스터 저장 선택). */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const FILE = '/tmp/Refatrix/refatrix-inbound.html';
const html = fs.readFileSync(FILE, 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function fixture() {
  return {
    shipment: { id: 1, invoice_no: 'D26-81319563', status: 'receiving' },
    pallets: [{
      id: 11, pl_no: 4, order_no: '26B2C', status: 'checking', cartons_expected: 8, qty_expected: 128,
      checked_at: '2026-08-17T20:00:00Z', working: false, scans: [],
      items: [
        { id: 101, code: 'CE0796', name: 'TERMINAL', cartons: 5, qty: 80, scanned_cartons: 5, put_cartons: 3, rack: 'A-01-01', zone: 1, zone_name: 'Zona 1', registered: true },
        { id: 102, code: 'CB0318', name: 'ROTULA',   cartons: 3, qty: 48, scanned_cartons: 3, put_cartons: 0, rack: 'B-02-01', zone: 2, zone_name: 'Zona 2', registered: true },
      ],
    },
    { id: 21, pl_no: 14, order_no: '26B2C', status: 'checked', cartons_expected: 2, qty_expected: 32,
      checked_at: '2026-08-17T21:00:00Z', received_at: null, working: false, scans: [],
      items: [{ id: 201, code: 'CQ0271L-02', name: 'H', cartons: 2, qty: 32, scanned_cartons: 2, put_cartons: 0, rack: 'C-01-01', zone: 3, zone_name: 'Zona 3', registered: true }] },
    { id: 22, pl_no: 15, order_no: '26B2C', status: 'wait', cartons_expected: 1, qty_expected: 16,
      checked_at: null, received_at: null, working: false, scans: [],
      items: [{ id: 202, code: 'CE0152', name: 'T2', cartons: 1, qty: 16, scanned_cartons: 0, put_cartons: 0, rack: null, zone: null, registered: true }] }],
    files: [],
  };
}

async function boot() {
  const SHIP = fixture();
  const calls = [];
  const dom = new JSDOM(html.replace(/<script src="refatrix-nav\.js[^"]*"><\/script>/, ''), {
    runScripts: 'outside-only', url: 'https://x.test/refatrix-inbound.html', pretendToBeVisual: true
  });
  const w = dom.window;
  w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { id: 9, name: 'Seb', role: 'warehouse' } }));
  w.localStorage.setItem('wh_lang', 'ko');
  w.confirm = () => true;
  w.fetch = (url, opt) => {
    const u = String(url);
    const body = (opt && opt.body) ? JSON.parse(opt.body) : {};
    calls.push({ u, body, method: (opt && opt.method) || 'GET' });
    let res = { ok: true };
    if (/putaway$/.test(u)) res = { ok: true, done: false };
    else if (/\/files(\?|$)/.test(u)) res = { items: [] };
    else if (/\/api\/inbound\/1(\?|$)/.test(u)) res = SHIP;
    else if (/\/api\/inbound(\?|$)/.test(u)) res = { items: [SHIP.shipment] };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(res) });
  };
  w.__tones = [];
  w.AudioContext = function () {
    this.currentTime = 0; this.state = 'running'; this.destination = {};
    this.createOscillator = function () { const o = { type: 'sine', frequency: { value: 0 }, connect: () => o, start: () => w.__tones.push(o.frequency.value), stop: () => {} }; return o; };
    this.createGain = function () { return { gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => {} }; };
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const script = html.match(/<script>\s*\(function\(\)\{[\s\S]*?<\/script>/g).pop()
    .replace(/^<script>/, '').replace(/<\/script>$/, '');
  w.eval(script.replace(/\}\)\(\);\s*$/,
    'window.__t={openShip:openShip,setStep:function(s){STEP=s;},renderPut:renderPut,'
    + 'setPutPal:function(i){putPal=i;},getPutAdd:function(){return putAdd;},getPutSaveRack:function(){return putSaveRack;},'
    + 'putFlush:putFlush,getDetail:function(){return DETAIL;},'
    + 'putListScan:putListScan,palByScan:palByScan,putScan:putScan,getPutPal:function(){return putPal;},renderPutList:renderPutList,setTiming:function(d,g){DUP_MS=d;GRACE_MS=g;}};\n})();'));
  await sleep(40);
  return { w, t: w.__t, calls, doc: w.document, SHIP };
}
const putCalls = (calls) => calls.filter(c => /putaway$/.test(c.u));
const openEdit = (doc, id) => { if (!doc.getElementById('peRack') || !doc.querySelector('[data-pe="'+id+'"]').textContent.includes('▲')) doc.querySelector('[data-pe="'+id+'"]').click(); };

(async () => {
  console.log('\n① ✎ 편집기 — 열기/표시');
  const { w, t, calls, doc } = await boot();
  t.openShip(1); await sleep(30);
  t.setStep('put'); t.setPutPal(11); t.renderPut(); await sleep(10);
  const editBtns = doc.querySelectorAll('[data-pe]');
  ok('SKU 마다 ✎ 버튼', editBtns.length === 2, editBtns.length);
  doc.querySelector('[data-pe="101"]').click(); await sleep(5);
  ok('편집기 열림(−1/+1/위치 적용)', !!doc.getElementById('peMinus') && !!doc.getElementById('peApply'));

  console.log('\n② [−1 빼기] — 이미 올린 박스를 내린다(음수 delta)');
  doc.getElementById('peMinus').click(); await sleep(5);
  doc.getElementById('peMinus').click(); await sleep(5);
  ok('putAdd = −2', t.getPutAdd()['101'] === -2, t.getPutAdd());
  ok('표시 1/5 로 감소', /1\/5/.test(doc.getElementById('putsku').textContent), doc.getElementById('putsku').textContent.slice(0, 80));
  // 0 밑으로는 안 내려간다
  doc.getElementById('peMinus').click(); await sleep(5);
  ok('0 에서 더 못 뺌(버튼 자체 방어)', (t.getPutAdd()['101'] || 0) >= -3, t.getPutAdd());
  t.putFlush(); await sleep(20);
  const c1 = putCalls(calls)[0];
  ok('서버로 음수 delta 전송', c1 && c1.body.items.some(r => r.item_id === 101 && r.put_delta < 0), c1 && c1.body.items);

  console.log('\n③ [위치 적용] — 위치 변경 + 마스터 저장 선택');
  openEdit(doc, 101); await sleep(5);
  const rk = doc.getElementById('peRack');
  ok('현재 위치가 미리 채워짐', rk.value === 'A-01-01', rk.value);
  rk.value = "C'03'05";                                   // 자판 따옴표 → 하이픈 보정 확인
  doc.getElementById('peApply').click(); await sleep(5);
  ok('위치 C-03-05 로 보정·설정', t.getPutSaveRack()['101'] === 'C-03-05', t.getPutSaveRack());
  t.putFlush(); await sleep(20);
  const c2 = putCalls(calls)[1];
  const r2 = c2 && c2.body.items.filter(r => r.item_id === 101)[0];
  ok('rack + save_rack:true 전송(마스터 체크 기본)', r2 && r2.rack === 'C-03-05' && r2.save_rack === true, r2);

  console.log('\n④ 마스터 체크 해제 — 이 선적만 변경');
  openEdit(doc, 102); await sleep(5);
  doc.getElementById('peRack').value = 'D-01-01';
  doc.getElementById('peMaster').checked = false;
  doc.getElementById('peApply').click(); await sleep(5);
  t.putFlush(); await sleep(20);
  const c3 = putCalls(calls)[2];
  const r3 = c3 && c3.body.items.filter(r => r.item_id === 102)[0];
  ok('rack 은 바뀌고 save_rack:false', r3 && r3.rack === 'D-01-01' && r3.save_rack === false, r3);

  console.log('\n⑤ Enter 로도 위치 적용(스캐너 입력)');
  openEdit(doc, 101); await sleep(5);
  const rk2 = doc.getElementById('peRack');
  rk2.value = 'E-05-05';
  rk2.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(5);
  ok('Enter → 적용', t.getPutSaveRack()['101'] === 'E-05-05', t.getPutSaveRack());

  console.log('\n⑥ 팔렛 바코드 스캔 → 드릴다운(2026-08-18)');
  {
    const b6 = await boot();
    b6.t.setTiming(0, 0);
    b6.t.openShip(1); await sleep(30);
    b6.t.setStep('put'); b6.t.renderPut(); await sleep(10);
    ok('팔렛 매칭: 26B2C-14', b6.t.palByScan('26B2C-14') && b6.t.palByScan('26B2C-14').id === 21);
    ok("자판 따옴표 보정: 26B2C'14", b6.t.palByScan(String("26B2C'14").replace(/'/g,'-')) !== null);
    ok('구분자 없이: 26B2C14', b6.t.palByScan('26B2C14') && b6.t.palByScan('26B2C14').id === 21);
    ok('팔렛 번호 단독(유일): 15', b6.t.palByScan('15') && b6.t.palByScan('15').id === 22);
    ok('없는 팔렛은 null', b6.t.palByScan('26B2C-99') === null);
    // 목록에서 팔렛 라벨 스캔 → 그 팔렛 작업 화면으로
    b6.t.putListScan('26B2C-14'); await sleep(10);
    ok('팔렛 라벨 스캔 → 드릴다운', b6.t.getPutPal() === 21, b6.t.getPutPal());
    ok('작업 화면 열림(SKU 목록)', /CQ0271L-02/.test(b6.doc.getElementById('putsku').textContent));
    // 작업 화면에서 다른 팔렛 라벨 스캔 → 저장 후 전환
    b6.t.putScan('26B2C-11'); await sleep(20);   // 팔렛 11? pl_no=4 → '26B2C4'
    b6.t.putScan('26B2C-4'); await sleep(20);
    ok('작업 중 팔렛 전환', b6.t.getPutPal() === 11, b6.t.getPutPal());
    // 미검수 팔렛은 경고만
    b6.t.putListScan('26B2C-15'); await sleep(10);
    ok('검수 전 팔렛은 진입 차단(경고)', b6.t.getPutPal() === 11);
  }

  console.log('\n' + (fail ? '❌' : '✅') + ` 결과: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 실행 오류:', e); process.exit(2); });
