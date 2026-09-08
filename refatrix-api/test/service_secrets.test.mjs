// 외부 서비스 API 키 관리 — 0209
//
//   순수 로직(암호화·마스킹·등록부·배선)은 DB 없이 돌고,
//   저장·복귀·이력·권한은 TEST_PG_URL 이 있을 때 실제 PostgreSQL + 라우트 inject 로 돈다.
//
//   실행: TEST_PG_URL=postgres://... node --test test/service_secrets.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = join(HERE, '..');
const REPO = join(API, '..');
const read = (p) => readFileSync(p, 'utf8');

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;

// 열쇠는 import 보다 먼저 — secrets.js 가 로딩 시점에 읽는다.
process.env.APP_SECRET_KEY = 'test-master-key-0209-do-not-use-in-prod';
// 기동 시점 환경변수 스냅샷 확인용(DB 값을 지우면 여기로 되돌아와야 한다)
process.env.ANTHROPIC_API_KEY = 'env-anthropic-key-boot';
delete process.env.WHATSAPP_TEMPLATE;
delete process.env.OPENAI_API_KEY;      // ⑪ 에서 "키 없음" 경로를 확인한다

const S = await import('../src/secrets.js');

// ── A. 암호화 ──────────────────────────────────────────────────────────
test('A1. 암호화 → 복호화 왕복', () => {
  const plain = 'sk-ant-api03-' + 'x'.repeat(80);
  const enc = S.encryptValue(plain);
  assert.ok(enc.startsWith('v1:'), '저장 형식은 v1: 로 시작한다');
  assert.ok(!enc.includes(plain), '암호문에 평문이 남아 있으면 안 된다');
  assert.equal(S.decryptValue(enc), plain);
});

test('A2. 같은 값도 매번 다른 암호문이 된다(IV 가 매번 새로 생성)', () => {
  const a = S.encryptValue('same-value-1234'), b = S.encryptValue('same-value-1234');
  assert.notEqual(a, b);
  assert.equal(S.decryptValue(a), S.decryptValue(b));
});

test('A3. 깨진 값·다른 열쇠로 만든 값은 null 을 돌려준다(던지지 않는다)', () => {
  assert.equal(S.decryptValue('v1:not-base64-@@@'), null);
  assert.equal(S.decryptValue(''), null);
  assert.equal(S.decryptValue('v1:' + Buffer.from('a'.repeat(40)).toString('base64')), null);
});

test('A4. 비밀이 아닌 설정값은 p1: 평문으로 읽힌다', () => {
  assert.equal(S.decryptValue('p1:v20.0'), 'v20.0');
});

test('A5. 마스킹은 앞 4·뒤 4 만 남긴다 · 짧은 값은 전부 가린다', () => {
  const m = S.maskValue('sk-ant-api03-abcdefghijklmn-XYZW');
  assert.ok(m.startsWith('sk-a') && m.includes('XYZW'));
  assert.ok(!m.includes('abcdefghijklmn'), '가운데는 남으면 안 된다');
  assert.equal(S.maskValue('short'), '•••••');
  assert.equal(S.maskValue(''), '');
});

// ── B. 등록부가 실제 사용처를 빠짐없이 덮는가 ──────────────────────────
test('B1. 소스에서 쓰는 외부 서비스 키가 모두 등록부에 있다', () => {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith('.js')) files.push(join(d, e.name));
    }
  };
  walk(join(API, 'src'));
  const used = new Set();
  for (const f of files) {
    for (const m of read(f).matchAll(/process\.env\.([A-Z0-9_]+)/g)) used.add(m[1]);
  }
  // 외부 제공사에 실제로 실려 나가는 값 — 화면에서 바꿀 수 있어야 한다.
  const mustManage = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID'];
  for (const k of mustManage) {
    assert.ok(used.has(k), k + ' 는 소스에서 쓰여야 한다(전제)');
    assert.ok(S.FIELD_INDEX.has(k), k + ' 가 등록부에 없다 — 화면에서 바꿀 수 없게 된다');
  }
});

test('B2. 서비스마다 필수 필드와 「멈추는 기능」 안내가 있다', () => {
  for (const s of S.SERVICES) {
    assert.ok(s.fields.some((f) => f.required), s.key + ': 필수 필드가 없다');
    assert.ok(s.uses && s.uses.length, s.key + ': 어디에 쓰이는지 안내가 없다');
  }
});

// ── C. 배선(서버·화면·메뉴) ────────────────────────────────────────────
test('C1. server.js 가 라우트를 등록하고 부팅 때 키를 읽는다', () => {
  const s = read(join(API, 'src/server.js'));
  assert.ok(s.includes("import secretRoutes from './routes/secretRoutes.js'"));
  assert.ok(s.includes('app.register(secretRoutes)'));
  assert.ok(s.includes('startSecretRefresh(app)'));
});

test('C2. 화면이 값을 요구하지 않고 마스킹만 쓴다', () => {
  const h = read(join(REPO, 'refatrix-apikeys.html'));
  assert.ok(h.includes('/api/secrets'), 'API 를 호출해야 한다');
  assert.ok(h.includes('/api/secrets/refresh'));
  assert.ok(!/d\.value|f\.value\b/.test(h), '화면이 비밀 원본값을 참조하면 안 된다');
  assert.ok(h.includes('빈칸 = 지금 값을 그대로 둡니다'), '저장 규칙 안내가 있어야 한다');
});

test('C3. 메뉴에 등록되고 디렉터 전용이다', () => {
  const nav = read(join(REPO, 'refatrix-nav.js'));
  assert.ok(nav.includes("apikeys:{file:'refatrix-apikeys.html'"));
  assert.ok(/apikeys:'__director__'/.test(nav), '디렉터 전용이어야 한다');
  assert.ok(nav.includes("'integrations','apikeys','processKpi'"), '관리 그룹에 들어가야 한다');
});

test('C4. 마이그레이션 0209 가 값을 평문 컬럼으로 두지 않는다', () => {
  const sql = read(join(API, 'migrations/0209_service_secrets.sql'));
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS service_secrets'));
  assert.ok(sql.includes('value_enc'), '컬럼 이름부터 암호문임을 밝힌다');
  assert.ok(sql.includes('service_secret_changes'));
});

// ── D. 실제 DB ─────────────────────────────────────────────────────────
const dbTest = PG ? test : test.skip;

dbTest('저장 · 하이드레이션 · 복귀 · 이력 · 권한 (실 DB)', async (t) => {
  const { query, pool } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const secretRoutes = (await import('../src/routes/secretRoutes.js')).default;

  const TAG = 'SEC' + String(Date.now()).slice(-6);
  const dirId = (await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'director','x',$2) RETURNING id`,
    ['디렉터' + TAG, 'dir_' + TAG])).rows[0].id;
  const salesId = (await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'sales','x',$2) RETURNING id`,
    ['영업' + TAG, 'sal_' + TAG])).rows[0].id;

  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  app.register(secretRoutes);
  await app.ready();
  const tokDir = app.jwt.sign({ sub: dirId });
  const tokSales = app.jwt.sign({ sub: salesId });

  const get = (tok) => app.inject({ method: 'GET', url: '/api/secrets', headers: { authorization: 'Bearer ' + tok } });
  const put = (tok, values) => app.inject({
    method: 'PUT', url: '/api/secrets',
    headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
    payload: { values },
  });

  t.after(async () => {
    await query(`DELETE FROM service_secret_changes WHERE changed_by = ANY($1::bigint[])`, [[dirId, salesId]]);
    await query(`DELETE FROM service_secrets WHERE name = ANY($1::text[])`,
      [['ANTHROPIC_API_KEY', 'WHATSAPP_TEMPLATE', 'WHATSAPP_PHONE_ID']]);
    await query(`DELETE FROM audit_log WHERE user_id = ANY($1::bigint[])`, [[dirId, salesId]]);
    await query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [[dirId, salesId]]);
    await app.close();
    await pool.end();
  });

  await t.test('① 영업사원은 볼 수도 바꿀 수도 없다(403)', async () => {
    assert.equal((await get(tokSales)).statusCode, 403);
    assert.equal((await put(tokSales, { ANTHROPIC_API_KEY: 'sk-ant-hacker-0000' })).statusCode, 403);
  });

  await t.test('② 처음엔 Railway 환경변수 값으로 동작한다(source=env)', async () => {
    const d = (await get(tokDir)).json();
    assert.equal(d.master_key, true);
    const f = d.services.find((s) => s.key === 'anthropic').fields.find((x) => x.name === 'ANTHROPIC_API_KEY');
    assert.equal(f.source, 'env');
    assert.equal(f.has_value, true);
  });

  const NEWKEY = 'sk-ant-api03-' + 'n'.repeat(70);
  await t.test('③ 저장하면 DB 에는 암호문만 들어가고 process.env 가 즉시 바뀐다', async () => {
    const r = await put(tokDir, { ANTHROPIC_API_KEY: NEWKEY });
    assert.equal(r.statusCode, 200);
    const row = (await query(`SELECT value_enc, is_secret FROM service_secrets WHERE name='ANTHROPIC_API_KEY'`)).rows[0];
    assert.ok(row.value_enc.startsWith('v1:'));
    assert.ok(!row.value_enc.includes(NEWKEY), 'DB 에 평문이 남으면 안 된다');
    assert.equal(row.is_secret, true);
    assert.equal(process.env.ANTHROPIC_API_KEY, NEWKEY, '호출부(process.env)가 새 키를 읽어야 한다');
  });

  await t.test('④ 화면으로는 값이 내려가지 않는다 — 마스킹만', async () => {
    const d = (await get(tokDir)).json();
    const f = d.services.find((s) => s.key === 'anthropic').fields.find((x) => x.name === 'ANTHROPIC_API_KEY');
    assert.equal(f.source, 'db');
    assert.ok(!JSON.stringify(d).includes(NEWKEY), '응답 어디에도 원본 키가 있으면 안 된다');
    assert.ok(f.preview.startsWith('sk-a'));
    assert.ok(f.preview.includes('nnnn'), '뒤 4자만 보인다');
  });

  await t.test('⑤ 비밀이 아닌 설정값은 그대로 보여 준다(전화번호 ID·템플릿명)', async () => {
    await put(tokDir, { WHATSAPP_TEMPLATE: 'refatrix_aviso' });
    const d = (await get(tokDir)).json();
    const f = d.services.find((s) => s.key === 'whatsapp').fields.find((x) => x.name === 'WHATSAPP_TEMPLATE');
    assert.equal(f.preview, 'refatrix_aviso');
    assert.equal(process.env.WHATSAPP_TEMPLATE, 'refatrix_aviso');
    const row = (await query(`SELECT value_enc FROM service_secrets WHERE name='WHATSAPP_TEMPLATE'`)).rows[0];
    assert.equal(row.value_enc, 'p1:refatrix_aviso');
  });

  await t.test('⑥ "-" 로 지우면 기동 시점 환경변수로 되돌아간다', async () => {
    const r = await put(tokDir, { ANTHROPIC_API_KEY: '-' });
    assert.equal(r.statusCode, 200);
    assert.equal(process.env.ANTHROPIC_API_KEY, 'env-anthropic-key-boot');
    const d = (await get(tokDir)).json();
    const f = d.services.find((s) => s.key === 'anthropic').fields.find((x) => x.name === 'ANTHROPIC_API_KEY');
    assert.equal(f.source, 'env');
  });

  await t.test('⑦ 환경변수가 없던 항목을 지우면 아무 값도 남지 않는다', async () => {
    await put(tokDir, { WHATSAPP_TEMPLATE: '-' });
    assert.equal(process.env.WHATSAPP_TEMPLATE, undefined);
    const d = (await get(tokDir)).json();
    const f = d.services.find((s) => s.key === 'whatsapp').fields.find((x) => x.name === 'WHATSAPP_TEMPLATE');
    assert.equal(f.source, 'none');
    assert.equal(f.has_value, false);
  });

  await t.test('⑧ 빈칸은 지금 값을 그대로 둔다', async () => {
    await put(tokDir, { ANTHROPIC_API_KEY: NEWKEY });
    const r = await put(tokDir, { ANTHROPIC_API_KEY: '' });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, 'nothing_to_save');
    assert.equal(process.env.ANTHROPIC_API_KEY, NEWKEY, '빈칸이 키를 지워서는 안 된다');
  });

  await t.test('⑨ 너무 짧은 키·줄바꿈 섞인 값은 거부한다', async () => {
    const a = await put(tokDir, { ANTHROPIC_API_KEY: 'sk-1' });
    assert.equal(a.statusCode, 400);
    assert.equal(a.json().error, 'too_short');
    const b = await put(tokDir, { ANTHROPIC_API_KEY: 'sk-ant-good-key\nmore' });
    assert.equal(b.json().error, 'newline_in_value');
    assert.equal(process.env.ANTHROPIC_API_KEY, NEWKEY, '거부된 저장이 값을 건드리면 안 된다');
  });

  await t.test('⑩ 이력에는 값이 아니라 무엇을·언제·누가 만 남는다', async () => {
    const d = (await get(tokDir)).json();
    const mine = d.changes.filter((c) => c.changed_by_name && c.changed_by_name.includes(TAG));
    assert.ok(mine.length >= 3);
    assert.ok(mine.some((c) => c.action === 'clear'));
    assert.ok(!JSON.stringify(d.changes).includes(NEWKEY), '이력에 값이 남으면 안 된다');
    const audit = (await query(
      `SELECT action, target, detail FROM audit_log
        WHERE user_id=$1 AND target LIKE 'service_secret:%'`, [dirId])).rows;
    assert.ok(audit.length >= 1, '감사 로그에 남아야 한다(audit_log 의 허용 action 안에서)');
    assert.ok(!JSON.stringify(audit).includes(NEWKEY), '감사 로그에도 값이 남으면 안 된다');
  });

  await t.test('⑪ 연결 테스트는 키가 없으면 호출조차 하지 않는다', async () => {
    // OPENAI_API_KEY 는 이 테스트 프로세스에서 처음부터 비어 있다(맨 위에서 지웠다).
    const r = await app.inject({ method: 'POST', url: '/api/secrets/openai/test',
      headers: { authorization: 'Bearer ' + tokDir } });
    const d = r.json();
    assert.equal(d.ok, false);
    assert.equal(d.reason, 'no_key');
  });

  await t.test('⑫ 없는 서비스는 404', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/secrets/nope/test',
      headers: { authorization: 'Bearer ' + tokDir } });
    assert.equal(r.statusCode, 404);
  });
});
