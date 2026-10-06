// =====================================================================
// wa_phone_52.test.mjs — 멕시코 WhatsApp 번호 52+10자리 전환 (2026-10-06)
//   A. normalizeWaNumber 규칙
//   B. 발송 직전 보정 — DB·환경변수에 남은 521… 도 Graph API 에는 52… 로 나간다
//   C. 0252 마이그레이션 — TEST_PG_URL 이 있을 때 실제 PostgreSQL
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
const W = await import('../src/waSend.js');

test('A1. 멕시코 번호는 52+10자리로 저장된다', () => {
  assert.equal(W.normalizeWaNumber('81 1234 5678'), '528112345678');
  assert.equal(W.normalizeWaNumber('+52 81 1234 5678'), '528112345678');
  assert.equal(W.normalizeWaNumber('+52 1 81 1234 5678'), '528112345678', '구 형식 521 → 52');
  assert.equal(W.normalizeWaNumber('5218112345678'), '528112345678');
  assert.equal(W.normalizeWaNumber('528112345678'), '528112345678', '이미 52 형식이면 그대로');
});

test('A2. 다른 나라·잘못된 번호', () => {
  assert.equal(W.normalizeWaNumber('82 10 1234 5678'), '821012345678', '한국 번호는 건드리지 않음');
  assert.equal(W.normalizeWaNumber('123'), null);
  assert.equal(W.normalizeWaNumber(''), null);
  assert.equal(W.normalizeWaNumber(null), null);
});

test('B1. 발송 직전 보정 — 저장된 521… 도 52… 로 나간다(텍스트·이미지·환경변수)', async () => {
  const keep = { ...process.env }; const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body).to);
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.X' }] }) };
  };
  try {
    process.env.WHATSAPP_TOKEN = 't'; process.env.WHATSAPP_PHONE_ID = '1';
    process.env.DAILY_SUMMARY_WA_TO = '5218110000009';
    assert.equal((await W.sendWaText('hola', '5218110000001')).ok, true);
    await W.sendWaImage({ to: '5218110000002', mediaId: 'm1', caption: 'c' });
    await W.sendWaText('env');                                   // 환경변수 수신자
    await W.sendWaText('kr', '821012345678');                    // 다른 나라
    assert.deepEqual(sent, ['528110000001', '528110000002', '528110000009', '821012345678']);
  } finally { globalThis.fetch = realFetch; process.env = keep; }
});

test('B2. 화면 안내 문구가 52 형식을 말한다', () => {
  const root = join(HERE, '..', '..');
  const cash = readFileSync(join(root, 'refatrix-cashdaily.html'), 'utf8');
  assert.match(cash, /<code>52<\/code>\+10자리로 자동 변환/);
  assert.doesNotMatch(readFileSync(join(root, 'refatrix-users.html'), 'utf8'), /521\+10자리/);
  assert.match(readFileSync(join(HERE, '..', 'src', 'secrets.js'), 'utf8'), /hint: '52 \+ 10자리'/);
});

test('C1. 0252 — 저장된 521 번호를 52 로 바꾸고, 다른 번호는 그대로', { skip: !PG && 'TEST_PG_URL 없음' }, async () => {
  const { query, pool } = await import('../src/db.js');
  after(() => pool.end());
  const sql = readFileSync(join(HERE, '..', 'migrations', '0252_wa_phone_52.sql'), 'utf8');
  await query(`DELETE FROM treasury_wa_sends; DELETE FROM treasury_wa_recipients;`);
  await query(`INSERT INTO treasury_wa_recipients (name, phone, lang) VALUES
    ('Old','5218110005311','ko'),('New','528110004385','ko'),('Kr','821012345678','ko')`);
  const u = (await query(`SELECT id FROM users ORDER BY id LIMIT 1`)).rows[0];
  if (u) await query(`UPDATE users SET wa_phone='5218119990000' WHERE id=$1`, [u.id]);
  await query(sql); await query(sql);                                  // 두 번 돌려도 같다(멱등)
  const rows = (await query(`SELECT name, phone FROM treasury_wa_recipients ORDER BY name`)).rows;
  assert.deepEqual(rows.map((r) => r.phone), ['821012345678', '528110004385', '528110005311']);
  if (u) assert.equal((await query(`SELECT wa_phone FROM users WHERE id=$1`, [u.id])).rows[0].wa_phone, '528119990000');
  await query(`DELETE FROM treasury_wa_recipients`);
});
