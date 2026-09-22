/* 프로모션 품목 화면 — 운영 refatrix-stockcount.html 의 인라인 스크립트를 그대로 실행(jsdom)
   실행:  node test/promo_ui.test.js        (REPO 환경변수로 다른 경로 지정 가능)

   보는 것: "무엇이 서버로 나갔는가(sent)" 와 "화면에 무엇이 보이는가".
   핵심 요구(디렉터 2026-09-18):
     · 신규 프로모션 품목은 제품마스터(PRO)로 등록되어 제품조회·견적에 나와야 한다
     · 코드는 기존 번호 다음으로 자동 제안된다
     · 수량은 화면이 직접 쓰지 않는다 — 등록(초기수량) / 수량조정(사유 필수) 으로만 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = process.env.REPO || path.resolve(__dirname, '..');
const FILE = path.join(REPO, 'refatrix-stockcount.html');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastScript = (html) => html.match(/<script>[\s\S]*?<\/script>/g).pop().replace(/^<script>/, '').replace(/<\/script>$/, '');

const PRO_ITEMS = [
  { id: 101, code: 'PRO001', name: 'GUANTE DE TRABAJO', ean: '7501111111118', rack_location: 'P-01', stock_qty: 120, list_price: 45, iva_rate: 16, sat_code: '53131600', is_active: true, avg_cost: 18 },
  { id: 102, code: 'PRO002', name: 'GORRA REFATRIX', ean: '', rack_location: '', stock_qty: 0, list_price: null, iva_rate: 16, sat_code: '', is_active: false, avg_cost: null },
];
const LEGACY = [{ id: 7, code: 'PROMO-TERMO', name: 'TERMO', barcode: '', rack_location: 'P-09', stock_qty: 40, unit_cost: 60, active: true }];

function mkDom({ proItems = PRO_ITEMS, legacy = LEGACY, nextCode = 'PRO003' } = {}) {
  const html = fs.readFileSync(FILE, 'utf8').replace(/<script src="refatrix-nav\.js[^"]*"><\/script>/, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://x.test/refatrix-stockcount.html', pretendToBeVisual: true });
  const w = dom.window;
  w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { id: 9, name: 'U', role: 'warehouse' } }));
  w.confirm = () => true; w.alert = () => {};
  const sent = [];
  const state = { pro: proItems.map((x) => ({ ...x })) };
  w.fetch = (url, opt) => {
    const u = String(url);
    const method = (opt && opt.method) || 'GET';
    const body = (opt && opt.body) ? JSON.parse(opt.body) : null;
    if (method !== 'GET') sent.push({ url: u, method, body });
    let out = {};
    if (/\/api\/promo-products\/next-code/.test(u)) out = { code: nextCode };
    else if (/\/api\/promo-products\/\d+\/adjust/.test(u)) {
      const id = Number(u.match(/promo-products\/(\d+)/)[1]);
      const p = state.pro.find((x) => x.id === id);
      const before = p.stock_qty; p.stock_qty = body.target_qty;
      out = { ok: true, code: p.code, before, after: p.stock_qty, changed: before !== p.stock_qty };
    } else if (/\/api\/promo-products\/\d+$/.test(u) && method === 'PATCH') {
      const id = Number(u.match(/promo-products\/(\d+)/)[1]);
      Object.assign(state.pro.find((x) => x.id === id), body);
      out = { ok: true };
    } else if (/\/api\/promo-products$/.test(u) && method === 'POST') {
      state.pro.push({ id: 999, code: body.code, name: body.name, ean: body.ean, rack_location: body.rack_location,
        stock_qty: body.stock_qty || 0, list_price: body.list_price, iva_rate: body.iva_rate, sat_code: body.sat_code, is_active: true });
      out = { ok: true, id: 999, code: body.code, stock_qty: body.stock_qty || 0 };
    } else if (/\/api\/promo-products/.test(u)) out = { items: state.pro };
    else if (/\/api\/promo-items/.test(u)) out = { items: legacy };
    else if (/\/api\/stock-counts/.test(u)) out = { items: [] };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(out) });
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.eval(lastScript(html));
  return { w, doc: w.document, sent, state };
}
const txt = (doc, id) => doc.getElementById(id).textContent.replace(/\s+/g, ' ').trim();
const val = (doc, id) => doc.getElementById(id).value;

(async () => {
  /* ---------- ① 화면 구성 ---------- */
  console.log('\n① 프로모션 화면 구성');
  {
    const { w, doc } = mkDom();
    await sleep(10);
    ok('build 태그 sc0922promo2', /build sc0922promo2/.test(fs.readFileSync(FILE, 'utf8')));
    ok('제품마스터(PRO) 표가 있다', !!doc.getElementById('proBody'));
    ok('구 프로모션 품목 표도 남아 있다', !!doc.getElementById('promoBody'));
    ok('PRO 편집 모달이 있다', !!doc.getElementById('proModal'));
    ok('수량조정 모달이 있다', !!doc.getElementById('proQtyModal'));
    await w.showPromo(); await sleep(20);
    const rows = txt(doc, 'proBody');
    ok('PRO001 이 목록에 보인다', /PRO001/.test(rows), rows.slice(0, 80));
    ok('재고수량이 보인다 (120)', /120/.test(rows));
    ok('판매정가가 금액으로 보인다', /\$45\.00/.test(rows), rows);
    ok('판매정가 없는 항목은 「미설정」 경고', /미설정/.test(rows));
    ok('비활성 항목에 배지', /비활성/.test(rows));
    ok('구 목록에 PROMO-TERMO', /PROMO-TERMO/.test(txt(doc, 'promoBody')));
    ok('안내문에 제품조회·견적 사용 명시', /제품조회/.test(txt(doc, 'promoView')) && /견적/.test(txt(doc, 'promoView')));
    ok('구 목록 안내에 "제품조회·견적에는 나오지 않고"', /제품조회·견적에는 나오지 않고/.test(txt(doc, 'promoView')));
  }

  /* ---------- ② 코드 자동 제안 ---------- */
  console.log('\n② 코드 자동 제안');
  {
    const { w, doc } = mkDom({ nextCode: 'PRO014' });
    await w.showPromo(); await sleep(10);
    await w.openProNew(); await sleep(20);
    ok('모달이 열린다', doc.getElementById('proModal').className.includes('on'));
    ok('코드칸에 다음 번호가 채워진다 (PRO014)', val(doc, 'prCode') === 'PRO014', val(doc, 'prCode'));
    ok('자동 제안 안내 문구', /자동 제안 PRO014/.test(txt(doc, 'prCodeHint')));
    ok('코드칸은 수정 가능', doc.getElementById('prCode').disabled === false);
    ok('IVA 기본 16', val(doc, 'prIva') === '16');
    ok('신규에는 초기수량·원가칸이 보인다', !doc.getElementById('prNewOnly').className.includes('hidden'));
    ok('신규에는 상태 선택이 숨겨진다', doc.getElementById('prActiveWrap').className.includes('hidden'));
  }

  /* ---------- ③ 등록 ---------- */
  console.log('\n③ 신규 등록');
  {
    const { w, doc, sent, state } = mkDom({ nextCode: 'PRO003' });
    await w.showPromo(); await sleep(10);
    await w.openProNew(); await sleep(20);

    // 품명 없이 저장 → 차단
    await w.saveProProduct(); await sleep(10);
    ok('품명 없으면 저장 차단(요청 없음)', sent.length === 0);
    ok('품명 필수 안내', /품명은 필수/.test(txt(doc, 'prMsg')));

    // PRO 아닌 코드 → 차단
    doc.getElementById('prName').value = 'PLAYERA REFATRIX';
    doc.getElementById('prCode').value = 'CE0796';
    await w.saveProProduct(); await sleep(10);
    ok('PRO 아닌 코드는 저장 차단', sent.length === 0);
    ok('PRO 접두사 안내', /PRO 로 시작/.test(txt(doc, 'prMsg')));

    // 정상 등록
    doc.getElementById('prCode').value = 'PRO003';
    doc.getElementById('prEan').value = '7501234567890';
    doc.getElementById('prRack').value = 'P-02';
    doc.getElementById('prPrice').value = '120';
    doc.getElementById('prSat').value = '53131600';
    doc.getElementById('prQty').value = '30';
    doc.getElementById('prCost').value = '45';
    await w.saveProProduct(); await sleep(20);
    const post = sent.find((s) => s.method === 'POST');
    ok('POST /api/promo-products 로 나간다', !!post && /\/api\/promo-products$/.test(post.url), sent);
    ok('코드·품명이 실린다', post.body.code === 'PRO003' && post.body.name === 'PLAYERA REFATRIX');
    ok('초기수량 30 이 실린다', post.body.stock_qty === 30);
    ok('판매정가 120 · IVA 16 · SAT 코드가 실린다',
      post.body.list_price === 120 && post.body.iva_rate === 16 && post.body.sat_code === '53131600');
    ok('참고원가 45 가 실린다', post.body.unit_cost === 45);
    ok('promo-items(구 API)로는 안 나간다', !sent.some((s) => /promo-items/.test(s.url) && s.method === 'POST'));
    ok('모달이 닫힌다', !doc.getElementById('proModal').className.includes('on'));
    ok('목록이 새로 그려진다 (PRO003)', /PRO003/.test(txt(doc, 'proBody')));
    ok('서버 상태에도 반영', state.pro.some((p) => p.code === 'PRO003' && p.stock_qty === 30));
  }

  /* ---------- ④ 편집 ---------- */
  console.log('\n④ 편집 — 수량은 여기서 못 바꾼다');
  {
    const { w, doc, sent } = mkDom();
    await w.showPromo(); await sleep(20);
    w.openProEdit(0);
    ok('편집 모달에 코드 고정', doc.getElementById('prCode').disabled === true && val(doc, 'prCode') === 'PRO001');
    ok('초기수량·원가칸이 숨겨진다(수량은 조정으로만)', doc.getElementById('prNewOnly').className.includes('hidden'));
    ok('상태 선택이 보인다', !doc.getElementById('prActiveWrap').className.includes('hidden'));
    ok('기존 값이 채워진다', val(doc, 'prName') === 'GUANTE DE TRABAJO' && val(doc, 'prPrice') === '45');
    doc.getElementById('prPrice').value = '55';
    doc.getElementById('prActive').value = '0';
    await w.saveProProduct(); await sleep(20);
    const patch = sent.find((s) => s.method === 'PATCH');
    ok('PATCH 로 나간다', !!patch && /promo-products\/101$/.test(patch.url), sent);
    ok('판매가·상태가 실린다', patch.body.list_price === 55 && patch.body.is_active === false);
    ok('수량(stock_qty)은 PATCH 본문에 없다', !('stock_qty' in patch.body), patch.body);
  }

  /* ---------- ⑤ 수량조정 ---------- */
  console.log('\n⑤ 수량조정 — 사유 필수, 이동내역으로');
  {
    const { w, doc, sent, state } = mkDom();
    await w.showPromo(); await sleep(20);
    w.openProQty(0);
    ok('현재 수량이 보인다', /120/.test(txt(doc, 'pqInfo')));
    ok('조정칸 기본값 = 현재 수량', val(doc, 'pqQty') === '120');

    doc.getElementById('pqQty').value = '90';
    await w.saveProQty(); await sleep(10);
    ok('사유 없으면 차단(요청 없음)', sent.length === 0);
    ok('사유 필수 안내', /사유는 필수/.test(txt(doc, 'pqMsg')));

    doc.getElementById('pqReason').value = '엑스포 배포 30개';
    await w.saveProQty(); await sleep(20);
    const adj = sent.find((s) => /adjust$/.test(s.url));
    ok('adjust 엔드포인트로 나간다', !!adj && /promo-products\/101\/adjust$/.test(adj.url), sent);
    ok('목표수량·사유가 실린다', adj.body.target_qty === 90 && adj.body.reason === '엑스포 배포 30개');
    ok('모달이 닫힌다', !doc.getElementById('proQtyModal').className.includes('on'));
    ok('목록에 조정된 수량 90', /90/.test(txt(doc, 'proBody')));
    ok('서버 상태 반영', state.pro.find((p) => p.id === 101).stock_qty === 90);

    // 음수 차단
    w.openProQty(0);
    doc.getElementById('pqQty').value = '-5';
    doc.getElementById('pqReason').value = 'x';
    const before = sent.length;
    await w.saveProQty(); await sleep(10);
    ok('음수 수량 차단', sent.length === before);
  }

  /* ---------- ⑥ 회귀 — 구 프로모션 품목 ---------- */
  console.log('\n⑥ 회귀 — 구 promo_items 는 편집만 가능');
  {
    const { w, doc, sent } = mkDom();
    await w.showPromo(); await sleep(20);
    w.openPromoEdit(LEGACY[0]);
    ok('구 모달이 열린다', doc.getElementById('promoModal').className.includes('on'));
    ok('구 모달 제목이 「구 프로모션 품목」', /구 프로모션 품목/.test(txt(doc, 'pmTitle')));
    ok('코드는 고정', doc.getElementById('pmCode').disabled === true);
    doc.getElementById('pmName').value = 'TERMO 500ML';
    await w.savePromo(); await sleep(20);
    const p = sent.find((s) => /promo-items/.test(s.url));
    ok('구 항목은 promo-items PATCH 로', !!p && p.method === 'PATCH', sent);
    ok('구 항목 신규 생성 경로(POST)는 없다', !sent.some((s) => s.method === 'POST' && /promo-items$/.test(s.url)));
  }

  /* ---------- ⑦ 회귀 — 실사 화면 자체 ---------- */
  console.log('\n⑦ 회귀 — 재고실사 화면 불변');
  {
    const { doc } = mkDom();
    await sleep(10);
    ok('스팟점검 화면 그대로', !!doc.getElementById('spotView'));
    ok('점검 이력 화면 그대로', !!doc.getElementById('spotHistView'));
    ok('전체실사 기록 화면 그대로', !!doc.getElementById('recordView'));
    ok('대조 화면 그대로', !!doc.getElementById('reconView'));
    ok('새 실사 모달 방식선택 2개 그대로', !!doc.getElementById('modeFull') && !!doc.getElementById('modeSpot'));
  }

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
