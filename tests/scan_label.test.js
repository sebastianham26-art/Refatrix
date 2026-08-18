/* 수입입고 검수 개편(2026-08-17m) 회귀 테스트 — "스캔은 기록, 판정은 보고서"
   운영 파일 refatrix-inbound.html 의 인라인 스크립트를 그대로 jsdom 에서 실행한다.
   흐름: 팔렛 선택 → 스캔 즉시 서버 기록(차단 없음) → [대조](dry) → [입고 확정].
   가짜 서버가 inbound_scans 의 tally 의미(코드·소입수별 집계, 최근 1건 취소)를 재현한다. */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const FILE = '/tmp/Refatrix/refatrix-inbound.html';
const html = fs.readFileSync(FILE, 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- 선적 픽스처 — 26B2C 실제 패턴(같은 SKU 소입수 다른 두 라인) ---------- */
function fixture() {
  return {
    shipment: { id: 1, invoice_no: 'D26-81319563', status: 'receiving', order_no: '26B2C' },
    pallets: [
      { id: 11, pl_no: 4, order_no: '26B2C', status: 'unloaded', cartons_expected: 23, qty_expected: 388,
        checked_at: null, working: false, working_by: null, working_step: null, scans: [],
        items: [
          { id: 101, code: 'CE0796', name: 'TERMINAL', cartons: 20, qty: 320, scanned_cartons: 0, put_cartons: 0, rack: 'A-01-03', zone: 1, zone_name: 'Zona 1', registered: true },
          { id: 102, code: 'CE0796', name: 'TERMINAL', cartons: 3,  qty: 36,  scanned_cartons: 0, put_cartons: 0, rack: 'A-01-03', zone: 1, zone_name: 'Zona 1', registered: true },
        ] },
      { id: 12, pl_no: 5, order_no: '26B2C', status: 'unloaded', cartons_expected: 2, qty_expected: 32,
        checked_at: null, working: false, working_by: null, working_step: null, scans: [],
        items: [
          { id: 201, code: 'CB0318', name: 'ROTULA', cartons: 2, qty: 32, scanned_cartons: 0, put_cartons: 0, rack: 'B-02-01', zone: 2, zone_name: 'Zona 2', registered: true },
        ] },
    ],
    files: [],
  };
}

/* ---------- 가짜 서버 — inbound_scans 의미 재현 ---------- */
function makeServer(SHIP) {
  const srv = { scans: [], calls: [], failScan: false, lostResponse: false, seenKeys: new Set() };
  srv.tally = (pid) => {
    const t = {}, order = [];
    srv.scans.filter(e => e.pid === pid).forEach(e => {
      const k = e.code + '|' + (e.qty || 0);
      if (!t[k]) { t[k] = { code: e.code, qty: e.qty || 0, n: 0 }; order.push(k); }
      t[k].n++;
    });
    return order.map(k => t[k]);
  };
  srv.fetch = (url, opt) => {
    const u = String(url);
    const body = (opt && opt.body) ? JSON.parse(opt.body) : {};
    srv.calls.push({ u, body, method: (opt && opt.method) || 'GET' });
    let res = {};
    let m;
    if ((m = u.match(/\/pallets\/(\d+)\/scan$/))) {
      if (srv.throwNet) return Promise.reject(new Error('network down'));
      if (srv.failScan) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
      const pid = +m[1];
      // 0175 멱등: 같은 client_key(k)는 다시 와도 기록하지 않는다
      (body.scans || []).forEach(s => {
        if (s.k && srv.seenKeys.has(s.k)) return;
        if (s.k) srv.seenKeys.add(s.k);
        srv.scans.push({ pid, code: s.code, qty: s.qty == null ? 0 : s.qty, matched: s.matched, k: s.k });
      });
      if (body.undo_code && !(body.undo_k && srv.seenKeys.has(body.undo_k))) {
        if (body.undo_k) srv.seenKeys.add(body.undo_k);
        for (let i = srv.scans.length - 1; i >= 0; i--) {
          const e = srv.scans[i];
          if (e.pid === pid && e.code === body.undo_code && (e.qty || 0) === (body.undo_qty || 0)) { srv.scans.splice(i, 1); break; }
        }
      }
      // 저장은 됐는데 응답이 유실되는 현장 상황 재현
      if (srv.lostResponse) return Promise.resolve({ ok: false, status: 0, json: () => Promise.resolve({}) });
      res = { ok: true, tally: srv.tally(pid) };
    } else if ((m = u.match(/\/pallets\/(\d+)\/confirm$/))) {
      const pid = +m[1];
      const pal = SHIP.pallets.filter(p => p.id === pid)[0];
      const cnt = {}; srv.scans.filter(e => e.pid === pid).forEach(e => { cnt[e.code] = (cnt[e.code] || 0) + 1; });
      // 간단 배정(테스트용): 파일 순서로 채우고 넘치면 마지막 라인에 — 서버 allocScans 규칙은 백엔드 테스트가 검증
      const lines = pal.items.map(it => ({ id: it.id, code: it.code, cartons: it.cartons, qty: it.qty, scanned: 0, diff: -it.cartons }));
      Object.keys(cnt).forEach(c => {
        let left = cnt[c]; const ls = lines.filter(l => l.code === c);
        ls.forEach((l, i) => { const take = (i === ls.length - 1) ? left : Math.min(left, l.cartons); l.scanned += take; left -= take; });
      });
      lines.forEach(l => { l.diff = l.scanned - l.cartons; });
      const unknown = {}; Object.keys(cnt).forEach(c => { if (!pal.items.some(it => it.code === c)) unknown[c] = cnt[c]; });
      const known = srv.scans.filter(e => e.pid === pid && pal.items.some(it => it.code === e.code)).length;
      res = { ok: true, dry: !!body.dry, lines, extras: {}, unknown,
        total_expected: pal.items.reduce((a, i) => a + i.cartons, 0), total_scanned: known };
      if (!body.dry) { pal.status = 'checked'; pal.checked_at = new Date().toISOString(); }
    } else if (/reset-check$/.test(u)) {
      res = { ok: true, reset: [{ pallet: '26B2C/4', scans_voided: srv.scans.length }] };
      srv.scans.length = 0;
    } else if (/working/.test(u)) res = { ok: true };
    else if (/\/files(\?|$)/.test(u)) res = { items: [] };
    else if (/\/api\/inbound\/1(\?|$)/.test(u)) { SHIP.pallets.forEach(p => { p.scans = srv.tally(p.id); }); res = SHIP; }
    else if (/\/api\/inbound(\?|$)/.test(u)) res = { items: [SHIP.shipment] };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(res) });
  };
  return srv;
}

async function boot(role) {
  const SHIP = fixture();
  const srv = makeServer(SHIP);
  const dom = new JSDOM(html.replace(/<script src="refatrix-nav\.js[^"]*"><\/script>/, ''), {
    runScripts: 'outside-only', url: 'https://x.test/refatrix-inbound.html', pretendToBeVisual: true
  });
  const w = dom.window;
  w.sessionStorage.setItem('refatrix_session', JSON.stringify({
    token: 't', api: 'https://api.test', user: { id: 9, name: 'Seb', role: role || 'warehouse' }
  }));
  w.localStorage.setItem('wh_lang', 'ko');
  w.fetch = srv.fetch;
  w.confirm = () => true;
  w.__tones = [];
  w.AudioContext = function () {
    this.currentTime = 0; this.state = 'running'; this.destination = {};
    this.createOscillator = function () {
      const o = { type: 'sine', frequency: { value: 0 }, connect: () => o, start: () => w.__tones.push(o.frequency.value), stop: () => {} };
      return o;
    };
    this.createGain = function () {
      return { gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => {} };
    };
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const script = html.match(/<script>\s*\(function\(\)\{[\s\S]*?<\/script>/g).pop()
    .replace(/^<script>/, '').replace(/<\/script>$/, '');
  w.eval(script.replace(/\}\)\(\);\s*$/,
    'window.__t={normScan:normScan,parseLabel:parseLabel,doScan:doScan,lockPallet:lockPallet,'
    + 'renderCheck:renderCheck,reconShow:reconShow,resetCheck:resetCheck,openShip:openShip,'
    + 'setStep:function(s){STEP=s;},setTiming:function(d,g){DUP_MS=d;GRACE_MS=g;},'
    + 'getQ:function(){return scanQ;},getTally:function(){return combTally();},getTotal:function(){return tallyTotal();},'
    + 'getSel:function(){return selPal;},getSrv:function(){return srvTally;},flush:flushScans,'
    + 'getDetail:function(){return DETAIL;},setDetail:function(d){DETAIL=d;}};\n})();'));
  await sleep(40);
  return { w, t: w.__t, srv, SHIP, doc: w.document };
}
const scanCalls = (srv) => srv.calls.filter(c => /\/scan$/.test(c.u));

(async () => {
  const { w, t, srv, doc } = await boot('warehouse');
  t.setTiming(0, 0);
  t.openShip(1); await sleep(30);
  t.setStep('check'); t.renderCheck(); await sleep(10);

  console.log('\n① parseLabel — 카톤 라벨 해석(회귀)');
  let p = t.parseLabel('CTR-CE0796-16');
  ok('CTR-CE0796-16 → CE0796 ×16', p.code === 'CE0796' && p.qty === 16 && p.matched === true, p);
  p = t.parseLabel("CTR'CE0796'16");
  ok("자판 따옴표 보정 후 해석", p.code === 'CE0796' && p.qty === 16, p);
  ok('SYD 접두어도 허용', t.parseLabel('SYD-CB0318-16').code === 'CB0318');

  console.log('\n② 팔렛을 선택해야 스캔이 시작된다');
  t.doScan('CTR-CE0796-16');
  ok('미선택 스캔은 기록되지 않음', t.getQ().length === 0 && scanCalls(srv).length === 0);
  ok('선택 안내 경고음', w.__tones.includes(660));
  const chips = doc.querySelectorAll('#palpick [data-lp]');
  ok('팔렛 칩 표시(하차된 2개)', chips.length === 2, chips.length);
  t.lockPallet(11);
  ok('팔렛 4 선택됨', t.getSel() === 11);

  console.log('\n③ 스캔 = 즉시 서버 기록 — 차단 없음');
  w.__tones.length = 0;
  t.doScan('CTR-CE0796-16'); await sleep(15);
  ok('POST /scan 1회 전송', scanCalls(srv).length === 1, scanCalls(srv).length);
  ok('payload {code,qty,matched}', (() => { const b = scanCalls(srv)[0].body.scans[0]; return b.code === 'CE0796' && b.qty === 16 && b.matched === true; })(), scanCalls(srv)[0].body);
  ok('전송 후 큐 비움(서버 tally 로 전환)', t.getQ().length === 0 && t.getSrv().length === 1);
  ok('등록음(1175Hz)', w.__tones.includes(1175));
  t.doScan('CTR-CE0796-16'); await sleep(15);
  t.doScan('CTR-CE0796-12'); await sleep(15);
  const tl = t.getTally();
  ok('소입수별 별도 집계(16×2 · 12×1)', tl.length === 2 && tl[0].qty === 16 && tl[0].n === 2 && tl[1].qty === 12 && tl[1].n === 1, tl);
  ok('합계 3박스 · 44EA', t.getTotal().n === 3 && t.getTotal().q === 44, t.getTotal());

  console.log('\n④ 초과여도 막지 않는다 — 판정은 [대조]에서');
  for (let i = 0; i < 21; i++) { t.doScan('CTR-CE0796-16'); await sleep(4); }
  await sleep(30);
  ok('예상(23) 초과 스캔도 전부 기록', t.getTotal().n === 24, t.getTotal());
  ok('오류음(196Hz) 없음 — 차단 없음', !w.__tones.includes(196));

  console.log('\n⑤ 중복(연쇄) 리딩은 스캐너 보호로만 거른다');
  t.setTiming(100000, 0);
  const n0 = t.getTotal().n;
  t.doScan('CTR-CB0318-16'); await sleep(10); // 새 코드 1건 — 집계됨(다른 팔렛 코드지만 기록)
  t.doScan('CTR-CB0318-16'); await sleep(10); // 같은 코드 연속 → 이중 리딩 무시
  ok('연쇄 이중 리딩 1건만 집계', t.getTotal().n === n0 + 1, t.getTotal().n - n0);
  t.setTiming(0, 0);

  console.log('\n⑥ 다른 팔렛의 코드 — 경고하되 기록은 한다');
  const cb = scanCalls(srv).map(c => c.body.scans && c.body.scans[0]).filter(Boolean).filter(s => s.code === 'CB0318')[0];
  ok('matched:false 로 서버 기록', cb && cb.matched === false, cb);
  ok('경고음 발생', w.__tones.includes(660));

  console.log('\n⑦ 부속 바코드(EAN 등)는 조용히 무시');
  const q0 = scanCalls(srv).length;
  t.doScan('7501234567890'); await sleep(10);
  ok('숫자 8자리 이상 미등록 → 미기록', scanCalls(srv).length === q0);

  console.log('\n⑧ [−] 취소 — 서버에서도 최근 1건 취소');
  const before = t.getTally().filter(e => e.code === 'CE0796' && e.qty === 16)[0].n;
  const btn = doc.querySelector('[data-bdel="CE0796|16"]');
  ok('[−] 버튼 존재', !!btn);
  btn.click(); await sleep(15);
  const afterN = t.getTally().filter(e => e.code === 'CE0796' && e.qty === 16)[0].n;
  ok('한 건만 감소(서버 반영)', afterN === before - 1, { before, afterN });
  const undoCall = scanCalls(srv).filter(c => c.body.undo_code)[0];
  ok('undo_code+undo_qty 전송', undoCall && undoCall.body.undo_code === 'CE0796' && undoCall.body.undo_qty === 16, undoCall && undoCall.body);

  console.log('\n⑨ 네트워크 단절 — 기록은 큐에 남고 자동 복구');
  srv.failScan = true;
  t.doScan('CTR-CE0796-16'); await sleep(20);
  ok('전송 실패분 큐 유지', t.getQ().length === 1, t.getQ());
  ok('localStorage 에 보존', JSON.parse(w.localStorage.getItem('inb_scanq_1_11') || '[]').length === 1);
  const nOffline = t.getTotal().n;
  srv.failScan = false;
  t.flush(); await sleep(20);
  ok('복구 후 큐 비움 + 서버 합류', t.getQ().length === 0 && t.getTotal().n === nOffline, t.getTotal());

  console.log('\n⑩ [대조](dry) → [입고 확정] — 실측 저장');
  t.reconShow(); await sleep(20);
  const dryCall = srv.calls.filter(c => /confirm$/.test(c.u))[0];
  ok('대조는 dry:true 로 저장 없음', dryCall && dryCall.body.dry === true, dryCall && dryCall.body);
  ok('대조 표 렌더(예상/스캔/차이)', !!doc.getElementById('btnConfirm') && /대조/.test(doc.getElementById('stepbody').textContent));
  ok('다른 팔렛 코드는 라인에 없음으로 표시', /CB0318/.test(doc.getElementById('stepbody').textContent));
  w.__tones.length = 0;
  doc.getElementById('btnConfirm').click(); await sleep(30);
  const realCall = srv.calls.filter(c => /confirm$/.test(c.u))[1];
  ok('확정은 dry 없이 전송', realCall && !realCall.body.dry, realCall && realCall.body);
  ok('저장음(784Hz 시작)', w.__tones.includes(784));
  ok('확정 후 선택 해제(다음 팔렛으로)', t.getSel() === null);
  ok('팔렛 상태 checked', t.getDetail().pallets[0].status === 'checked');

  console.log('\n⑪ 검수 리셋(디렉터 전용)');
  {
    const b2 = await boot('director');
    b2.t.setTiming(0, 0);
    b2.t.openShip(1); await sleep(30);
    b2.t.setStep('check'); b2.t.renderCheck(); await sleep(10);
    b2.t.lockPallet(11); b2.t.doScan('CTR-CE0796-16'); await sleep(20);
    b2.w.localStorage.setItem('inb_scanq_1_99', '[{"code":"X"}]');   // 리셋 시 함께 비워질 잔여 큐
    b2.t.resetCheck(); await sleep(30);
    const rc = b2.srv.calls.filter(c => /reset-check$/.test(c.u))[0];
    ok('POST /reset-check 전송', !!rc);
    ok('선적의 미전송 큐 정리', b2.w.localStorage.getItem('inb_scanq_1_99') === null && b2.w.localStorage.getItem('inb_scanq_1_11') === null);
    ok('리셋 후 서버 스캔 0', b2.srv.scans.length === 0);
    ok('선택 해제·초기 화면 복귀', b2.t.getSel() === null);
  }

  console.log('\n⑫ 창고 계정은 리셋 불가(프런트 가드)');
  {
    const b3 = await boot('warehouse');
    b3.t.openShip(1); await sleep(30);
    b3.t.resetCheck(); await sleep(10);
    ok('POST 미발생', b3.srv.calls.filter(c => /reset-check$/.test(c.u)).length === 0);
  }

  console.log('\n⑬ 멱등 키 — 저장됐는데 응답이 유실돼도 이중 기록 없음("한 순간에 2회" 버그)');
  {
    const b4 = await boot('warehouse');
    b4.t.setTiming(0, 0);
    b4.t.openShip(1); await sleep(30);
    b4.t.setStep('check'); b4.t.renderCheck(); await sleep(10);
    b4.t.lockPallet(11);
    const sc0 = scanCalls(b4.srv)[0];
    b4.t.doScan('CTR-CE0796-16'); await sleep(20);
    const firstK = scanCalls(b4.srv)[0].body.scans[0].k;
    ok('스캔마다 고유 키(k) 전송', !!firstK, scanCalls(b4.srv)[0].body.scans[0]);
    // 서버는 저장했지만 응답이 끊긴다 → 클라이언트는 실패로 알고 재시도
    b4.srv.lostResponse = true;
    b4.t.doScan('CTR-CE0796-12'); await sleep(20);
    ok('서버에는 이미 기록됨', b4.srv.scans.length === 2, b4.srv.scans.length);
    ok('클라이언트는 실패로 보고 큐 유지', b4.t.getQ().length === 1);
    b4.srv.lostResponse = false;
    b4.t.flush(); await sleep(20);
    ok('재전송해도 서버 기록은 그대로 1건(이중 기록 없음)', b4.srv.scans.filter(e => e.qty === 12).length === 1, b4.srv.scans);
    ok('큐 비움 + 화면 합계 2박스(3 아님)', b4.t.getQ().length === 0 && b4.t.getTotal().n === 2, b4.t.getTotal());
    // 취소도 동일 — 응답 유실 후 재시도해도 1건만 취소
    const before = b4.srv.scans.length;
    b4.srv.lostResponse = true;
    const btn4 = b4.doc.querySelector('[data-bdel="CE0796|16"]');
    btn4.click(); await sleep(20);
    b4.srv.lostResponse = false;
    b4.t.flush(); await sleep(20);
    ok('취소 재시도에도 1건만 취소', b4.srv.scans.length === before - 1 && b4.t.getTotal().n === 1, b4.t.getTotal());
  }

  console.log('\n⑭ 전송 실패 원인 표시 + 네트워크 단절(응답 없음) 복구');
  {
    const b5 = await boot('warehouse');
    b5.t.setTiming(0, 0);
    b5.t.openShip(1); await sleep(30);
    b5.t.setStep('check'); b5.t.renderCheck(); await sleep(10);
    b5.t.lockPallet(11);
    // ⓐ 서버 500 (마이그레이션 누락 등) — 원인과 조치가 배너에 보인다
    b5.srv.failScan = true;
    b5.t.doScan('CTR-CE0796-16'); await sleep(20);
    const st = b5.doc.getElementById('syncst');
    ok('전송 대기 + HTTP 500 원인 표시', /전송 대기/.test(st.textContent) && /HTTP 500/.test(st.textContent), st.textContent);
    ok('조치 안내(마이그레이션 확인)', /마이그레이션/.test(st.textContent), st.textContent);
    // ⓑ 응답 자체가 없는 완전 단절 — scanBusy 가 잠기지 않고 복구된다
    b5.srv.failScan = false; b5.srv.throwNet = true;
    b5.t.flush(); await sleep(20);
    ok('네트워크 없음 표시', /네트워크 없음/.test(b5.doc.getElementById('syncst').textContent), b5.doc.getElementById('syncst').textContent);
    b5.srv.throwNet = false;
    b5.t.flush(); await sleep(20);
    ok('연결 복구 → 큐 비움(잠김 없음)', b5.t.getQ().length === 0 && b5.t.getTotal().n === 1, b5.t.getTotal());
    ok('복구 후 저장됨 표시', /서버 저장됨/.test(b5.doc.getElementById('syncst').textContent));
  }

  console.log('\n' + (fail ? '❌' : '✅') + ` 결과: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 실행 오류:', e); process.exit(2); });
