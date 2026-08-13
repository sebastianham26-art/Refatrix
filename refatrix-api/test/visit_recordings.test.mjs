// =====================================================================
// 방문 상담 녹음 파이프라인 + 아침 브리핑 (2026-08-03)
//   pg-mem 으로 실제 SQL 경로 통합 검증. 외부 API(Whisper/Claude/WhatsApp)는
//   ai 객체 스텁·global fetch 스텁으로 대체.
// =====================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { pool } from '../src/db.js';
import {
  processOne, processQueueTick, collectBriefingData, runSalesBriefingJob, ai,
} from '../src/routes/visitRecRoutes.js';
import {
  parseSummaryJson, mergeNote, summaryToNotes, buildBriefingText, briefingHeadline, esDateLabel, AI_MARK, clip,
} from '../src/visitAi.js';

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
    CREATE TABLE users(id INT PRIMARY KEY, name TEXT, role TEXT, team_id INT, wa_phone TEXT,
      updated_by INT, deleted_at TIMESTAMPTZ);
    CREATE TABLE customers(id INT PRIMARY KEY, name TEXT, team_id INT, deleted_at TIMESTAMPTZ);
    CREATE TABLE sales_visits(id INT PRIMARY KEY, visit_date DATE, visited_at TIMESTAMPTZ DEFAULT now(),
      customer_id INT, place_name TEXT, geo_lat FLOAT, geo_lng FLOAT, geo_accuracy FLOAT,
      met_person TEXT, talk_note TEXT, insight_note TEXT, contact_email TEXT, contact_phone TEXT,
      meeting_id INT, created_by INT, created_at TIMESTAMPTZ DEFAULT now(), deleted_at TIMESTAMPTZ);
    CREATE TABLE sales_visit_pendings(id SERIAL PRIMARY KEY, visit_id INT, content TEXT, due_date DATE,
      done BOOLEAN DEFAULT FALSE, done_at TIMESTAMPTZ, done_by INT, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE sales_visit_recordings(id SERIAL PRIMARY KEY, visit_id INT, mode TEXT DEFAULT 'memo',
      mime TEXT, duration_sec INT, size_bytes BIGINT, audio_b64 TEXT, status TEXT DEFAULT 'queued',
      error TEXT, attempts INT DEFAULT 0, transcript TEXT, summary_json JSONB,
      created_by INT, created_at TIMESTAMPTZ DEFAULT now(), processed_at TIMESTAMPTZ);
    CREATE TABLE sales_briefing_sends(id SERIAL PRIMARY KEY, user_id INT, brief_date DATE, status TEXT,
      error TEXT, attempts INT DEFAULT 0, sent_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(user_id, brief_date));
    CREATE TABLE customer_meetings(id INT PRIMARY KEY, customer_id INT, meeting_date DATE, note TEXT,
      stage_before INT, stage_after INT, created_by INT);
    CREATE TABLE calendar_events(id INT PRIMARY KEY, event_date DATE, event_time TEXT, event_at TIMESTAMPTZ,
      content TEXT, scope TEXT DEFAULT 'personal', team_id INT, owner_id INT, created_by INT, deleted_at TIMESTAMPTZ);
    CREATE TABLE calendar_event_targets(event_id INT, user_id INT);
    CREATE TABLE todos(id INT PRIMARY KEY, title TEXT, detail TEXT, assignee_id INT, due_date DATE,
      status TEXT DEFAULT 'open', created_by INT, deleted_at TIMESTAMPTZ);
    CREATE TABLE todo_assignees(todo_id INT, user_id INT);
    CREATE TABLE audit_log(id SERIAL PRIMARY KEY, user_id INT, device_id INT, action TEXT, target TEXT,
      detail TEXT, result TEXT, occurred_at TIMESTAMPTZ DEFAULT now());
  `);
  const run = (text, params) => pub.query(String(text).replace(/\$(\d+)/g, (_, n) => esc((params || [])[Number(n) - 1])));
  pool.query = async (text, params) => run(text, params);
  pool.connect = async () => ({
    query: async (text, params) => run(text, params),
    release: () => {},
  });
}

const B64 = Buffer.from('fake-audio').toString('base64');
function seedBase() {
  pub.none(`
    INSERT INTO users VALUES (1,'director','director',NULL,NULL,NULL,NULL);
    INSERT INTO users VALUES (2,'Oscar','sales',5,'8112345678',NULL,NULL);
    INSERT INTO users VALUES (3,'Maria','sales',5,NULL,NULL,NULL);
    INSERT INTO customers VALUES (10,'Refaccionaria Aguila',5,NULL);
    INSERT INTO customer_meetings VALUES (77,10,'2026-01-02','[현장방문]' || E'\\n' || '만남: Sr. Juan',NULL,NULL,2);
    INSERT INTO sales_visits (id, visit_date, customer_id, place_name, geo_lat, geo_lng, met_person, talk_note, meeting_id, created_by)
      VALUES (100,'2026-01-02',10,'Refaccionaria Aguila',25.6,-100.3,'Sr. Juan','수기 메모',77,2);
  `);
}
const SUMMARY = {
  resumen: 'Habló de balatas y precios.',
  insights: 'Cliente compra a competidor X.',
  action_items: [
    { content: 'Enviar cotización de balatas', due_date: '2026-08-05' },
    { content: 'Confirmar stock CL0001', due_date: null },
  ],
  products: ['CL0001'],
  next_step: 'Visitar próximo lunes',
};

beforeEach(() => {
  installDb();
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  delete process.env.VISIT_KEEP_AUDIO;
  // 외부 호출 기본 스텁(각 테스트에서 덮어씀)
  ai.transcribe = async () => ({ ok: true, text: 'transcripción de prueba' });
  ai.summarize = async () => ({ ok: true, text: JSON.stringify(SUMMARY) });
});

async function claimRow(id) {
  return (await pool.query(
    `UPDATE sales_visit_recordings SET status='transcribing', attempts=attempts+1 WHERE id=${id}
     RETURNING id, visit_id, mode, mime, audio_b64, transcript, duration_sec, created_by, attempts`)).rows[0];
}

// ── ① 녹음 처리 성공 경로 ────────────────────────────────────────────
test('processOne: 전사→요약→노트 병합→펜딩 자동 등록→미팅 노트 갱신→오디오 폐기', async () => {
  seedBase();
  pub.none(`INSERT INTO sales_visit_recordings (visit_id, mode, mime, audio_b64, created_by)
            VALUES (100,'memo','audio/webm','${B64}',2)`);
  const row = await claimRow(1);
  const ok = await processOne(row);
  assert.equal(ok, true);
  const rec = pub.one(`SELECT status, error, audio_b64, transcript, summary_json FROM sales_visit_recordings WHERE id=1`);
  assert.equal(rec.status, 'done');
  assert.equal(rec.audio_b64, null, '기본은 오디오 원본 폐기');
  assert.equal(rec.transcript, 'transcripción de prueba');
  const v = pub.one(`SELECT talk_note, insight_note FROM sales_visits WHERE id=100`);
  assert.ok(v.talk_note.startsWith('수기 메모'), '수기 입력 보존');
  assert.ok(v.talk_note.includes(AI_MARK) && v.talk_note.includes('balatas'), 'AI 요약 병합');
  assert.ok(v.talk_note.includes('CL0001') && v.talk_note.includes('다음:'), '제품·다음 계획 포함');
  assert.ok(v.insight_note.includes('competidor X'));
  const pend = pub.many(`SELECT content, due_date FROM sales_visit_pendings WHERE visit_id=100 ORDER BY id`);
  assert.equal(pend.length, 2, 'action_items 2건 펜딩 자동 등록');
  assert.equal(new Date(pend[0].due_date).toISOString().slice(0, 10), '2026-08-05');
  assert.equal(pend[1].due_date, null);
  const meet = pub.one(`SELECT note FROM customer_meetings WHERE id=77`);
  assert.ok(meet.note.startsWith('[현장방문]') && meet.note.includes(AI_MARK), '자동 미팅 노트에 AI 블록');
});

// ── ①-b 다중 구간(절전/앱전환 중단 후 자동 이어녹음) ─────────────────
test('processOne 다중 구간: 구간별 Whisper 전사 후 이어붙임 · done', async () => {
  seedBase();
  const P1 = Buffer.from('parte-uno').toString('base64');
  const P2 = Buffer.from('parte-dos').toString('base64');
  pub.none(`INSERT INTO sales_visit_recordings (visit_id, mode, mime, audio_b64, created_by)
            VALUES (100,'full','audio/webm','${P1}|${P2}',2)`);
  const calls = [];
  ai.transcribe = async ({ b64 }) => { calls.push(b64); return { ok: true, text: calls.length === 1 ? 'primera parte' : 'segunda parte' }; };
  const row = await claimRow(1);
  const ok = await processOne(row);
  assert.equal(ok, true);
  assert.equal(calls.length, 2, '구간별로 Whisper 2회 호출');
  assert.deepEqual(calls, [P1, P2], '각 구간의 base64 가 그대로 전달');
  const rec = pub.one(`SELECT status, transcript FROM sales_visit_recordings WHERE id=1`);
  assert.equal(rec.status, 'done');
  assert.equal(rec.transcript, 'primera parte\nsegunda parte', '전사문 이어붙임');
});

test('processOne 다중 구간: 한 구간 일시 오류 → 자동 재큐(전체 재시도)', async () => {
  seedBase();
  const P1 = Buffer.from('a').toString('base64');
  const P2 = Buffer.from('b').toString('base64');
  pub.none(`INSERT INTO sales_visit_recordings (visit_id, mode, mime, audio_b64, created_by)
            VALUES (100,'memo','audio/webm','${P1}|${P2}',2)`);
  let n = 0;
  ai.transcribe = async () => { n++; return n === 2 ? { ok: false, error: 'stt: network', transient: true } : { ok: true, text: 'ok' }; };
  const row = await claimRow(1);
  await processOne(row);
  const rec = pub.one(`SELECT status, error, audio_b64 FROM sales_visit_recordings WHERE id=1`);
  assert.equal(rec.status, 'queued', '일시 오류 → 자동 재큐');
  assert.ok(rec.audio_b64.includes('|'), '오디오 구간 보존(재시도 가능)');
});

test('processOne 재처리: 기존 AI 블록 교체(중복 누적 없음)', async () => {
  seedBase();
  pub.none(`INSERT INTO sales_visit_recordings (visit_id, mode, mime, audio_b64, created_by)
            VALUES (100,'memo','audio/webm','${B64}',2)`);
  await processOne(await claimRow(1));
  pub.none(`INSERT INTO sales_visit_recordings (visit_id, mode, mime, audio_b64, created_by)
            VALUES (100,'memo','audio/webm','${B64}',2)`);
  ai.summarize = async () => ({ ok: true, text: JSON.stringify({ ...SUMMARY, resumen: 'SEGUNDA versión.' }) });
  await processOne(await claimRow(2));
  const v = pub.one(`SELECT talk_note FROM sales_visits WHERE id=100`);
  assert.equal(v.talk_note.split(AI_MARK).length - 1, 1, 'AI 블록은 1개만(교체)');
  assert.ok(v.talk_note.includes('SEGUNDA') && !v.talk_note.includes('balatas'));
  assert.ok(v.talk_note.startsWith('수기 메모'));
});

// ── ② 실패·재시도 정책 ───────────────────────────────────────────────
test('일시 오류(network)는 자동 재큐, 상한(3회) 초과 시 failed', async () => {
  seedBase();
  pub.none(`INSERT INTO sales_visit_recordings (visit_id, mode, mime, audio_b64, created_by)
            VALUES (100,'memo','audio/webm','${B64}',2)`);
  ai.transcribe = async () => ({ ok: false, error: 'stt: network', transient: true });
  await processOne(await claimRow(1));
  assert.equal(pub.one(`SELECT status FROM sales_visit_recordings WHERE id=1`).status, 'queued', '1회차 → 재큐');
  await processOne(await claimRow(1));
  assert.equal(pub.one(`SELECT status FROM sales_visit_recordings WHERE id=1`).status, 'queued', '2회차 → 재큐');
  await processOne(await claimRow(1));
  const r = pub.one(`SELECT status, error, attempts FROM sales_visit_recordings WHERE id=1`);
  assert.equal(r.status, 'failed', '3회차(상한) → failed');
  assert.equal(r.error, 'stt: network');
});

test('비일시 오류(ai_parse)는 즉시 failed · 전사문은 보존 · 재시도 시 STT 건너뜀', async () => {
  seedBase();
  pub.none(`INSERT INTO sales_visit_recordings (visit_id, mode, mime, audio_b64, created_by)
            VALUES (100,'memo','audio/webm','${B64}',2)`);
  ai.summarize = async () => ({ ok: true, text: '이건 JSON 이 아님' });
  let sttCalls = 0;
  const origT = ai.transcribe;
  ai.transcribe = async (a) => { sttCalls++; return origT(a); };
  await processOne(await claimRow(1));
  const r1 = pub.one(`SELECT status, transcript, audio_b64 FROM sales_visit_recordings WHERE id=1`);
  assert.equal(r1.status, 'failed');
  assert.equal(r1.transcript, 'transcripción de prueba', '전사문 보존');
  assert.equal(r1.audio_b64, null, '전사 성공 시점에 오디오 폐기');
  assert.equal(sttCalls, 1);
  // 수동 재시도(요약만 재실행)
  ai.summarize = async () => ({ ok: true, text: JSON.stringify(SUMMARY) });
  pub.none(`UPDATE sales_visit_recordings SET status='queued', error=NULL WHERE id=1`);
  await processOne(await claimRow(1));
  assert.equal(sttCalls, 1, '재시도에서 STT 재호출 없음');
  assert.equal(pub.one(`SELECT status FROM sales_visit_recordings WHERE id=1`).status, 'done');
});

test('키 미설정: OPENAI 없음 → no_openai_key 로 failed(자동 재큐 안 함)', async () => {
  seedBase();
  delete process.env.OPENAI_API_KEY;
  pub.none(`INSERT INTO sales_visit_recordings (visit_id, mode, mime, audio_b64, created_by)
            VALUES (100,'memo','audio/webm','${B64}',2)`);
  await processOne(await claimRow(1));
  const r = pub.one(`SELECT status, error FROM sales_visit_recordings WHERE id=1`);
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'no_openai_key');
});

test('processQueueTick: 큐 순차 소진(2건)', async () => {
  seedBase();
  pub.none(`INSERT INTO sales_visits (id, visit_date, customer_id, place_name, geo_lat, geo_lng, created_by)
            VALUES (101,'2026-08-03',NULL,'Nueva Tienda',25.7,-100.4,2)`);
  pub.none(`INSERT INTO sales_visit_recordings (visit_id, mode, mime, audio_b64, created_by) VALUES (100,'memo','audio/webm','${B64}',2)`);
  pub.none(`INSERT INTO sales_visit_recordings (visit_id, mode, mime, audio_b64, created_by) VALUES (101,'full','audio/mp4','${B64}',2)`);
  const n = await processQueueTick(5);
  assert.equal(n, 2);
  const sts = pub.many(`SELECT status FROM sales_visit_recordings ORDER BY id`).map((r) => r.status);
  assert.deepEqual(sts, ['done', 'done']);
  assert.ok(pub.many(`SELECT * FROM sales_visit_pendings WHERE visit_id=101`).length === 2, '미등록 방문처(미팅 없음)도 펜딩 등록');
});

// ── ③ 브리핑 데이터 수집 ─────────────────────────────────────────────
function seedBriefing(mxToday, mxYesterday) {
  pub.none(`
    INSERT INTO calendar_events (id, event_date, event_time, content, scope, team_id, created_by, deleted_at)
      VALUES (1,'${mxToday}','09:00','회사 전체 회의','company',NULL,1,NULL);
    INSERT INTO calendar_events (id, event_date, content, scope, team_id, created_by, deleted_at)
      VALUES (2,'${mxToday}','팀 일정','team',5,1,NULL);
    INSERT INTO calendar_events (id, event_date, content, scope, team_id, created_by, deleted_at)
      VALUES (3,'${mxToday}','오스카 개인 일정','personal',NULL,2,NULL);
    INSERT INTO calendar_events (id, event_date, content, scope, team_id, created_by, deleted_at)
      VALUES (4,'${mxToday}','남의 개인 일정','personal',NULL,3,NULL);
    INSERT INTO calendar_events (id, event_date, content, scope, team_id, created_by, deleted_at)
      VALUES (5,'${mxToday}','나에게 공유된 일정','shared',NULL,3,NULL);
    INSERT INTO calendar_event_targets VALUES (5,2);
    INSERT INTO sales_visits (id, visit_date, customer_id, place_name, geo_lat, geo_lng, created_by)
      VALUES (200,'${mxYesterday}',10,'Refaccionaria Aguila',25.6,-100.3,2);
    INSERT INTO sales_visit_recordings (visit_id, mode, status, summary_json, created_by)
      VALUES (200,'memo','done','${JSON.stringify(SUMMARY).replace(/'/g, "''")}',2);
    INSERT INTO sales_visit_pendings (visit_id, content, due_date, done) VALUES (200,'Pendiente vencido','2026-01-05',FALSE);
    INSERT INTO sales_visit_pendings (visit_id, content, due_date, done) VALUES (200,'Pendiente hoy','${mxToday}',FALSE);
    INSERT INTO sales_visit_pendings (visit_id, content, due_date, done) VALUES (200,'Pendiente done','${mxToday}',TRUE);
    INSERT INTO todos (id, title, assignee_id, due_date, status) VALUES (1,'Tarea ERP',2,'${mxToday}','open');
    INSERT INTO todos (id, title, assignee_id, due_date, status) VALUES (2,'Tarea ajena',3,'${mxToday}','open');
  `);
}

test('collectBriefingData: 일정 가시성(회사+팀+개인+공유만) · 펜딩 분류 · 어제 방문 AI 헤드라인 · 할일', async () => {
  seedBase();
  const { mxTodayStr } = await import('../src/workingHours.js');
  const mxToday = mxTodayStr(new Date());
  const [y, m, d] = mxToday.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d)); t.setUTCDate(t.getUTCDate() - 1);
  const mxYesterday = t.toISOString().slice(0, 10);
  seedBriefing(mxToday, mxYesterday);

  const data = await collectBriefingData(2);
  assert.equal(data.name, 'Oscar');
  const contents = data.schedule.map((s) => s.content);
  assert.ok(contents.includes('회사 전체 회의') && contents.includes('팀 일정')
    && contents.includes('오스카 개인 일정') && contents.includes('나에게 공유된 일정'));
  assert.ok(!contents.includes('남의 개인 일정'), '타인 개인 일정 제외');
  assert.equal(data.schedule[0].time, '09:00', '시간순 정렬(타임드 먼저)');
  assert.equal(data.pendings.overdue.length, 1);
  assert.ok(data.pendings.overdue[0].overdue > 0);
  assert.equal(data.pendings.today.length, 1, 'done 은 제외');
  assert.equal(data.todos.length, 1, '남의 할일 제외');
  assert.equal(data.yesterdayVisits.length, 1);
  assert.equal(data.yesterdayVisits[0].resumen, SUMMARY.resumen, '녹음 AI 요약 헤드라인');
  // 텍스트 조립
  const text = buildBriefingText(data);
  assert.ok(text.includes('Buenos días, Oscar') && text.includes('VENCIDO') && text.includes('HOY'));
  assert.ok(text.includes('Visitas de ayer') && text.includes('balatas'));
});

// ── ④ 브리핑 발송 잡 ─────────────────────────────────────────────────
function stubGraph(responder) {
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('graph.facebook.com')) return responder(url, opts);
    throw new Error('unexpected fetch: ' + url);
  };
}

test('runSalesBriefingJob: wa_phone 설정자에게만 발송 · 하루 1회 가드 · force 재발송', async () => {
  seedBase();
  process.env.WHATSAPP_TOKEN = 't'; process.env.WHATSAPP_PHONE_ID = 'p';
  let calls = 0;
  stubGraph(async () => { calls++; return { ok: true, json: async () => ({ messages: [{ id: 'wamid.1' }] }) }; });

  const out1 = await runSalesBriefingJob({});
  assert.equal(out1.results.length, 1, 'wa_phone 있는 Oscar 만 대상(디렉터·Maria 제외)');
  assert.equal(out1.results[0].ok, true);
  assert.equal(calls, 1);
  const s1 = pub.one(`SELECT status, attempts FROM sales_briefing_sends WHERE user_id=2`);
  assert.equal(s1.status, 'sent_text');

  const out2 = await runSalesBriefingJob({});
  assert.equal(out2.results[0].skipped, 'already_sent', '같은 날 재발송 안 함');
  assert.equal(calls, 1);

  const out3 = await runSalesBriefingJob({ force: true, userId: 2 });
  assert.equal(out3.results[0].ok, true, 'force 는 재발송');
  assert.equal(calls, 2);
});

test('runSalesBriefingJob: 텍스트 실패 → failed 기록·attempts 누적, 이후 성공 시 sent', async () => {
  seedBase();
  process.env.WHATSAPP_TOKEN = 't'; process.env.WHATSAPP_PHONE_ID = 'p';
  delete process.env.WHATSAPP_TEMPLATE;
  stubGraph(async () => ({ ok: false, json: async () => ({ error: { code: 131047, message: 're-engagement' } }) }));
  const out1 = await runSalesBriefingJob({});
  assert.equal(out1.results[0].ok, undefined);
  const s1 = pub.one(`SELECT status, attempts FROM sales_briefing_sends WHERE user_id=2`);
  assert.equal(s1.status, 'failed');
  assert.equal(Number(s1.attempts), 1);
  stubGraph(async () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.2' }] }) }));
  const out2 = await runSalesBriefingJob({});
  assert.equal(out2.results[0].ok, true, '실패 건은 다음 틱에 재시도');
  const s2 = pub.one(`SELECT status, attempts FROM sales_briefing_sends WHERE user_id=2`);
  assert.equal(s2.status, 'sent_text');
  assert.equal(Number(s2.attempts), 2);
});

test('번호 오류(bad_number)는 발송 시도 없이 failed', async () => {
  seedBase();
  process.env.WHATSAPP_TOKEN = 't'; process.env.WHATSAPP_PHONE_ID = 'p';
  pub.none(`UPDATE users SET wa_phone='12' WHERE id=2`);
  stubGraph(async () => { throw new Error('should not call'); });
  const out = await runSalesBriefingJob({});
  assert.equal(out.results[0].error, 'bad_number');
});

// ── ⑤ visitAi 순수 함수 ──────────────────────────────────────────────
test('parseSummaryJson: 마크다운 감싼 JSON·불량 due_date·10건 초과 캡·쓰레기 입력', () => {
  const wrapped = '```json\n' + JSON.stringify(SUMMARY) + '\n```';
  const p1 = parseSummaryJson(wrapped);
  assert.equal(p1.resumen, SUMMARY.resumen);
  assert.equal(p1.action_items.length, 2);
  const p2 = parseSummaryJson(JSON.stringify({
    resumen: 'r',
    action_items: [
      { content: 'a', due_date: 'mañana' }, { content: '', due_date: '2026-08-05' },
      ...Array.from({ length: 15 }, (_, i) => ({ content: 'x' + i })),
    ],
  }));
  assert.equal(p2.action_items[0].due_date, null, '불량 날짜 → null');
  assert.ok(p2.action_items.length <= 10, '최대 10건');
  assert.ok(!p2.action_items.some((a) => !a.content), '빈 내용 제거');
  assert.equal(parseSummaryJson('no json here'), null);
  assert.equal(parseSummaryJson('{broken'), null);
});

test('mergeNote/summaryToNotes: 병합·교체·빈 값', () => {
  assert.equal(mergeNote('', 'A'), AI_MARK + ' A');
  assert.equal(mergeNote('수기', 'A'), '수기\n' + AI_MARK + ' A');
  assert.equal(mergeNote('수기\n' + AI_MARK + ' 옛요약', 'NEW'), '수기\n' + AI_MARK + ' NEW');
  assert.equal(mergeNote('수기', ''), '수기');
  assert.equal(mergeNote('', ''), null);
  const n = summaryToNotes(SUMMARY);
  assert.ok(n.talkAppend.includes(SUMMARY.resumen) && n.talkAppend.includes('CL0001'));
  assert.equal(n.insightAppend, SUMMARY.insights);
});

test('buildBriefingText/briefingHeadline: 빈 데이터·줄바꿈 금지·날짜 라벨', () => {
  const empty = buildBriefingText({ name: 'Oscar', mxToday: '2026-08-03', schedule: [], pendings: {}, todos: [], yesterdayVisits: [] });
  assert.ok(empty.includes('Sin eventos') && empty.includes('Sin pendientes') && empty.includes('Sin visitas'));
  const hl = briefingHeadline({ mxToday: '2026-08-03', schedule: [{}], pendings: { overdue: [{}, {}] }, yesterdayVisits: [] });
  assert.ok(!hl.includes('\n') && hl.includes('agenda 1') && hl.includes('vencidos 2'));
  assert.equal(esDateLabel('2026-08-03'), 'lunes 03/08/2026');
  assert.equal(clip('abcdef', 4), 'abc…');
});

// ── ⑥ 방문 리뷰(buildVisitReview) ─────────────────────────────────────
test('buildVisitReview: 날짜별 순서·함축·F/UP 상태·권한 스코프', async () => {
  const { buildVisitReview } = await import('../src/routes/visitRecRoutes.js');
  seedBase();
  const { mxTodayStr } = await import('../src/workingHours.js');
  const mxToday = mxTodayStr(new Date());
  // 방문 3건: 오늘 오스카 2건(순서 확인) + 오늘 마리아 1건(권한 확인)
  pub.none(`
    UPDATE sales_visits SET visit_date='${mxToday}', visited_at='2026-08-04T15:00:00Z' WHERE id=100;
    INSERT INTO sales_visits (id, visit_date, visited_at, customer_id, place_name, geo_lat, geo_lng, talk_note, created_by)
      VALUES (101,'${mxToday}','2026-08-04T13:00:00Z',NULL,'Nueva Tienda',25.7,-100.4,'사전계획 텍스트',2);
    INSERT INTO sales_visits (id, visit_date, visited_at, customer_id, place_name, geo_lat, geo_lng, created_by)
      VALUES (102,'${mxToday}','2026-08-04T14:00:00Z',10,'Refaccionaria Aguila',25.6,-100.3,3);
    INSERT INTO sales_visit_recordings (visit_id, mode, status, summary_json, created_by)
      VALUES (100,'memo','done','${JSON.stringify(SUMMARY).replace(/'/g, "''")}',2);
    INSERT INTO sales_visit_pendings (visit_id, content, due_date, done) VALUES (100,'A 완료된 일','2026-08-01',TRUE);
    INSERT INTO sales_visit_pendings (visit_id, content, due_date, done) VALUES (100,'B 연체된 일','2026-01-05',FALSE);
    INSERT INTO sales_visit_pendings (visit_id, content, done) VALUES (101,'C 열린 일',FALSE);
  `);
  // 디렉터: 전체
  const dir = await buildVisitReview({ userId: 1, role: 'director' }, {});
  const day = dir.days.find((d) => d.date === mxToday);
  assert.ok(day && day.visits.length === 3);
  assert.deepEqual(day.visits.map((v) => v.id), [101, 102, 100], 'visited_at 오름차순(방문 순서)');
  const v100 = day.visits.find((v) => v.id === 100);
  assert.equal(v100.has_ai, true);
  assert.equal(v100.headline, SUMMARY.resumen, 'AI resumen 이 함축으로');
  assert.equal(v100.fup, 'overdue', '연체 펜딩 있으면 overdue');
  assert.equal(v100.pend_total, 2); assert.equal(v100.pend_done, 1); assert.equal(v100.pend_overdue, 1);
  const v101 = day.visits.find((v) => v.id === 101);
  assert.equal(v101.fup, 'open'); assert.equal(v101.plan, '사전계획 텍스트');
  assert.equal(v101.headline, '사전계획 텍스트', 'AI 없으면 수기 함축');
  const v102 = day.visits.find((v) => v.id === 102);
  assert.equal(v102.fup, 'none'); assert.equal(v102.name, 'Refaccionaria Aguila');
  // 영업사원(오스카): 본인 것만
  const own = await buildVisitReview({ userId: 2, role: 'sales' }, {});
  assert.deepEqual(own.days.find((d) => d.date === mxToday).visits.map((v) => v.id), [101, 100]);
  // 디렉터 + user_id 필터
  const filt = await buildVisitReview({ userId: 1, role: 'director' }, { userId: 3 });
  assert.deepEqual(filt.days.find((d) => d.date === mxToday).visits.map((v) => v.id), [102]);
});

test('buildVisitReview: 기간 검증(31일 캡·역순 보정·기본 7일)', async () => {
  const { buildVisitReview } = await import('../src/routes/visitRecRoutes.js');
  seedBase();
  const r1 = await buildVisitReview({ userId: 1, role: 'director' }, { from: '2026-01-01', to: '2026-08-01' });
  assert.equal(r1.from, '2026-07-01', '31일 초과 → to-31 로 캡');
  const r2 = await buildVisitReview({ userId: 1, role: 'director' }, { from: '2026-08-10', to: '2026-08-01' });
  assert.equal(r2.from, r2.to, '역순 입력 보정');
  const r3 = await buildVisitReview({ userId: 1, role: 'director' }, {});
  assert.equal(r3.to, (await import('../src/workingHours.js')).mxTodayStr(new Date()), '기본 to=오늘');
});
