// =====================================================================
// 견적·매출 추적 — 신규 견적 WhatsApp 알림 설정 패널 (jsdom, 0256 · ql-1007wa1)
//   운영 HTML(refatrix-quotelist.html)을 그대로 띄우고 fetch 만 스텁한다.
//   실행: node --test test/quote_wa_front.test.mjs   (jsdom 필요)
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const L_HTML = resolve(here, '..', '..', 'refatrix-quotelist.html');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* 미설치 → skip */ }
const SKIP = !JSDOM || !existsSync(L_HTML);
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const TEAMS = [{ id: 1, name: '01_Monterrey' }, { id: 2, name: '02_Merida' }];
function boot(role = 'director') {
  const calls = [];
  let items = [{ id: 7, name: 'Seba', phone: '528110005311', phone_masked: '528****5311', lang: 'ko', team_ids: [], active: true, window_open: true }];
  const dom = new JSDOM(readFileSync(L_HTML, 'utf-8'), {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-quotelist.html',
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 'T', api: 'https://api.test', user: { name: 'U', role } }));
      w.alert = () => {}; w.confirm = () => true;
      w.requestAnimationFrame = (cb) => setTimeout(cb, 0);
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
      w.fetch = async (url, opt = {}) => {
        const u = String(url); const method = opt.method || 'GET'; const body = opt.body ? JSON.parse(opt.body) : null;
        calls.push({ u, method, body });
        const json = (d, s = 200) => ({ ok: s < 400, status: s, json: async () => d });
        if (u.includes('/api/quote-wa/recipients') && method === 'GET') return json({ items, teams: TEAMS, webhook: true });
        if (u.includes('/api/quote-wa/recipients') && method === 'POST') {
          if (!body.phone) return json({ error: 'bad_phone' }, 400);
          const r = { id: 8, name: body.name, phone: '52' + body.phone, phone_masked: '52x', lang: body.lang, team_ids: body.team_ids, active: true, window_open: false };
          items = [...items, r]; return json(r);
        }
        if (u.match(/\/api\/quote-wa\/recipients\/\d+/) && method === 'PATCH') {
          const id = Number(u.split('/').pop()); items = items.map((x) => (x.id === id ? { ...x, ...body } : x));
          return json(items.find((x) => x.id === id));
        }
        if (u.includes('/api/quote-wa/status')) return json({ enabled: true, api_ready: true, template: 'nueva_cotizacion', webhook: true,
          recent: [{ quote_id: 1, quote_no: 'Q-2026-0501', customer_name: 'REFA SUR', name: 'Seba', status: 'sent_text', dlv_status: 'read', attempts: 1, updated_at: '2026-10-07T17:00:00Z' },
            { quote_id: 2, quote_no: 'Q-2026-0502', customer_name: 'REFA NORTE', name: 'Seba', status: 'sent_text', dlv_status: 'failed', dlv_reason: '24시간 창 밖', attempts: 1, updated_at: '2026-10-07T17:01:00Z' }] });
        if (u.includes('/api/quote-wa/preview')) return json({ quote_no: 'Q-2026-0502', text: (u.includes('lang=es') ? '🧾 *Nueva cotización*' : '🧾 *신규 견적*') + ' · Q-2026-0502' });
        if (u.includes('/api/quote-wa/send')) return json({ quote_no: 'Q-2026-0502', results: [{ ok: true, status: 'sent_text' }] });
        if (u.includes('/api/quotes/summary')) return json({ period: [], empty: true });
        if (u.includes('/api/quotes/open-count')) return json({ open: 0, guest_pending: 0, delete_pending: 0 });
        return json({ items: [] });
      };
    },
  });
  const w = dom.window;
  return { w, d: w.document, calls, close: () => w.close(),
    ready: new Promise((r) => { if (w.document.readyState === 'complete') r(); else w.addEventListener('load', r); }) };
}

test('신규 견적 WhatsApp 알림 패널 (jsdom)', { skip: SKIP && 'jsdom 또는 HTML 없음' }, async (t) => {
  await t.test('① 디렉터: 버튼 → 패널 · 상태 · 수신자(팀 범위 · 24시간 창) · 원장(읽음/실패 사유) · 미리보기', async () => {
    const c = boot(); await c.ready; await tick(500);
    assert.match(c.d.title, /ql-1007wa1/);
    const btn = c.d.getElementById('qwOpen'); assert.ok(btn, '디렉터에게 버튼');
    btn.click(); await tick(300);
    assert.ok(c.d.getElementById('qwModal').classList.contains('on'));
    const stat = c.d.getElementById('qwStat').textContent;
    assert.match(stat, /알림 켜짐/); assert.match(stat, /nueva_cotizacion/); assert.match(stat, /웹훅 연결/);
    const rec = c.d.getElementById('qwRecips');
    assert.match(rec.textContent, /Seba/); assert.match(rec.textContent, /전체/); assert.match(rec.textContent, /열림/);
    assert.equal(rec.querySelectorAll('input[data-act="team"]').length, 2);
    const log = c.d.getElementById('qwLog').textContent;
    assert.match(log, /Q-2026-0501/); assert.match(log, /읽음/); assert.match(log, /전달 실패 — 24시간 창 밖/);
    assert.match(c.d.getElementById('qwPv').textContent, /신규 견적/);
    c.d.getElementById('qwPvLang').value = 'es'; c.d.getElementById('qwPvLang').dispatchEvent(new c.w.Event('change')); await tick(200);
    assert.match(c.d.getElementById('qwPv').textContent, /Nueva cotización/);
    c.close();
  });

  await t.test('② 추가(팀 선택) · 팀 범위 변경 PATCH · 시험 발송 · 닫기', async () => {
    const c = boot(); await c.ready; await tick(500);
    c.d.getElementById('qwOpen').click(); await tick(300);
    c.d.getElementById('qwName').value = 'Oscar'; c.d.getElementById('qwPhone').value = '9991234567'; c.d.getElementById('qwLang').value = 'es';
    c.d.querySelector('#qwNewTeams input[value="2"]').checked = true;
    c.d.getElementById('qwAdd').click(); await tick(300);
    const post = c.calls.find((x) => x.method === 'POST' && x.u.endsWith('/api/quote-wa/recipients'));
    assert.deepEqual(post.body, { name: 'Oscar', phone: '9991234567', lang: 'es', team_ids: [2] });
    assert.match(c.d.getElementById('qwRecips').textContent, /Oscar/);
    const cb = c.d.querySelector('tr[data-id="7"] input[data-act="team"][value="1"]');
    cb.checked = true; cb.dispatchEvent(new c.w.Event('change', { bubbles: true })); await tick(200);
    const pat = c.calls.find((x) => x.method === 'PATCH');
    assert.ok(pat.u.endsWith('/api/quote-wa/recipients/7')); assert.deepEqual(pat.body, { team_ids: [1] });
    c.d.querySelector('tr[data-id="7"] button[data-act="test"]').click(); await tick(200);
    const send = c.calls.find((x) => x.u.includes('/api/quote-wa/send'));
    assert.deepEqual(send.body, { recipient_id: 7 });
    assert.match(c.d.getElementById('qwMsg').textContent, /보냈습니다 — Q-2026-0502/);
    c.d.getElementById('qwClose').click();
    assert.ok(!c.d.getElementById('qwModal').classList.contains('on'));
    c.close();
  });

  await t.test('③ 디렉터가 아니면 버튼이 없고 API 도 부르지 않는다', async () => {
    const c = boot('sales'); await c.ready; await tick(500);
    assert.equal(c.d.getElementById('qwOpen'), null);
    assert.ok(!c.calls.some((x) => x.u.includes('/api/quote-wa/')));
    c.close();
  });

  await t.test('④ 새 코드에 인라인 onclick 없음', () => {
    const html = readFileSync(L_HTML, 'utf-8');
    const blk = html.slice(html.indexOf('0256 신규 견적 WhatsApp 알림 — 디렉터 전용'));
    assert.ok(!/onclick=/.test(blk));
  });
});
