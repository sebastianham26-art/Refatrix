/* 파서 CARTON UNIT · QTY PER C/T 인식 — 운영 parseWorkbook 을 jsdom 에서 실행 */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync('/tmp/Refatrix/refatrix-inbound.html', 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

function boot() {
  const dom = new JSDOM(html.replace(/<script src="refatrix-nav\.js[^"]*"><\/script>/, ''), { runScripts: 'outside-only', url: 'https://x.test/i.html' });
  const w = dom.window;
  w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { id: 9, name: 'M', role: 'warehouse' } }));
  w.localStorage.setItem('wh_lang', 'ko');
  w.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) });
  // XLSX 스텁: rows 배열을 그대로 돌려준다
  w.__rows = null;
  w.XLSX = { utils: { sheet_to_json: () => w.__rows } };
  const script = html.match(/<script>\s*\(function\(\)\{[\s\S]*?<\/script>/g).pop().replace(/^<script>/, '').replace(/<\/script>$/, '');
  w.eval(script.replace(/\}\)\(\);\s*$/, 'window.__t={parseWorkbook:parseWorkbook};\n})();'));
  return w;
}
const wb = { SheetNames: ['packing list_details'], Sheets: { 'packing list_details': {} } };

(async () => {
  console.log('\n① CARTON UNIT × QTY PER C/T 형식 (26B2C-4 케이스)');
  {
    const w = boot();
    w.__rows = [
      ['PACKING LIST'],
      ['ORDER NO', 'PL NO', 'FROM', 'TO', 'CTR NO', 'DESCRIPTION', 'CARTON UNIT', 'QTY PER C/T', 'TOTAL QTY'],
      ['26B2C', 4, 1, 1, 'CE0796', 'TERMINAL', 2, 12, 24],     // FROM/TO 는 1행뿐이지만 실제 2카톤!
      ['26B2C', 4, 2, 2, 'CE0152', 'T2', 3, 16, 48],
      ['26B2C', 4, 3, 3, 'CE0154', 'T3', 1, 10, 10],
    ];
    const res = w.__t.parseWorkbook(wb);
    ok('카톤 기준 = CARTON UNIT', res.cartonBasis === 'CARTON UNIT', res.cartonBasis);
    ok('CE0796: 2카톤 24EA (FROM/TO=1 무시)', res.rows[0].cartons === 2 && res.rows[0].qty === 24, res.rows[0]);
    ok('소입수 = 12 복원', Math.round(res.rows[0].qty / res.rows[0].cartons) === 12);
    ok('CE0152: 3카톤 48EA', res.rows[1].cartons === 3 && res.rows[1].qty === 48);
    ok('파일 합계 82EA', res.fileQty === 82, res.fileQty);
    ok('대사 경고 없음', res.cuMismatch.length === 0);
  }
  console.log('\n② CARTON UNIT×QTY PER C/T ≠ TOTAL → 경고 목록');
  {
    const w = boot();
    w.__rows = [
      ['ORDER NO', 'PL NO', 'FROM', 'TO', 'CTR NO', 'CARTON UNIT', 'QTY PER C/T', 'TOTAL QTY'],
      ['26B2C', 4, 1, 2, 'CE0796', 2, 12, 30],                  // 2×12=24 ≠ 30
    ];
    const res = w.__t.parseWorkbook(wb);
    ok('TOTAL 이 우선(30 유지)', res.rows[0].qty === 30);
    ok('경고 목록에 기록', res.cuMismatch.length === 1 && /CE0796/.test(res.cuMismatch[0]), res.cuMismatch);
  }
  console.log('\n③ TOTAL 열이 빈 양식 — CU×QPC 로 계산');
  {
    const w = boot();
    w.__rows = [
      ['ORDER NO', 'PL NO', 'FROM', 'TO', 'CTR NO', 'CARTON UNIT', 'QTY PER C/T', 'TOTAL QTY'],
      ['26B2C', 4, 1, 2, 'CE0796', 2, 12, null],
    ];
    const res = w.__t.parseWorkbook(wb);
    ok('qty = 2×12 = 24 계산', res.rows[0].qty === 24 && res.rows[0].cartons === 2, res.rows[0]);
  }
  console.log('\n④ 구형 양식(FROM/TO 만) — 기존 동작 유지');
  {
    const w = boot();
    w.__rows = [
      ['ORDER NO', 'PL NO', 'FROM', 'TO', 'CTR NO', 'TOTAL QTY'],
      ['100RA', 12, 1, 20, 'CE0796', 320],
      ['100RA', 12, 21, 23, 'CE0796', 36],
    ];
    const res = w.__t.parseWorkbook(wb);
    ok('카톤 기준 = FROM/TO', res.cartonBasis === 'FROM/TO');
    ok('20카톤·3카톤 그대로', res.rows[0].cartons === 20 && res.rows[1].cartons === 3);
  }
  console.log('\n' + (fail ? '❌' : '✅') + ` 결과: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('오류:', e); process.exit(2); });
