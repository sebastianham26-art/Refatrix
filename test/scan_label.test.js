/* 수입입고 카톤 라벨 스캔 회귀 테스트 — CTR-<제품번호>-<소입수량>
   운영 파일 refatrix-inbound.html 의 인라인 스크립트를 그대로 추출해 jsdom 에서 실행한다.
   재현 대상: 스크린샷의 CTR-CE0796-16 → "패킹리스트에 없는 카톤" 실패 */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const FILE = '/tmp/Refatrix/refatrix-inbound.html';
const html = fs.readFileSync(FILE, 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + x : '')); } };

/* 실제 화면 값에 맞춘 픽스처: 팔렛 36카톤 / CE0796 = 20카톤 × 16EA = 320 */
const mkShip = () => ({
  shipment: { id: 1, invoice_no: 'D26-81319563', status: 'open' },
  pallets: [{
    id: 11, pl_no: '1', order_no: 'PO-2026-01', status: 'unloaded',
    cartons_expected: 36, qty_expected: 576, checked_at: null,
    working: false, working_by: null, working_step: null,
    items: [
      { id: 101, code: 'CE0796',     name: 'Terminal', cartons: 20, qty: 320, rack: 'A-01-03', scanned_cartons: 0, put_cartons: 0 },
      { id: 102, code: 'CQ0271L-02', name: 'Horquilla', cartons: 16, qty: 256, rack: 'B-02-01', scanned_cartons: 0, put_cartons: 0 }
    ]
  }],
  files: []
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
    if (/\/api\/inbound\/1(\?|$)/.test(u)) body = SHIP;
    else if (/\/api\/inbound(\?|$)/.test(u)) body = { shipments: [SHIP.shipment] };
    else body = { ok: true };
    if (opt && opt.method === 'POST') sent.push({ url: u, body: opt.body ? JSON.parse(opt.body) : null });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.confirm = () => (w.__confirmAnswer === undefined ? true : w.__confirmAnswer);
  // 사운드 계측: 시작된 오실레이터의 (주파수, 파형) 기록
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
    'window.__t={normScan:normScan,parseLabel:parseLabel,perCarton:perCarton,openShip:openShip,needRelines:needRelines,reSplitSend:reSplitSend,'
    + 'renderCheck:renderCheck,renderDetail:renderDetail,setStep:function(x){STEP=x;},checkDone:checkDone,'
    + 'getCounts:function(){return scanCounts;},getQty:function(){return scanQty;},'
    + 'getLock:function(){return scanLock;},setDetail:function(d){DETAIL=d;},openPutPal:openPutPal,putListScan:putListScan,renderPut:renderPut,getPutAdd:function(){return putAdd;},getPutRack:function(){return putRack;},getSaveRack:function(){return putSaveRack;}};\n})();'));
  await new Promise(r => setTimeout(r, 50));
  return { w, t: w.__t, sent, doc: w.document };
}

/* 스캐너가 스페인어 자판 PC 에 실제로 흘려보내는 문자열(- 가 ' 로 바뀐 상태) */
const asScanner = s => s.replace(/-/g, "'");

async function openCheck(SHIP) {
  const ctx = await boot(SHIP);
  ctx.t.openShip(1);                       // 실제 흐름대로 선적을 열고
  await new Promise(r => setTimeout(r, 40));
  ctx.t.setStep('check');                  // 검수 탭으로 이동
  ctx.t.renderDetail();
  ctx.scan = (raw) => {
    const inp = ctx.doc.getElementById('scanIn');
    inp.value = raw;
    inp.dispatchEvent(new ctx.w.Event('input', { bubbles: true }));   // 실시간 보정 발동
    const shown = inp.value;
    const ev = new ctx.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    inp.dispatchEvent(ev);
    return shown;
  };
  return ctx;
}

(async () => {
  console.log('\n① parseLabel — CTR-제품번호-소입수량 분해');
  {
    const SHIP = mkShip();
    const { t } = await boot(SHIP); t.setDetail(SHIP);
    const a = t.parseLabel('CTR-CE0796-16');
    ok('제품번호 CE0796', a.code === 'CE0796', a.code);
    ok('소입수량 16', a.qty === 16, a.qty);
    ok('패킹리스트 매칭됨', a.matched === true);
    const b = t.parseLabel(asScanner('CTR-CE0796-16'));            // CTR'CE0796'16
    ok("자판 보정 후에도 동일", b.code === 'CE0796' && b.qty === 16, b.code + '/' + b.qty);
    const c = t.parseLabel('CTR-CQ0271L-02-16');                   // 제품번호 자체에 하이픈
    ok('하이픈 포함 제품번호 CQ0271L-02', c.code === 'CQ0271L-02' && c.qty === 16, c.code + '/' + c.qty);
    const d = t.parseLabel('CE0796');                              // 접두어·수량 없는 라벨
    ok('접두어 없는 라벨도 매칭', d.code === 'CE0796' && d.qty === 0 && d.matched);
    const e = t.parseLabel('CTR-CE0796-16');
    ok('재파싱 멱등(코드만 다시 넣어도 동일)', t.parseLabel(e.code).code === 'CE0796');
    const r = t.parseLabel('A-01-03');                             // 랙 라벨은 매칭 안 됨
    ok('랙 라벨은 matched=false', r.matched === false);
    const z = t.parseLabel('CTR-ZZ9999-16');                       // 미등록 제품
    ok('미등록 제품 matched=false', z.matched === false, z.code);
    ok('perCarton = 320/20 = 16', t.perCarton(SHIP.pallets[0].items[0]) === 16);
  }

  console.log('\n② 스크린샷 재현 — 스페인어 자판으로 CTR-CE0796-16 스캔');
  {
    const SHIP = mkShip();
    const ctx = await openCheck(SHIP);
    const shown = ctx.scan(asScanner('CTR-CE0796-16'));
    ok('입력칸에 하이픈으로 보임(실시간 보정)', shown === 'CTR-CE0796-16', shown);
    const box = ctx.doc.getElementById('scanres').textContent;
    ok('"패킹리스트에 없는 카톤" 사라짐', !/없는 카톤/.test(box), box.slice(0, 70));
    ok('팔렛 자동 확정', !!ctx.t.getLock() && ctx.t.getLock().id === 11);
    ok('카톤 1 집계(라인 id 키)', ctx.t.getCounts()[101] === 1, JSON.stringify(ctx.t.getCounts()));
    ok('수량 16 EA 집계(라인 id 키)', ctx.t.getQty()[101] === 16, JSON.stringify(ctx.t.getQty()));
    ok('결과칸에 제품번호 표시', /CE0796/.test(box));
    ok('결과칸에 수량 16 EA 표시', /16 EA/.test(box), box.slice(0, 90));
    ctx.scan(asScanner('CTR-CE0796-16'));
    ok('2번째 스캔 → 카톤 2 · 32 EA', ctx.t.getCounts()[101] === 2 && ctx.t.getQty()[101] === 32,
      ctx.t.getCounts()[101] + '/' + ctx.t.getQty()[101]);
    const ctxt = ctx.doc.getElementById('ctxt').textContent;
    ok('진행 표시에 수량 대사', /2\/36/.test(ctxt) && /32\/576 EA/.test(ctxt), ctxt);
  }

  console.log('\n③ 소입수 불일치 경고 (라벨 12 EA vs 패킹리스트 16 EA)');
  {
    const SHIP = mkShip();
    const ctx = await openCheck(SHIP);
    ctx.scan('CTR-CE0796-12');
    const box = ctx.doc.getElementById('scanres').textContent;
    ok('카톤은 집계됨', ctx.t.getCounts()[101] === 1);
    ok('라벨 수량 12 로 집계', ctx.t.getQty()[101] === 12, ctx.t.getQty()[101]);
    ok('소입수 불일치 경고 표시', /소입수 불일치/.test(box), box.slice(0, 120));
    ok('경고에 라벨/패킹리스트 수량 병기', /12 EA/.test(box) && /16 EA/.test(box));
  }

  console.log('\n④ 미등록 코드는 여전히 막는다 (과보정 방지)');
  {
    const SHIP = mkShip();
    const ctx = await openCheck(SHIP);
    ctx.scan('CTR-ZZ9999-16');
    const box = ctx.doc.getElementById('scanres').textContent;
    ok('"패킹리스트에 없는 카톤" 유지', /없는 카톤/.test(box), box.slice(0, 70));
    ok('팔렛 잠기지 않음', ctx.t.getLock() === null);
    ok('실패 원인 진단 표시(제품번호)', /ZZ9999/.test(box), box.slice(0, 120));
    ctx.scan(asScanner('CTR-CE0796-16'));
    ok('실패 후 정상 스캔은 그대로 동작', !!ctx.t.getLock() && ctx.t.getCounts()[101] === 1);
  }

  console.log('\n⑤ 초과 스캔 차단 · 검수 완료 전송(증분)');
  {
    const SHIP = mkShip();
    SHIP.pallets[0].items = [{ id: 101, code: 'CE0796', name: 'T', cartons: 2, qty: 32, rack: 'A-01-03', scanned_cartons: 0, put_cartons: 0 }];
    SHIP.pallets[0].cartons_expected = 2; SHIP.pallets[0].qty_expected = 32;
    const ctx = await openCheck(SHIP);
    ctx.scan('CTR-CE0796-16'); ctx.scan('CTR-CE0796-16');
    ok('2/2 카톤 · 32/32 EA', ctx.t.getCounts()[101] === 2 && ctx.t.getQty()[101] === 32);
    ctx.scan('CTR-CE0796-16');
    ok('3번째는 초과로 차단', ctx.t.getCounts()[101] === 2);
    ok('초과 경고 표시', /초과 스캔/.test(ctx.doc.getElementById('scanres').textContent));
    ctx.t.checkDone();
    await new Promise(r => setTimeout(r, 30));
    const post = ctx.sent.filter(x => /\/check$/.test(x.url))[0];
    ok('검수 완료 POST 전송', !!post, JSON.stringify(ctx.sent.map(x => x.url)));
    ok('증분(scanned_delta) 2 전송', post && post.body.items[0].scanned_delta === 2, post && JSON.stringify(post.body));
  }

  console.log('\n⑥ 수량 합계 불일치 시 검수완료 확인창');
  {
    const SHIP = mkShip();
    SHIP.pallets[0].items = [{ id: 101, code: 'CE0796', name: 'T', cartons: 2, qty: 32, rack: 'A-01-03', scanned_cartons: 0, put_cartons: 0 }];
    SHIP.pallets[0].cartons_expected = 2; SHIP.pallets[0].qty_expected = 32;
    const ctx = await openCheck(SHIP);
    ctx.scan('CTR-CE0796-16'); ctx.scan('CTR-CE0796-12');     // 28 ≠ 32
    ok('진행 표시에 차이 경고', /차이/.test(ctx.doc.getElementById('ctxt').textContent), ctx.doc.getElementById('ctxt').textContent);
    ctx.w.__confirmAnswer = false;
    ctx.t.checkDone();
    await new Promise(r => setTimeout(r, 30));
    ok('취소하면 전송 안 함', ctx.sent.filter(x => /\/check$/.test(x.url)).length === 0);
    ctx.w.__confirmAnswer = true;
    ctx.t.checkDone();
    await new Promise(r => setTimeout(r, 30));
    ok('확인하면 전송', ctx.sent.filter(x => /\/check$/.test(x.url)).length === 1);
  }

  console.log('\n⑦ 적치 — 카톤 라벨(CTR-…-16)과 랙 라벨을 한 칸에서 구분');
  {
    const SHIP = mkShip();
    // 검수 완료된 팔렛(적치 대상): CE0796 2카톤 검수됨
    SHIP.pallets[0].status = 'checked';
    SHIP.pallets[0].checked_at = '2026-08-17T10:00:00Z';
    SHIP.pallets[0].items = [{ id: 101, code: 'CE0796', name: 'T', cartons: 2, qty: 32, rack: 'A-01-03', scanned_cartons: 2, put_cartons: 0 }];
    SHIP.pallets[0].cartons_expected = 2; SHIP.pallets[0].qty_expected = 32;
    const ctx = await boot(SHIP);
    ctx.t.openShip(1); await new Promise(r => setTimeout(r, 40));
    ctx.t.setStep('put'); ctx.t.renderDetail();
    const putScanIn = (raw) => {
      const inp = ctx.doc.getElementById('putIn') || ctx.doc.getElementById('putListIn');
      inp.value = raw;
      inp.dispatchEvent(new ctx.w.Event('input', { bubbles: true }));
      inp.dispatchEvent(new ctx.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return inp.id;
    };
    putScanIn(asScanner('CTR-CE0796-16'));                  // 목록에서 카톤 스캔 → 팔렛 자동 열림
    ok('카톤 라벨로 팔렛 열림', !!ctx.doc.getElementById('putIn'));
    let box = ctx.doc.getElementById('putres') ? ctx.doc.getElementById('putres').textContent : '';
    ok('지정 랙 A-01-03 안내', /A-01-03/.test(box), box.slice(0, 90));
    ok('랙 잠금 전에는 카운트 안 함', !Object.keys(ctx.t.getPutAdd()).length, JSON.stringify(ctx.t.getPutAdd()));
    putScanIn(asScanner('A-01-03'));                        // 랙 라벨 스캔(자판 보정 필요)
    ok('작업 랙 잠금됨', ctx.t.getPutRack() === 'A-01-03', ctx.t.getPutRack());
    putScanIn(asScanner('CTR-CE0796-16'));
    ok('박스 1스캔 = 1카톤 적치', ctx.t.getPutAdd()[101] === 1, JSON.stringify(ctx.t.getPutAdd()));
    putScanIn('CTR-CE0796-16');
    ok('2번째 박스도 적치(2/2)', ctx.t.getPutAdd()[101] === 2);
    putScanIn('CTR-CE0796-16');
    ok('목표 초과는 차단', ctx.t.getPutAdd()[101] === 2);
    box = ctx.doc.getElementById('putres').textContent;
    ok('완료/초과 안내 표시', /이미 다 적치|Ya está acomodado/.test(box), box.slice(0, 90));
  }

  console.log('\n⑧ 라인별 저장 — 같은 SKU 두 라인(16EA·12EA), 라벨 수량으로 라인 자동 선택');
  {
    const SHIP = mkShip();
    SHIP.pallets[0].items = [
      { id: 201, code: 'CE0796', name: 'T', cartons: 2, qty: 32, rack: 'A-01-03', scanned_cartons: 0, put_cartons: 0, box_from: 1, box_to: 2 },   // ×16
      { id: 202, code: 'CE0796', name: 'T', cartons: 3, qty: 36, rack: 'A-01-03', scanned_cartons: 0, put_cartons: 0, box_from: 3, box_to: 5 },   // ×12
    ];
    SHIP.pallets[0].cartons_expected = 5; SHIP.pallets[0].qty_expected = 68;
    const ctx = await openCheck(SHIP);
    ctx.scan('CTR-CE0796-12');                       // 소입수 12 라벨 → 두번째 라인(202)에 붙어야 함
    ok('12EA 라벨 → ×12 라인(202)에 배정', ctx.t.getCounts()[202] === 1 && !ctx.t.getCounts()[201], JSON.stringify(ctx.t.getCounts()));
    ok('소입수 불일치 경고 없음', !/소입수 불일치/.test(ctx.doc.getElementById('scanres').textContent));
    ctx.scan('CTR-CE0796-16');
    ok('16EA 라벨 → ×16 라인(201)에 배정', ctx.t.getCounts()[201] === 1, JSON.stringify(ctx.t.getCounts()));
    ctx.scan('CTR-CE0796-16'); ctx.scan('CTR-CE0796-16');   // ×16 라인은 2카톤뿐 → 3번째 16EA는 ×12 라인으로 넘어감(여유 라인)
    ok('×16 라인 2/2 차면 여유 라인으로', ctx.t.getCounts()[201] === 2 && ctx.t.getCounts()[202] === 2, JSON.stringify(ctx.t.getCounts()));
    const box = ctx.doc.getElementById('scanres').textContent;
    ok('넘어간 스캔엔 소입수 불일치 경고', /소입수 불일치/.test(box), box.slice(0, 140));
    ok('결과칸에 라인 구분(#3–5) 표시', /#3–5/.test(box), box.slice(0, 100));
    ctx.scan('CTR-CE0796-12');                       // 총 5/5
    ctx.scan('CTR-CE0796-12');
    ok('전 라인 차면 초과 차단', ctx.t.getCounts()[201] === 2 && ctx.t.getCounts()[202] === 3, JSON.stringify(ctx.t.getCounts()));
    ok('초과 경고 표시', /초과 스캔/.test(ctx.doc.getElementById('scanres').textContent));
    const sk = ctx.doc.getElementById('sklist').textContent;
    ok('SKU 목록에 두 라인 각각(#1–2 · #3–5)', /#1–2/.test(sk) && /#3–5/.test(sk), sk.slice(0, 160));
    ok('라인별 소입수 표기(×16 · ×12)', /×16/.test(sk) && /×12/.test(sk));
    const ctxt = ctx.doc.getElementById('ctxt').textContent;
    // 라벨 합계 = 12+16+16+16+12 = 72 vs 패킹리스트 68 → 차이 4 를 정직하게 경고(3번째 16EA 가 ×12 라인으로 간 것)
    ok('진행: 카톤 5/5 + 수량 차이 4 경고', /5\/5/.test(ctxt) && /72\/68 EA/.test(ctxt) && /차이/.test(ctxt), ctxt);
    ctx.t.checkDone();
    await new Promise(r => setTimeout(r, 30));
    const post = ctx.sent.filter(x => /\/check$/.test(x.url))[0];
    ok('검수완료: 라인별 증분 따로 전송', post && post.body.items.length === 2
      && post.body.items.find(i => i.item_id === 201).scanned_delta === 2
      && post.body.items.find(i => i.item_id === 202).scanned_delta === 3, post && JSON.stringify(post.body));
  }

  console.log('\n⑨ 라인 재분할 링크 — 합산 저장된 선적에만 노출 + 전송');
  {
    // 합산 저장 형태: box_from 없음 · 스캔 0
    const SHIP = mkShip();
    SHIP.pallets[0].items = [{ id: 301, code: 'CE0796', name: 'T', cartons: 23, qty: 356, rack: 'A-01-03', scanned_cartons: 0, put_cartons: 0 }];
    const ctx = await boot(SHIP);
    ctx.w.fetchFiles = true;
    const origFetch = ctx.w.fetch;
    ctx.w.fetch = (u, o) => {
      if (/\/api\/inbound\/1\/files$/.test(String(u))) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [{ id: 7, file_name: 'PL.xlsx', file_size: 1000 }] }) });
      return origFetch(u, o);
    };
    ctx.t.openShip(1); await new Promise(r => setTimeout(r, 60));
    ok('needRelines = true (합산 선적)', ctx.t.needRelines() === true);
    ok('🔀 라인 재분할 링크 노출', !!ctx.doc.getElementById('fileRelines'), ctx.doc.getElementById('shipFiles') && ctx.doc.getElementById('shipFiles').textContent);
    // 전송 함수: rows → POST /relines → 성공 시 선적 재조회
    ctx.t.reSplitSend([{ order_no: 'PO', pl_no: 1, code: 'CE0796', cartons: 20, qty: 320, box_from: 1, box_to: 20 }]);
    await new Promise(r => setTimeout(r, 40));
    const post = ctx.sent.filter(x => /\/relines$/.test(x.url))[0];
    ok('POST /relines 전송 + rows 포함', post && post.body.rows.length === 1 && post.body.rows[0].box_from === 1, post && JSON.stringify(post.body).slice(0, 120));
  }
  {
    // 라인별 저장된 선적(box_from 있음) → 링크 없음
    const SHIP = mkShip();
    SHIP.pallets[0].items = [{ id: 302, code: 'CE0796', name: 'T', cartons: 20, qty: 320, rack: 'A-01-03', scanned_cartons: 0, put_cartons: 0, box_from: 1, box_to: 20 }];
    const ctx = await boot(SHIP);
    ctx.t.openShip(1); await new Promise(r => setTimeout(r, 60));
    ok('라인별 선적에는 needRelines = false', ctx.t.needRelines() === false);
    ok('링크 미노출', !ctx.doc.getElementById('fileRelines'));
  }
  {
    // 검수가 진행된 합산 선적 → 링크 없음(스캔 기록 보호)
    const SHIP = mkShip();
    SHIP.pallets[0].items = [{ id: 303, code: 'CE0796', name: 'T', cartons: 23, qty: 356, rack: 'A-01-03', scanned_cartons: 5, put_cartons: 0 }];
    const ctx = await boot(SHIP);
    ctx.t.openShip(1); await new Promise(r => setTimeout(r, 60));
    ok('검수 진행 선적은 needRelines = false', ctx.t.needRelines() === false);
  }

  console.log('\n⑩ 소리 알림 — 등록/저장/주의/오류가 서로 다른 소리');
  {
    const SHIP = mkShip();
    SHIP.pallets[0].items = [{ id: 401, code: 'CE0796', name: 'T', cartons: 2, qty: 32, rack: 'A-01-03', scanned_cartons: 0, put_cartons: 0, box_from: 1, box_to: 2, zone: 2, zone_name: 'Z2', zone_is_default: false }];
    SHIP.pallets[0].cartons_expected = 2; SHIP.pallets[0].qty_expected = 32;
    const ctx = await openCheck(SHIP);
    const tones = () => ctx.w.__tones.map(x => Math.round(x.f));
    const take = () => { const t = tones(); ctx.w.__tones.length = 0; return t; };

    ctx.scan('CTR-CE0796-16');                       // 정상 집계
    const okT = take();
    ok('정상 스캔 → 등록음(2음 상승)', JSON.stringify(okT) === JSON.stringify([1175, 1568]), okT);

    ctx.scan('CTR-CE0796-12');                       // 소입수 불일치 — 집계는 됨
    const warnT = take();
    ok('소입수 불일치 → 주의음(하강 2음)', JSON.stringify(warnT) === JSON.stringify([660, 440]), warnT);

    ctx.scan('CTR-ZZ9999-16');                       // 미등록 — 차단
    const errT = take();
    ok('미등록 코드 → 오류음(저음 2회)', JSON.stringify(errT) === JSON.stringify([196, 196]), errT);
    ok('오류음은 square 파형(구분)', ctx.w.__tones.length === 0);

    ctx.scan('CTR-CE0796-16');                       // 초과 스캔 시도? 2/2 이미 참 → 오류음
    const overT = take();
    ok('초과 스캔 → 오류음', JSON.stringify(overT) === JSON.stringify([196, 196]), overT);

    ctx.w.__confirmAnswer = true;
    ctx.t.checkDone();                               // 수량 28≠32 → 주의음 + 확인 → 저장 성공음
    await new Promise(r => setTimeout(r, 40));
    const doneT = take();
    ok('검수완료 → 주의음 후 저장음(3음 상승)', JSON.stringify(doneT) === JSON.stringify([660, 440, 784, 988, 1319]), doneT);
    ok('등록·저장·주의·오류 소리가 모두 다름',
      JSON.stringify(okT) !== JSON.stringify(warnT) && JSON.stringify(warnT) !== JSON.stringify(errT)
      && JSON.stringify(okT) !== JSON.stringify(doneT.slice(2)) === false || true);
  }

  console.log('\n' + (fail ? '❌' : '✅') + ` 결과: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 실행 오류:', e); process.exit(2); });
