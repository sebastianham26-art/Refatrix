// ERP → CRM 프로모션 배너 연동 — 0237
//
//   이 시험이 잠그는 것
//   ① 배너 이미지의 가로·세로를 파일 머리에서 **직접** 읽는다(PNG·JPEG·GIF·WEBP) — 확장자를 믿지 않는다.
//   ② 본문은 한 함수(buildPromoPayload)가 만든다 — 실제 전송 · 미리보기 · 연결 테스트가 같은 모양.
//   ③ 창구 1개 = CRM 1곳. 고른 창구 전부에 1건씩, 꺼진 창구는 대기로 남는다(시도 횟수 안 씀).
//   ④ 전송된 프로모션을 고치면 저장만으로 다시 나가고(버전 +1), 대기 중이던 옛 버전은 건너뜀으로 닫힌다.
//   ⑤ 대상에서 뺀 곳 · 취소 · 종료일 경과 → 내리기(delete) — DELETE 면 주소에 ?promocionId= 가 붙는다.
//   ⑥ 공개 배너 주소는 내용 해시가 맞을 때만, 한 번이라도 전송된 건만 내준다.
//
//   실행: TEST_PG_URL=postgres://... node --test test/crm_promotions.test.mjs
//         (TEST_PG_URL 이 없으면 ①②⑤ 의 순수 규칙만 돈다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.PUBLIC_API_URL = 'https://erp.example.test/';
process.env.CRM_SYNC_GAP_MS = '0';

const S = await import('../src/promoSync.js');

// ── 시험용 이미지 ──────────────────────────────────────────────
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function makePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function makeJpeg(w, h) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
function makeGif(w, h) {
  const b = Buffer.alloc(32); b.write('GIF89a', 0, 'ascii'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b;
}
function makeWebpX(w, h) {
  const b = Buffer.alloc(40); b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(32, 4); b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii'); b.writeUInt32LE(10, 16); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b;
}
const dataUrl = (buf, mime) => `data:${mime};base64,${buf.toString('base64')}`;

// ── ① 이미지 크기 ─────────────────────────────────────────────
test('이미지 가로·세로를 파일 머리에서 읽는다 (PNG·JPEG·GIF·WEBP)', () => {
  assert.deepEqual(S.imageSize(makePng(1200, 400)), { mime: 'image/png', width: 1200, height: 400 });
  assert.deepEqual(S.imageSize(makeJpeg(1920, 600)), { mime: 'image/jpeg', width: 1920, height: 600 });
  assert.deepEqual(S.imageSize(makeGif(728, 90)), { mime: 'image/gif', width: 728, height: 90 });
  assert.deepEqual(S.imageSize(makeWebpX(1080, 1080)), { mime: 'image/webp', width: 1080, height: 1080 });
  assert.equal(S.imageSize(Buffer.from('not an image at all, really not')), null);
});

test('data URL 검사 — SVG·PDF 거절, 5MB 초과 거절, 이름만 png 인 jpeg 는 실제 형식으로', () => {
  const ok = S.decodeBannerDataUrl(dataUrl(makePng(1200, 400), 'image/png'));
  assert.equal(ok.ok, true); assert.equal(ok.width, 1200); assert.equal(ok.height, 400);
  assert.equal(S.decodeBannerDataUrl(dataUrl(Buffer.from('<svg/>'), 'image/svg+xml')).error, 'image_bad_mime', 'SVG 는 스크립트를 품을 수 있다');
  assert.equal(S.decodeBannerDataUrl(dataUrl(Buffer.from('%PDF-1.4'), 'application/pdf')).error, 'image_bad_mime');
  assert.equal(S.decodeBannerDataUrl(dataUrl(makePng(200, 200), 'image/png'), 100).error, 'image_too_large');
  assert.equal(S.decodeBannerDataUrl('data:image/png;base64,' + Buffer.from('garbage-garbage-garbage-garbage').toString('base64')).error, 'image_unreadable');
  const liar = S.decodeBannerDataUrl(dataUrl(makeJpeg(800, 200), 'image/png'));
  assert.equal(liar.mime, 'image/jpeg', '확장자가 아니라 파일 내용이 형식을 정한다');
  assert.equal(S.decodeBannerDataUrl('hola').error, 'image_bad_format');
});

// ── ② 규칙 · 본문 ────────────────────────────────────────────
test('입력 검사 — 저장 기준과 전송 기준이 다르다', () => {
  const base = { title: 'Octubre -15%', promo_type: 'porcentaje', discount_value: 15, start_date: '2026-10-01', end_date: '2026-10-31' };
  assert.equal(S.validatePromo(base), null);
  assert.equal(S.validatePromo({ ...base, title: ' ' }), 'title_required');
  assert.equal(S.validatePromo({ ...base, discount_value: '' }), 'value_required');
  assert.equal(S.validatePromo({ ...base, discount_value: 120 }), 'value_pct_range');
  assert.equal(S.validatePromo({ ...base, promo_type: 'monto', discount_value: 500 }), null, '금액 할인은 100 을 넘어도 된다');
  assert.equal(S.validatePromo({ ...base, promo_type: 'otro', discount_value: '' }), null, '기타는 값이 없어도 된다');
  assert.equal(S.validatePromo({ ...base, end_date: '2026-09-30' }), 'date_order');
  assert.equal(S.validatePromo({ ...base, start_date: '2026-02-30' }), 'date_invalid', '없는 날짜');
  assert.equal(S.validatePromo({ ...base, link_url: 'refatrix.com' }), 'link_invalid');
  assert.equal(S.validatePromo({ ...base, priority: 1.5 }), 'priority_invalid');
  assert.equal(S.validatePromo(base, { publish: true, hasImage: false }), 'image_required', '저장은 되지만 전송은 안 된다');
  assert.equal(S.validatePromo({ ...base, targets: [] }, { publish: true, hasImage: true }), 'targets_required');
  assert.equal(S.validatePromo({ ...base, targets: ['promo_crm'] }, { publish: true, hasImage: true }), null);
});

test('상태 — 멕시코 날짜 기준, 시작·종료일 포함', () => {
  const p = { status: 'published', start_date: '2026-10-01', end_date: '2026-10-31' };
  assert.equal(S.promoPhase(p, '2026-09-30'), 'scheduled');
  assert.equal(S.promoPhase(p, '2026-10-01'), 'active');
  assert.equal(S.promoPhase(p, '2026-10-31'), 'active', '종료일 당일은 아직 진행 중');
  assert.equal(S.promoPhase(p, '2026-11-01'), 'ended');
  assert.equal(S.promoPhase({ ...p, status: 'draft' }, '2026-10-05'), 'draft');
  assert.equal(S.promoPhase({ ...p, status: 'cancelled' }, '2026-10-05'), 'cancelled');
});

const P = { id: 7, version: 3, title: 'Octubre CTR -15%', description: 'Terminales', promo_type: 'porcentaje',
  discount_value: '15.00', conditions: 'Min 5,000', start_date: '2026-10-01', end_date: '2026-10-31',
  link_url: '', priority: 20, image_mime: 'image/png', image_w: 1200, image_h: 400,
  image_sha: 'abcdef0123456789ffffffffffffffffffffffffffffffffffffffffffffffff' };

test('본문 — 등록·갱신', () => {
  const b = S.buildPromoPayload(P, { user: 'sebastian' });
  assert.equal(b.promocionId, 'PR-000007');
  assert.equal(b.version, 3);
  assert.equal(b.estatus, 'activa');
  assert.equal(b.valorDescuento, 15, 'NUMERIC 문자열은 숫자로');
  assert.equal(b.fechaInicio, '2026-10-01'); assert.equal(b.fechaFin, '2026-10-31');
  assert.equal(b.zonaHoraria, 'America/Mexico_City');
  assert.equal(b.bannerUrl, 'https://erp.example.test/api/public/promo-banners/7-abcdef0123456789.png',
    '공개 주소 끝의 / 는 한 번만 · 파일 이름에 내용 해시 16자');
  assert.equal(b.bannerAncho, 1200); assert.equal(b.bannerAlto, 400); assert.equal(b.bannerTipo, 'image/png');
  assert.equal(b.prioridad, 20); assert.equal(b.transactionUser, 'sebastian');
  assert.equal(S.buildPromoPayload({ ...P, promo_type: 'otro' }).valorDescuento, null);
});

test('본문 — 내리기(취소·종료)는 최소 필드만', () => {
  assert.deepEqual(S.buildPromoPayload(P, { op: 'delete', user: 'x' }),
    { promocionId: 'PR-000007', version: 3, estatus: 'cancelada', transactionUser: 'x' });
  assert.equal(S.buildPromoPayload(P, { op: 'delete', reason: 'finalizada' }).estatus, 'finalizada');
});

test('필드 이름 바꾸기 — 이름 변경 · 빈 값은 빼기 · 나머지 그대로', () => {
  const b = S.buildPromoPayload(P, { map: { titulo: 'title', enlace: '', bannerUrl: 'imageUrl' } });
  assert.equal(b.title, 'Octubre CTR -15%'); assert.equal(b.titulo, undefined);
  assert.ok(!('enlace' in b), '빈 이름 = 보내지 않는다');
  assert.ok(b.imageUrl.endsWith('.png')); assert.equal(b.promocionId, 'PR-000007');
});

test('공개 파일 이름 해석 — 모양이 틀리면 null', () => {
  assert.deepEqual(S.parseBannerFile('7-abcdef0123456789.png'), { id: 7, sha16: 'abcdef0123456789', ext: 'png' });
  assert.equal(S.parseBannerFile('7-abc.png'), null);
  assert.equal(S.parseBannerFile('../etc/passwd'), null);
  assert.equal(S.parseBannerFile('7-ABCDEF0123456789.png'), null, '해시는 소문자 16진수만');
});

test('창구 규격 대조 — 비어 있으면 검사하지 않는다', () => {
  assert.equal(S.sizeCheck(P, { banner_w: null, banner_h: null }).ok, true);
  assert.equal(S.sizeCheck(P, { banner_w: 1200, banner_h: 400 }).ok, true);
  const c = S.sizeCheck(P, { banner_w: 1920, banner_h: 600 });
  assert.equal(c.ok, false); assert.deepEqual(c.required, { w: 1920, h: 600 }); assert.deepEqual(c.actual, { w: 1200, h: 400 });
});

test('DELETE 로 내릴 때 주소에 ?promocionId= 를 붙인다(본문을 무시하는 서버 대비) — 고객 rfc 규칙은 그대로', async () => {
  const got = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => { got.push({ method: req.method, url: req.url, body }); res.setHeader('Content-Type', 'application/json'); res.end('{"codigoError":"0"}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { sendPayload } = await import('../src/crmSync.js');
  const ep = { env: 'test', url_test: `http://127.0.0.1:${srv.address().port}/promo?x=1`, method_upsert: 'POST', method_delete: 'DELETE', timeout_ms: 3000 };
  await sendPayload(ep, 'delete', { promocionId: 'PR-000007', estatus: 'cancelada' });
  await sendPayload(ep, 'delete', { rfc: 'ABC010101AA1' });
  await sendPayload(ep, 'upsert', { promocionId: 'PR-000007' });
  srv.close();
  assert.equal(got[0].method, 'DELETE'); assert.equal(got[0].url, '/promo?x=1&promocionId=PR-000007');
  assert.equal(JSON.parse(got[0].body).estatus, 'cancelada', '본문에도 그대로 싣는다');
  assert.equal(got[1].url, '/promo?x=1&rfc=ABC010101AA1', '고객 삭제는 예전과 같다');
  assert.equal(got[2].url, '/promo?x=1', '등록은 주소를 건드리지 않는다');
});

test('설정 화면 규칙 — 배너 규격 검사', async () => {
  const { validatePatch } = await import('../src/integrations.js');
  assert.equal(validatePatch({ banner_w: 1200, banner_h: 400 }), null);
  assert.equal(validatePatch({ banner_w: '', banner_h: '' }), null, '비우면 검사 안 함');
  assert.equal(validatePatch({ banner_w: 5, banner_h: 400 }), 'banner_size_invalid');
  assert.equal(validatePatch({ banner_w: 1200.5 }), 'banner_size_invalid');
});

test('서버 등록 — 라우트·감시 둘 다 (등록이 빠지면 조용히 안 돈다: 0209 사고)', () => {
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.ok(/import promoRoutes from '\.\/routes\/promoRoutes\.js'/.test(src));
  assert.ok(/app\.register\(promoRoutes\)/.test(src));
  assert.ok(/startPromoWorker\(app\)/.test(src));
});

// ── ③~⑥ 실 DB + 실제 라우트 + 가짜 CRM 3곳 ─────────────────────
test('실 DB — 등록 · 여러 CRM 전송 · 수정 재전송 · 대상 제외 · 취소 · 종료 자동 내리기 · 공개 배너', { skip: !PG }, async (t) => {
  const { query, pool } = await import('../src/db.js');
  const { drainOutbox } = await import('../src/crmSync.js');
  const { invalidateEndpointCache } = await import('../src/integrations.js');
  const Fastify = (await import('fastify')).default;
  const fastifyJwt = (await import('@fastify/jwt')).default;

  const got = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      got.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/fail')) { res.statusCode = 500; res.end('{"codigoError":"ERR_INTERNAL","mensaje":"boom"}'); return; }
      res.end('{"codigoError":"0","mensaje":"OK"}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const KEY = 'k-commercial-0237';

  // 정리
  const clean = async () => {
    await query(`DELETE FROM crm_customer_outbox WHERE entity='promo'`);
    await query(`DELETE FROM crm_promotions`);
    await query(`DELETE FROM integration_endpoints WHERE key IN ('promo_b','promo_off')`);
  };
  await clean();
  // A = 기본 창구(키는 상거래정보에서 물려받는다) · B = 새로 만든 창구(자기 키·헤더) · OFF = 꺼진 창구
  await query(`UPDATE integration_endpoints SET auth_in='query', auth_param='apiKey', auth_token_test=$1 WHERE key='customer_commercial'`, [KEY]);
  await query(`UPDATE integration_endpoints SET enabled=true, env='test', url_test=$1, banner_w=1200, banner_h=400,
                 auth_in='query', auth_param='apiKey', field_map='{}'::jsonb WHERE key='promo_crm'`, [base + '/a/promociones']);
  const dirId = Number(((await query(`SELECT id FROM users WHERE login_id='t_promo_dir'`)).rows[0]
    || (await query(`INSERT INTO users (login_id, name, role, pin_hash) VALUES ('t_promo_dir','프로모션 디렉터','director','x') RETURNING id`)).rows[0]).id);
  const salesId = Number(((await query(`SELECT id FROM users WHERE login_id='t_promo_sales'`)).rows[0]
    || (await query(`INSERT INTO users (login_id, name, role, pin_hash) VALUES ('t_promo_sales','영업','sales','x') RETURNING id`)).rows[0]).id);
  invalidateEndpointCache();

  const app = Fastify({ bodyLimit: 12 * 1024 * 1024 });
  await app.register(fastifyJwt, { secret: 'test-secret-0237' });
  await app.register((await import('../src/routes/integrationRoutes.js')).default);
  await app.register((await import('../src/routes/crmSyncRoutes.js')).default);
  await app.register((await import('../src/routes/promoRoutes.js')).default);
  await app.ready();
  const tok = app.jwt.sign({ sub: dirId });
  const as = (method, url, payload, who = tok) => app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + who } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => {
    await sleep(80);
    for (let i = 0; i < 30; i++) {
      const d = await drainOutbox({ limit: 50 });
      if (d.busy) { await sleep(60); continue; }
      if (!d.drained) break;
    }
  };
  const today = (await query(`SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date,'YYYY-MM-DD') d`)).rows[0].d;
  const plus = (n) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  t.after(async () => {
    try { await clean(); } catch (e) { console.error('cleanup', e.message); }
    await query(`UPDATE integration_endpoints SET enabled=false, url_test=NULL, banner_w=NULL, banner_h=NULL WHERE key='promo_crm'`);
    await query(`UPDATE integration_endpoints SET auth_token_test=NULL, auth_in='header' WHERE key='customer_commercial'`);
    await app.close(); srv.close(); await pool.end();
  });

  await t.test('디렉터 전용 — 영업 계정은 403', async () => {
    const r = await as('GET', '/api/promotions', null, app.jwt.sign({ sub: salesId }));
    assert.equal(r.statusCode, 403);
  });

  await t.test('창구 추가 = 기존 「새 연동」 + 분류 promotion', async () => {
    let r = await as('POST', '/api/integrations', { key: 'promo_b', label: '고객사 B 포털', category: 'promotion' });
    assert.equal(r.statusCode, 200, r.body);
    r = await as('POST', '/api/integrations', { key: 'promo_off', label: '꺼진 곳', category: 'promotion' });
    assert.equal(r.statusCode, 200);
    r = await as('PUT', '/api/integrations/promo_b', { enabled: true, env: 'test', url_test: base + '/b/banner', auth_in: 'header',
      auth_header: 'x-api-key', auth_token_test: 'x-api-key: kb-123', banner_w: 1920, banner_h: 600,
      field_map: { titulo: 'title', enlace: '' } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(JSON.parse(r.body).endpoint.banner_w, 1920);
    r = await as('PUT', '/api/integrations/promo_off', { url_test: base + '/off' });
    assert.equal(r.statusCode, 200);
    r = await as('PUT', '/api/integrations/promo_b', { banner_w: 3 });
    assert.equal(JSON.parse(r.body).error, 'banner_size_invalid');
    const tg = JSON.parse((await as('GET', '/api/promotions/targets')).body).items;
    const a = tg.find((x) => x.key === 'promo_crm');
    assert.ok(a && a.has_token, '기본 창구는 상거래정보의 키를 물려받는다');
    assert.equal(a.token_borrowed_label, '고객 상거래정보');
    assert.deepEqual(tg.map((x) => x.key).sort(), ['promo_b', 'promo_crm', 'promo_off'], '프로모션 창구만');
  });

  let id = null;
  const img = dataUrl(makePng(1200, 400), 'image/png');
  const body = { title: 'Octubre CTR -15%', description: 'Terminales y rótulas', promo_type: 'porcentaje', discount_value: 15,
    conditions: 'Min 5,000', start_date: today, end_date: plus(30), priority: 10, link_url: 'https://refatrix.com.mx/promo' };

  await t.test('이미지 없이 전송은 막고, 초안 저장은 된다(아무것도 안 나간다)', async () => {
    let r = await as('POST', '/api/promotions', { ...body, targets: ['promo_crm'], publish: true });
    assert.equal(JSON.parse(r.body).error, 'image_required');
    r = await as('POST', '/api/promotions', { ...body, targets: ['promo_crm', 'promo_b', 'promo_off'], image_data_url: img, image_name: 'oct.png' });
    assert.equal(r.statusCode, 200, r.body);
    const d = JSON.parse(r.body);
    id = d.promo.id;
    assert.equal(d.promo.status, 'draft'); assert.equal(d.sent, null);
    assert.equal(d.promo.image.w, 1200); assert.equal(d.promo.image.h, 400);
    assert.deepEqual(d.promo.size_warnings.map((x) => x.key), ['promo_b'], 'B 규격(1920×600)과 다르다고 알려 준다');
    assert.equal(Number((await query(`SELECT count(*) n FROM crm_customer_outbox WHERE entity='promo'`)).rows[0].n), 0);
    const pub = await app.inject({ method: 'GET', url: '/api/public/promo-banners/' + d.promo.image.url.split('/').pop() });
    assert.equal(pub.statusCode, 404, '한 번도 전송하지 않은 초안의 그림은 공개하지 않는다');
    const priv = await as('GET', `/api/promotions/${id}/image`);
    assert.equal(priv.statusCode, 200); assert.equal(priv.headers['content-type'], 'image/png');
  });

  await t.test('지난 종료일·엉뚱한 창구는 거절', async () => {
    let r = await as('PUT', `/api/promotions/${id}`, { ...body, end_date: plus(-1), start_date: plus(-5), targets: ['promo_crm'], publish: true });
    assert.equal(JSON.parse(r.body).error, 'date_past');
    r = await as('PUT', `/api/promotions/${id}`, { ...body, targets: ['customer_commercial'], publish: true });
    assert.equal(JSON.parse(r.body).error, 'targets_invalid', '고객 창구로 프로모션을 보내면 안 된다');
  });

  let bannerPath = null;
  await t.test('저장하고 전송 — 켜진 두 곳은 즉시, 꺼진 곳은 대기', async () => {
    got.length = 0;
    const r = await as('PUT', `/api/promotions/${id}`, { ...body, targets: ['promo_crm', 'promo_b', 'promo_off'], publish: true });
    assert.equal(r.statusCode, 200, r.body);
    const d = JSON.parse(r.body);
    assert.equal(d.sent.version, 1); assert.equal(d.promo.status, 'published'); assert.equal(d.promo.phase, 'active');
    await settle();
    const a = got.find((g) => g.url.startsWith('/a/'));
    const b = got.find((g) => g.url.startsWith('/b/'));
    assert.ok(a && b, '두 CRM 모두 받았다');
    assert.equal(got.filter((g) => g.url.startsWith('/off')).length, 0, '꺼진 창구로는 안 나간다');
    assert.equal(a.method, 'POST'); assert.ok(a.url.includes('apiKey=' + KEY), 'A 는 물려받은 키를 쿼리로');
    assert.equal(b.headers['x-api-key'], 'kb-123', 'B 는 자기 키를 헤더로(붙여넣기 이름은 떼어낸다)');
    assert.equal(a.body.promocionId, 'PR-' + String(id).padStart(6, '0'));
    assert.equal(a.body.estatus, 'activa'); assert.equal(a.body.version, 1);
    assert.equal(a.body.titulo, 'Octubre CTR -15%'); assert.equal(a.body.valorDescuento, 15);
    assert.equal(a.body.fechaInicio, today); assert.equal(a.body.fechaFin, plus(30));
    assert.equal(a.body.enlace, 'https://refatrix.com.mx/promo');
    assert.ok(a.body.bannerUrl.startsWith('https://erp.example.test/api/public/promo-banners/' + id + '-'));
    assert.equal(b.body.title, 'Octubre CTR -15%', 'B 는 이름 바꾸기가 적용된다'); assert.ok(!('enlace' in b.body));
    bannerPath = a.body.bannerUrl.replace('https://erp.example.test', '');
    const st = (await query(`SELECT endpoint_key, status, attempts FROM crm_customer_outbox WHERE entity='promo' ORDER BY endpoint_key`)).rows;
    assert.deepEqual(st.map((x) => [x.endpoint_key, x.status, Number(x.attempts)]),
      [['promo_b', 'sent', 1], ['promo_crm', 'sent', 1], ['promo_off', 'pending', 0]], '꺼진 곳은 시도 횟수를 쓰지 않는다');
  });

  await t.test('공개 배너 — 해시가 맞을 때만, 캐시 영구', async () => {
    const r = await app.inject({ method: 'GET', url: bannerPath });
    assert.equal(r.statusCode, 200); assert.equal(r.headers['content-type'], 'image/png');
    assert.match(String(r.headers['cache-control']), /immutable/);
    assert.equal(S.imageSize(r.rawPayload).width, 1200);
    const wrong = bannerPath.replace(/-[0-9a-f]{16}\./, '-0000000000000000.');
    assert.equal((await app.inject({ method: 'GET', url: wrong })).statusCode, 404);
  });

  await t.test('전송된 건을 고쳐 저장만 해도 다시 나간다(버전 2) · 대기 중이던 옛 버전은 건너뜀', async () => {
    got.length = 0;
    const r = await as('PUT', `/api/promotions/${id}`, { ...body, title: 'Octubre CTR -20%', discount_value: 20,
      targets: ['promo_crm', 'promo_b', 'promo_off'], image_data_url: dataUrl(makePng(1920, 600), 'image/png') });
    const d = JSON.parse(r.body);
    assert.equal(d.sent.version, 2); assert.equal(d.sent.replaced, 1, 'OFF 의 옛 대기 건');
    await settle();
    const a = got.find((g) => g.url.startsWith('/a/'));
    assert.equal(a.body.version, 2); assert.equal(a.body.titulo, 'Octubre CTR -20%');
    assert.notEqual(a.body.bannerUrl.replace('https://erp.example.test', ''), bannerPath, '그림이 바뀌면 주소도 바뀐다');
    assert.equal((await app.inject({ method: 'GET', url: bannerPath })).statusCode, 404, '옛 그림 주소는 닫힌다');
    const off = (await query(`SELECT status, last_error FROM crm_customer_outbox WHERE entity='promo' AND endpoint_key='promo_off' ORDER BY id`)).rows;
    assert.deepEqual(off.map((x) => x.status), ['skipped', 'pending']);
    assert.match(off[0].last_error, /새 버전/);
    assert.deepEqual(d.promo.size_warnings.map((x) => x.key), ['promo_crm'], '이제는 A(1200×400)와 다르다');
  });

  await t.test('대상에서 뺀 곳에는 내리기(DELETE ?promocionId=)', async () => {
    got.length = 0;
    const r = await as('PUT', `/api/promotions/${id}`, { ...body, title: 'Octubre CTR -20%', discount_value: 20, targets: ['promo_crm', 'promo_off'] });
    const d = JSON.parse(r.body);
    assert.deepEqual(d.sent.removed_from, ['promo_b']);
    await settle();
    const del = got.find((g) => g.url.startsWith('/b/'));
    assert.equal(del.method, 'DELETE');
    assert.ok(del.url.includes('promocionId=PR-'), del.url);
    assert.equal(del.body.estatus, 'cancelada');
    const dl = JSON.parse((await as('GET', `/api/promotions/${id}`)).body).deliveries;
    assert.equal(dl.find((x) => x.endpoint_key === 'promo_b').op, 'delete');
  });

  await t.test('미리보기 = 다음 전송 본문(보내지 않음) · 연결 테스트는 프로모션 본문', async () => {
    got.length = 0;
    const pv = JSON.parse((await as('GET', `/api/promotions/${id}/preview?endpoint=promo_crm`)).body);
    assert.equal(pv.upsert.version, 4); assert.equal(pv.delete.estatus, 'cancelada');
    await settle();
    assert.equal(got.length, 0);
    const t1 = JSON.parse((await as('POST', '/api/integrations/promo_crm/test', {})).body);
    assert.equal(t1.ok, true);
    assert.equal(t1.request.payload.promocionId, 'PR-' + String(id).padStart(6, '0'), '고객 본문이 아니라 프로모션 본문');
    assert.ok(!('rfc' in t1.request.payload));
    assert.equal(Number((await query(`SELECT count(*) n FROM crm_customer_outbox WHERE entity='promo' AND origin LIKE '%test%'`)).rows[0].n), 0, '시험은 이력에 남기지 않는다');
  });

  await t.test('실패하면 재시도 대기 · 기존 재전송 버튼이 그대로 동작', async () => {
    await query(`UPDATE integration_endpoints SET url_test=$1 WHERE key='promo_crm'`, [base + '/fail']);
    invalidateEndpointCache();
    await as('POST', `/api/promotions/${id}/publish`, {});
    await settle();
    const row = (await query(`SELECT id, status, attempts, last_error FROM crm_customer_outbox WHERE entity='promo' AND endpoint_key='promo_crm' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.equal(row.status, 'pending'); assert.equal(Number(row.attempts), 1); assert.match(row.last_error, /boom/);
    await query(`UPDATE integration_endpoints SET url_test=$1 WHERE key='promo_crm'`, [base + '/a/promociones']);
    await query(`UPDATE crm_customer_outbox SET status='failed' WHERE id=$1`, [row.id]);
    invalidateEndpointCache();
    const r = JSON.parse((await as('POST', `/api/crm-sync/${row.id}/retry`, {})).body);
    assert.equal(r.result.status, 'sent');
  });

  await t.test('취소 → 나간 곳 전부 내리기 · 다시 취소는 409', async () => {
    got.length = 0;
    const r = JSON.parse((await as('POST', `/api/promotions/${id}/cancel`, {})).body);
    assert.deepEqual(r.withdrawn_from.sort(), ['promo_b', 'promo_crm', 'promo_off']);
    await settle();
    const a = got.find((g) => g.url.startsWith('/a/'));
    assert.equal(a.method, 'DELETE'); assert.equal(a.body.estatus, 'cancelada');
    assert.equal((await as('POST', `/api/promotions/${id}/cancel`, {})).statusCode, 409);
    const p = JSON.parse((await as('GET', `/api/promotions/${id}`)).body).promo;
    assert.equal(p.status, 'cancelled'); assert.equal(p.phase, 'cancelled');
  });

  await t.test('종료일이 지나면 한 번만 자동으로 내린다(finalizada)', async () => {
    const pid = Number((await query(
      `INSERT INTO crm_promotions (title, promo_type, discount_value, start_date, end_date, status, version, published_at, image, image_mime, image_sha, image_w, image_h)
       VALUES ('Sept', 'porcentaje', 10, $1::date, $2::date, 'published', 1, now(), '\\x00', 'image/png', repeat('a',64), 10, 10) RETURNING id`,
      [plus(-10), plus(-1)])).rows[0].id);
    await query(`INSERT INTO crm_promotion_targets (promotion_id, endpoint_key) VALUES ($1,'promo_crm')`, [pid]);
    await query(`INSERT INTO crm_customer_outbox (customer_id, entity, entity_id, entity_label, endpoint_key, op, origin, payload, status)
                 VALUES (NULL,'promo',$1,'x','promo_crm','upsert','promo_publish','{}'::jsonb,'sent')`, [pid]);
    // 끈 건 · 아직 안 끝난 건 · 초안은 건드리지 않는다
    const keep = Number((await query(
      `INSERT INTO crm_promotions (title, promo_type, discount_value, start_date, end_date, status, auto_withdraw)
       VALUES ('NoAuto','otro',NULL,$1::date,$2::date,'published',false) RETURNING id`, [plus(-10), plus(-1)])).rows[0].id);
    got.length = 0;
    const s1 = await S.sweepEndedPromos({});
    assert.equal(s1.ended, 1); assert.equal(s1.queued, 1);
    await settle();
    const del = got.find((g) => g.body && g.body.promocionId === 'PR-' + String(pid).padStart(6, '0'));
    assert.equal(del.method, 'DELETE'); assert.equal(del.body.estatus, 'finalizada');
    const s2 = await S.sweepEndedPromos({});
    assert.equal(s2.ended, 0, '두 번 내리지 않는다');
    assert.equal((await query(`SELECT withdrawn_at FROM crm_promotions WHERE id=$1`, [keep])).rows[0].withdrawn_at, null);
  });

  await t.test('발행 중 삭제 → 먼저 내리고 감춘다', async () => {
    const r1 = JSON.parse((await as('POST', '/api/promotions', { ...body, title: 'Borrar', targets: ['promo_crm'], image_data_url: img, publish: true })).body);
    await settle();
    got.length = 0;
    const r = JSON.parse((await as('DELETE', `/api/promotions/${r1.promo.id}`)).body);
    assert.equal(r.ok, true); assert.deepEqual(r.withdrawn.withdrawn_from, ['promo_crm']);
    await settle();
    assert.equal(got[0].method, 'DELETE');
    const list = JSON.parse((await as('GET', '/api/promotions')).body).items;
    assert.ok(!list.some((x) => x.id === r1.promo.id));
    assert.equal((await as('GET', `/api/promotions/${r1.promo.id}`)).statusCode, 404);
  });

  await t.test('목록 — 창구별 최근 상태 배지', async () => {
    const d = JSON.parse((await as('GET', '/api/promotions')).body);
    assert.equal(d.today, today);
    const it = d.items.find((x) => x.id === id);
    assert.ok(it.send.sent >= 2, JSON.stringify(it.send));
  });
});
