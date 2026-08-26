// =====================================================================
// 전시회 미팅 시간표(영업 > 고객상담 > 🎪 전시회) 백엔드
//   pg-mem 통합 + 순수함수 단위 (2026-08-26)
//   외부 API(Claude)는 consultAiApi 스텁으로 대체.
// =====================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { pool } from '../src/db.js';
import {
  buildBoard, getExhibition, ownerOptions, mxNowParts, shiftYmd,
} from '../src/routes/exhibitionRoutes.js';
import {
  ordinalDay, dayAxis, hourAxis, weekdayKo, ownerColorMap, OWNER_PALETTE,
  meetingTotals, ownerTotals, normQual, parseQualEvalJson, buildQualEvalPrompt,
  summaryToText, num, clip, normKind, BOOTH_COLOR,
} from '../src/exhibitionAi.js';

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
    CREATE TABLE exhibitions(id SERIAL PRIMARY KEY, name TEXT, venue TEXT, start_date DATE,
      day_count INT DEFAULT 3, start_hour INT DEFAULT 8, end_hour INT DEFAULT 18, currency TEXT DEFAULT 'MXN',
      is_active BOOLEAN DEFAULT TRUE, note TEXT, created_by INT,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ);
    CREATE TABLE exhibition_meetings(id SERIAL PRIMARY KEY, exhibition_id INT, day_no INT, slot_hour INT,
      meet_date DATE, owner_user_id INT, customer_id INT, company_name TEXT, contact_name TEXT,
      wa_phone TEXT, email TEXT, goal_note TEXT, target_quote NUMERIC DEFAULT 0, target_order NUMERIC DEFAULT 0,
      actual_quote NUMERIC, actual_order NUMERIC, memo TEXT, status TEXT DEFAULT 'planned',
      is_walkin BOOLEAN DEFAULT FALSE, kind TEXT DEFAULT 'meeting', is_confirmed BOOLEAN DEFAULT FALSE,
      confirmed_at TIMESTAMPTZ, confirmed_by INT, consult_id INT, qual_result TEXT, qual_eval TEXT,
      qual_eval_json JSONB, qual_eval_at TIMESTAMPTZ, created_by INT,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ);
    CREATE TABLE audit_log(id SERIAL PRIMARY KEY, user_id INT, device_id INT, action TEXT, target TEXT,
      detail TEXT, result TEXT, occurred_at TIMESTAMPTZ DEFAULT now());
  `);
  const run = (text, params) => pub.query(String(text).replace(/\$(\d+)/g, (_, n) => esc((params || [])[Number(n) - 1])));
  pool.query = async (text, params) => run(text, params);
  pool.connect = async () => ({ query: async (text, params) => run(text, params), release: () => {} });
}

function seed() {
  pub.none(`
    INSERT INTO users VALUES (1,'Sebastian','admin','director',NULL,NULL);
    INSERT INTO users VALUES (2,'Oscar','oscar','sales',5,NULL);
    INSERT INTO users VALUES (3,'Maria','maria','sales',5,NULL);
    INSERT INTO users VALUES (4,'Viewer','viewer','viewer',5,NULL);
    INSERT INTO users VALUES (5,'Borrado','old','sales',5,now());
    INSERT INTO customers VALUES (101,'Refaccionaria El Aguila',5,NULL);

    INSERT INTO exhibitions (id,name,venue,start_date,day_count,start_hour,end_hour,currency,is_active,created_by)
      VALUES (10,'RUJAC 2026','Expo Guadalajara','2026-09-16',3,8,18,'MXN',TRUE,1);
    INSERT INTO exhibitions (id,name,venue,start_date,day_count,start_hour,end_hour,currency,is_active,created_by)
      VALUES (11,'Automechanika','CDMX','2026-06-01',2,9,17,'USD',FALSE,1);

    INSERT INTO exhibition_meetings (id,exhibition_id,day_no,slot_hour,meet_date,owner_user_id,customer_id,
      company_name,contact_name,goal_note,target_quote,target_order,actual_quote,actual_order,status,is_walkin,created_by)
      VALUES (1,10,1,9,'2026-09-16',2,101,'Grupo Zeta','Juan','연간 계약 의향 확인',850000,400000,NULL,NULL,'planned',FALSE,2);
    INSERT INTO exhibition_meetings (id,exhibition_id,day_no,slot_hour,meet_date,owner_user_id,
      company_name,goal_note,target_quote,target_order,actual_quote,actual_order,status,is_walkin,created_by,qual_result)
      VALUES (2,10,1,11,'2026-09-16',3,'El Aguila','신뢰 회복',420000,250000,460000,250000,'done',FALSE,3,'achieved');
    INSERT INTO exhibition_meetings (id,exhibition_id,day_no,slot_hour,meet_date,owner_user_id,
      company_name,target_quote,target_order,status,is_walkin,created_by)
      VALUES (3,10,2,12,'2026-09-17',2,'Llantas y Mas (부스)',0,0,'done',TRUE,2);
    INSERT INTO exhibition_meetings (id,exhibition_id,day_no,slot_hour,meet_date,owner_user_id,
      company_name,target_quote,target_order,status,kind,is_confirmed,created_by)
      VALUES (6,10,3,15,'2026-09-18',2,'Frenos del Golfo (부스방문)',0,0,'planned','booth',FALSE,2);
    UPDATE exhibition_meetings SET is_confirmed = TRUE, confirmed_at = now() WHERE id = 2;
    INSERT INTO exhibition_meetings (id,exhibition_id,day_no,slot_hour,meet_date,owner_user_id,
      company_name,target_quote,target_order,status,created_by)
      VALUES (4,10,3,13,'2026-09-18',1,'Comercial Andrade',150000,0,'cancelled',1);
    INSERT INTO exhibition_meetings (id,exhibition_id,day_no,slot_hour,company_name,target_quote,target_order,created_by,deleted_at)
      VALUES (5,10,3,14,'삭제된 미팅',999999,999999,1,now());
  `);
}

const DIRECTOR = { userId: 1, role: 'director' };
const OSCAR = { userId: 2, role: 'sales' };
const MARIA = { userId: 3, role: 'sales' };

beforeEach(() => {
  installDb();
  seed();
  process.env.ANTHROPIC_API_KEY = 'k';
});

// =====================================================================
// ① 시간표 축 · 순수함수
// =====================================================================
test('ordinalDay: 1st/2nd/3rd/4th · 11th~13th 예외', () => {
  assert.equal(ordinalDay(1), '1st day');
  assert.equal(ordinalDay(2), '2nd day');
  assert.equal(ordinalDay(3), '3rd day');
  assert.equal(ordinalDay(4), '4th day');
  assert.equal(ordinalDay(11), '11th day');
  assert.equal(ordinalDay(12), '12th day');
  assert.equal(ordinalDay(13), '13th day');
  assert.equal(ordinalDay(21), '21st day');
  assert.equal(ordinalDay(0), '');
});

test('dayAxis: 시작일부터 일수만큼 날짜·요일이 붙는다(3일 = 1st/2nd/3rd)', () => {
  const ax = dayAxis('2026-09-16', 3);
  assert.equal(ax.length, 3);
  assert.deepEqual(ax.map((d) => d.date), ['2026-09-16', '2026-09-17', '2026-09-18']);
  assert.deepEqual(ax.map((d) => d.label), ['1st day', '2nd day', '3rd day']);
  assert.equal(ax[0].weekday, weekdayKo('2026-09-16'));
  assert.equal(dayAxis('2026-09-16', 99).length, 10, '일수 상한 10');
  assert.equal(dayAxis('2026-09-16', 0).length, 1, '일수 하한 1');
});

test('hourAxis: 08~18시는 10칸이고 마지막 칸은 17:00–18:00', () => {
  const hs = hourAxis(8, 18);
  assert.equal(hs.length, 10);
  assert.equal(hs[0].label, '08:00');
  assert.equal(hs[0].range, '08:00–09:00');
  assert.equal(hs[9].range, '17:00–18:00');
  assert.equal(hourAxis(9, 17).length, 8);
  assert.equal(hourAxis(8, 8).length, 1, '종료가 시작 이하면 최소 1칸');
});

test('shiftYmd: 월말·연말을 넘어가도 정확하다', () => {
  assert.equal(shiftYmd('2026-09-16', 2), '2026-09-18');
  assert.equal(shiftYmd('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftYmd('2026-02-28', 1), '2026-03-01');
});

test('mxNowParts: UTC-6 로 환산한 날짜·시각을 준다', () => {
  const p = mxNowParts(new Date('2026-09-17T02:30:00Z'));   // 멕시코 20:30 (전날)
  assert.equal(p.date, '2026-09-16');
  assert.equal(p.hour, 20);
});

// =====================================================================
// ② 담당자 색상(자동 배정)
// =====================================================================
test('ownerColorMap: 같은 사람은 항상 같은 색 · 서로 겹치지 않는다', () => {
  const a = ownerColorMap([1, 2, 3, 4, 5, 6, 7]);
  const b = ownerColorMap([7, 5, 3, 1, 6, 4, 2]);   // 순서만 바꿔도
  assert.deepEqual(a[3], b[3]);
  const idxs = Object.values(a).map((x) => x.idx);
  assert.equal(new Set(idxs).size, idxs.length, '색 인덱스 중복 없음');
  for (const v of Object.values(a)) assert.ok(/^#[0-9A-F]{6}$/i.test(v.bg));
});

test('ownerColorMap: 팔레트보다 많으면 순환하되 예외 없이 채운다', () => {
  const ids = Array.from({ length: OWNER_PALETTE.length + 4 }, (_, i) => i + 1);
  const m = ownerColorMap(ids);
  assert.equal(Object.keys(m).length, ids.length);
});

test('ownerColorMap: 잘못된 값(0·음수·null·중복)은 걸러낸다', () => {
  const m = ownerColorMap([2, 2, 0, -1, null, undefined, '3']);
  assert.deepEqual(Object.keys(m).sort(), ['2', '3']);
});

// =====================================================================
// ③ 목표/달성 집계
// =====================================================================
const SAMPLE = [
  { status: 'planned', target_quote: '850000', target_order: 400000, actual_quote: null, actual_order: null, owner_user_id: 2 },
  { status: 'done', target_quote: 420000, target_order: 250000, actual_quote: 460000, actual_order: '250000', owner_user_id: 3, qual_result: 'achieved', has_ai: true },
  { status: 'done', target_quote: 0, target_order: 0, actual_quote: 0, actual_order: 0, owner_user_id: 2, is_walkin: true, has_ai: true },
  { status: 'cancelled', target_quote: 150000, target_order: 999, actual_quote: 1, actual_order: 1, owner_user_id: 1 },
];

test('meetingTotals: 취소 건은 목표·달성 어디에도 안 들어간다', () => {
  const t = meetingTotals(SAMPLE);
  assert.equal(t.total, 3);
  assert.equal(t.cancelled, 1);
  assert.equal(t.target_quote, 1270000);
  assert.equal(t.target_order, 650000);
  assert.equal(t.actual_quote, 460000);
  assert.equal(t.actual_order, 250000);
  assert.equal(t.walkin, 1);
  assert.equal(t.done, 2);
  assert.equal(t.planned, 1);
  assert.equal(t.recorded, 2);
  assert.equal(t.qual.achieved, 1);
});

test('meetingTotals: 문자열 NUMERIC(node-pg)도 숫자로 합산된다', () => {
  const t = meetingTotals([{ status: 'done', target_quote: '1000.50', actual_quote: '2000' }]);
  assert.equal(t.target_quote, 1000.5);
  assert.equal(t.actual_quote, 2000);
});

test('meetingTotals: 목표가 0이면 달성률은 null(0으로 나누지 않는다)', () => {
  const t = meetingTotals([{ status: 'done', target_quote: 0, target_order: 0, actual_quote: 500, actual_order: 0 }]);
  assert.equal(t.rate_quote, null);
  assert.equal(t.rate_order, null);
  const t2 = meetingTotals([{ status: 'done', target_quote: 400, actual_quote: 300 }]);
  assert.equal(t2.rate_quote, 75);
});

test('ownerTotals: 담당자별로 묶고 건수 많은 순으로 준다', () => {
  const o = ownerTotals(SAMPLE);
  assert.equal(o.length, 2, '취소 건의 담당자는 빠진다');
  assert.equal(o[0].owner_user_id, 2);
  assert.equal(o[0].count, 2);
  assert.equal(o[0].target_quote, 850000);
});

test('num/clip: 쉼표·빈값·비정상 입력을 안전하게 처리한다', () => {
  assert.equal(num('1,234.5'), 1234.5);
  assert.equal(num(''), 0);
  assert.equal(num(null, 7), 7);
  assert.equal(num('abc'), 0);
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip(null, 5), '');
});

// =====================================================================
// ④ 정성목표 판단 프롬프트/파서
// =====================================================================
test('buildQualEvalPrompt: 정성목표·정량목표·요약이 프롬프트에 들어간다', () => {
  const p = buildQualEvalPrompt({
    exhibition_name: 'RUJAC 2026', venue: 'Expo Guadalajara', currency: 'MXN',
    meet_date: '2026-09-16', slot_hour: 9, company_name: 'Grupo Zeta', owner_name: 'Oscar',
    target_quote: 850000, target_order: 400000, goal_note: '연간 계약 의향 확인',
    summary_text: 'resumen de la reunión', transcript: 'hola',
  });
  assert.ok(p.includes('연간 계약 의향 확인'));
  assert.ok(p.includes('850,000 MXN'));
  assert.ok(p.includes('RUJAC 2026'));
  assert.ok(p.includes('resumen de la reunión'));
  assert.ok(p.includes('achieved'));
});

test('buildQualEvalPrompt: 정성목표가 없으면 (없음) 으로 표시한다', () => {
  const p = buildQualEvalPrompt({ company_name: 'X', goal_note: '' });
  assert.ok(p.includes('(없음)'));
});

test('parseQualEvalJson: 마크다운으로 감싸도 파싱 · 금액은 숫자만 남긴다', () => {
  const ev = parseQualEvalJson('```json\n{"result":"partial","reason":"합의 없음",'
    + '"evidence":["a","b"],"quote_amount":"$460,000","order_amount":null,"next_step":"재제안"}\n```');
  assert.equal(ev.result, 'partial');
  assert.equal(ev.quote_amount, 460000);
  assert.equal(ev.order_amount, null);
  assert.deepEqual(ev.evidence, ['a', 'b']);
  assert.equal(ev.next_step, '재제안');
});

test('parseQualEvalJson: 모르는 result 는 null 로 두되 이유는 살린다', () => {
  const ev = parseQualEvalJson('{"result":"tal vez","reason":"애매함"}');
  assert.equal(ev.result, null);
  assert.equal(ev.reason, '애매함');
});

test('parseQualEvalJson: 스페인어·한국어 표현도 정규화한다', () => {
  assert.equal(normQual('LOGRADO'), 'achieved');
  assert.equal(normQual('parcial'), 'partial');
  assert.equal(normQual('no logrado'), 'missed');
  assert.equal(normQual('달성'), 'achieved');
  assert.equal(normQual('부분 달성'), 'partial');
  assert.equal(normQual(''), null);
});

test('parseQualEvalJson: JSON 이 아니면 null(요약을 덮어쓰지 않는다)', () => {
  assert.equal(parseQualEvalJson('죄송합니다 판단할 수 없습니다'), null);
  assert.equal(parseQualEvalJson('{"result":null,"reason":"","evidence":[]}'), null);
});

test('summaryToText: 요약·불릿·후속조치·제품을 한 덩어리로 만든다', () => {
  const t = summaryToText({
    resumen: 'R', bullets: [{ category: 'precio', text: 'B1' }], insights: 'I',
    action_items: [{ content: 'A1', due_date: '2026-09-22' }], products: ['CL0001'], next_step: 'N',
  });
  assert.ok(t.includes('R') && t.includes('B1') && t.includes('precio'));
  assert.ok(t.includes('A1') && t.includes('2026-09-22'));
  assert.ok(t.includes('CL0001') && t.includes('N'));
  assert.equal(summaryToText(null), '');
});

// =====================================================================
// ⑤ 전시회 조회 · 보드 조립 (pg-mem)
// =====================================================================
test("getExhibition('active'): is_active 인 전시회를 고른다", async () => {
  const e = await getExhibition('active');
  assert.equal(Number(e.id), 10);
  assert.equal(e.name, 'RUJAC 2026');
});

test("getExhibition('active'): 활성이 없으면 최신 전시회로 폴백한다", async () => {
  pub.none(`UPDATE exhibitions SET is_active = FALSE`);
  const e = await getExhibition('active');
  assert.equal(Number(e.id), 10, '시작일이 가장 늦은 전시회');
});

test('getExhibition: 삭제된 전시회·잘못된 id 는 null', async () => {
  pub.none(`UPDATE exhibitions SET deleted_at = now() WHERE id = 10`);
  assert.equal(await getExhibition(10), null);
  assert.equal(await getExhibition('abc'), null);
  assert.equal(await getExhibition(-1), null);
});

test('ownerOptions: 삭제된 계정과 viewer 는 담당자 후보에서 빠진다', async () => {
  const os = await ownerOptions();
  const names = os.map((o) => o.name);
  assert.ok(names.includes('Oscar') && names.includes('Maria') && names.includes('Sebastian'));
  assert.ok(!names.includes('Viewer'), 'viewer 제외');
  assert.ok(!names.includes('Borrado'), '삭제 계정 제외');
});

test('buildBoard: 축(3일 × 10칸)과 미팅이 칸에 맞게 나온다', async () => {
  const e = await getExhibition(10);
  const b = await buildBoard(DIRECTOR, e);
  assert.equal(b.days.length, 3);
  assert.deepEqual(b.days.map((d) => d.label), ['1st day', '2nd day', '3rd day']);
  assert.equal(b.hours.length, 10);
  assert.equal(b.exhibition.currency, 'MXN');
  assert.equal(b.meetings.length, 5, '소프트 삭제 미팅은 제외');
  const m1 = b.meetings.find((m) => m.id === 1);
  assert.equal(m1.day_no, 1);
  assert.equal(m1.slot_hour, 9);
  assert.equal(m1.owner_name, 'Oscar');
  assert.equal(m1.company_name, 'Grupo Zeta');
});

test('buildBoard: 금액은 전부 숫자로 변환된다(문자열 NUMERIC 방지)', async () => {
  const b = await buildBoard(DIRECTOR, await getExhibition(10));
  for (const m of b.meetings) {
    assert.equal(typeof m.target_quote, 'number');
    assert.equal(typeof m.target_order, 'number');
    if (m.actual_quote !== null) assert.equal(typeof m.actual_quote, 'number');
  }
  assert.equal(b.meetings.find((m) => m.id === 2).actual_quote, 460000);
  assert.equal(b.meetings.find((m) => m.id === 1).actual_quote, null);
});

test('buildBoard: 합계는 취소 건을 빼고 계산된다', async () => {
  const b = await buildBoard(DIRECTOR, await getExhibition(10));
  assert.equal(b.totals.total, 4, '취소 1건 제외');
  assert.equal(b.totals.target_quote, 850000 + 420000 + 0 + 0);
  assert.equal(b.totals.actual_quote, 460000);
  assert.equal(b.totals.walkin, 1);
  assert.equal(b.totals.qual.achieved, 1);
});

test('buildBoard: 담당자 색상은 범례·칩이 같은 값을 쓰도록 서버가 계산한다', async () => {
  const b = await buildBoard(OSCAR, await getExhibition(10));
  const oscar = b.owners.find((o) => o.name === 'Oscar');
  assert.ok(/^#[0-9A-F]{6}$/i.test(oscar.bg));
  assert.ok(/^#[0-9A-F]{6}$/i.test(oscar.fg));
  const colors = b.owners.map((o) => o.bg);
  assert.equal(new Set(colors).size, colors.length, '담당자끼리 색이 겹치지 않는다');
  assert.ok(b.unset_color && b.unset_color.bg, '담당 미지정 색도 내려준다');
});

test('buildBoard: 전시회는 팀 공용 — 영업사원도 남의 미팅을 전부 본다', async () => {
  const forOscar = await buildBoard(OSCAR, await getExhibition(10));
  const forMaria = await buildBoard(MARIA, await getExhibition(10));
  assert.equal(forOscar.meetings.length, 5);
  assert.equal(forMaria.meetings.length, 5);
  assert.ok(forOscar.meetings.some((m) => m.owner_name === 'Maria'));
});

test('buildBoard: 연결된 상담의 녹음 상태·요약이 미팅에 붙는다', async () => {
  pub.none(`
    INSERT INTO sales_consults (id, consult_date, company_name, created_by)
      VALUES (500,'2026-09-16','Grupo Zeta',2);
    UPDATE exhibition_meetings SET consult_id = 500 WHERE id = 1;
    INSERT INTO sales_consult_recordings (id, consult_id, status, duration_sec, summary_json, created_by)
      VALUES (900,500,'done',1122,'{"resumen":"ok"}',2);
  `);
  const b = await buildBoard(OSCAR, await getExhibition(10));
  const m = b.meetings.find((x) => x.id === 1);
  assert.equal(m.consult_id, 500);
  assert.equal(m.rec_status, 'done');
  assert.equal(m.rec_id, 900);
  assert.equal(m.duration_sec, 1122);
  assert.equal(m.has_ai, true);
  assert.equal(m.summary.resumen, 'ok');
  assert.equal(b.totals.recorded, 1);
});

test('buildBoard: 🔒 감춘 상담의 요약은 감춘 디렉터에게만 보인다', async () => {
  pub.none(`
    INSERT INTO sales_consults (id, consult_date, company_name, created_by, private_by)
      VALUES (501,'2026-09-16','Grupo Zeta',2,1);
    UPDATE exhibition_meetings SET consult_id = 501 WHERE id = 1;
    INSERT INTO sales_consult_recordings (id, consult_id, status, summary_json, created_by)
      VALUES (901,501,'done','{"resumen":"secreto"}',2);
  `);
  const forOscar = (await buildBoard(OSCAR, await getExhibition(10))).meetings.find((m) => m.id === 1);
  assert.equal(forOscar.consult_hidden, true);
  assert.equal(forOscar.has_ai, false);
  assert.equal(forOscar.summary, null, '작성자에게도 요약이 안 보인다');

  const forDir = (await buildBoard(DIRECTOR, await getExhibition(10))).meetings.find((m) => m.id === 1);
  assert.equal(forDir.consult_hidden, false);
  assert.equal(forDir.summary.resumen, 'secreto');
});

test('buildBoard: 정성목표 판단 결과(JSON)가 그대로 실려온다', async () => {
  pub.none(`UPDATE exhibition_meetings
              SET qual_result='partial', qual_eval='합의 없음',
                  qual_eval_json='{"result":"partial","evidence":["a"],"quote_amount":460000}'
            WHERE id = 1`);
  const m = (await buildBoard(DIRECTOR, await getExhibition(10))).meetings.find((x) => x.id === 1);
  assert.equal(m.qual_result, 'partial');
  assert.equal(m.qual_eval, '합의 없음');
  assert.deepEqual(m.qual_eval_json.evidence, ['a']);
  assert.equal(m.qual_eval_json.quote_amount, 460000);
});

test('buildBoard: 다른 전시회의 미팅은 섞이지 않는다', async () => {
  pub.none(`INSERT INTO exhibition_meetings (id,exhibition_id,day_no,slot_hour,company_name,created_by)
            VALUES (7,11,1,9,'다른 전시회 미팅',1)`);
  const b = await buildBoard(DIRECTOR, await getExhibition(10));
  assert.ok(!b.meetings.some((m) => m.company_name === '다른 전시회 미팅'));
  const b11 = await buildBoard(DIRECTOR, await getExhibition(11));
  assert.equal(b11.meetings.length, 1);
  assert.equal(b11.days.length, 2);
  assert.equal(b11.hours.length, 8, '09~17시 = 8칸');
  assert.equal(b11.exhibition.currency, 'USD');
});

test('buildBoard: 오늘이 전시 기간이면 now.day_no 가 채워진다', async () => {
  const e = await getExhibition(10);
  const b = await buildBoard(DIRECTOR, { ...e, start_date: mxNowParts(new Date()).date });
  assert.equal(b.now.day_no, 1, '오늘 = 1st day');
  const b2 = await buildBoard(DIRECTOR, e);
  assert.ok(b2.now.day_no === null || typeof b2.now.day_no === 'number');
});

// =====================================================================
// ⑥ 약속 확정(컨펌) · 부스 직접 방문
// =====================================================================
test('normKind: booth 만 부스로 보고 나머지는 전부 약속 미팅', () => {
  assert.equal(normKind('booth'), 'booth');
  assert.equal(normKind('meeting'), 'meeting');
  assert.equal(normKind(''), 'meeting');
  assert.equal(normKind(null), 'meeting');
  assert.equal(normKind('BOOTH'), 'meeting', '정확히 booth 일 때만');
});

test('부스 공통 색은 담당자 팔레트와 겹치지 않는다', () => {
  assert.ok(/^#[0-9A-F]{6}$/i.test(BOOTH_COLOR[0]));
  assert.ok(!OWNER_PALETTE.some((c) => c[0].toLowerCase() === BOOTH_COLOR[0].toLowerCase()));
});

test('meetingTotals: 약속/부스를 나눠 세고 확정은 약속에만 적용된다', () => {
  const t = meetingTotals([
    { status: 'planned', kind: 'meeting', is_confirmed: true },
    { status: 'planned', kind: 'meeting', is_confirmed: false },
    { status: 'done', kind: 'meeting', is_confirmed: true },
    { status: 'planned', kind: 'booth', is_confirmed: false },
    { status: 'cancelled', kind: 'meeting', is_confirmed: true },
  ]);
  assert.equal(t.total, 4);
  assert.equal(t.meeting, 3);
  assert.equal(t.booth, 1);
  assert.equal(t.confirmed, 2, '취소 건은 빠진다');
  assert.equal(t.unconfirmed, 1, '계획 상태의 미확정 약속만');
});

test('meetingTotals: kind 가 없는 옛 데이터는 전부 약속 미팅으로 센다', () => {
  const t = meetingTotals([{ status: 'planned' }, { status: 'done' }]);
  assert.equal(t.meeting, 2);
  assert.equal(t.booth, 0);
});

test('ownerTotals: 담당자별로 부스 방문 건수를 따로 센다', () => {
  const o = ownerTotals([
    { status: 'planned', kind: 'booth', owner_user_id: 2 },
    { status: 'planned', kind: 'meeting', owner_user_id: 2 },
    { status: 'planned', kind: 'meeting', owner_user_id: 3 },
  ]);
  const oscar = o.find((x) => x.owner_user_id === 2);
  assert.equal(oscar.count, 2);
  assert.equal(oscar.booth, 1);
  assert.equal(o.find((x) => x.owner_user_id === 3).booth, 0);
});

test('buildBoard: kind·확정 상태와 부스 공통색을 함께 내려준다', async () => {
  const b = await buildBoard(DIRECTOR, await getExhibition(10));
  const booth = b.meetings.find((m) => m.id === 6);
  assert.equal(booth.kind, 'booth');
  assert.equal(booth.is_confirmed, false);
  assert.equal(booth.owner_name, 'Oscar', '부스 방문도 담당자는 남는다');
  const appt = b.meetings.find((m) => m.id === 2);
  assert.equal(appt.kind, 'meeting');
  assert.equal(appt.is_confirmed, true);
  assert.ok(appt.confirmed_at);
  assert.equal(b.meetings.find((m) => m.id === 1).is_confirmed, false);
  assert.ok(b.booth_color && /^#[0-9A-F]{6}$/i.test(b.booth_color.bg));
  assert.equal(b.totals.booth, 1);
  assert.equal(b.totals.meeting, 3);
  assert.equal(b.totals.confirmed, 1);
});
