// =====================================================================
// wa_platform_front.test.mjs — REFATRIX Platform(Netlify) marketing.html (0282 · 2026-10-16)
//   원본 templates/marketing_platform.html 을 jsdom 으로 띄우고 fetch 만 스텁.
//   ① 플랫폼 세션 → /api/pf-images/login (토큰 · 이름 · 사용자 키) → 내 목록
//   ② 플랫폼 세션 없음 → 안내 + 플랫폼 링크(ERP 호출 없음)
//   ③ 여러 장 올리기(설명 붙음 · 중복 표시) · 지우기 · 401 → 재확인 후 이어서
//   ④ 플랫폼에서 다른 사람으로 로그인 → 새로 확인 · 인라인 onclick 없음 · ERP 주소 노출 최소
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = resolve(here, '..', 'templates', 'marketing_platform.html');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* skip */ }
const SKIP = !JSDOM || !existsSync(HTML);
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const T1 = 'aaaaaaaa-1111-4111-8111-111111111111';

function boot({ pf = { t: T1, e: Date.now() + 3600e3, u: { id: 7, name: 'Kim HQ' } }, cached = null, expire = 0 } = {}) {
  const calls = []; let items = [
    { id: 11, name: 'buenfin.jpg', mime: 'image/jpeg', size: 300000, width: 1080, height: 1350, memo: 'Buen Fin', created_mx: '2026-10-16T10:00:00', has_thumb: true, removed: false },
    { id: 10, name: 'viejo.png', mime: 'image/png', size: 9000, memo: null, created_mx: '2026-10-01T10:00:00', has_thumb: false, removed: true },
  ];
  let left401 = expire; let n = 0;
  const dom = new JSDOM(readFileSync(HTML, 'utf-8'), {
    runScripts: 'dangerously', url: 'https://refatrix-platform.netlify.app/marketing.html',
    beforeParse(w) {
      if (pf) w.sessionStorage.setItem('rfx_sess', JSON.stringify(pf));
      if (cached) w.sessionStorage.setItem('rfx_pf_images', JSON.stringify(cached));
      w.confirm = () => true; w.URL.createObjectURL = () => 'blob:x';
      w.fetch = async (url, opt = {}) => {
        const u = String(url); const method = opt.method || 'GET'; const body = opt.body ? JSON.parse(opt.body) : null;
        calls.push({ u, method, body, auth: (opt.headers || {}).Authorization || null });
        const json = (d, s = 200) => ({ ok: s < 400, status: s, json: async () => d, blob: async () => new w.Blob(['x']) });
        if (u.endsWith('/api/pf-images/login')) return json({ token: 'PF' + (++n), name: body.name, folder: '본사(CTR)' });
        if (left401 > 0 && !u.endsWith('/login')) { left401--; return json({ error: 'unauthorized' }, 401); }
        if (u.match(/\/api\/pf-images\/\d+\/thumb/)) return json({});
        if (u.match(/\/api\/pf-images\/\d+$/) && method === 'DELETE') { items = items.filter((x) => x.id !== Number(u.split('/').pop())); return json({ ok: true }); }
        if (u.endsWith('/api/pf-images') && method === 'POST') {
          if (body.name === 'dup.png') return json({ id: 11, duplicate: true });
          const id = 20 + items.length; items = [{ id, name: body.name, mime: body.mime, size: 10, memo: body.memo || null, created_mx: '2026-10-16T11:00:00', removed: false }, ...items];
          return json({ id, duplicate: false });
        }
        if (u.endsWith('/api/pf-images')) return json({ name: 'Kim HQ', folder: '본사(CTR)', items });
        return json({ error: 'nope' }, 404);
      };
    },
  });
  const w = dom.window;
  return { w, d: w.document, calls, close: () => w.close() };
}

test('marketing.html (REFATRIX Platform)', { skip: SKIP && 'jsdom 없음' }, async (t) => {
  await t.test('① 플랫폼 세션 → 로그인 → 내 목록', async () => {
    const c = boot(); await tick();
    const lg = c.calls.find((x) => x.u.endsWith('/api/pf-images/login'));
    assert.deepEqual(lg.body, { token: T1, name: 'Kim HQ', user_key: '7' });
    assert.ok(!c.d.getElementById('app').classList.contains('hidden'));
    assert.equal(c.d.querySelectorAll('#list .it').length, 2);
    assert.match(c.d.getElementById('list').textContent, /ERP 저장됨/);
    assert.match(c.d.getElementById('list').textContent, /ERP 에서 정리됨/);
    assert.equal(c.d.querySelectorAll('[data-del]').length, 1, '정리된 것은 지우기 없음');
    assert.match(c.d.getElementById('cnt').textContent, /1장/);
    assert.ok(c.calls.filter((x) => x.u.endsWith('/api/pf-images') && x.method === 'GET').every((x) => x.auth === 'Bearer PF1'));
    assert.ok(!/사용 \d+회|도착|답장/.test(c.d.getElementById('list').textContent), '광고 결과 없음');
    // 보기 크기
    c.d.querySelector('#view button[data-v="sm"]').click(); assert.ok(c.d.querySelector('#list .grid.sm'));
    // 검색
    const q = c.d.getElementById('q'); q.value = 'buen'; q.dispatchEvent(new c.w.Event('input'));
    assert.equal(c.d.querySelectorAll('#list .it').length, 1);
    c.close();
  });

  await t.test('② 플랫폼 세션 없음 / 만료 → 안내 + 플랫폼 링크 · ERP 호출 없음', async () => {
    for (const pf of [null, { t: T1, e: Date.now() - 1000, u: {} }]) {
      const c = boot({ pf }); await tick();
      assert.equal(c.calls.length, 0);
      assert.ok(c.d.getElementById('app').classList.contains('hidden'));
      assert.match(c.d.getElementById('gate').textContent, /로그인한 뒤/);
      assert.equal(c.d.querySelector('#gate a').getAttribute('target'), '_top');
      c.close();
    }
  });

  await t.test('③ 여러 장 올리기(설명 · 중복) · 지우기 · 401 → 재확인', async () => {
    const c = boot({ expire: 1 }); await tick(250);
    assert.equal(c.calls.filter((x) => x.u.endsWith('/login')).length, 2, '401 → 플랫폼 세션으로 다시 확인');
    assert.equal(c.d.querySelectorAll('#list .it').length, 2);
    c.d.getElementById('memo').value = '  Versa 2015-2019  ';
    const File = c.w.File;
    const fs = [new File(['a'], 'a.png', { type: 'image/png' }), new File(['b'], 'dup.png', { type: 'image/png' }), new File(['c'], 'notes.txt', { type: 'text/plain' })];
    const ev = new c.w.Event('drop', { bubbles: true }); ev.dataTransfer = { files: fs };
    c.d.getElementById('drop').dispatchEvent(ev); await tick(400);
    const ups = c.calls.filter((x) => x.u.endsWith('/api/pf-images') && x.method === 'POST');
    assert.equal(ups.length, 2, '이미지만');
    assert.ok(ups.every((x) => x.body.memo === 'Versa 2015-2019' && x.body.mime === 'image/png' && x.body.image_b64));
    assert.match(c.d.getElementById('progT').textContent, /저장 1장 · 이미 있던 같은 파일 1장/);
    assert.equal(c.d.querySelectorAll('#list .it').length, 3);
    c.d.querySelector('[data-del="11"]').click(); await tick();
    assert.ok(c.calls.some((x) => x.method === 'DELETE' && x.u.endsWith('/api/pf-images/11')));
    assert.match(c.d.getElementById('msg').textContent, /지웠습니다/);
    c.close();
  });

  await t.test('④ 다른 사람으로 로그인 → 새로 확인 · 같은 세션이면 그대로 · 인라인 onclick 없음', async () => {
    const c1 = boot({ cached: { token: 'OLD', name: 'Lee', pt: 'cccccccc-1111-4111-8111-111111111111' } }); await tick();
    assert.equal(c1.calls.filter((x) => x.u.endsWith('/login')).length, 1, '플랫폼 세션이 바뀜 → 새로 확인');
    assert.match(c1.d.getElementById('who').textContent, /Kim HQ/);
    c1.close();
    const c2 = boot({ cached: { token: 'KEEP', name: 'Kim HQ', pt: T1 } }); await tick();
    assert.equal(c2.calls.filter((x) => x.u.endsWith('/login')).length, 0);
    assert.equal(c2.calls[0].auth, 'Bearer KEEP');
    c2.close();
    const src = readFileSync(HTML, 'utf-8');
    assert.ok(!/onclick=/.test(src));
    assert.ok(!/erp\.refatrix\.com/.test(src), 'ERP 화면 주소 노출 없음');
  });
});
