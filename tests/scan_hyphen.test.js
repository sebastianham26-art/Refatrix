/* 수입입고 스캔 하이픈 보정 회귀 테스트
   운영 파일 refatrix-inbound.html 의 인라인 스크립트를 그대로 추출해 jsdom 에서 실행한다.
   시나리오: 스페인어 자판 PC 에서 Code-128 라벨의 `-` 가 `'` 로 들어오는 상황. */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const FILE = '/tmp/Refatrix/refatrix-inbound.html';
const html = fs.readFileSync(FILE, 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
};

/* ---------- 선적 픽스처: 하이픈 포함 SKU + 하이픈 포함 랙 ---------- */
const SHIP = {
  shipment: { id: 1, invoice_no: 'D26-81319563', status: 'open', order_no: 'PO-2026-01' },
  pallets: [{
    id: 11, pl_no: 'PLT-1', order_no: 'PO-2026-01', status: 'unloaded',
    cartons_expected: 4, qty_expected: 400, checked_at: null,
    working: false, working_by: null, working_step: null,
    items: [
      { id: 101, code: 'CQ0271L-02', name: 'Horquilla', cartons: 2, qty: 200, rack: 'A-01-03', scanned_cartons: 0, put_cartons: 0 },
      { id: 102, code: 'CB0318',     name: 'Rotula',    cartons: 2, qty: 200, rack: 'B-02-01', scanned_cartons: 0, put_cartons: 0 }
    ]
  }],
  files: []
};

async function boot() {
  const dom = new JSDOM(html.replace(/<script src="refatrix-nav\.js[^"]*"><\/script>/, ''), {
    runScripts: 'outside-only', url: 'https://x.test/refatrix-inbound.html', pretendToBeVisual: true
  });
  const w = dom.window;
  w.sessionStorage.setItem('refatrix_session', JSON.stringify({
    token: 't', api: 'https://api.test', user: { id: 9, name: 'Maria', role: 'warehouse' }
  }));
  w.localStorage.setItem('wh_lang', 'ko');
  w.fetch = (url, opt) => {
    const u = String(url);
    let body = {};
    if (/\/api\/inbound\/1(\?|$)/.test(u)) body = SHIP;
    else if (/\/api\/inbound(\?|$)/.test(u)) body = { shipments: [SHIP.shipment] };
    else if (/working/.test(u)) body = { ok: true };
    else if (/check|putaway/.test(u)) body = { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const script = html.match(/<script>\s*\(function\(\)\{[\s\S]*?<\/script>/g).pop()
    .replace(/^<script>/, '').replace(/<\/script>$/, '');
  // 내부 함수를 테스트에서 집어보기 위해 노출 훅을 덧붙인다(운영 코드 무변경)
  w.eval(script.replace(/\}\)\(\);\s*$/,
    'window.__t={normScan:normScan,bare:bare,bareEq:bareEq,findItem:findItem,parseLabel:parseLabel,'
    + 'doScan:doScan,putScan:putScan,openShip:openShip,setStep:function(s){STEP=s;},setTiming:function(d,g){DUP_MS=d;GRACE_MS=g;},'
    + 'getDetail:function(){return DETAIL;},setDetail:function(d){DETAIL=d;},'
    + 'getPutAdd:function(){return putAdd;},setPutPal:function(i){putPal=i;},setPutRack:function(r){putRack=r;}};\n})();'));
  await new Promise(r => setTimeout(r, 60));
  return { w, t: w.__t };
}

(async () => {
  const { w, t } = await boot();
  t.setTiming(0,0);

  console.log('\n① normScan — 자판 변종 따옴표를 모두 하이픈으로');
  ok("' (U+0027) → -", t.normScan("A'01'03") === 'A-01-03', t.normScan("A'01'03"));
  ok("’ (U+2019) → -", t.normScan('A’01’03') === 'A-01-03', t.normScan('A’01’03'));
  ok("‘ (U+2018) → -", t.normScan('A‘01') === 'A-01');
  ok("´ (U+00B4) → -", t.normScan('A´01') === 'A-01');
  ok('` (U+0060) → -', t.normScan('A`01') === 'A-01');
  ok('소문자 → 대문자', t.normScan("cq0271l'02") === 'CQ0271L-02');
  ok('CR/LF 접미사 제거', t.normScan("A'01\r\n") === 'A-01');
  ok('앞뒤/내부 공백 제거', t.normScan("  A' 01 ") === 'A-01');
  ok('빈 입력 안전', t.normScan(null) === '' && t.normScan(undefined) === '');
  ok('하이픈 없는 코드 무영향', t.normScan('CB0318') === 'CB0318');

  console.log('\n② bare / findItem — 구분자 자체를 무시하는 폴백');
  ok('bare 구분자 제거', t.bare('A-01/03') === 'A0103');
  ok('bareEq 하이픈↔슬래시', t.bareEq('A-01-03', 'A/01/03') === true);
  ok('bareEq 빈값 false', t.bareEq('', 'A-01') === false);
  const items = SHIP.pallets[0].items;
  ok('findItem 정확 일치', t.findItem(items, 'CQ0271L-02') === items[0]);
  ok('findItem 구분자 무시', t.findItem(items, 'CQ0271L02') === items[0]);
  ok('findItem 미등록은 null', t.findItem(items, 'XX9999') === null);

  console.log('\n③ parseLabel — 코드 표준화 (전체 흐름은 scan_label.test.js 에서 검증)');
  t.setDetail(SHIP);
  ok('구분자 달라도 표준 코드로', t.parseLabel('CQ0271L02').code === 'CQ0271L-02', t.parseLabel('CQ0271L02').code);
  ok('정확 일치 우선', t.parseLabel('CB0318').code === 'CB0318');
  ok('미등록은 그대로 반환', t.parseLabel('ZZ-999').code === 'ZZ-999');

  console.log('\n④ 적치 — 랙 라벨도 자판 보정 후 일치');
  ok("랙 A'01'03 == A-01-03", t.bareEq(t.normScan("A'01'03"), 'A-01-03') === true);
  ok("다른 랙은 여전히 불일치", t.bareEq(t.normScan("B'02'01"), 'A-01-03') === false);

  console.log('\n⑤ 미등록 코드는 여전히 걸러진다(과보정 방지)');
  ok('미등록 코드는 자판 보정만 적용', t.parseLabel("ZZ'999").code === 'ZZ-999' && t.parseLabel("ZZ'999").matched === false);
  ok('미등록 코드 findItem null', t.findItem(items, 'ZZ-999') === null);

  console.log('\n' + (fail ? '❌' : '✅') + ` 결과: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 실행 오류:', e); process.exit(2); });
