/* 프로모션 화면 — 작업버튼 노출 + 실사 반영 대기 표시 (build sc0922proapply)
   실행:  node test/promo_pending_ui.test.js   (REPO 환경변수로 다른 경로 지정 가능) */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const REPO = process.env.REPO || path.resolve(__dirname, '..');
const FILE = path.join(REPO, 'refatrix-stockcount.html');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastScript = (html) => html.match(/<script>[\s\S]*?<\/script>/g).pop().replace(/^<script>/, '').replace(/<\/script>$/, '');

// 2026-09-22 운영 데이터 형태를 그대로 축약
const PRO = [
  { id: 1711, code: 'PRO015', name: 'material promocion_CALCETINAS CTR', ean: '', rack_location: '', stock_qty: 16, list_price: null, is_active: true },
  { id: 1712, code: 'PRO016', name: 'material promocion_LLAVEROS AMORTIGUADOR', ean: '', rack_location: '', stock_qty: 31, list_price: null, is_active: true },
  { id: 1715, code: 'PRO_019', name: 'Bolsa CTR', ean: '', rack_location: '', stock_qty: 0, list_price: null, is_active: true },
  { id: 1716, code: 'PRO019', name: 'Bolsa CTR', ean: '', rack_location: '', stock_qty: 77, list_price: null, is_active: true },
  { id: 1720, code: 'PRO021', name: 'SIN CONTEO', ean: '', rack_location: '', stock_qty: 3, list_price: 10, is_active: true },
];
const LEGACY = [{ id: 7, code: 'PRO200', name: '테스트', barcode: '', rack_location: '', stock_qty: 999, unit_cost: 0, active: true }];
const SESSIONS = [
  { id: 24, code: 'SC-2026-0012', status: 'submitted', mode: 'full' },
  { id: 23, code: 'SP-2026-0011', status: 'submitted', mode: 'spot' },
  { id: 20, code: 'SC-2026-0011', status: 'submitted', mode: 'full' },
  { id: 18, code: 'SC-2026-0010', status: 'submitted', mode: 'full' },
  { id: 9, code: 'SC-2026-0005', status: 'reconciled', mode: 'full' },
  { id: 8, code: 'SC-2026-0004', status: 'draft', mode: 'full' },
];
const LINES = {
  24: [{ item_kind: 'part', product_id: 1712, counted_qty: 20 }, { item_kind: 'part', product_id: 1712, counted_qty: 11 }],
  20: [{ item_kind: 'part', product_id: 1711, counted_qty: 18 }],
  18: [{ item_kind: 'part', product_id: 1715, counted_qty: 88 }, { item_kind: 'unknown', product_id: null, counted_qty: 5 }, { item_kind: 'promo', promo_item_id: 7, counted_qty: 990 }],
  9: [{ item_kind: 'part', product_id: 1721, counted_qty: 1 }],
  8: [{ item_kind: 'part', product_id: 1721, counted_qty: 1 }],
  23: [{ item_kind: 'part', product_id: 1721, counted_qty: 1 }],
};

const PA = {
  20: { count_id: 20, code: 'SC-2026-0011', status: 'submitted', can_apply: true, other_pending: 0,
        items: [{ kind: 'part', product_id: 1711, code: 'PRO015', name: 'CALCETINAS', system_qty: 16, counted_qty: 18, delta: 2, rack_scanned: 'E3-2', master_rack: '', rack_diff: true }] },
  24: { count_id: 24, code: 'SC-2026-0012', status: 'submitted', can_apply: true, other_pending: 2,
        items: [{ kind: 'part', product_id: 1712, code: 'PRO016', name: 'LLAVEROS', system_qty: 31, counted_qty: 31, delta: 0, rack_scanned: 'E3-1', master_rack: '', rack_diff: true },
                { kind: 'part', product_id: 1715, code: 'PRO_019', name: 'Bolsa', system_qty: 0, counted_qty: 88, delta: 88, rack_scanned: '', master_rack: '', rack_diff: false }] },
};
let sentPA = [], paReply = null;
function mkDom({ sessions = SESSIONS } = {}) {
  sentPA = []; paReply = null;
  const html = fs.readFileSync(FILE, 'utf8').replace(/<script src="refatrix-nav\.js[^"]*"><\/script>/, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://x.test/refatrix-stockcount.html', pretendToBeVisual: true });
  const w = dom.window;
  w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { id: 9, name: 'U', role: 'warehouse' } }));
  w.confirm = () => true; w.alert = () => {};
  const calls = [];
  w.fetch = (url, opt) => {
    const u = String(url); const method = (opt && opt.method) || 'GET';
    calls.push({ u, method });
    let out = {};
    let m;
    if ((m = u.match(/\/api\/stock-counts\/(\d+)\/promo-apply/))) {
      if (method === 'POST') { sentPA.push({ cid: Number(m[1]), body: JSON.parse(opt.body) });
        out = paReply || { ok: true, applied: 1, rack_saved: 1, closed: true, remaining: 0 }; }
      else out = PA[m[1]] || { count_id: Number(m[1]), code: 'X', status: 'submitted', can_apply: true, items: [], other_pending: 0 };
    }
    else if (/\/api\/promo-products/.test(u)) out = { items: PRO };
    else if (/\/api\/promo-items/.test(u)) out = { items: LEGACY };
    else if ((m = u.match(/\/api\/stock-counts\/(\d+)\/reconcile/))) out = { count: { id: Number(m[1]), code: 'X', status: 'submitted' }, can_apply: false, summary: { match: 0, short: 0, over: 0, uncounted: 0, unknown: 0, diff_qty_total: 0 }, rows: [] };
    else if ((m = u.match(/\/api\/stock-counts\/(\d+)$/))) out = { id: Number(m[1]), status: 'submitted', lines: LINES[m[1]] || [] };
    else if (/\/api\/stock-counts/.test(u)) out = { items: sessions };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(out) });
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.eval(lastScript(html));
  return { w, doc: w.document, calls, sentPA: () => sentPA, setReply: (r) => { paReply = r; } };
}
const rowOf = (doc, body, code) => [...doc.getElementById(body).rows].find((r) => r.cells[1] && r.cells[1].textContent.trim().startsWith(code));

(async () => {
  console.log('\n① 작업 버튼이 맨 앞 열');
  {
    const { w, doc } = mkDom();
    await w.showPromo(); await sleep(40);
    const ths = [...doc.querySelectorAll('#promoView table')[0].querySelectorAll('thead th')].map((t) => t.textContent);
    ok('PRO 표 첫 열 = 작업', ths[0] === '작업', ths);
    ok('재고수량 · 실사 반영 대기 가 품명 바로 뒤', ths[3] === '재고수량' && ths[4] === '실사 반영 대기', ths);
    const r = rowOf(doc, 'proBody', 'PRO015');
    ok('첫 칸에 [⚖ 수량조정] 버튼', /수량조정/.test(r.cells[0].textContent) && r.cells[0].querySelector('button[data-act="qty"]'));
    ok('첫 칸에 [편집] 버튼', !!r.cells[0].querySelector('button[data-act="edit"]'));
    ok('작업 칸은 sticky 클래스(act)', r.cells[0].classList.contains('act'));
    ok('인라인 onclick 없음(PRO 표)', !doc.getElementById('proBody').innerHTML.includes('onclick'));
    ok('구 표도 첫 칸 [편집]', !!rowOf(doc, 'promoBody', 'PRO200').cells[0].querySelector('button[data-act="oldedit"]'));
    ok('인라인 onclick 없음(구 표)', !doc.getElementById('promoBody').innerHTML.includes('onclick'));
    ok('CSS: 작업열 sticky', /#promoView td\.act\{position:sticky;left:0/.test(fs.readFileSync(FILE, 'utf8')));
  }

  console.log('\n② 버튼 클릭 → 기존 모달');
  {
    const { w, doc } = mkDom();
    await w.showPromo(); await sleep(40);
    const r = rowOf(doc, 'proBody', 'PRO016');
    r.cells[0].querySelector('button[data-act="qty"]').click(); await sleep(10);
    ok('수량조정 모달이 열린다', doc.querySelector('.modal.on') !== null);
    ok('수량조정 대상 = 클릭한 행(PRO016)', /PRO016/.test(doc.querySelector('.modal.on').textContent), doc.querySelector('.modal.on') && doc.querySelector('.modal.on').textContent.slice(0, 120));
    doc.querySelectorAll('.modal.on').forEach((m) => m.classList.remove('on'));
    r.cells[0].querySelector('button[data-act="edit"]').click(); await sleep(10);
    ok('편집 모달이 열린다', doc.querySelector('.modal.on') !== null);
    doc.querySelectorAll('.modal.on').forEach((m) => m.classList.remove('on'));
    rowOf(doc, 'promoBody', 'PRO200').cells[0].querySelector('button').click(); await sleep(10);
    ok('구 품목 편집 모달 · 코드 PRO200', doc.getElementById('promoModal').classList.contains('on') && doc.getElementById('pmCode').value === 'PRO200');
    // 재바인딩 안전: 두 번 열어도 클릭 1회 = 모달 1회
    await w.showPromo(); await sleep(40);
    let n = 0; const orig = w.openProQty; w.openProQty = (i) => { n++; };
    rowOf(doc, 'proBody', 'PRO015').cells[0].querySelector('button[data-act="qty"]').click();
    ok('화면 재진입 후에도 리스너 중복 없음', n === 1, n); w.openProQty = orig;
  }

  console.log('\n③ 실사 반영 대기');
  {
    const { w, doc, calls } = mkDom();
    await w.showPromo(); await sleep(40);
    const p15 = rowOf(doc, 'proBody', 'PRO015').cells[4].textContent;
    ok('PRO015: SC-2026-0011 · 실사 18 (+2)', /SC-2026-0011/.test(p15) && /실사 18/.test(p15) && /\+2/.test(p15), p15);
    const p16 = rowOf(doc, 'proBody', 'PRO016').cells[4].textContent;
    ok('PRO016: 같은 세션 여러 줄 합산 20+11=31 → 일치', /실사 31/.test(p16) && /일치/.test(p16), p16);
    const p19u = rowOf(doc, 'proBody', 'PRO_019').cells[4].textContent;
    ok('PRO_019: SC-2026-0010 · 실사 88 (+88) — 중복등록이 드러남', /SC-2026-0010/.test(p19u) && /\+88/.test(p19u), p19u);
    ok('PRO019: 대기 없음', rowOf(doc, 'proBody', 'PRO019').cells[4].textContent.trim() === '—');
    ok('PRO021: 대기 없음', rowOf(doc, 'proBody', 'PRO021').cells[4].textContent.trim() === '—');
    const old = rowOf(doc, 'promoBody', 'PRO200').cells[4].textContent;
    ok('구 품목 PRO200: 실사 990 (−9)', /실사 990/.test(old) && /-9/.test(old), old);
    ok('스팟·반영완료·작성중 세션은 안 읽는다', !calls.some((c) => /stock-counts\/(23|9|8)$/.test(c.u)), calls.map((c) => c.u));
    ok('제출된 전체실사 3건만 상세 조회', ['24', '20', '18'].every((id) => calls.some((c) => new RegExp('stock-counts/' + id + '$').test(c.u))));
    ok('POST/PATCH 없음 — 화면 여는 것만으로 재고 안 바뀜', !calls.some((c) => c.method !== 'GET'), calls.filter((c) => c.method !== 'GET'));
    const bar = doc.getElementById('proPendBar').textContent;
    ok('상단 안내: 반영 대기 3건', /반영 대기 중인 재고실사 3건/.test(bar), bar);
    // 대조·반영 링크 → 해당 세션 대조 화면
    doc.querySelector('#proPendBar [data-act="recon"][data-cid="20"]').click(); await sleep(30);
    ok('[대조 보기] → SC 20 대조 호출', calls.some((c) => /stock-counts\/20\/reconcile/.test(c.u)));
    ok('대조 화면으로 전환', !doc.getElementById('reconView').classList.contains('hidden') && doc.getElementById('promoView').classList.contains('hidden'));
  }

  console.log('\n④ 대기 없음');
  {
    const { w, doc } = mkDom({ sessions: [] });
    await w.showPromo(); await sleep(40);
    ok('안내 바 비어 있음', doc.getElementById('proPendBar').innerHTML === '');
    ok('모든 행 —', [...doc.getElementById('proBody').rows].every((r) => r.cells[4].textContent.trim() === '—'));
  }


  console.log('\n⑤ 프로모션만 반영 (sc0922proapply)');
  {
    const { w, doc, calls, sentPA, setReply } = mkDom();
    await w.showPromo(); await sleep(40);
    const btns = [...doc.querySelectorAll('#proPendBar button[data-act="proapply"]')].map((b) => b.getAttribute('data-cid'));
    ok('안내 바에 세션별 [✔ 프로모션만 반영] 버튼 3개', btns.length === 3 && ['24', '20', '18'].every((c) => btns.includes(c)), btns);
    ok('행의 링크는 [반영 ▸]', /반영 ▸/.test(rowOf(doc, 'proBody', 'PRO015').cells[4].textContent));
    rowOf(doc, 'proBody', 'PRO015').cells[4].querySelector('[data-act="proapply"]').click(); await sleep(30);
    ok('모달 열림 · 제목에 SC-2026-0011', doc.getElementById('proApplyModal').classList.contains('on') && /SC-2026-0011/.test(doc.getElementById('paTitle').textContent));
    ok('PRO015 행 · 차이 있으니 반영 기본 체크 · 랙 변경 기본 체크', doc.getElementById('paA_0').checked && doc.getElementById('paR_0').checked && doc.getElementById('paQ_0').value === '18');
    ok('기타 항목 없음 → 반영완료로 닫힌다 안내', /반영완료/.test(doc.getElementById('paOther').textContent));
    doc.getElementById('paSubmit').click(); await sleep(20);
    ok('PIN 없으면 요청 안 나감 + 안내', sentPA().length === 0 && /PIN/.test(doc.getElementById('paMsg').textContent));
    doc.getElementById('paQ_0').value = '-1'; doc.getElementById('paPin').value = '4242';
    doc.getElementById('paSubmit').click(); await sleep(20);
    ok('음수 수량이면 요청 안 나감', sentPA().length === 0 && /0 이상/.test(doc.getElementById('paMsg').textContent));
    doc.getElementById('paQ_0').value = '18'; doc.getElementById('paC_0').value = 'ok';
    doc.getElementById('paSubmit').click(); await sleep(40);
    const b = sentPA()[0];
    ok('POST /stock-counts/20/promo-apply', b && b.cid === 20, sentPA());
    ok('본문 = PRO015 · apply · 랙저장 · 수량 18 · 코멘트 · PIN', b && b.body.pin === '4242' && b.body.items.length === 1 && b.body.items[0].product_id === 1711
      && b.body.items[0].apply === true && b.body.items[0].save_rack === true && b.body.items[0].final_qty === 18 && b.body.items[0].comment === 'ok', b && b.body);
    ok('본문에 kind/부품 없음(PRO id 만)', b && !('promo_item_id' in b.body.items[0]));
    ok('성공 → 모달 닫힘 · PIN 비움', !doc.getElementById('proApplyModal').classList.contains('on') && doc.getElementById('paPin').value === '');
    ok('프로모 화면 다시 불러옴', calls.filter((c) => /\/api\/promo-products/.test(c.u)).length >= 2);
  }
  {
    const { w, doc, sentPA, setReply } = mkDom();
    await w.showPromo(); await sleep(40);
    await w.openProApply(24); await sleep(20);
    ok('SC-0012: 일치+랙변경 행은 반영 해제·랙저장 체크 / 차이 행은 반영 체크', !doc.getElementById('paA_0').checked && doc.getElementById('paR_0').checked && doc.getElementById('paA_1').checked);
    ok('랙 스캔 없는 행은 랙저장 비활성', doc.getElementById('paR_1').disabled);
    ok('부품 섞임 경고(2건 · 디렉터 반영)', /2건/.test(doc.getElementById('paOther').textContent) && /디렉터/.test(doc.getElementById('paOther').textContent));
    doc.getElementById('paA_1').checked = false;   // PRO_019 는 보류 — 보내지 않는다
    doc.getElementById('paPin').value = '4242';
    setReply({ ok: false, status: 403, error: 'bad_pin' });
    doc.getElementById('paSubmit').click(); await sleep(40);
    const b = sentPA()[0];
    ok('체크 해제한 PRO_019 는 본문에 없음(대기로 남음)', b && b.body.items.length === 1 && b.body.items[0].product_id === 1712 && b.body.items[0].apply === false && b.body.items[0].save_rack === true, b && b.body);
    ok('PIN 오류 → 모달 유지 · 안내 · PIN 비움', doc.getElementById('proApplyModal').classList.contains('on') && /PIN/.test(doc.getElementById('paMsg').textContent) && doc.getElementById('paPin').value === '');
    doc.getElementById('paR_0').checked = false;
    doc.getElementById('paPin').value = '4242';
    doc.getElementById('paSubmit').click(); await sleep(20);
    ok('아무것도 체크 안 하면 요청 안 나감', sentPA().length === 1 && /하나 이상/.test(doc.getElementById('paMsg').textContent));
    doc.getElementById('paCancel').click();
    ok('[취소] 닫힘', !doc.getElementById('proApplyModal').classList.contains('on'));
  }
  {
    const { w, doc } = mkDom();
    await w.openReconcile(20); await sleep(60);
    const btn = doc.querySelector('#applyBox [data-act="proapply"]');
    ok('대조 화면(창고 계정)에도 [🎁 프로모션 품목만 반영 (1건)]', !!btn && /1건/.test(btn.textContent), doc.getElementById('applyBox').textContent);
    btn.click(); await sleep(30);
    ok('→ 같은 모달', doc.getElementById('proApplyModal').classList.contains('on'));
  }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
