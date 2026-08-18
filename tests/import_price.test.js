/* 수입단가 필수 입력 절차(imp-0818d) — 단가 미입력이면 다음 단계 차단 */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync('/tmp/Refatrix/refatrix-import.html', 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const dom = new JSDOM(html.replace(/<script src=[^>]+><\/script>/g, ''), {
    runScripts: 'outside-only', url: 'https://x.test/refatrix-import.html', pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  w.fetch = (url, opt) => {
    const u = String(url); calls.push({ u, method: (opt && opt.method) || 'GET' });
    let res = { ok: true };
    if (/\/api\/imports$/.test(u)) res = { ok: true, id: 9, sku_count: 1, total_qty: 12, stock_value_mxn: 0 };
    else if (/preview$/.test(u)) res = { preview: [] };
    else if (/pending/.test(u)) res = { items: [] };
    else if (/from-inbound/.test(u)) res = { items: [] };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(res) });
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const scripts = html.match(/<script>([\s\S]*?)<\/script>/g).map(s => s.replace(/^<script>/, '').replace(/<\/script>$/, ''));
  // 모든 스크립트 + 드라이버를 한 eval 로 실행(let/const 스코프 공유)
  w.eval(scripts.join('\n')+`
    ;session={token:'t',user:{name:'Seb',role:'director'},api:'https://x.test/api'.replace('/api','')+''};
    session.api='https://api.test'; isDirector=true;
    window.__t={addLine:addLine,createAndPreview:createAndPreview,readInvoicePrices:readInvoicePrices,refreshLineTools:refreshLineTools,dollar:$};
    $('idate').value='2026-08-18'; $('lines').innerHTML='';
    addLine({id:1,code:'GV0828',name:'BUJE',qty:12,price:'',currency:'USD',invoice_no:'D26'});
    addLine({id:2,code:'CE0796',name:'TERMINAL',qty:32,price:2.35,currency:'USD',invoice_no:'D26'});
  `);
  await sleep(20);
  const doc = w.document;
  const rows = doc.querySelectorAll('#lines .lrow');
  ok('라인 2개 구성(단가 빈 칸 1)', rows.length === 2 && rows[0].querySelector('.l-price').value === '', rows.length);

  console.log('\n① 단가 미입력 → 다음 단계 차단');
  w.__t.createAndPreview(); await sleep(30);
  ok('POST /api/imports 미발생(차단)', !calls.some(c => /\/api\/imports$/.test(c.u) && c.method === 'POST'), calls.filter(c=>c.method==='POST'));
  ok('오류 안내: 수입단가 미입력', /수입단가 미입력 1건/.test(doc.getElementById('formMsg').textContent), doc.getElementById('formMsg').textContent.slice(0,120));
  ok('해당 칸 붉게 표시', rows[0].querySelector('.l-price').style.border.indexOf('178, 59') >= 0 || /B23B2E/i.test(rows[0].querySelector('.l-price').style.border), rows[0].querySelector('.l-price').style.border);
  ok('안내에 재매칭 경로 포함', /구매 재매칭/.test(doc.getElementById('formMsg').textContent));

  console.log('\n② 단가 입력 시 표시 해제 + 진행 허용');
  const inp = rows[0].querySelector('.l-price');
  inp.value = '3.85';
  inp.dispatchEvent(new w.Event('input', { bubbles: true })); await sleep(5);
  ok('입력하면 붉은 표시 해제', inp.style.border === '', inp.style.border);
  w.__t.createAndPreview(); await sleep(40);
  ok('모두 입력 후 POST 진행', calls.some(c => /\/api\/imports$/.test(c.u) && c.method === 'POST'));

  console.log('\n③ 인보이스 단가 읽기 — 자동 입력 + 발주단가 차이 표시');
  // XLSX 스텁: CTR NO / QTY / UNIT PRICE 헤더가 3행에 있는 인보이스
  w.eval(`window.XLSX={
    read:()=>({SheetNames:['INV'],Sheets:{INV:{}}}),
    utils:{sheet_to_json:()=>[
      ['COMMERCIAL INVOICE','','',''],
      ['','','',''],
      ['CTR NO','DESCRIPTION','QTY','UNIT PRICE'],
      ['GV-0828','BUJE',12,3.85],
      ['CE0796','TERMINAL',30,2.5],
      ['ZZ0001','OTRO',5,1.1],
    ]}
  };`);
  // 발주단가 기준값 세팅: CE0796 라인은 발주 2.35
  rows[1].dataset.poPrice='2.35';
  rows[0].querySelector('.l-price').value='';   // GV0828 다시 비움(인보이스가 채우는지)
  w.__t.readInvoicePrices({arrayBuffer:async()=>new ArrayBuffer(0)}); await sleep(30);
  ok('GV0828 단가 3.85 자동 입력(표기차 GV-0828 매칭)', rows[0].querySelector('.l-price').value==='3.85', rows[0].querySelector('.l-price').value);
  ok('CE0796 단가 2.5 로 갱신', rows[1].querySelector('.l-price').value==='2.5', rows[1].querySelector('.l-price').value);
  ok('발주단가와 차이 → 노란 표시', /C9A24B|201, 162, 75/i.test(rows[1].querySelector('.l-price').style.border), rows[1].querySelector('.l-price').style.border);
  const diffBox=doc.getElementById('invDiffBox').textContent;
  ok('차이 표: 2.35 → 2.5 (+6.4%)', /2\.35/.test(diffBox)&&/2\.5/.test(diffBox)&&/6\.4/.test(diffBox), diffBox.slice(0,150));
  ok('수량 차이 경고(32 vs 30)', /수량 차이/.test(diffBox)&&/30/.test(diffBox));
  ok('라인에 없는 인보이스 코드 ZZ0001 안내', /ZZ0001/.test(diffBox));
  ok('요약: 적용 2건 · 차이 1건', /적용 2건/.test(doc.getElementById('formMsg').textContent)&&/차이 1건/.test(doc.getElementById('formMsg').textContent), doc.getElementById('formMsg').textContent.slice(0,120));

  console.log('\n④ 필터·카운트(스크롤 보조)');
  w.__t.refreshLineTools();
  ok('카운트 표시', /전체 2라인/.test(doc.getElementById('lineCount').textContent), doc.getElementById('lineCount').textContent);
  doc.getElementById('lineFilter').value='GV0828';
  doc.getElementById('lineFilter').dispatchEvent(new w.Event('input',{bubbles:true})); await sleep(5);
  ok('코드 필터 동작(1건 표시)', /표시 1 \/ 전체 2/.test(doc.getElementById('lineCount').textContent), doc.getElementById('lineCount').textContent);
  ok('필터로 숨김', rows[1].style.display==='none');
  doc.getElementById('lineFilter').value='';
  doc.getElementById('lineFilter').dispatchEvent(new w.Event('input',{bubbles:true})); await sleep(5);

  console.log('\n' + (fail ? '❌' : '✅') + ` 결과: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 실행 오류:', e); process.exit(2); });
