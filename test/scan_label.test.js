/* 수입입고 검수 — 일괄 스캔(전체 스캔 → 팔렛 처리) 모드 + 적치/재분할 회귀 (jsdom)
   운영 refatrix-inbound.html 의 인라인 스크립트를 그대로 추출해 실행한다. */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const FILE = '/tmp/Refatrix/refatrix-inbound.html';
const html = fs.readFileSync(FILE, 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const mkShip = () => ({
  shipment: { id: 1, invoice_no: 'D26-81319563', status: 'receiving', eta: '2026-08-07' },
  pallets: [{
    id: 11, pl_no: '12', order_no: '100RA25K2C', status: 'unloaded',
    cartons_expected: 25, qty_expected: 388, checked_at: null, working: false,
    items: [
      { id: 201, code: 'CE0796', name: 'TERMINAL', cartons: 20, qty: 320, rack: 'B-01-01', scanned_cartons: 0, put_cartons: 0, box_from: 1, box_to: 20, zone: 2, zone_name: 'A동 뒤', zone_is_default: false },   // ×16
      { id: 202, code: 'CE0796', name: 'TERMINAL', cartons: 3, qty: 36, rack: 'B-01-01', scanned_cartons: 0, put_cartons: 0, box_from: 21, box_to: 23, zone: 2, zone_name: 'A동 뒤', zone_is_default: false },    // ×12
      { id: 203, code: 'CE0152', name: 'T2', cartons: 2, qty: 32, rack: null, scanned_cartons: 0, put_cartons: 0, box_from: 24, box_to: 25, zone: 4, zone_name: '신규', zone_is_default: true },
    ],
  }],
  files: [],
});

async function boot(SHIP) {
  const dom = new JSDOM(html.replace(/<script src="refatrix-nav\.js[^"]*"><\/script>/, ''),
    { runScripts: 'outside-only', url: 'https://x.test/refatrix-inbound.html', pretendToBeVisual: true });
  const w = dom.window;
  w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { id: 9, name: 'Maria', role: 'warehouse' } }));
  w.localStorage.setItem('wh_lang', 'ko');
  const sent = [];
  w.fetch = (url, opt) => {
    const u = String(url); let body = {};
    if (opt && opt.method === 'POST') sent.push({ url: u, body: opt.body ? JSON.parse(opt.body) : null });
    if (/\/api\/inbound\/1\/files$/.test(u)) body = { items: [] };
    else if (/\/api\/inbound\/1(\?|$)/.test(u)) body = SHIP;
    else if (/\/api\/inbound(\?|$)/.test(u)) body = { items: [{ id: 1, invoice_no: 'D26-81319563', status: 'receiving', pallets: SHIP.pallets.length, pallets_checked: 0 }] };
    else body = { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.confirm = () => (w.__confirmAnswer === undefined ? true : w.__confirmAnswer);
  w.__tones = [];
  w.AudioContext = class {
    constructor(){ this.state='running'; this.currentTime=0; this.destination={}; }
    resume(){}
    createGain(){ return { gain:{ setValueAtTime(){}, exponentialRampToValueAtTime(){} }, connect(){} }; }
    createOscillator(){ const o={ type:'sine', frequency:{ value:0 }, connect(){}, stop(){},
      start:()=>w.__tones.push({f:o.frequency.value,t:o.type}) }; return o; }
  };
  const script = html.match(/<script>\s*\(function\(\)\{[\s\S]*?<\/script>/g).pop()
    .replace(/^<script>/, '').replace(/<\/script>$/, '');
  w.eval(script.replace(/\}\)\(\);\s*$/,
    'window.__t={parseLabel:parseLabel,perCarton:perCarton,normScan:normScan,openShip:openShip,renderDetail:renderDetail,'
    + 'setStep:function(x){STEP=x;},doScan:doScan,processBatch:processBatch,checkDone:checkDone,lockPallet:lockPallet,'
    + 'getBatch:function(){return batchScans;},getUnknown:function(){return unknownTally;},'
    + 'getCounts:function(){return scanCounts;},getQty:function(){return scanQty;},getLock:function(){return scanLock;},'
    + 'setDetail:function(d){DETAIL=d;},setTiming:function(d,g){DUP_MS=d;GRACE_MS=g;},'
    + 'needRelines:needRelines,reSplitSend:reSplitSend};\n})();'));
  await sleep(50);
  return { w, doc: w.document, sent, t: w.__t };
}
async function openCheck(SHIP, keepTiming) {
  const ctx = await boot(SHIP);
  if (!keepTiming) ctx.t.setTiming(0, 0);
  ctx.t.openShip(1); await sleep(50);
  ctx.t.setStep('check'); ctx.t.renderDetail();
  ctx.scan = (raw) => {
    const inp = ctx.doc.getElementById('scanIn');
    inp.value = raw;
    inp.dispatchEvent(new ctx.w.Event('input', { bubbles: true }));
    inp.dispatchEvent(new ctx.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };
  return ctx;
}
const asScanner = (s) => s.replace(/-/g, "'");

(async () => {
  console.log('\n① parseLabel — CTR-제품번호-소입수량 (회귀)');
  {
    const SHIP = mkShip();
    const { t } = await boot(SHIP); t.setDetail(SHIP);
    ok('CE0796 ×16 분해', (() => { const a = t.parseLabel('CTR-CE0796-16'); return a.code === 'CE0796' && a.qty === 16 && a.matched; })());
    ok('자판 보정(따옴표) 동일', (() => { const a = t.parseLabel(asScanner('CTR-CE0796-16')); return a.code === 'CE0796' && a.qty === 16; })());
    ok('미등록 matched=false', t.parseLabel('CTR-ZZ9999-16').matched === false);
  }

  console.log('\n② 일괄 스캔 — 자유 누적 · 존 안내 · 미확인 · 부속/중복 무시');
  {
    const ctx = await openCheck(mkShip());
    ctx.scan(asScanner('CTR-CE0796-16'));
    ok('스캔 1건 누적(검증·차단 없음)', ctx.t.getBatch().length === 1, ctx.t.getBatch());
    const box = ctx.doc.getElementById('scanres').textContent;
    ok('존 안내 그대로(존 2 크게)', /옮길 곳/.test(box) && /A동 뒤/.test(box), box.slice(0, 80));
    ok('누적 횟수 표시', /누적/.test(box));
    ctx.scan('CTR-CE0796-16'); ctx.scan('CTR-CE0796-12'); ctx.scan('CTR-CE0152-16');
    ok('4박스 누적', ctx.t.getBatch().length === 4);
    const tallyTxt = ctx.doc.getElementById('sklist').textContent;
    ok('집계표: ×16 2회 · ×12 1회 분리', /×16/.test(tallyTxt) && /×12/.test(tallyTxt) && /2회/.test(tallyTxt), tallyTxt.slice(0, 120));
    ok('진행줄: 4박스 · 수량 합계(60 EA)', /4/.test(ctx.doc.getElementById('ctxt').textContent) && /60 EA/.test(ctx.doc.getElementById('ctxt').textContent),
      ctx.doc.getElementById('ctxt').textContent);
    ok('[팔렛 처리] 버튼 활성', ctx.doc.getElementById('btnProc').disabled === false);

    ctx.w.__tones.length = 0;
    ctx.scan('7501234567890');                          // 부속 EAN — 조용히 무시
    ok('부속 바코드 무시(누적 그대로·무음)', ctx.t.getBatch().length === 4 && !ctx.w.__tones.length);
    ctx.scan('CTR-ZZ9999-16');                          // 미확인 — 오류음 + 별도 집계(차단 아님)
    ok('미확인 코드 별도 집계', ctx.t.getUnknown()['ZZ9999'] === 1, ctx.t.getUnknown());
    ok('미확인은 오류음', ctx.w.__tones.some(x => Math.round(x.f) === 196));
    ok('배치는 오염되지 않음', ctx.t.getBatch().length === 4);
  }
  {
    // 중복 연쇄(자동 모드) — 운영 기본 타이밍으로
    const ctx = await openCheck(mkShip(), true);
    ctx.scan('CTR-CE0796-16'); await sleep(150); ctx.scan('CTR-CE0796-16'); await sleep(150); ctx.scan('CTR-CE0796-16');
    ok('연쇄 재리딩 → 1박스만', ctx.t.getBatch().length === 1, ctx.t.getBatch().length);
    await sleep(320); ctx.scan('CTR-CE0796-16');
    ok('간격 두면 다음 박스 정상', ctx.t.getBatch().length === 2);
    ctx.doc.querySelector('#sklist [data-bdel]').dispatchEvent(new ctx.w.Event('click', { bubbles: true }));
    ok('집계표 −1 보정', ctx.t.getBatch().length === 1);
    ctx.doc.getElementById('btnSlog').dispatchEvent(new ctx.w.Event('click', { bubbles: true }));
    const log = ctx.doc.getElementById('slogbox').textContent;
    ok('이력: 스캔·중복·보정 기록', /스캔/.test(log) && /중복 무시/.test(log) && /수동 −1/.test(log), log.slice(0, 140));
  }

  console.log('\n③ 팔렛 처리 — 자동 판별 · 라인 배정(소입수 우선) · 정산표 · 저장');
  {
    const ctx = await openCheck(mkShip());
    for (let i = 0; i < 20; i++) ctx.scan('CTR-CE0796-16');
    for (let i = 0; i < 3; i++) ctx.scan('CTR-CE0796-12');
    for (let i = 0; i < 2; i++) ctx.scan('CTR-CE0152-16');
    ok('25박스 누적', ctx.t.getBatch().length === 25);
    ctx.doc.getElementById('btnProc').dispatchEvent(new ctx.w.Event('click', { bubbles: true }));
    ok('팔렛 유일 → 즉시 정산표', !!ctx.doc.getElementById('btnReconSave'));
    ok('배정: ×16 라인 20 · ×12 라인 3 · CE0152 2', ctx.t.getCounts()[201] === 20 && ctx.t.getCounts()[202] === 3 && ctx.t.getCounts()[203] === 2,
      JSON.stringify(ctx.t.getCounts()));
    const body = ctx.doc.body.textContent;
    ok('정산표: 전부 일치 표시', /전부 일치/.test(body), body.match(/전부 일치|차이 있는 라인 \d+/));
    ok('정산표에 라인 구분(#1–20 ×16)', /#1–20/.test(body) && /×16/.test(body));
    ctx.w.__tones.length = 0;
    ctx.doc.getElementById('btnReconSave').dispatchEvent(new ctx.w.Event('click', { bubbles: true }));
    await sleep(40);
    const post = ctx.sent.filter(x => /\/check$/.test(x.url))[0];
    ok('저장: 라인별 증분 전송', post && post.body.items.length === 3
      && post.body.items.find(i => i.item_id === 201).scanned_delta === 20
      && post.body.items.find(i => i.item_id === 202).scanned_delta === 3, post && JSON.stringify(post.body));
    ok('저장음(3음 상승)', JSON.stringify(ctx.w.__tones.map(x => Math.round(x.f))) === JSON.stringify([784, 988, 1319]), ctx.w.__tones.map(x => x.f));
  }

  console.log('\n④ 모호 팔렛 — 후보 칩 선택 후 정산');
  {
    const SHIP = mkShip();
    SHIP.pallets = [0, 1].map((k) => ({
      id: 21 + k, pl_no: String(12 + k), order_no: '100RA25K2C', status: 'unloaded',
      cartons_expected: 5, qty_expected: 80, checked_at: null, working: false,
      items: [{ id: 301 + k, code: 'CE0796', name: 'T', cartons: 5, qty: 80, rack: 'B-01-01', scanned_cartons: 0, put_cartons: 0, zone: 2, zone_name: 'Z', zone_is_default: false }],
    }));
    const ctx = await openCheck(SHIP);
    for (let i = 0; i < 5; i++) ctx.scan('CTR-CE0796-16');
    ctx.doc.getElementById('btnProc').dispatchEvent(new ctx.w.Event('click', { bubbles: true }));
    ok('후보 2개 → 정산 대신 선택 안내', !ctx.doc.getElementById('btnReconSave'));
    ok('후보 칩 강조 2개', ctx.doc.querySelectorAll('#palpick .pchip.cand').length === 2);
    ctx.doc.querySelector('#palpick .pchip[data-lp="22"]').dispatchEvent(new ctx.w.Event('click', { bubbles: true }));
    ok('칩 선택 → 그 팔렛으로 정산표', !!ctx.doc.getElementById('btnReconSave') && ctx.t.getLock().id === 22,
      ctx.t.getLock() && ctx.t.getLock().id);
    ok('배정 반영(5카톤)', ctx.t.getCounts()[302] === 5, JSON.stringify(ctx.t.getCounts()));
  }

  console.log('\n⑤ 차이 있는 정산 — 부족·초과 + 확인 후 저장(초과분 미전송)');
  {
    const ctx = await openCheck(mkShip());
    for (let i = 0; i < 22; i++) ctx.scan('CTR-CE0796-16');   // ×16 라인(20) 소진 후 2박스는 ×12 라인으로 이월
    ctx.doc.getElementById('btnProc').dispatchEvent(new ctx.w.Event('click', { bubbles: true }));
    ok('이월 배정: 201=20, 202=2', ctx.t.getCounts()[201] === 20 && ctx.t.getCounts()[202] === 2, JSON.stringify(ctx.t.getCounts()));
    const body = ctx.doc.body.textContent;
    ok('차이 표시(부족 라인)', /차이 있는 라인/.test(body), body.match(/차이 있는 라인 \d+/));
    ctx.w.__confirmAnswer = false;
    ctx.doc.getElementById('btnReconSave').dispatchEvent(new ctx.w.Event('click', { bubbles: true }));
    await sleep(30);
    ok('확인 취소 → 전송 안 함', ctx.sent.filter(x => /\/check$/.test(x.url)).length === 0);
    ctx.w.__confirmAnswer = true;
    ctx.doc.getElementById('btnReconSave').dispatchEvent(new ctx.w.Event('click', { bubbles: true }));
    await sleep(30);
    const post = ctx.sent.filter(x => /\/check$/.test(x.url))[0];
    ok('확인 후 저장(부족 검수 허용)', post && post.body.items.length === 2, post && JSON.stringify(post.body.items));
  }
  {
    const SHIP = mkShip();
    SHIP.pallets[0].items = [{ id: 401, code: 'CE0796', name: 'T', cartons: 2, qty: 32, rack: 'B-01-01', scanned_cartons: 0, put_cartons: 0, zone: 2, zone_name: 'Z', zone_is_default: false }];
    SHIP.pallets[0].cartons_expected = 2; SHIP.pallets[0].qty_expected = 32;
    const ctx = await openCheck(SHIP);
    for (let i = 0; i < 4; i++) ctx.scan('CTR-CE0796-16');
    ctx.doc.getElementById('btnProc').dispatchEvent(new ctx.w.Event('click', { bubbles: true }));
    ok('초과 스캔 정산표에 표시', /초과 스캔/.test(ctx.doc.body.textContent));
    ctx.w.__confirmAnswer = true;
    ctx.doc.getElementById('btnReconSave').dispatchEvent(new ctx.w.Event('click', { bubbles: true }));
    await sleep(30);
    const post = ctx.sent.filter(x => /\/check$/.test(x.url))[0];
    ok('전송은 상한(2)까지만', post && post.body.items[0].scanned_delta === 2, post && JSON.stringify(post.body));
  }

  console.log('\n⑥ [← 계속 스캔] — 배치 유지 · 정산 중 스캔 잠금');
  {
    const ctx = await openCheck(mkShip());
    ctx.scan('CTR-CE0796-16'); ctx.scan('CTR-CE0796-16');
    ctx.doc.getElementById('btnProc').dispatchEvent(new ctx.w.Event('click', { bubbles: true }));
    ok('정산표 진입', !!ctx.doc.getElementById('btnReconSave'));
    ctx.t.doScan('CTR-CE0796-16');
    ok('정산 중 스캔 무시', ctx.t.getBatch().length === 2);
    ctx.doc.getElementById('btnReconBack').dispatchEvent(new ctx.w.Event('click', { bubbles: true }));
    ok('복귀 후 배치 유지(2박스)', ctx.t.getBatch().length === 2 && !!ctx.doc.getElementById('btnProc'));
    ctx.scan('CTR-CE0796-16');
    ok('복귀 후 이어서 스캔', ctx.t.getBatch().length === 3);
  }

  console.log('\n⑦ 적치 회귀 — 랙 잠금·1박스 1스캔 (일괄 모드 무영향)');
  {
    const SHIP = mkShip();
    SHIP.pallets[0].status = 'checked'; SHIP.pallets[0].checked_at = '2026-08-17T10:00:00Z';
    SHIP.pallets[0].items = [{ id: 501, code: 'CE0796', name: 'T', cartons: 2, qty: 32, rack: 'A-01-03', scanned_cartons: 2, put_cartons: 0, zone: 1, zone_name: 'Z1', zone_is_default: false }];
    SHIP.pallets[0].cartons_expected = 2; SHIP.pallets[0].qty_expected = 32;
    const ctx = await boot(SHIP);
    ctx.t.setTiming(0, 0);
    ctx.t.openShip(1); await sleep(40);
    ctx.t.setStep('put'); ctx.t.renderDetail();
    const putScanIn = (raw) => {
      const inp = ctx.doc.getElementById('putIn') || ctx.doc.getElementById('putListIn');
      inp.value = raw;
      inp.dispatchEvent(new ctx.w.Event('input', { bubbles: true }));
      inp.dispatchEvent(new ctx.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    };
    putScanIn(asScanner('CTR-CE0796-16'));
    ok('카톤 라벨로 팔렛 열림', !!ctx.doc.getElementById('putIn'));
    putScanIn(asScanner('A-01-03'));
    putScanIn('CTR-CE0796-16'); putScanIn('CTR-CE0796-16'); putScanIn('CTR-CE0796-16');
    const put = ctx.doc.body.textContent;
    ok('랙 잠금 + 2/2 적치 + 초과 차단', /A-01-03/.test(put) && /2\/2/.test(put), put.match(/\d\/\d/g));
  }

  console.log('\n⑧ 라인 재분할 링크 회귀');
  {
    const SHIP = mkShip();
    SHIP.pallets[0].items = [{ id: 601, code: 'CE0796', name: 'T', cartons: 23, qty: 356, rack: 'A-01-03', scanned_cartons: 0, put_cartons: 0 }];
    const ctx = await boot(SHIP);
    ctx.t.openShip(1); await sleep(60);
    ok('합산 선적 → needRelines true', ctx.t.needRelines() === true);
    ctx.t.reSplitSend([{ order_no: 'PO', pl_no: 1, code: 'CE0796', cartons: 20, qty: 320, box_from: 1, box_to: 20 }]);
    await sleep(30);
    ok('POST /relines 전송', ctx.sent.some(x => /\/relines$/.test(x.url)));
  }

  console.log('\n⑨ 입력칸 자동 처리 회귀 — Enter 없이 읽고 비움');
  {
    const ctx = await openCheck(mkShip());
    const inp = ctx.doc.getElementById('scanIn');
    ctx.scan('CTR-CE0796-16');
    ok('Enter 후 입력칸 비움', inp.value === '');
    inp.value = 'CTR-CE0796-16';
    inp.dispatchEvent(new ctx.w.Event('input', { bubbles: true }));
    await sleep(230);
    ok('Enter 없이 자동 누적 + 비움', ctx.t.getBatch().length === 2 && inp.value === '', inp.value);
  }

  console.log('\n' + (fail ? '❌' : '✅') + ` 결과: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 실행 오류:', e); process.exit(2); });
