/* 부족분>Offer Sheet — 비활성화(오퍼 중단) 화면 동작 (0183 · build sh-0826a)
   운영 HTML(refatrix-shortage.html)의 인라인 스크립트를 그대로 실행해서 검증한다.
   실행: node test/offersheet_disable_ui.test.js   (jsdom 없으면 skip) */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) {
  console.log('⏭  jsdom 미설치 — skip'); process.exit(0);
}
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

// osRender/osLoad 가 들어 있는 인라인 블록(마지막 큰 스크립트)
function mainScript(html) {
  const blocks = html.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g) || [];
  const b = blocks.filter((s) => s.includes('function osRender')).pop();
  return b.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
}

/** payload = /api/offersheets 응답, detail = /api/offersheets/:id 응답 */
function mkDom({ payload, detail }) {
  const html = fs.readFileSync(path.join(REPO, 'refatrix-shortage.html'), 'utf8')
    .replace(/<script src="refatrix-nav\.js[^"]*"><\/script>/, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://x.test/refatrix-shortage.html', pretendToBeVisual: true });
  const w = dom.window;
  const sent = [];
  w.fetch = (url, opt) => {
    const u = String(url);
    if (opt && opt.method === 'POST') sent.push({ url: u, body: opt.body ? JSON.parse(opt.body) : null });
    let body = { ok: true };
    if (/\/api\/offersheets\?/.test(u)) body = payload;
    else if (/\/api\/offersheets\/\d+$/.test(u)) body = detail;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  w.confirm = () => true;
  w.prompt = () => '단종 예정';
  w.alert = () => {};
  // 인라인 스크립트를 한 번에 실행하면서 필요한 핸들을 window 로 노출(let 바인딩은 eval 밖으로 안 나감)
  w.eval(mainScript(html) + `
    session={token:'t',user:{id:1,name:'Maria',role:'sales'},api:'https://api.test'};
    window.__t={ load:()=>osLoad(), render:()=>osRender(), open:(id)=>osOpen(id),
                 disable:()=>osDisable(), enable:()=>osEnable(),
                 setFilter:(v)=>{document.getElementById('osFilter').value=v;} };
  `);
  return { w, doc: w.document, sent };
}

const ROW = (o) => ({
  id: 1, offer_no: 'OS-20260826-1', status: 'ready', origin: 'auto', subtotal_mxn: 1000, iva_mxn: 160, total_mxn: 1160,
  created_at: '2026-08-20T10:00:00Z', sent_at: null, customer_id: 10, customer_name: 'Cliente A', customer_phone: '8112345678',
  item_count: 2, total_qty: 15, reply_count: 0, disabled: false, disabled_at: null, disabled_by_name: null, disabled_note: null, ...o,
});
const PAYLOAD = (items, perm) => ({
  items, summary: { ready: 1, sent: 0, replied: 0, no_reply: 0, ordered: 0, disabled: 1 },
  perm: perm || { can_disable: true }, wa: { api_ready: true, template: null },
});
const DETAIL = (sheet, perm) => ({
  sheet: {
    id: 1, offer_no: 'OS-20260826-1', status: 'ready', origin: 'auto', subtotal_mxn: 1000, iva_mxn: 160, total_mxn: 1160,
    created_at: '2026-08-20T10:00:00Z', customer_id: 10, customer_name: 'Cliente A', customer_phone: '8112345678',
    disabled: false, disabled_at: null, disabled_by_name: null, disabled_note: null, ...sheet,
  },
  perm: perm || { can_disable: true },
  items: [], lines: [{ product_id: 1, ctr_code: 'CL0001', product_name: 'TERMINAL', stock_qty: 50, offer_qty: 15, list_price: 100, discount_rate: 0, unit_price: 100, line_subtotal: 1500, sources: ['부족기록'] }],
  replies: [],
});
const wait = () => new Promise((r) => setTimeout(r, 25));

(async () => {
  console.log('① 목록 — 비활성 시트 표시·필터·요약');
  {
    const items = [ROW(), ROW({ id: 2, offer_no: 'OS-20260826-2', disabled: true, disabled_at: '2026-08-26T09:00:00Z', disabled_by_name: 'Maria', disabled_note: '단종 예정' })];
    const { w, doc } = mkDom({ payload: PAYLOAD(items) });
    w.__t.setFilter('all'); await w.__t.load(); await wait();
    const rows = [...doc.querySelectorAll('#osWrap tbody tr')];
    ok('비활성 시트도 목록에 함께 보인다(숨기지 않음)', rows.length === 2, rows.length);
    ok('비활성 행에 🚫 비활성 pill', /🚫 비활성/.test(rows[1].innerHTML));
    ok('비활성 행은 회색(offrow) 처리', rows[1].className.includes('offrow'), rows[1].className);
    ok('활성 행에는 pill 없음', !/🚫 비활성/.test(rows[0].innerHTML));
    ok('요약에 비활성 타일', /비활성\(중단\)/.test(doc.getElementById('osWrap').innerHTML));
    ok('사유가 툴팁으로 노출', /단종 예정/.test(rows[1].innerHTML));

    w.__t.setFilter('disabled'); w.__t.render();
    const only = [...doc.querySelectorAll('#osWrap tbody tr')];
    ok('필터 🚫 비활성 → 비활성만', only.length === 1 && /OS-20260826-2/.test(only[0].innerHTML), only.length);

    w.__t.setFilter('active'); w.__t.render();
    const act = [...doc.querySelectorAll('#osWrap tbody tr')];
    ok('필터 활성만 → 비활성 제외', act.length === 1 && /OS-20260826-1/.test(act[0].innerHTML), act.length);

    w.__t.setFilter('ready'); w.__t.render();
    ok('상태 필터(발송 대기)는 기존대로 동작', doc.querySelectorAll('#osWrap tbody tr').length === 2);
  }

  console.log('② 상세 — 활성 시트: 비활성화 버튼(권한자)');
  {
    const { w, doc } = mkDom({ payload: PAYLOAD([ROW()]), detail: DETAIL() });
    await w.__t.load(); await wait(); await w.__t.open(1); await wait();
    const h = doc.getElementById('osModalBody').innerHTML;
    ok('[🚫 비활성화] 버튼 노출', /🚫 비활성화/.test(h));
    ok('기존 발송 버튼 유지', /WhatsApp 자동발송/.test(h) && /PDF 출력/.test(h));
    ok('취소 vs 비활성화 차이 안내문', /다시 오퍼로 생성/.test(h) && /다시 생성되지 않습니다/.test(h));
  }

  console.log('③ 상세 — 권한 없는 사용자에게는 버튼이 없다');
  {
    const { w, doc } = mkDom({ payload: PAYLOAD([ROW()], { can_disable: false }), detail: DETAIL(null, { can_disable: false }) });
    await w.__t.load(); await wait(); await w.__t.open(1); await wait();
    const h = doc.getElementById('osModalBody').innerHTML;
    ok('비활성화 버튼 없음', !/🚫 비활성화/.test(h));
    ok('발송 기능은 그대로', /WhatsApp 자동발송/.test(h));
  }

  console.log('④ 상세 — 비활성 시트: 발송 잠금 + 활성화 버튼');
  {
    const dis = { disabled: true, disabled_at: '2026-08-26T09:00:00Z', disabled_by_name: 'Maria', disabled_note: '단종 예정' };
    const { w, doc } = mkDom({ payload: PAYLOAD([ROW(dis)]), detail: DETAIL(dis) });
    await w.__t.load(); await wait(); await w.__t.open(1); await wait();
    const h = doc.getElementById('osModalBody').innerHTML;
    ok('중단 안내 배너', /비활성\(중단\)된 오퍼입니다/.test(h));
    ok('중단자·사유 표시', /Maria/.test(h) && /단종 예정/.test(h));
    ok('[↩ 활성화] 버튼', /↩ 활성화/.test(h));
    ok('WhatsApp 발송 버튼 잠김', !/osWaSend\(\)/.test(h));
    ok('수동 열기·발송완료·취소 버튼 잠김', !/osWhatsapp\(\)|osMarkSent\(\)|osCancel\(\)/.test(h));
    ok('PDF 출력 버튼 잠김', !/osPrintPdf\(\)/.test(h));
    ok('회신 입력 잠김', !/회신 저장/.test(h));
    ok('부족 기록 유지 문구', /부족 기록 자체는 그대로/.test(h));
  }

  console.log('⑤ 버튼 → API 호출');
  {
    const { w, sent } = mkDom({ payload: PAYLOAD([ROW()]), detail: DETAIL() });
    await w.__t.load(); await wait(); await w.__t.open(1); await wait();
    await w.__t.disable(); await wait();
    const call = sent.find((s) => /\/disable$/.test(s.url));
    ok('POST /api/offersheets/1/disable', !!call, sent.map((s) => s.url));
    ok('사유(prompt)가 body 로 전달', call && call.body && call.body.note === '단종 예정', call && call.body);
  }
  {
    const dis = { disabled: true, disabled_at: '2026-08-26T09:00:00Z' };
    const { w, sent } = mkDom({ payload: PAYLOAD([ROW(dis)]), detail: DETAIL(dis) });
    await w.__t.load(); await wait(); await w.__t.open(1); await wait();
    await w.__t.enable(); await wait();
    ok('POST /api/offersheets/1/enable', sent.some((s) => /\/enable$/.test(s.url)), sent.map((s) => s.url));
  }

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
