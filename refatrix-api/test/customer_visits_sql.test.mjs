// =====================================================================
// GET /api/customers/:id/visits 의 실제 SQL 을 Postgres 로 실증 (2026-08-19)
//   TEST_PG_URL 이 설정된 경우에만 실행(미설정 시 skip — CI/기본 npm test 무영향).
//   예) TEST_PG_URL="postgres://postgres@/postgres?host=/tmp/pgsock&port=5433" node --test test/customer_visits_sql.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleVisitHistory } from '../src/customerVisits.js';

const URL_ = process.env.TEST_PG_URL || '';
const VISIT_TZ = 'America/Mexico_City';

const SQL_VISITS = `SELECT v.id,
              to_char(v.visit_date,'YYYY-MM-DD') AS visit_date,
              to_char(v.visited_at AT TIME ZONE $2,'HH24:MI') AS visit_time,
              v.met_person, v.talk_note, v.insight_note, u.name AS by_name
         FROM sales_visits v
         LEFT JOIN users u ON u.id = v.created_by
        WHERE v.customer_id = $1 AND v.deleted_at IS NULL
        ORDER BY v.visit_date DESC, v.visited_at DESC, v.id DESC
        LIMIT $3`;
// 비(非)디렉터 = 본인이 기록한 것만(라우트가 조건절을 덧붙인 형태)
const SQL_VISITS_OWN = SQL_VISITS.replace('v.deleted_at IS NULL', 'v.deleted_at IS NULL AND v.created_by = $4');
const SQL_MEET_OWN = () => SQL_MEET.replace("NOT LIKE '[현장방문]%'", "NOT LIKE '[현장방문]%' AND m.created_by = $3");
const SQL_PEND = `SELECT id, visit_id, content, due_date, done FROM sales_visit_pendings
          WHERE visit_id = ANY($1) ORDER BY done ASC, (due_date IS NULL) ASC, due_date ASC, id ASC`;
const SQL_RECS = `SELECT id, visit_id, status, summary_json FROM sales_visit_recordings
            WHERE visit_id = ANY($1) ORDER BY id ASC`;
const SQL_MEET = `SELECT m.id, to_char(m.meeting_date,'YYYY-MM-DD') AS meeting_date, m.note,
              u.name AS by_name, sb.name AS stage_before_name, sa.name AS stage_after_name
         FROM customer_meetings m
         LEFT JOIN users  u  ON u.id  = m.created_by
         LEFT JOIN stages sb ON sb.id = m.stage_before
         LEFT JOIN stages sa ON sa.id = m.stage_after
        WHERE m.customer_id = $1 AND COALESCE(m.note,'') NOT LIKE '[현장방문]%'
        ORDER BY m.meeting_date DESC, m.id DESC
        LIMIT $2`;

const SCHEMA = `
DROP TABLE IF EXISTS sales_visit_recordings, sales_visit_pendings, sales_visits, customer_meetings, stages, customers, users CASCADE;
CREATE TABLE users (id BIGSERIAL PRIMARY KEY, name TEXT);
CREATE TABLE customers (id BIGSERIAL PRIMARY KEY, name TEXT, team_id BIGINT, deleted_at TIMESTAMPTZ);
CREATE TABLE stages (id BIGSERIAL PRIMARY KEY, name TEXT);
CREATE TABLE sales_visits (
  id BIGSERIAL PRIMARY KEY, visit_date DATE NOT NULL, visited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  customer_id BIGINT REFERENCES customers(id), place_name TEXT, met_person TEXT,
  talk_note TEXT, insight_note TEXT, created_by BIGINT REFERENCES users(id), deleted_at TIMESTAMPTZ);
CREATE TABLE sales_visit_pendings (
  id BIGSERIAL PRIMARY KEY, visit_id BIGINT REFERENCES sales_visits(id) ON DELETE CASCADE,
  content TEXT NOT NULL, due_date DATE, done BOOLEAN NOT NULL DEFAULT FALSE);
CREATE TABLE sales_visit_recordings (
  id BIGSERIAL PRIMARY KEY, visit_id BIGINT REFERENCES sales_visits(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued', summary_json JSONB);
CREATE TABLE customer_meetings (
  id BIGSERIAL PRIMARY KEY, customer_id BIGINT REFERENCES customers(id), meeting_date DATE NOT NULL,
  note TEXT, stage_before BIGINT REFERENCES stages(id), stage_after BIGINT REFERENCES stages(id),
  created_by BIGINT REFERENCES users(id));

INSERT INTO users (id,name) VALUES (1,'Oscar'),(2,'Ana');
INSERT INTO customers (id,name,team_id) VALUES (3,'Refaccionaria Aguila',2),(4,'Otro',2);
INSERT INTO stages (id,name) VALUES (1,'3_견적'),(2,'4_협상');
-- v10: 2026-08-18 MX 11:20 (= 17:20Z, MX 는 UTC-6)
INSERT INTO sales_visits (id,visit_date,visited_at,customer_id,met_person,talk_note,insight_note,created_by)
VALUES (10,'2026-08-18','2026-08-18T17:20:00Z',3,'Luis',E'plan: hablar de precios\\n[AI요약]\\nResumen ES','Maneja SYD',1),
       (11,'2026-08-12','2026-08-12T15:05:00Z',3,NULL,'primera visita, nos presentamos','',1),
       (12,'2026-08-17','2026-08-17T16:00:00Z',4,NULL,'otro cliente','',1),
       (13,'2026-08-16','2026-08-16T16:00:00Z',3,NULL,'borrado','',1);
UPDATE sales_visits SET deleted_at=now() WHERE id=13;
INSERT INTO sales_visit_pendings (id,visit_id,content,due_date,done) VALUES
  (1,10,'Enviar cotizacion','2026-08-10',false),(2,10,'Llamar',NULL,true);
INSERT INTO sales_visit_recordings (id,visit_id,status,summary_json) VALUES
  (77,10,'done','{"resumen":"Resumen ES","insights":"Compra a la competencia","next_step":"Visitar en 2 semanas","action_items":[{"content":"Enviar cotizacion","due_date":"2026-08-10"}],"products":["CL0001"]}');
INSERT INTO customer_meetings (id,customer_id,meeting_date,note,stage_before,stage_after,created_by) VALUES
  (5,3,'2026-08-15','Llamada: pago pendiente de la factura 992',1,2,2),
  (6,3,'2026-08-18',E'[현장방문]\\n대화: auto', NULL,NULL,1);
`;

test('실 Postgres: 고객별 상담·방문 이력 SQL + 조립', { skip: URL_ ? false : 'TEST_PG_URL 미설정' }, async () => {
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: URL_ });
  await c.connect();
  try {
    await c.query(SCHEMA);
    const visits = (await c.query(SQL_VISITS, [3, VISIT_TZ, 300])).rows;
    // 다른 고객(12)·소프트삭제(13) 제외, 최신순
    assert.deepEqual(visits.map((v) => Number(v.id)), [10, 11]);
    assert.equal(visits[0].visit_date, '2026-08-18');
    assert.equal(visits[0].visit_time, '11:20', 'MX 현지시각(UTC-6)으로 변환');
    assert.equal(visits[0].by_name, 'Oscar');

    const vids = visits.map((v) => Number(v.id));
    const pendings = (await c.query(SQL_PEND, [vids])).rows;
    assert.deepEqual(pendings.map((p) => Number(p.id)), [1, 2], '미완 → 완료 순');
    const recordings = (await c.query(SQL_RECS, [vids])).rows;
    assert.equal(recordings.length, 1);
    assert.equal(typeof recordings[0].summary_json, 'object', 'JSONB 는 객체로 반환');

    const meetings = (await c.query(SQL_MEET, [3, 300])).rows;
    assert.deepEqual(meetings.map((m) => Number(m.id)), [5], '[현장방문] 자동미팅은 제외');
    assert.equal(meetings[0].stage_after_name, '4_협상');

    // 비디렉터(본인 기록만) — Ana(id 2) 는 자기가 쓴 미팅 1건만, 방문은 0건
    const ownVisits = (await c.query(SQL_VISITS_OWN, [3, VISIT_TZ, 300, 2])).rows;
    const ownMeets = (await c.query(SQL_MEET_OWN(), [3, 300, 2])).rows;
    assert.deepEqual(ownVisits.map((v) => Number(v.id)), [], 'Oscar 의 방문은 Ana 에게 보이지 않는다');
    assert.deepEqual(ownMeets.map((m) => Number(m.id)), [5], 'Ana 가 쓴 미팅만');
    const ownOscar = (await c.query(SQL_VISITS_OWN, [3, VISIT_TZ, 300, 1])).rows;
    assert.deepEqual(ownOscar.map((v) => Number(v.id)), [10, 11], 'Oscar 는 본인 방문 전부');

    const out = assembleVisitHistory({ visits, meetings, pendings, recordings, mxToday: '2026-08-19' });
    assert.deepEqual(out.items.map((i) => i.key), ['v10', 'm5', 'v11']);
    const v10 = out.items[0];
    assert.equal(v10.time, '11:20');
    assert.equal(v10.rec_id, 77);
    assert.equal(v10.fup, 'overdue');
    assert.ok(v10.tags.includes('quote') && v10.tags.includes('competitor'));
    assert.equal(out.open_pendings, 1);
  } finally { await c.end(); }
});
