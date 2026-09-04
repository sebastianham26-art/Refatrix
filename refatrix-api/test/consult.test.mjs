// =====================================================================
// 고객상담(영업 > 고객상담) 백엔드 — pg-mem 통합 + 순수함수 단위 (2026-08-19)
//   외부 API(Whisper/Claude)는 consultAiApi 스텁으로 대체.
// =====================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { pool } from '../src/db.js';
import {
  processOne, processQueueTick, buildConsultList, visibilityCond, consultAiApi,
} from '../src/routes/consultRoutes.js';
import {
  parseConsultSummaryJson, parseConsultTranslationJson, parseInsightJson,
  buildConsultSummaryPrompt, buildConsultTranslatePrompt, buildInsightPrompt,
  normCat, scopeKeyOf, groupByCategory, CAT_KEYS,
  splitTranscript, mergeConsultSummaries, buildConsultMergePrompt, TRANSCRIPT_CHUNK_MAX,
} from '../src/consultAi.js';

// ── pg-mem 셋업 + pool 몽키패치 ──────────────────────────────────────
function esc(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (Array.isArray(v)) return `ARRAY[${v.map(esc).join(',')}]`;
  return `'${String(v).replace(/'/g, "''")}'`;
}
let pub;
function installDb() {
  const db = newDb();
  pub = db.public;
  pub.none(`
    CREATE TABLE users(id INT PRIMARY KEY, name TEXT, login_id TEXT, role TEXT, team_id INT, deleted_at TIMESTAMPTZ);
    CREATE TABLE customers(id INT PRIMARY KEY, name TEXT, team_id INT, deleted_at TIMESTAMPTZ);
    CREATE TABLE sales_consults(id SERIAL PRIMARY KEY, consult_date DATE, company_name TEXT, customer_id INT,
      contact_name TEXT, wa_phone TEXT, email TEXT, geo_lat FLOAT, geo_lng FLOAT, geo_accuracy FLOAT,
      place_label TEXT, note TEXT, private_by INT, private_at TIMESTAMPTZ,
      created_by INT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ);
    CREATE TABLE sales_consult_recordings(id SERIAL PRIMARY KEY, consult_id INT, mode TEXT DEFAULT 'full',
      mime TEXT, duration_sec INT, size_bytes BIGINT, audio_b64 TEXT, status TEXT DEFAULT 'queued',
      error TEXT, attempts INT DEFAULT 0, transcript TEXT, summary_json JSONB,
      created_by INT, created_at TIMESTAMPTZ DEFAULT now(), processed_at TIMESTAMPTZ);
    CREATE TABLE sales_consult_pendings(id SERIAL PRIMARY KEY, consult_id INT, content TEXT, category TEXT,
      source_rec_id INT, due_date DATE, done BOOLEAN DEFAULT FALSE, done_at TIMESTAMPTZ, done_by INT,
      created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE sales_consult_insights(id SERIAL PRIMARY KEY, scope_key TEXT, consult_ids TEXT,
      insight_json JSONB, created_by INT, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE audit_log(id SERIAL PRIMARY KEY, user_id INT, device_id INT, action TEXT, target TEXT,
      detail TEXT, result TEXT, occurred_at TIMESTAMPTZ DEFAULT now());
  `);
  const run = (text, params) => pub.query(String(text).replace(/\$(\d+)/g, (_, n) => esc((params || [])[Number(n) - 1])));
  pool.query = async (text, params) => run(text, params);
  pool.connect = async () => ({ query: async (text, params) => run(text, params), release: () => {} });
}

const B64 = Buffer.from('fake-audio').toString('base64');
function seed() {
  pub.none(`
    INSERT INTO users VALUES (1,'director','admin','director',NULL,NULL);
    INSERT INTO users VALUES (2,'Oscar','oscar','sales',5,NULL);
    INSERT INTO users VALUES (3,'Maria','maria','sales',5,NULL);
    INSERT INTO sales_consults (id, consult_date, company_name, contact_name, wa_phone, email,
      geo_lat, geo_lng, place_label, created_by)
      VALUES (10,'2026-08-18','Refaccionaria Aguila','Juan','8112345678','juan@aguila.mx',25.6,-100.3,'Monterrey',2);
    INSERT INTO sales_consults (id, consult_date, company_name, created_by)
      VALUES (11,'2026-08-19','Autopartes del Norte',3);
  `);
}

const DIRECTOR = { userId: 1, role: 'director' };
const OSCAR = { userId: 2, role: 'sales' };
const MARIA = { userId: 3, role: 'sales' };

const GOOD_SUMMARY = JSON.stringify({
  resumen: 'Se habló de precios de balatas y entrega.',
  bullets: [
    { category: 'precio', text: 'Pide 8% de descuento en balatas CL0001.' },
    { category: 'INVENTARIO', text: 'Sin stock de CL0002 en su bodega.' },
  ],
  insights: 'Competencia SYD ofrece 10% menos.',
  action_items: [
    { content: 'Enviar cotización CL0001', category: 'precio', due_date: '2026-08-21' },
    { content: 'Confirmar entrega', category: 'entrega', due_date: null },
  ],
  products: ['CL0001', 'CL0002'],
  next_step: 'Visitar el lunes',
});

beforeEach(() => {
  installDb();
  seed();
  process.env.ANTHROPIC_API_KEY = 'k';
  process.env.OPENAI_API_KEY = 'k';
  consultAiApi.transcribe = async () => ({ ok: true, text: 'transcripción de prueba' });
  consultAiApi.summarize = async () => ({ ok: true, text: GOOD_SUMMARY });
});

// ── 순수함수 ────────────────────────────────────────────────────────
test('normCat: 별칭·대문자·한글·라벨을 고정 키로 정규화하고 모르면 relacion', () => {
  assert.equal(normCat('precio'), 'precio');
  assert.equal(normCat('INVENTARIO'), 'producto');
  assert.equal(normCat('entrega'), 'logistica');
  assert.equal(normCat('가격'), 'precio');
  assert.equal(normCat('Precio / Cotización'), 'precio');
  assert.equal(normCat(''), 'relacion');
  assert.equal(normCat('무슨소리'), 'relacion');
  for (const k of CAT_KEYS) assert.equal(normCat(k), k);
});

test('parseConsultSummaryJson: 마크다운 감싸기 허용 · 카테고리 정규화 · 기한 검증', () => {
  const s = parseConsultSummaryJson('```json\n' + GOOD_SUMMARY + '\n```');
  assert.ok(s);
  assert.equal(s.bullets.length, 2);
  assert.equal(s.bullets[1].category, 'producto');          // INVENTARIO → producto
  assert.equal(s.action_items.length, 2);
  assert.equal(s.action_items[0].due_date, '2026-08-21');
  assert.equal(s.action_items[1].due_date, null);
  assert.equal(s.action_items[1].category, 'logistica');     // entrega → logistica
  assert.deepEqual(s.products, ['CL0001', 'CL0002']);
});

test('parseConsultSummaryJson: 잘못된 응답은 null · 잘못된 due_date 는 null 로 떨어짐', () => {
  assert.equal(parseConsultSummaryJson('설명만 있고 JSON 없음'), null);
  const s = parseConsultSummaryJson(JSON.stringify({
    resumen: 'x', action_items: [{ content: 'a', due_date: 'mañana' }],
  }));
  assert.equal(s.action_items[0].due_date, null);
  assert.equal(s.action_items[0].category, 'relacion');
});

test('요약 프롬프트: 카테고리 키·상담 정보·전사문이 모두 들어간다', () => {
  const p = buildConsultSummaryPrompt({
    transcript: 'hola', companyName: 'Aguila', contactName: 'Juan',
    consultDate: '2026-08-18', placeLabel: 'Monterrey', mode: 'full',
  });
  for (const k of CAT_KEYS) assert.ok(p.includes(k), 'missing cat ' + k);
  assert.ok(p.includes('2026-08-18') && p.includes('Aguila') && p.includes('Juan') && p.includes('hola'));
});

test('parseConsultTranslationJson: 개수 보정 · 카테고리/기한은 원문 유지 · 누락은 원문 폴백', () => {
  const base = parseConsultSummaryJson(GOOD_SUMMARY);
  const ko = parseConsultTranslationJson(JSON.stringify({
    resumen: '브레이크 패드 가격과 납품을 이야기했다.',
    bullets: ['CL0001 브레이크 패드 8% 할인 요청'],       // 1건만 왔다(원문 2건)
    insights: '경쟁사 SYD가 10% 싸다.',
    action_items: ['CL0001 견적 발송'],                    // 1건만 왔다(원문 2건)
    products: [],
    next_step: '월요일 방문',
  }), base);
  assert.equal(ko.action_items.length, 2);
  assert.equal(ko.action_items[0].content, 'CL0001 견적 발송');
  assert.equal(ko.action_items[1].content, 'Confirmar entrega');   // 누락 → 원문 폴백
  assert.equal(ko.action_items[0].due_date, '2026-08-21');         // 기한 원문 유지
  assert.equal(ko.action_items[1].category, 'logistica');          // 카테고리 원문 유지
  assert.equal(ko.bullets.length, 2);
  assert.equal(ko.bullets[1].text, 'Sin stock de CL0002 en su bodega.');
  assert.deepEqual(ko.products, ['CL0001', 'CL0002']);             // 제품 코드 보존
});

test('번역 프롬프트: 원문 값이 담기고 코드 보존 규칙이 들어간다', () => {
  const base = parseConsultSummaryJson(GOOD_SUMMARY);
  const p = buildConsultTranslatePrompt(base);
  assert.ok(p.includes('CL0001'));
  assert.ok(p.includes('제품 코드'));
  assert.ok(p.includes('순서와 개수'));
});

test('parseInsightJson: 카테고리 정규화 · 빈 응답은 null', () => {
  const ins = parseInsightJson(JSON.stringify({
    headline: '가격 압박이 반복됨',
    period_bullets: [{ category: '가격', text: '3개 업체가 할인 요구' }, 'CL 라인 재고 부족'],
    themes: ['할인 요구 반복'], risks: ['SYD 침투'],
    next_actions: [{ content: '가격표 재검토', category: 'precio' }],
  }));
  assert.equal(ins.period_bullets[0].category, 'precio');
  assert.equal(ins.period_bullets[1].category, 'relacion');
  assert.equal(ins.next_actions[0].category, 'precio');
  assert.equal(parseInsightJson('{}'), null);
});

test('인사이트 프롬프트: 상담 건이 번호와 카테고리 태그로 들어간다', () => {
  const p = buildInsightPrompt([{
    id: 10, date: '2026-08-18', company: 'Aguila', by_name: 'Oscar',
    resumen: 'precio', insights: '', bullets: [{ category: 'precio', text: 'descuento' }],
    action_items: [{ content: 'cotizar', category: 'precio', due_date: '2026-08-21' }],
  }], { from: '2026-08-18', to: '2026-08-18' });
  assert.ok(p.includes('#1 2026-08-18 · Aguila'));
  assert.ok(p.includes('[precio] descuento'));
  assert.ok(p.includes('(펜딩/precio) cotizar'));
  assert.ok(p.includes('한국어'));
});

test('scopeKeyOf: 순서·중복과 무관하게 같은 키 · groupByCategory 는 7개 버킷', () => {
  assert.equal(scopeKeyOf([3, 1, 2, 1]), scopeKeyOf([1, 2, 3]));
  assert.notEqual(scopeKeyOf([1, 2]), scopeKeyOf([1, 2, 3]));
  const g = groupByCategory([{ category: 'precio' }, { category: 'zzz' }]);
  assert.equal(Object.keys(g).length, CAT_KEYS.length);
  assert.equal(g.precio.length, 1);
  assert.equal(g.relacion.length, 1);
});

// ── 큐 처리 ─────────────────────────────────────────────────────────
test('processOne: 전사 → 요약 → done · 펜딩이 카테고리와 함께 자동 등록', async () => {
  pub.none(`INSERT INTO sales_consult_recordings (id, consult_id, mode, mime, audio_b64, created_by)
            VALUES (100, 10, 'full', 'audio/webm', '${B64}', 2)`);
  const row = pub.many(`SELECT * FROM sales_consult_recordings WHERE id=100`)[0];
  await processOne(row);
  const r = pub.many(`SELECT status, transcript, summary_json, audio_b64 FROM sales_consult_recordings WHERE id=100`)[0];
  assert.equal(r.status, 'done');
  assert.equal(r.transcript, 'transcripción de prueba');
  assert.equal(r.audio_b64, null);                        // 기본 폐기
  const s = typeof r.summary_json === 'string' ? JSON.parse(r.summary_json) : r.summary_json;
  assert.equal(s.bullets.length, 2);
  const pends = pub.many(`SELECT content, category, due_date, source_rec_id FROM sales_consult_pendings WHERE consult_id=10 ORDER BY id`);
  assert.equal(pends.length, 2);
  assert.equal(pends[0].category, 'precio');
  assert.equal(pends[1].category, 'logistica');
  assert.equal(Number(pends[0].source_rec_id), 100);
});

test('processOne 재처리: 같은 녹음의 자동 펜딩은 중복되지 않고 수기 펜딩은 보존', async () => {
  pub.none(`INSERT INTO sales_consult_pendings (consult_id, content, category) VALUES (10,'수기 항목','relacion')`);
  pub.none(`INSERT INTO sales_consult_recordings (id, consult_id, mode, mime, audio_b64, created_by)
            VALUES (100, 10, 'full', 'audio/webm', '${B64}', 2)`);
  await processOne(pub.many(`SELECT * FROM sales_consult_recordings WHERE id=100`)[0]);
  // 요약 단계만 재실행(전사 보존)
  pub.none(`UPDATE sales_consult_recordings SET status='queued' WHERE id=100`);
  await processOne(pub.many(`SELECT * FROM sales_consult_recordings WHERE id=100`)[0]);
  const pends = pub.many(`SELECT content FROM sales_consult_pendings WHERE consult_id=10 ORDER BY id`);
  assert.equal(pends.length, 3);                           // 수기 1 + 자동 2 (중복 없음)
  assert.equal(pends[0].content, '수기 항목');
});

test('processOne: 요약 파싱 실패는 failed · 일시 오류는 자동 재큐', async () => {
  pub.none(`INSERT INTO sales_consult_recordings (id, consult_id, mime, audio_b64, created_by, attempts)
            VALUES (101, 10, 'audio/webm', '${B64}', 2, 1)`);
  consultAiApi.summarize = async () => ({ ok: true, text: '설명만' });
  await processOne(pub.many(`SELECT * FROM sales_consult_recordings WHERE id=101`)[0]);
  assert.equal(pub.many(`SELECT status, error FROM sales_consult_recordings WHERE id=101`)[0].status, 'failed');

  pub.none(`UPDATE sales_consult_recordings SET status='queued', transcript=NULL, error=NULL, audio_b64='${B64}' WHERE id=101`);
  consultAiApi.transcribe = async () => ({ ok: false, error: 'stt: timeout', transient: true });
  await processOne(pub.many(`SELECT * FROM sales_consult_recordings WHERE id=101`)[0]);
  assert.equal(pub.many(`SELECT status FROM sales_consult_recordings WHERE id=101`)[0].status, 'queued');
});

test('processQueueTick: queued 건을 집어 done 으로 만든다', async () => {
  pub.none(`INSERT INTO sales_consult_recordings (id, consult_id, mime, audio_b64, created_by)
            VALUES (102, 11, 'audio/webm', '${B64}', 3)`);
  const n = await processQueueTick();
  assert.equal(n, 1);
  assert.equal(pub.many(`SELECT status FROM sales_consult_recordings WHERE id=102`)[0].status, 'done');
});

// ── 긴 녹음: 전사문 분할 요약 (2026-09-04) ──────────────────────────
test('splitTranscript: 짧으면 그대로 1조각, 길면 문장 경계로 나누고 내용을 버리지 않는다', () => {
  assert.deepEqual(splitTranscript('hola'), ['hola']);
  assert.equal(splitTranscript('').length, 0);
  const sentence = 'El cliente pidió una cotización de balatas para el viernes. ';
  const long = sentence.repeat(2000);                       // ≈ 118k 자
  const parts = splitTranscript(long);
  assert.ok(parts.length > 1, '여러 조각으로 나뉘어야 함');
  assert.ok(parts.every((p) => p.length <= TRANSCRIPT_CHUNK_MAX * 1.2));
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  assert.equal(joined, long.replace(/\s+/g, ' ').trim(), '나눈 뒤 이어붙이면 원문과 같다');
});

test('splitTranscript: 아주 긴 전사문도 조각 수 상한 안에서 전부 담는다', () => {
  const huge = 'palabra '.repeat(120000);                    // ≈ 960k 자
  const parts = splitTranscript(huge);
  assert.ok(parts.length <= 16, '조각 수 상한을 지킨다');
  const total = parts.reduce((n, p) => n + p.length, 0);
  assert.ok(total > huge.trim().length * 0.99, '뒷부분을 버리지 않는다');
});

test('mergeConsultSummaries: 구간 요약을 중복 없이 합치고 next_step 은 마지막 구간을 쓴다', () => {
  const a = parseConsultSummaryJson(GOOD_SUMMARY);
  const b = parseConsultSummaryJson(JSON.stringify({
    resumen: 'Segunda parte: pago.',
    bullets: [{ category: 'pago', text: 'Pide 30 días de crédito' },
      { category: 'precio', text: 'Pide 8% de descuento en balatas CL0001.' }],
    insights: '',
    action_items: [{ content: 'Enviar cotización CL0001', category: 'precio', due_date: null },
      { content: 'Revisar crédito', category: 'pago', due_date: null }],
    products: ['CL0001', 'CL0003'], next_step: 'Llamar el martes',
  }));
  const m = mergeConsultSummaries([a, b]);
  assert.equal(m.bullets.length, 3);                        // 같은 불릿은 한 번만
  assert.equal(m.action_items.length, 3);                   // 같은 할 일은 한 번만
  assert.deepEqual(m.products, ['CL0001', 'CL0002', 'CL0003']);
  assert.equal(m.next_step, 'Llamar el martes');
  assert.ok(m.resumen.includes('balatas') && m.resumen.includes('Segunda parte'));
  assert.equal(mergeConsultSummaries([]), null);
});

test('병합 프롬프트: 구간별 메모와 카테고리 키가 들어간다', () => {
  const p = buildConsultMergePrompt({
    partials: [parseConsultSummaryJson(GOOD_SUMMARY)],
    companyName: 'Zeta', consultDate: '2026-09-04', mode: 'full',
  });
  assert.ok(p.includes('[구간 1]'));
  assert.ok(p.includes('precio'));
  assert.ok(p.includes('2026-09-04'));
});

test('processOne: 긴 전사문(2~3시간)은 구간별로 요약한 뒤 하나로 합친다', async () => {
  const long = 'El cliente habló de precios y entrega. '.repeat(4000);   // ≈ 152k 자
  pub.none(`INSERT INTO sales_consult_recordings (id, consult_id, mode, mime, transcript, created_by)
            VALUES (120, 10, 'full', 'audio/webm', '${long}', 2)`);
  const prompts = [];
  consultAiApi.summarize = async (prompt) => { prompts.push(prompt); return { ok: true, text: GOOD_SUMMARY }; };
  await processOne(pub.many(`SELECT * FROM sales_consult_recordings WHERE id=120`)[0]);
  const r = pub.many(`SELECT status, summary_json FROM sales_consult_recordings WHERE id=120`)[0];
  assert.equal(r.status, 'done');
  assert.ok(prompts.length >= 3, '구간 요약 여러 번 + 병합 1번');
  assert.ok(prompts.slice(0, -1).every((p) => p.includes('번째 구간')), '구간 프롬프트에 위치를 알려준다');
  assert.ok(prompts[prompts.length - 1].includes('[구간별 요약'), '마지막은 병합 프롬프트');
  const s = typeof r.summary_json === 'string' ? JSON.parse(r.summary_json) : r.summary_json;
  assert.equal(s.bullets.length, 2);
  const pends = pub.many(`SELECT content FROM sales_consult_pendings WHERE consult_id=10`);
  assert.equal(pends.length, 2);
});

test('processOne: 병합 응답이 깨져도 구간 요약을 합쳐 요약을 남긴다', async () => {
  const long = 'Hablamos del pago y del crédito. '.repeat(4000);
  pub.none(`INSERT INTO sales_consult_recordings (id, consult_id, mode, mime, transcript, created_by)
            VALUES (121, 10, 'full', 'audio/webm', '${long}', 2)`);
  let n = 0;
  consultAiApi.summarize = async () => { n++; return n <= 2 ? { ok: true, text: GOOD_SUMMARY } : { ok: true, text: '설명만' }; };
  await processOne(pub.many(`SELECT * FROM sales_consult_recordings WHERE id=121`)[0]);
  const r = pub.many(`SELECT status, summary_json FROM sales_consult_recordings WHERE id=121`)[0];
  assert.equal(r.status, 'done', '병합이 실패해도 요약은 남는다');
  const s = typeof r.summary_json === 'string' ? JSON.parse(r.summary_json) : r.summary_json;
  assert.ok(s.bullets.length >= 2);
});

test('processOne: 짧은 전사문은 예전처럼 한 번만 요약한다(비용 증가 없음)', async () => {
  pub.none(`INSERT INTO sales_consult_recordings (id, consult_id, mode, mime, audio_b64, created_by)
            VALUES (122, 10, 'full', 'audio/webm', '${B64}', 2)`);
  let calls = 0;
  consultAiApi.summarize = async () => { calls++; return { ok: true, text: GOOD_SUMMARY }; };
  await processOne(pub.many(`SELECT * FROM sales_consult_recordings WHERE id=122`)[0]);
  assert.equal(calls, 1);
  assert.equal(pub.many(`SELECT status FROM sales_consult_recordings WHERE id=122`)[0].status, 'done');
});

test('processOne: 여러 구간 오디오는 구간마다 전사해 이어붙인다(긴 녹음 경로)', async () => {
  pub.none(`INSERT INTO sales_consult_recordings (id, consult_id, mode, mime, audio_b64, created_by)
            VALUES (123, 10, 'full', 'audio/webm', '${B64}|${B64}|${B64}', 2)`);
  const seen = [];
  consultAiApi.transcribe = async ({ b64 }) => { seen.push(b64); return { ok: true, text: 'parte ' + seen.length }; };
  await processOne(pub.many(`SELECT * FROM sales_consult_recordings WHERE id=123`)[0]);
  const r = pub.many(`SELECT status, transcript FROM sales_consult_recordings WHERE id=123`)[0];
  assert.equal(seen.length, 3, '구간마다 Whisper 를 부른다(파일 하나가 25MB를 넘지 않게)');
  assert.equal(r.transcript, 'parte 1\nparte 2\nparte 3');
  assert.equal(r.status, 'done');
});

// ── 목록·가시성(감추기) ─────────────────────────────────────────────
test('목록: 영업사원은 본인 상담만, 디렉터는 전체', async () => {
  const o = await buildConsultList(OSCAR, { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(o.items.map((x) => x.id), [10]);
  const d = await buildConsultList(DIRECTOR, { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(d.items.map((x) => x.id).sort(), [10, 11]);
  assert.equal(d.items.find((x) => x.id === 10).by_name, 'Oscar');
  assert.equal(d.items.find((x) => x.id === 10).by_login, 'oscar');
});

test('감추기: 디렉터가 숨긴 상담은 작성자에게도 안 보이고 디렉터에게만 보인다', async () => {
  pub.none(`UPDATE sales_consults SET private_by=1, private_at=now() WHERE id=10`);
  const o = await buildConsultList(OSCAR, { from: '2026-08-01', to: '2026-08-31' });
  assert.equal(o.items.length, 0);                                  // 작성자도 못 봄
  const d = await buildConsultList(DIRECTOR, { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(d.items.map((x) => x.id).sort(), [10, 11]);
  assert.equal(d.items.find((x) => x.id === 10).is_private, true);
  const m = await buildConsultList(MARIA, { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(m.items.map((x) => x.id), [11]);                  // 남의 숨김은 안 보임
});

test('visibilityCond: 디렉터는 작성자 조건 없음, 비디렉터는 본인 조건 추가', () => {
  const p1 = []; const c1 = visibilityCond(DIRECTOR, p1);
  assert.ok(!c1.some((c) => c.includes('created_by')));
  assert.ok(c1.some((c) => c.includes('private_by')));
  const p2 = []; const c2 = visibilityCond(OSCAR, p2);
  assert.ok(c2.some((c) => c.includes('created_by')));
  assert.deepEqual(p2, [2]);
});

test('목록: 요약·펜딩·F/UP 집계가 붙는다(연체 반영)', async () => {
  pub.none(`INSERT INTO sales_consult_recordings (id, consult_id, status, duration_sec, summary_json, created_by)
            VALUES (110, 10, 'done', 900, '${GOOD_SUMMARY.replace(/'/g, "''")}', 2)`);
  pub.none(`INSERT INTO sales_consult_pendings (consult_id, content, category, due_date, done)
            VALUES (10,'연체 항목','precio','2020-01-01',FALSE)`);
  pub.none(`INSERT INTO sales_consult_pendings (consult_id, content, category, done)
            VALUES (10,'완료 항목','pago',TRUE)`);
  const d = await buildConsultList(DIRECTOR, { from: '2026-08-01', to: '2026-08-31' });
  const it = d.items.find((x) => x.id === 10);
  assert.equal(it.has_ai, true);
  assert.equal(it.rec_id, 110);
  assert.equal(it.duration_sec, 900);
  assert.equal(it.pend_total, 2);
  assert.equal(it.pend_done, 1);
  assert.ok(it.pend_overdue >= 1);
  assert.equal(it.fup, 'overdue');
  assert.ok(it.headline.startsWith('Se habló'));
  assert.equal(it.pendings[0].category, 'precio');
});

test('목록: 기간·담당자·검색 필터', async () => {
  const only18 = await buildConsultList(DIRECTOR, { from: '2026-08-18', to: '2026-08-18' });
  assert.deepEqual(only18.items.map((x) => x.id), [10]);
  const byUser = await buildConsultList(DIRECTOR, { from: '2026-08-01', to: '2026-08-31', userId: 3 });
  assert.deepEqual(byUser.items.map((x) => x.id), [11]);
  const byQ = await buildConsultList(DIRECTOR, { from: '2026-08-01', to: '2026-08-31', q: 'Aguila' });
  assert.deepEqual(byQ.items.map((x) => x.id), [10]);
  // 비디렉터의 user_id 필터는 무시(본인만)
  const spoof = await buildConsultList(OSCAR, { from: '2026-08-01', to: '2026-08-31', userId: 3 });
  assert.deepEqual(spoof.items.map((x) => x.id), [10]);
});

test('목록: 카테고리 정의를 함께 내려준다(화면 렌더용)', async () => {
  const d = await buildConsultList(DIRECTOR, { from: '2026-08-01', to: '2026-08-31' });
  assert.equal(d.categories.length, CAT_KEYS.length);
  assert.ok(d.categories.every((c) => c.key && c.ko));
});
