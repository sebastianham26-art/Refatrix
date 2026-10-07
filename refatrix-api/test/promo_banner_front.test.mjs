// =====================================================================
// 연동 관리 › 📣 프로모션 배너 — refatrix-integrations.html 을 jsdom 에서 실제로 구동 (build 20260929promo)
//
//   ① 상단 전환 — 연동 설정 ⇄ 프로모션 배너 (기존 .tab 핸들러와 섞이지 않는다)
//   ② 전송할 곳(=CRM 창구) 체크 목록 — 새 프로모션은 켜진 곳 전부가 기본
//   ③ 이미지·전송할 곳 없이 전송 누르면 막는다(서버 호출 없음)
//   ④ 규격이 다른 창구가 있으면 경고하고, 전송 전에 한 번 더 묻는다
//   ⑤ 전송 본문 = 이미지 data URL + 고른 창구 + publish:true
//   ⑥ 열기 — 필드 채움 · 발행 중이면 「다시 전송·내리기」 버튼 · 실패 건 재전송 버튼
//   ⑦ 연동 설정의 프로모션 창구 — 배너 규격 칸이 보이고 저장 본문에 실린다 · 고객 전용 버튼은 숨김
//   ⑧ 새 코드에 인라인 onclick 없음(프로젝트 규칙)
// =====================================================================
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import assert from 'node:assert';

const HTML = readFileSync(new URL('../../refatrix-integrations.html', import.meta.url), 'utf8');
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const TARGETS = [
  { key: 'promo_crm', label: '웹 카달록', enabled: true, env: 'prod', active_url: 'https://crm/a', has_token: true,
    token_borrowed_label: '고객 상거래정보', banner_w: 1200, banner_h: 400, method_delete: 'DELETE' },
  { key: 'promo_b', label: '고객사 B', enabled: true, env: 'test', active_url: 'https://b/x', has_token: true, banner_w: 1920, banner_h: 600 },
  { key: 'promo_off', label: '준비 중', enabled: false, env: 'test', active_url: '', has_token: false, banner_w: null, banner_h: null },
];
const PROMO = { id: 5, code: 'PR-000005', title: 'Octubre -15%', description: 'Desc', promo_type: 'porcentaje', discount_value: 15,
  conditions: 'Min', start_date: '2026-10-01', end_date: '2026-10-31', link_url: '', priority: 10, auto_withdraw: true,
  status: 'published', phase: 'active', version: 2,
  image: { url: 'https://erp/api/public/promo-banners/5-aaaaaaaaaaaaaaaa.png', mime: 'image/png', name: 'o.png', bytes: 2048, w: 1200, h: 400 },
  targets: ['promo_crm', 'promo_b'], size_warnings: [{ key: 'promo_b' }], send: { sent: 1, pending: 0, failed: 1 } };
const DRAFT = { ...PROMO, id: 6, code: 'PR-000006', title: 'Borrador', status: 'draft', phase: 'draft', image: null, targets: [], send: {} };
const ENDED = { ...PROMO, id: 7, code: 'PR-000007', title: 'Septiembre', phase: 'ended', send: {} };

function boot() {
  const calls = [];
  const dom = new JSDOM(HTML.replace(/<script src=[^>]*><\/script>/g, ''), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/refatrix-integrations.html',
  });
  const w = dom.window;
  const j = (o, status = 200) => ({ ok: status < 400, status, json: async () => o, blob: async () => new w.Blob(['x']) });
  w.URL.createObjectURL = () => 'blob:x';
  w.URL.revokeObjectURL = () => {};
  w.fetch = async (url, opt = {}) => {
    const u = String(url); const method = (opt.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: opt.body ? JSON.parse(opt.body) : null });
    if (u.endsWith('/api/promotions/targets')) return j({ items: JSON.parse(JSON.stringify(TARGETS)) });
    if (u.endsWith('/api/promotions') && method === 'GET') return j({ today: '2026-10-05', items: [PROMO, DRAFT, ENDED] });
    if (/\/api\/promotions\/5\/image$/.test(u)) return j({});
    if (/\/api\/promotions\/5$/.test(u) && method === 'GET') return j({ promo: PROMO, deliveries: [
      { endpoint_key: 'promo_crm', outbox_id: 91, op: 'upsert', status: 'sent', attempts: 1, http_status: 200, codigo_error: '0', env: 'prod', version: 2, created_at: '2026-10-05T15:00:00Z', sent_at: '2026-10-05T15:00:01Z' },
      { endpoint_key: 'promo_b', outbox_id: 92, op: 'upsert', status: 'failed', attempts: 6, http_status: 500, last_error: 'boom', env: 'test', version: 2, created_at: '2026-10-05T15:00:00Z' },
    ], history: [] });
    if (u.endsWith('/api/promotions') && method === 'POST') {
      return j({ ok: true, promo: { ...DRAFT, id: 8, status: 'published' }, sent: { version: 1, sent_to: ['promo_crm', 'promo_b'], removed_from: [], replaced: 0 } });
    }
    if (/\/api\/integrations$/.test(u)) return j({ migrated: true, engine: {}, items: [
      { key: 'customer_commercial', label: '고객', category: 'customer', enabled: true, env: 'prod', counts: {} },
      { key: 'promo_crm', label: '웹 카달록', category: 'promotion', enabled: true, env: 'prod', counts: {} }] });
    if (/\/api\/integrations\/promo_crm$/.test(u)) return j({ endpoint: { key: 'promo_crm', label: '웹 카달록', category: 'promotion', direction: 'out',
      enabled: true, env: 'prod', url_test: '', url_prod: 'https://crm/a', method_upsert: 'POST', method_delete: 'DELETE', auth_in: 'query',
      auth_param: 'apiKey', ok_code: '0', timeout_ms: 10000, user_field: 'login_id', banner_w: 1200, banner_h: 400, promo_ready: true,
      field_map: { titulo: 'title' }, contract: {} }, changes: [] });
    if (/\/api\/integrations\/customer_commercial$/.test(u)) return j({ endpoint: { key: 'customer_commercial', label: '고객', category: 'customer',
      direction: 'out', enabled: true, env: 'prod', url_prod: 'https://crm/c', method_upsert: 'POST', method_delete: 'DELETE', auth_in: 'header', ok_code: '0',
      timeout_ms: 10000, user_field: 'login_id', contract: {} }, changes: [] });
    return j({ items: [] });
  };
  w.alert = () => {};
  const confirms = [];
  w.confirm = (m) => { confirms.push(m); return true; };
  w.prompt = () => null;
  w.eval(`session={token:'t',user:{id:1,name:'Dir',role:'director'},api:''};`);
  return { w, calls, confirms, $: (id) => w.document.getElementById(id) };
}
const posts = (calls, re) => calls.filter((c) => c.method !== 'GET' && re.test(c.url));

test('① 상단 전환 — 프로모션 화면이 뜨고 연동 목록은 감춘다', async () => {
  const { w, calls, $ } = boot();
  w.document.querySelector('.mtab[data-mode="promo"]').click(); await tick(40);
  assert.equal($('viewPromo').classList.contains('hidden'), false);
  assert.equal($('viewEps').classList.contains('hidden'), true);
  assert.ok(calls.some((c) => c.url.endsWith('/api/promotions/targets')));
  assert.ok(calls.some((c) => c.url.endsWith('/api/promotions')));
  // 기존 설정 탭(.tab) 은 그대로 3개 — 상단 전환이 거기에 끼지 않았다
  assert.equal(w.document.querySelectorAll('.tab').length, 3);
});

test('② 목록 필터 · 전송할 곳 — 새 프로모션은 켜진 곳 전부 기본 선택', async () => {
  const { w, $ } = boot();
  w.setMode ? w.setMode('promo') : w.eval("setMode('promo')"); await tick(40);
  const titles = () => Array.from(w.document.querySelectorAll('#pmList .pm .t')).map((x) => x.textContent);
  assert.deepEqual(titles(), ['Octubre -15%'], '기본 = 진행·예정만');
  w.document.querySelector('#pmFilter button[data-f="all"]').click();
  assert.deepEqual(titles(), ['Octubre -15%', 'Borrador', 'Septiembre']);
  w.document.querySelector('#pmFilter button[data-f="draft"]').click();
  assert.deepEqual(titles(), ['Borrador']);
  const checked = Array.from(w.document.querySelectorAll('#pmTargets input[data-tgt]')).filter((c) => c.checked).map((c) => c.dataset.tgt);
  assert.deepEqual(checked, ['promo_crm', 'promo_b'], '꺼진 창구는 기본 선택에서 빠진다');
  assert.match($('pmTargets').textContent, /주소 미설정/);
  assert.match($('pmTargets').textContent, /키: 「고객 상거래정보」 것 사용/);
  assert.equal($('pmFStart').value, '2026-10-05', '시작일 기본 = 멕시코 오늘');
  assert.equal($('pmFEnd').value, '2026-11-04');
});

test('③ 이미지 없이 전송 → 막고 서버를 부르지 않는다', async () => {
  const { w, calls, $ } = boot();
  w.eval("setMode('promo')"); await tick(40);
  $('pmFTitle').value = 'Nueva'; $('pmFValue').value = '10';
  $('pmPublish').click(); await tick();
  assert.match($('pmMsg').textContent, /배너 이미지/);
  assert.equal(posts(calls, /\/api\/promotions/).length, 0);
});

test('④⑤ 규격 경고 → 확인 → 전송 본문', async () => {
  const { w, calls, confirms, $ } = boot();
  w.eval("setMode('promo')"); await tick(40);
  $('pmFTitle').value = 'Nueva'; $('pmFValue').value = '10';
  w.eval("PMIMG={dataUrl:'data:image/png;base64,AAAA',name:'n.png',w:1200,h:400,bytes:4,mime:'image/png'}; renderSizeWarn();");
  assert.match($('pmSizeWarn').textContent, /고객사 B.*1920×600/);
  $('pmPublish').click(); await tick(30);
  assert.ok(confirms.some((m) => /규격과 다릅니다/.test(m) && /고객사 B/.test(m)), '규격 다름을 묻는다');
  assert.ok(confirms.some((m) => /운영 CRM/.test(m) && /웹 카달록/.test(m)), '운영 게시를 묻는다');
  const p = posts(calls, /\/api\/promotions$/);
  assert.equal(p.length, 1);
  assert.equal(p[0].method, 'POST');
  assert.equal(p[0].body.publish, true);
  assert.deepEqual(p[0].body.targets, ['promo_crm', 'promo_b']);
  assert.equal(p[0].body.image_data_url, 'data:image/png;base64,AAAA');
  assert.equal(p[0].body.discount_value, '10');
  assert.match($('pmMsg').textContent, /2곳.*전송/);
});

test('⑥ 발행 중인 건 열기 — 필드·버튼·창구별 현황·실패 재전송', async () => {
  const { w, calls, $ } = boot();
  w.eval("setMode('promo')"); await tick(40);
  w.document.querySelector('#pmList .pm[data-pm="5"]').click(); await tick(40);
  assert.equal($('pmFTitle').value, 'Octubre -15%');
  assert.equal($('pmFStart').value, '2026-10-01');
  assert.equal($('pmResend').classList.contains('hidden'), false);
  assert.equal($('pmCancel').classList.contains('hidden'), false);
  assert.equal($('pmSaveDraft').classList.contains('hidden'), true, '발행 중이면 저장=전송이라 버튼 하나');
  assert.match($('pmPublish').textContent, /고친 내용/);
  assert.equal($('pmDelivBox').classList.contains('hidden'), false);
  const rows = Array.from(w.document.querySelectorAll('#pmDelivRows tr')).map((r) => r.textContent);
  assert.equal(rows.length, 2);
  assert.match(rows[1], /실패/); assert.match(rows[1], /boom/);
  const retry = w.document.querySelector('#pmDelivRows button[data-pmretry="92"]');
  assert.ok(retry, '실패 건에만 재전송 버튼');
  retry.click(); await tick(20);
  assert.ok(posts(calls, /\/api\/crm-sync\/92\/retry$/).length === 1, '기존 재전송 API 를 그대로 쓴다');
});

test('⑦ 연동 설정 — 프로모션 창구는 배너 규격 칸 · 고객 전용 버튼 숨김 · 저장 본문에 실림', async () => {
  const { w, calls, $ } = boot();
  await w.eval('loadEndpoints("promo_crm")'); await tick(40);
  assert.equal($('boxPromo').classList.contains('hidden'), false);
  assert.equal($('btnBulk').classList.contains('hidden'), true, '「전체 동기화」(고객 전송)는 숨긴다');
  assert.equal($('tCustomer').classList.contains('hidden'), true);
  assert.equal($('fBannerW').value, '1200');
  const titleMap = w.document.querySelector('#promoMapRows input[data-pmapf="titulo"]');
  assert.equal(titleMap.value, 'title');
  $('fBannerW').value = '1920'; $('fBannerH').value = '600';
  $('btnSaveCfg').click(); await tick(30);
  const put = posts(calls, /\/api\/integrations\/promo_crm$/).find((c) => c.method === 'PUT');
  assert.ok(put, '저장 호출');
  assert.equal(put.body.banner_w, '1920'); assert.equal(put.body.banner_h, '600');
  assert.deepEqual(put.body.field_map, { titulo: 'title' });
  // 고객 창구로 가면 프로모션 칸은 사라지고 저장 본문에도 없다
  await w.eval('selectEp("customer_commercial")'); await tick(30);
  assert.equal($('boxPromo').classList.contains('hidden'), true);
  $('btnSaveCfg').click(); await tick(30);
  const put2 = posts(calls, /\/api\/integrations\/customer_commercial$/).find((c) => c.method === 'PUT');
  assert.ok(put2 && !('banner_w' in put2.body), '다른 창구의 값을 건드리지 않는다');
});

test('⑧ 새 코드에 인라인 onclick 없음 · 빌드 토큰', () => {
  const start = HTML.indexOf('0237 · 프로모션 배너 — ERP 에서 등록');
  const end = HTML.indexOf('window.selectEp=selectEp;');
  assert.ok(start > 0 && end > start);
  assert.equal(/onclick\s*=/.test(HTML.slice(start, end)), false);
  const view = HTML.slice(HTML.indexOf('<!-- ===== 0237 · 프로모션 배너 ===== -->'), HTML.indexOf('<script>', HTML.indexOf('<!-- ===== 0237')));
  assert.equal(/onclick\s*=/.test(view), false);
  assert.match(HTML, /<title>[^<]*build (20260929promo|20261006ex|20261006xl)<\/title>/);
});
