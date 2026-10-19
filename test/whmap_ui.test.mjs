// 2026-10-19 · 창고 도면 화면(wm-1019b) — 운영 HTML 인라인 스크립트를 jsdom 에서 그대로 실행.
//   실행: JSDOM=<jsdom 경로> node test/whmap_ui.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { JSDOM } = require(process.env.JSDOM || 'jsdom');
const HTML = fs.readFileSync(path.join(here, '..', 'refatrix-whmap.html'), 'utf8').replace(/<script src="refatrix-nav\.js[^"]*"><\/script>/, '');
let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n + (e !== undefined ? ' — ' + JSON.stringify(e) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SEED = [
  { id: 'cage', name: '케이지 · Jaula', type: 'storage', x: 21, y: 2.8, w: 23, h: 45, rows: [['B2', 'C1'], ['A1', 'D2']] },
  { id: 'za', name: 'A 랙 · Racks A', type: 'storage', x: 46, y: 5, w: 35, h: 41, rows: [['AA1', 'AB1', 'AD2']] },
  { id: 'office', name: '사무실 · Oficina', type: 'area', x: 1, y: 2, w: 17, h: 51, rows: [] },
];
function boot({ role = 'director', lang = 'ko', put = null, canEdit = null } = {}) {
  const calls = [];
  const dom = new JSDOM(HTML, { url: 'https://erp.refatrix.com/refatrix-whmap.html', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { role, name: '관리자' } }));
      w.localStorage.setItem('wh_lang', lang); w.confirm = () => true;
      w.fetch = async (url, opt) => {
        const u = new URL(String(url)); const m = (opt && opt.method) || 'GET'; const body = opt && opt.body ? JSON.parse(opt.body) : null;
        calls.push({ p: u.pathname, q: Object.fromEntries(u.searchParams), m, body });
        let out = {}, status = 200;
        if (u.pathname === '/api/wh-map' && m === 'GET') out = { ok: true, seeded: true, version: 0, zones: SEED, can_edit: canEdit == null ? role === 'director' : canEdit,
          racks: [{ rack: 'AD2-1', skus: 2, qty: 54, kind: 'carton' }, { rack: 'AD2-5', skus: 1, qty: 24, kind: 'carton' }, { rack: 'B2-1', skus: 1, qty: 5, kind: 'fast' }, { rack: 'FM-01', skus: 1, qty: 7, kind: 'fast' }],
          known: ['AA1-1', 'AA1-2', 'AD2-1', 'AD2-5', 'B2-1', 'C1-1', 'A1-1', 'D2-1', 'FM-01'] };
        else if (u.pathname === '/api/wh-map/bay') out = { ok: true, bay: u.searchParams.get('bay'), items: [
          { rack: 'AD2-1', code: 'CE0800L', name: 'TERMINAL', qty: 30 }, { rack: 'AD2-1', code: 'CE0801L', name: 'TERMINAL', qty: 24 }, { rack: 'AD2-5', code: 'CB0011', name: 'RÓTULA', qty: 24 }] };
        else if (u.pathname === '/api/wh-map/search') out = { ok: true, items: [{ rack: 'AD2-1', bay: 'AD2', code: 'CE0800L', name: 'TERMINAL', qty: 30 }] };
        else if (u.pathname === '/api/wh-map' && m === 'PUT') { if (put) { status = put.status; out = put.body; } else out = { ok: true, version: 1, updated_at: '2026-10-19T18:00:00Z', zones: body.zones }; }
        return { ok: status < 400, status, json: async () => out };
      };
    } });
  return { dom, w: dom.window, d: dom.window.document, calls };
}

// 1) 운영 — 칸 색 · 클릭 · 상세
let { dom, w, d, calls } = boot();
await sleep(100);
const bay = (b) => d.querySelector('.bay[data-b="' + b + '"]');
t('빌드 토큰', /build wm-1019b<\/title>/.test(HTML) && d.title.includes('wm-1019b'));
t('재고 있는 칸(AD2) = stock', bay('AD2').classList.contains('stock'));
t('ERP 랙 있지만 빈 칸(AA1) = empty', bay('AA1').classList.contains('empty'));
t('ERP 미등록 칸(AB1) = unreg', bay('AB1').classList.contains('unreg'));
t('fast 랙 표시(B2 ⚡)', /⚡/.test(bay('B2').textContent));
t('개요: 도면에 없는 재고 랙 FM 칩', /FM · 7/.test(d.getElementById('side').textContent));
t('디렉터에게 운영/설정 토글', d.getElementById('modeSeg').style.display === '');
bay('AD2').click(); await sleep(50);
t('칸 클릭 → /api/wh-map/bay?bay=AD2', calls.some((c) => c.p === '/api/wh-map/bay' && c.q.bay === 'AD2'));
const side = () => d.getElementById('side').textContent;
t('상세: 층 AD2-1 · AD2-5, SKU 3 · 합계 78', /AD2-1/.test(side()) && /AD2-5/.test(side()) && /3 SKU/.test(side()) && /78/.test(side()), side().slice(0, 300));
t('선택 칸 = sel', bay('AD2').classList.contains('sel'));
t('수량 수정 버튼 없음(읽기 전용)', !d.querySelector('#side button[data-inc], #side input[type=number]'));
bay('AB1').click(); await sleep(30);
t('미등록 칸 → 안내 · 서버 호출 없음', /등록되지 않은 랙/.test(side()) && !calls.some((c) => c.p === '/api/wh-map/bay' && c.q.bay === 'AB1'));

// 2) 검색
const q = d.getElementById('q'); q.value = 'CE0800'; q.dispatchEvent(new w.Event('input')); await sleep(350);
t('검색 → AD2 금색, 나머지 dim', bay('AD2').classList.contains('hit') && bay('AA1').classList.contains('dim'));
t('검색 결과 1', /검색 결과\s*1/.test(side()));
d.querySelector('#side [data-selb="AD2"]').click(); await sleep(50);
t('결과 클릭 → 검색 지우고 AD2 상세', q.value === '' && bay('AD2').classList.contains('sel'));

// 3) 설정 — 랙 편집 · 저장
d.querySelector('#modeSeg button[data-m="setup"]').click(); await sleep(30);
t('설정 화면 · 저장 버튼 비활성', /도면 설정/.test(side()) && d.getElementById('bSave').disabled);
d.querySelector('#side [data-selz="za"]').click(); await sleep(30);
const ta = d.getElementById('eRacks');
t('구역 랙 textarea', ta && ta.value === 'AA1 AB1 AD2');
ta.value = 'aa1 ad2\nae1'; ta.dispatchEvent(new w.Event('change')); await sleep(30);
t('편집 → 저장 안 됨 표시 · 미등록 경고(AE1)', /저장 안 됨/.test(d.getElementById('app').textContent) && /ERP 미등록 1/.test(side()));
t('도면 갱신(AE1 칸)', !!bay('AE1'));
d.getElementById('eRacks').value = 'AA1 B2'; d.getElementById('eRacks').dispatchEvent(new w.Event('change')); await sleep(30);
t('다른 구역과 중복 경고', /중복: B2/.test(side()));
d.getElementById('eRacks').value = 'AA1 AD2\nAE1'; d.getElementById('eRacks').dispatchEvent(new w.Event('change')); await sleep(30);
d.getElementById('bSave').click(); await sleep(60);
const put = calls.filter((c) => c.m === 'PUT').pop();
t('PUT 저장 · version 0 · rows 대문자', put && put.body.version === 0 && JSON.stringify(put.body.zones.find((z) => z.id === 'za').rows) === '[["AA1","AD2"],["AE1"]]', put && put.body);
t('저장 후 저장 안 됨 표시 사라짐', !/저장 안 됨/.test(d.getElementById('app').textContent));
dom.window.close();

// 4) 저장 충돌(409)
({ dom, w, d, calls } = boot({ put: { status: 409, body: { error: 'version_conflict', version: 3 } } }));
await sleep(100);
d.querySelector('#modeSeg button[data-m="setup"]').click(); await sleep(20);
d.getElementById('bAdd').click(); await sleep(20);
d.getElementById('bSave').click(); await sleep(60);
t('409 → 충돌 안내 · 저장 안 됨 유지', /먼저 도면을 저장/.test(d.getElementById('toast').textContent) && /저장 안 됨/.test(d.getElementById('app').textContent));
dom.window.close();

// 5) 창고 계정(스페인어) — 설정 없음
({ dom, w, d, calls } = boot({ role: 'warehouse', lang: 'es' }));
await sleep(100);
t('창고 계정: 설정 토글 숨김 · 스페인어', d.getElementById('modeSeg').style.display === 'none' && /Mapa del almacén/.test(d.getElementById('ttl').textContent) && /Elija una zona/.test(d.getElementById('side').textContent));
const ko = (d.getElementById('app').textContent.match(/[가-힣]+/g) || []).filter((x) => !/^(케이지|랙|사무실)$/.test(x));
t('스페인어 화면에 남은 한국어 없음', ko.length === 0, ko);
dom.window.close();
// 6) 창고 직원 + 「창고 도면 수정」 권한 → 설정 보임, 서버가 403 이면 안내
({ dom, w, d, calls } = boot({ role: 'warehouse', lang: 'ko', canEdit: true, put: { status: 403, body: { error: 'forbidden', page: 'whmap' } } }));
await sleep(100);
t('whmap 수정 권한 직원: 설정 토글 보임', d.getElementById('modeSeg').style.display === '');
d.querySelector('#modeSeg button[data-m="setup"]').click(); await sleep(20);
t('설정 제목에 「디렉터」 표기 없음', !/디렉터/.test(d.getElementById('side').textContent));
d.getElementById('bAdd').click(); await sleep(20); d.getElementById('bSave').click(); await sleep(60);
t('서버 403 → 권한 없음 안내', /수정 권한이 없습니다/.test(d.getElementById('toast').textContent));
dom.window.close();
// 7) 디렉터라도 서버가 can_edit false 면(가정) 설정 숨김 — 판단은 서버가 한다
({ dom, w, d, calls } = boot({ role: 'director', canEdit: false }));
await sleep(100);
t('can_edit false → 설정 숨김', d.getElementById('modeSeg').style.display === 'none');
dom.window.close();
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
