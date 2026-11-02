// =====================================================================
// 고객상담 — 휴대폰 녹음 파일 업로드 · 변환 · 전사 모델 방어 (2026-11-02)
//   ① sttModelName / redactSecrets — 「전사 모델」 칸에 키가 들어간 사고 재현
//   ② audioConvert — 실제 ffmpeg 로 m4a·mp3·wav·3gp 변환/분할, 손상 파일, ffmpeg 없음
//   ③ prepareFileRecording + processOne — pg-mem 으로 큐 처리 전체 흐름
// =====================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newDb } from 'pg-mem';
import { pool } from '../src/db.js';
import { sttModelName, redactSecrets, looksLikeApiKey } from '../src/sttModel.js';
import {
  convertToSegments, findFfmpeg, _resetFfmpegCache, parseDuration, fileMimeOf, isUploadAllowed,
  canPassThrough, whisperMimeOf, cleanFileName, extOf,
} from '../src/audioConvert.js';
import {
  processOne, prepareFileRecording, consultAiApi, consultConvertApi,
} from '../src/routes/consultRoutes.js';

const REAL_TRANSCRIBE = consultAiApi.transcribe;   // beforeEach 스텁 전에 진짜 함수를 잡아 둔다

// ── ① 전사 모델 방어 ──────────────────────────────────────────────────
test('sttModelName: 키·빈값·이상한 값은 whisper-1, 정상 모델명은 그대로', () => {
  assert.equal(sttModelName('sk-proj-6vNddKEExxxxxxxxxxxxxxxx'), 'whisper-1');
  assert.equal(sttModelName('sk-6vNddKEE,,,,,,'), 'whisper-1');
  assert.equal(sttModelName(''), 'whisper-1');
  assert.equal(sttModelName(undefined), 'whisper-1');
  assert.equal(sttModelName('  '), 'whisper-1');
  assert.equal(sttModelName('whisper 1 please'), 'whisper-1');
  assert.equal(sttModelName('whisper-1'), 'whisper-1');
  assert.equal(sttModelName('gpt-4o-transcribe'), 'gpt-4o-transcribe');
  assert.equal(sttModelName(' gpt-4o-mini-transcribe '), 'gpt-4o-mini-transcribe');
});

test('redactSecrets: 오류문 속 키를 가린다(쉼표가 끼어 있어도)', () => {
  const msg = 'The model `sk-proj-6vNddKEE,,,,,,abc123` does not exist or you do not have access to it.';
  const r = redactSecrets(msg);
  assert.ok(!/6vNddKEE/.test(r), r);
  assert.ok(/sk-\*\*\*/.test(r));
  assert.ok(/does not exist/.test(r), '나머지 문장은 남긴다');
  assert.equal(redactSecrets('stt: timeout'), 'stt: timeout');
  assert.ok(looksLikeApiKey('sk-proj-abcdefghijkl'));
  assert.ok(!looksLikeApiKey('whisper-1'));
});

test('consultAiApi.transcribe: 키가 모델 칸에 있어도 model=whisper-1 로 보내고, 오류문의 키는 가린다', async () => {
  const realFetch = globalThis.fetch;
  const saved = process.env.VISIT_STT_MODEL;
  process.env.VISIT_STT_MODEL = 'sk-proj-6vNddKEEzzzzzzzzzzzz';
  process.env.OPENAI_API_KEY = 'sk-test';
  let sentModel = null;
  globalThis.fetch = async (url, opts) => {
    sentModel = opts.body.get('model');
    return { ok: false, status: 404, json: async () => ({ error: { message: 'The model `sk-proj-6vNddKEEzzzz` does not exist' } }) };
  };
  try {
    const r = await REAL_TRANSCRIBE.call(consultAiApi, { b64: Buffer.from('x').toString('base64'), mime: 'audio/ogg' });
    assert.equal(sentModel, 'whisper-1');
    assert.equal(r.ok, false);
    assert.ok(!/6vNddKEE/.test(r.error), r.error);
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.VISIT_STT_MODEL; else process.env.VISIT_STT_MODEL = saved;
  }
});

// ── ② 파일 판별 헬퍼 ──────────────────────────────────────────────────
test('파일 형식 판별: 확장자 우선, 휴대폰 브라우저의 빈 type 도 처리', () => {
  assert.equal(extOf('Grabación 2026-11-02.M4A'), 'm4a');
  assert.equal(fileMimeOf('Voice 001.m4a', ''), 'audio/mp4');
  assert.equal(fileMimeOf('rec.amr', 'application/octet-stream'), 'audio/amr');
  assert.equal(fileMimeOf('noext', 'audio/x-wav'), 'audio/x-wav');
  assert.ok(isUploadAllowed('Call_8112345678.3gp', ''));
  assert.ok(isUploadAllowed('nota', 'audio/aac'));
  assert.ok(!isUploadAllowed('foto.jpg', 'image/jpeg'));
  assert.ok(!isUploadAllowed('doc.pdf', ''));
  assert.ok(canPassThrough('a.m4a', 'audio/mp4', 5e6));
  assert.ok(!canPassThrough('a.m4a', 'audio/mp4', 30 * 1024 * 1024), '24MB 초과는 변환 필요');
  assert.ok(!canPassThrough('a.amr', 'audio/amr', 1e5), 'amr 은 Whisper 가 안 받음');
  assert.equal(whisperMimeOf('a.wav', 'audio/x-wav'), 'audio/wav');
  assert.equal(cleanFileName('C:\\Users\\x\\Grab\u0001ación.m4a'), 'Grabación.m4a');
  assert.equal(parseDuration('  Duration: 01:02:03.50, start: 0'), 3724);
  assert.equal(parseDuration('nothing'), null);
});

// ── ② 실제 ffmpeg 변환 ───────────────────────────────────────────────
const FF = spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0;
function makeAudio(dir, name, args, sec) {
  const out = path.join(dir, name);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `sine=frequency=440:duration=${sec}`, '-f', 'lavfi', '-i', `anoisesrc=d=${sec}:a=0.02`,
    '-filter_complex', 'amix=inputs=2', ...args, out]);
  assert.equal(r.status, 0, String(r.stderr));
  return readFileSync(out);
}

test('ffmpeg: 휴대폰 형식(m4a·mp3·wav·3gp)을 16kHz 모노 ogg/opus 구간으로 바꾸고 길이를 잰다', { skip: !FF }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cf-'));
  try {
    const cases = [
      ['a.m4a', ['-c:a', 'aac', '-b:a', '128k', '-ac', '2']],
      ['a.mp3', ['-c:a', 'libmp3lame', '-b:a', '96k']],
      ['a.wav', ['-c:a', 'pcm_s16le', '-ar', '44100']],
      ['a.3gp', ['-c:a', 'aac', '-ar', '16000', '-ac', '1']],
    ];
    for (const [name, args] of cases) {
      const buf = makeAudio(dir, name, args, 50);
      const r = await convertToSegments(buf, { segSec: 20 });
      assert.equal(r.ok, true, name + ' ' + r.error);
      assert.equal(r.mime, 'audio/ogg');
      assert.equal(r.segments.length, 3, name + ': 50초 / 20초 구간 = 3');
      assert.ok(Math.abs(r.durationSec - 50) <= 1, name + ' dur=' + r.durationSec);
      for (const seg of r.segments) assert.equal(seg.subarray(0, 4).toString('latin1'), 'OggS', '각 구간이 온전한 ogg');
      // 각 구간을 ffprobe 처럼 다시 열 수 있어야 Whisper 가 받는다
      const p = path.join(dir, 'chk.ogg');
      spawnSync('sh', ['-c', `cat > "${p}"`], { input: r.segments[1] });
      const chk = spawnSync('ffmpeg', ['-hide_banner', '-i', p, '-f', 'null', '-']);
      assert.equal(chk.status, 0, '중간 구간도 단독 재생 가능');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ffmpeg: 1시간짜리 128kbps m4a(≈57MB)도 25MB 미만 구간들로 줄어든다', { skip: !FF }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cf-'));
  try {
    const buf = makeAudio(dir, 'long.m4a', ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'], 3600);
    assert.ok(buf.length > 25 * 1024 * 1024, '원본은 Whisper 한도를 넘는다: ' + buf.length);
    const t0 = Date.now();
    const r = await convertToSegments(buf);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.segments.length, 3, '20분 × 3');
    for (const s of r.segments) assert.ok(s.length < 10 * 1024 * 1024, '구간 ' + s.length);
    assert.ok(Math.abs(r.durationSec - 3600) <= 2);
    console.log(`  1h m4a ${(buf.length / 1048576).toFixed(1)}MB → ${r.segments.map((s) => (s.length / 1048576).toFixed(1) + 'MB').join(' + ')} in ${Date.now() - t0}ms`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ffmpeg: 오디오가 아닌 파일은 재시도 없이 실패(convert: …)', { skip: !FF }, async () => {
  const r = await convertToSegments(Buffer.from('%PDF-1.4 not audio at all '.repeat(200)));
  assert.equal(r.ok, false);
  assert.match(r.error, /^convert: /);
  assert.equal(r.transient, false);
});

test('ffmpeg 가 없으면 ffmpeg_missing (FFMPEG_PATH 가 틀리고 PATH 에도 없을 때)', async () => {
  // PATH 를 비워 진짜 '없음' 상태를 만든다
  const savedPath = process.env.PATH; const savedFf = process.env.FFMPEG_PATH;
  process.env.PATH = '/nonexistent'; process.env.FFMPEG_PATH = '/nonexistent/ffmpeg';
  _resetFfmpegCache();
  try {
    assert.equal(await findFfmpeg(true), null);
    const r2 = await convertToSegments(Buffer.from('abc'));
    assert.deepEqual([r2.ok, r2.error, r2.transient], [false, 'ffmpeg_missing', false]);
  } finally {
    process.env.PATH = savedPath;
    if (savedFf === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = savedFf;
    _resetFfmpegCache();
  }
});

// ── ③ 큐 처리 (pg-mem) ──────────────────────────────────────────────
function esc(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return `'${String(v).replace(/'/g, "''")}'`;
}
let pub;
function installDb() {
  const db = newDb();
  pub = db.public;
  pub.none(`
    CREATE TABLE users(id INT PRIMARY KEY, name TEXT, role TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE sales_consults(id SERIAL PRIMARY KEY, consult_date DATE, company_name TEXT, customer_id INT,
      contact_name TEXT, place_label TEXT, note TEXT, private_by INT, created_by INT,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ);
    CREATE TABLE sales_consult_recordings(id SERIAL PRIMARY KEY, consult_id INT, mode TEXT DEFAULT 'full',
      mime TEXT, duration_sec INT, size_bytes BIGINT, audio_b64 TEXT, status TEXT DEFAULT 'queued',
      error TEXT, attempts INT DEFAULT 0, transcript TEXT, summary_json JSONB,
      created_by INT, created_at TIMESTAMPTZ DEFAULT now(), processed_at TIMESTAMPTZ,
      source TEXT NOT NULL DEFAULT 'rec', file_name TEXT, converted_at TIMESTAMPTZ);
    CREATE TABLE sales_consult_pendings(id SERIAL PRIMARY KEY, consult_id INT, content TEXT, category TEXT,
      source_rec_id INT, due_date DATE, done BOOLEAN DEFAULT FALSE, done_at TIMESTAMPTZ, done_by INT,
      created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE audit_log(id SERIAL PRIMARY KEY, user_id INT, device_id INT, action TEXT, target TEXT,
      detail TEXT, result TEXT, occurred_at TIMESTAMPTZ DEFAULT now());
    INSERT INTO users VALUES (2,'Oscar','sales',NULL);
    INSERT INTO sales_consults (id, consult_date, company_name, created_by) VALUES (10,'2026-11-02','Refaccionaria Aguila',2);
  `);
  const run = (text, params) => pub.query(String(text).replace(/\$(\d+)/g, (_, n) => esc((params || [])[Number(n) - 1])));
  pool.query = async (text, params) => run(text, params);
  pool.connect = async () => ({ query: async (text, params) => run(text, params), release: () => {} });
}
function insertFile(fileName, mime, b64) {
  return pub.one(`INSERT INTO sales_consult_recordings (consult_id, mime, audio_b64, created_by, source, file_name, status, attempts)
    VALUES (10, ${esc(mime)}, ${esc(b64)}, 2, 'file', ${esc(fileName)}, 'transcribing', 1) RETURNING *`);
}
const SUMMARY = JSON.stringify({ resumen: 'Pidió precio de amortiguadores.', bullets: [{ category: 'precio', text: 'Precio' }],
  insights: '', action_items: [{ content: 'Enviar cotización', category: 'precio', due_date: null }], products: [], next_step: '' });

let sttCalls;
beforeEach(() => {
  installDb();
  process.env.ANTHROPIC_API_KEY = 'k';
  process.env.OPENAI_API_KEY = 'k';
  sttCalls = [];
  consultAiApi.transcribe = async ({ b64, mime }) => { sttCalls.push({ len: b64.length, mime }); return { ok: true, text: 'parte ' + sttCalls.length }; };
  consultAiApi.summarize = async () => ({ ok: true, text: SUMMARY });
});

test('파일 녹음: 변환 → 구간별 전사 → 요약 → 펜딩, 원본은 변환본으로 교체·converted_at 기록', async () => {
  consultConvertApi.convert = async () => ({ ok: true, mime: 'audio/ogg', durationSec: 2400,
    segments: [Buffer.from('seg-one'), Buffer.from('seg-two')] });
  const row = insertFile('Grabación 001.m4a', 'audio/mp4', Buffer.from('raw-m4a').toString('base64'));
  await processOne(row);
  const r = pub.one(`SELECT * FROM sales_consult_recordings WHERE id=${row.id}`);
  assert.equal(r.status, 'done', r.error);
  assert.equal(sttCalls.length, 2, '구간마다 한 번씩 전사');
  assert.ok(sttCalls.every((c) => c.mime === 'audio/ogg'));
  assert.equal(r.mime, 'audio/ogg');
  assert.equal(Number(r.duration_sec), 2400);
  assert.ok(r.converted_at, 'converted_at 기록');
  assert.equal(r.transcript, 'parte 1\nparte 2');
  assert.equal(pub.many(`SELECT * FROM sales_consult_pendings WHERE source_rec_id=${row.id}`).length, 1);
});

test('재시도 시 이미 변환한 파일은 다시 변환하지 않는다', async () => {
  let convs = 0;
  consultConvertApi.convert = async () => { convs++; return { ok: true, mime: 'audio/ogg', durationSec: 60, segments: [Buffer.from('s1')] }; };
  consultAiApi.transcribe = async () => ({ ok: false, error: 'stt: network', transient: true });
  const row = insertFile('a.m4a', 'audio/mp4', Buffer.from('raw').toString('base64'));
  await processOne(row);
  let r = pub.one(`SELECT * FROM sales_consult_recordings WHERE id=${row.id}`);
  assert.equal(r.status, 'queued', '일시 오류는 대기열로');
  assert.equal(convs, 1);
  consultAiApi.transcribe = async () => ({ ok: true, text: 'hola' });
  await processOne(r);
  r = pub.one(`SELECT * FROM sales_consult_recordings WHERE id=${row.id}`);
  assert.equal(r.status, 'done', r.error);
  assert.equal(convs, 1, '두 번째 처리에서는 변환 생략');
});

test('ffmpeg 없음: 24MB 이하 m4a 는 원본 그대로 전사', async () => {
  consultConvertApi.convert = async () => ({ ok: false, error: 'ffmpeg_missing', transient: false });
  const raw = Buffer.from('small-m4a').toString('base64');
  const row = insertFile('nota.m4a', 'audio/mp4', raw);
  await processOne(row);
  const r = pub.one(`SELECT * FROM sales_consult_recordings WHERE id=${row.id}`);
  assert.equal(r.status, 'done', r.error);
  assert.equal(sttCalls.length, 1);
  assert.equal(sttCalls[0].mime, 'audio/mp4');
  assert.equal(sttCalls[0].len, raw.length);
});

test('ffmpeg 없음: amr 은 명확한 사유로 실패(재시도로 해결 안 되는 오류)', async () => {
  consultConvertApi.convert = async () => ({ ok: false, error: 'ffmpeg_missing', transient: false });
  const row = insertFile('Call.amr', 'audio/amr', Buffer.from('amr').toString('base64'));
  await processOne(row);
  const r = pub.one(`SELECT * FROM sales_consult_recordings WHERE id=${row.id}`);
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'ffmpeg_missing: format');
  assert.equal(sttCalls.length, 0);
});

test('손상 파일: convert 오류로 실패, 전사 호출 없음', async () => {
  consultConvertApi.convert = async () => ({ ok: false, error: 'convert: Invalid data found when processing input', transient: false });
  const row = insertFile('x.m4a', 'audio/mp4', Buffer.from('junk').toString('base64'));
  await processOne(row);
  const r = pub.one(`SELECT * FROM sales_consult_recordings WHERE id=${row.id}`);
  assert.equal(r.status, 'failed');
  assert.match(r.error, /^convert: Invalid data/);
  assert.equal(sttCalls.length, 0);
});

test('4시간 초과 파일은 too_long', async () => {
  consultConvertApi.convert = async () => ({ ok: true, mime: 'audio/ogg', durationSec: 5 * 3600, segments: [Buffer.from('s')] });
  const row = insertFile('long.m4a', 'audio/mp4', Buffer.from('r').toString('base64'));
  await processOne(row);
  const r = pub.one(`SELECT * FROM sales_consult_recordings WHERE id=${row.id}`);
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'too_long');
});

test('기존 화면 녹음(source=rec)은 변환을 타지 않는다(동작 불변)', async () => {
  let convs = 0;
  consultConvertApi.convert = async () => { convs++; return { ok: false, error: 'should_not_run' }; };
  const row = pub.one(`INSERT INTO sales_consult_recordings (consult_id, mime, audio_b64, created_by, status, attempts)
    VALUES (10, 'audio/webm', ${esc(Buffer.from('webm').toString('base64'))}, 2, 'transcribing', 1) RETURNING *`);
  await processOne(row);
  const r = pub.one(`SELECT * FROM sales_consult_recordings WHERE id=${row.id}`);
  assert.equal(r.status, 'done', r.error);
  assert.equal(convs, 0);
  assert.equal(r.converted_at, null);
});

test('실패 오류문에 키가 섞여 있어도 DB 에는 가려서 저장된다', async () => {
  consultConvertApi.convert = async () => ({ ok: true, mime: 'audio/ogg', durationSec: 60, segments: [Buffer.from('s')] });
  consultAiApi.transcribe = async () => ({ ok: false, error: 'stt: The model `sk-proj-6vNddKEEqqqqqq` does not exist', transient: false });
  const row = insertFile('a.m4a', 'audio/mp4', Buffer.from('r').toString('base64'));
  await processOne(row);
  const r = pub.one(`SELECT * FROM sales_consult_recordings WHERE id=${row.id}`);
  assert.equal(r.status, 'failed');
  assert.ok(!/6vNddKEE/.test(r.error), r.error);
});

test('prepareFileRecording 은 내보내져 있다(진단용)', () => { assert.equal(typeof prepareFileRecording, 'function'); });
