// 2026-10-19 · 수입입고 — 패킹리스트 없이 「SKU · 수량 · 참조 오더번호」 붙여넣기 (build 20261019paste)
//   운영 HTML 인라인 스크립트를 jsdom 에서 그대로 실행한다.  실행: JSDOM=<jsdom 경로> node test/inbound_paste_ui.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { JSDOM } = require(process.env.JSDOM || 'jsdom');
const HTML = fs.readFileSync(path.join(here, '..', 'refatrix-inbound.html'), 'utf8')
  .replace(/<script src="refatrix-nav\.js[^"]*"><\/script>/, '')
  .replace(/<script src="https:\/\/cdnjs[^"]*"><\/script>/, '');

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n + (e !== undefined ? ' — ' + JSON.stringify(e) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = [];

function boot() { return new JSDOM(HTML, {
  url: 'https://erp.refatrix.com/refatrix-inbound.html', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { role: 'director', name: 'x' } }));
    w.localStorage.setItem('wh_lang', 'ko');
    w.confirm = () => true; w.alert = () => {};
    w.fetch = async (url, opt) => {
      const u = String(url); const m = (opt && opt.method) || 'GET';
      const body = opt && opt.body ? JSON.parse(opt.body) : null;
      calls.push({ u, m, body });
      let out = {};
      if (u.endsWith('/api/inbound') && m === 'GET') out = { items: [] };
      else if (u.endsWith('/api/inbound/preview')) {
        const orders = [...new Set(body.rows.map((r) => r.order_no))];
        out = { ok: true, summary: { pallets: orders.length, cartons: 0, skus: new Set(body.rows.map((r) => r.code)).size,
          qty: body.rows.reduce((s, r) => s + r.qty, 0), orders, unmatched: body.rows.filter((r) => r.code === 'ZZ999').map((r) => r.code), norack: [] } };
      } else if (u.endsWith('/api/inbound') && m === 'POST') out = { ok: true, id: 77 };
      else if (u.endsWith('/api/inbound/77')) out = { error: 'stop' };
      return { ok: true, status: 200, json: async () => out };
    };
  },
}); }
let dom = boot();
let w = dom.window, d = w.document;
await sleep(200);
const app = () => d.getElementById('app').textContent;

// 1) 새 선적 → 붙여넣기 탭
d.getElementById('btnNew').click(); await sleep(50);
t('업로드 화면에 방식 탭 2개', d.querySelectorAll('.umode button').length === 2 && /붙여넣기 \(패킹리스트 없음\)/.test(app()));
d.querySelector('.umode button[data-m="paste"]').click(); await sleep(50);
t('붙여넣기 칸 표시', !!d.getElementById('pasteIn') && !!d.getElementById('defOrd'));

// 2) 엑셀 복사 형태(머리글 + 탭 + 천단위 콤마 + 빈 줄 + 오류 줄)
const paste = (txt, ord = '') => { const ta = d.getElementById('pasteIn'); ta.value = txt; ta.dispatchEvent(new w.Event('input')); const o = d.getElementById('defOrd'); o.value = ord; o.dispatchEvent(new w.Event('input')); };
paste('SKU\tCANTIDAD\tORDEN\r\nCE0839L\t1,200\tPO-2610-01\r\ncb0568 \t24\tPO-2610-01\r\n\r\nCQ0346\t10\tPO-2610-02\r\nCE0083L\tabc\tPO-2610-02\r\n\t5\tPO-2610-02\r\n');
await sleep(250);
const rows = [...d.querySelectorAll('.ptbl tbody tr')];
t('5줄 표시(정상 3 + 오류 2)', rows.length === 5, rows.map((r) => r.textContent));
t('오류 줄 빨간색 2', d.querySelectorAll('.ptbl tr.bad').length === 2);
t('머리글 인식', /머리글 인식/.test(app()));
t('합계 1,234 EA · 오더 2', /1,234 EA/.test(app()) && /오더 2/.test(app()), app().slice(0, 300));
t('SKU 대문자·공백 제거(CB0568)', rows.some((r) => /CB0568/.test(r.textContent)));

// 3) 확인 → 서버 미리보기
d.getElementById('btnPasteCheck').click(); await sleep(80);
const pv = calls.filter((c) => c.u.endsWith('/api/inbound/preview')).pop();
t('미리보기 요청 rows 3', pv && pv.body.rows.length === 3, pv && pv.body);
t('카톤 0 · 팔렛 1 · _line 제거', pv && pv.body.rows.every((r) => r.cartons === 0 && r.pl_no === 1 && !('_line' in r)));
t('수량 1200 숫자', pv && pv.body.rows[0].qty === 1200);
t('미리보기에 「패킹리스트 없음」 안내 · 수량 대사 일치', /패킹리스트 없음/.test(app()) && /수량 대사 일치/.test(app()), app().slice(0, 600));
t('인보이스 칸은 선택(경고 없음)', !/파일에서 못 찾음/.test(app()));

// 4) ETA 없이 생성 → 막힘, ETA 넣고 생성
d.getElementById('btnCreate').click(); await sleep(30);
t('ETA 없으면 생성 안 함', !calls.some((c) => c.u.endsWith('/api/inbound') && c.m === 'POST'));
d.getElementById('eta').value = '2026-10-25';
d.getElementById('invNo').value = 'REF-OCT';
d.getElementById('btnCreate').click(); await sleep(80);
const cr = calls.filter((c) => c.u.endsWith('/api/inbound') && c.m === 'POST').pop();
t('선적 생성 POST · rows 3 · ETA · 참조번호', cr && cr.body.rows.length === 3 && cr.body.eta === '2026-10-25' && cr.body.invoice_no === 'REF-OCT', cr && cr.body);
t('파일 첨부 없음', cr && !cr.body.file_data);

// 5) 두 열(SKU · 수량) + 공통 오더번호, 머리글 없음
async function fresh() { dom.window.close(); dom = boot(); w = dom.window; d = w.document; await sleep(200);
  d.getElementById('btnNew').click(); await sleep(30); d.querySelector('.umode button[data-m="paste"]').click(); await sleep(30); }
await fresh();
paste('CE0839L\t40\nCB0568\t24', 'PO-2610-09'); await sleep(250);
d.getElementById('btnPasteCheck').click(); await sleep(80);
const pv2 = calls.filter((c) => c.u.endsWith('/api/inbound/preview')).pop();
t('두 열 + 공통 오더 → 모든 줄 PO-2610-09', pv2 && pv2.body.rows.length === 2 && pv2.body.rows.every((r) => r.order_no === 'PO-2610-09'), pv2 && pv2.body);

// 6) 오더번호가 전혀 없으면 줄이 빨간색, 확인 버튼 없음
await fresh();
paste('CE0839L\t40', ''); await sleep(250);
t('오더번호 없음 → 오류 · 확인 버튼 없음', d.querySelectorAll('.ptbl tr.bad').length === 1 && !d.getElementById('btnPasteCheck'));

// 7) 파일 탭으로 돌아가기
d.querySelector('.umode button[data-m="file"]').click(); await sleep(30);
t('패킹리스트 엑셀 탭 복귀(drop 영역)', !!d.getElementById('drop'));
t('빌드 토큰', /build 20261019paste<\/title>/.test(HTML) && /var BUILD='20261019paste'/.test(HTML));

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
