// =====================================================================
// 고객 병합(디렉터) — 순수 로직 + 실제 Postgres 실증 (2026-09-03)
//   순수 로직은 항상 돈다. SQL 실증은 TEST_PG_URL 이 설정된 경우에만(미설정 시 skip).
//   예) TEST_PG_URL="postgres://postgres@/refx?host=/tmp/pgsock&port=5433" \
//       node --test test/customer_merge.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MERGE_MOVES, MOVED_TABLES, safeIdent, residualLabel,
  checkMerge, moveTotal, mergeNote,
} from '../src/customerMerge.js';

const C = (o = {}) => ({
  id: 1, code: 'C-0034', name: 'FRENOS NORTE', rfc: 'FNO900101AB1', rfc_norm: 'FNO900101AB1',
  deleted_at: null, approval_status: 'approved', team_id: 2, owner_id: 5,
  owner_name: 'Oscar', team_name: '01_Monterrey', rfc_claim_exempt: false, ...o,
});

// ---------------------------------------------------------------- 대상 정의
test('이관 대상은 상담·방문 3종뿐 — 견적·매출은 들어 있지 않다', () => {
  assert.deepEqual(MERGE_MOVES.map((m) => m.table),
    ['sales_visits', 'customer_meetings', 'sales_consults']);
  for (const t of ['quotes', 'sales', 'invoices', 'ar_plans']) {
    assert.equal(MOVED_TABLES.has(t), false, `${t} 는 옮기지 않는다`);
  }
});

test('자식(녹음·후속조치)은 「남는 것」 집계에서 빠진다 — 부모를 따라 자동으로 옮겨지므로', () => {
  for (const t of ['sales_visit_pendings', 'sales_visit_recordings',
                   'sales_consult_pendings', 'sales_consult_recordings']) {
    assert.equal(MOVED_TABLES.has(t), true, `${t} 는 자동 이관 대상`);
  }
});

test('safeIdent — 카탈로그에서 온 이름만 통과시킨다', () => {
  assert.equal(safeIdent('sales_visits'), true);
  assert.equal(safeIdent('quote_items2'), true);
  assert.equal(safeIdent('Sales'), false);          // 대문자 = 인용부호 필요 → 거른다
  assert.equal(safeIdent('a; drop table x'), false);
  assert.equal(safeIdent('"x"'), false);
  assert.equal(safeIdent(''), false);
  assert.equal(safeIdent(null), false);
});

test('residualLabel — 아는 테이블은 한국어, 모르는 테이블은 이름 그대로(누락 방지)', () => {
  assert.equal(residualLabel('quotes'), '견적');
  assert.equal(residualLabel('customer_documents'), '증빙서류');
  assert.equal(residualLabel('some_new_module'), 'some_new_module');
});

// ---------------------------------------------------------------- 차단 규칙
test('같은 고객끼리는 병합할 수 없다', () => {
  const { blockers } = checkMerge(C({ id: 7 }), C({ id: 7 }));
  assert.equal(blockers.some((b) => b.code === 'same_customer'), true);
});

test('삭제된 고객은 양쪽 다 막는다', () => {
  assert.equal(checkMerge(C({ deleted_at: new Date() }), C({ id: 2 })).blockers
    .some((b) => b.code === 'from_deleted'), true);
  assert.equal(checkMerge(C(), C({ id: 2, deleted_at: new Date() })).blockers
    .some((b) => b.code === 'into_deleted'), true);
});

test('반려된 고객으로는 합칠 수 없다 (반대로 반려 고객을 옮기는 것은 허용)', () => {
  assert.equal(checkMerge(C(), C({ id: 2, approval_status: 'rejected' })).blockers
    .some((b) => b.code === 'into_rejected'), true);
  assert.equal(checkMerge(C({ approval_status: 'rejected' }), C({ id: 2 })).blockers.length, 0);
});

test('고객을 못 찾으면 그 자리에서 끊는다 — 뒤 규칙을 돌리지 않는다', () => {
  const r = checkMerge(null, C());
  assert.equal(r.blockers.length, 1);
  assert.equal(r.blockers[0].code, 'from_not_found');
});

// ---------------------------------------------------------------- 경고 규칙
test('RFC 가 같으면 경고가 없다 — 이게 원래 노리는 경우다', () => {
  const { blockers, warnings } = checkMerge(C({ id: 1 }), C({ id: 2 }));
  assert.equal(blockers.length, 0);
  assert.equal(warnings.length, 0);
});

test('RFC 가 다르면 경고하되 막지는 않는다', () => {
  const { blockers, warnings } = checkMerge(C(), C({ id: 2, rfc: 'XXX900101AB1', rfc_norm: 'XXX900101AB1' }));
  assert.equal(blockers.length, 0);
  assert.equal(warnings.some((w) => w.code === 'rfc_differs'), true);
});

test('남길 고객에 RFC 가 없으면 선점을 잃는다고 경고한다', () => {
  const { warnings } = checkMerge(C(), C({ id: 2, rfc: null, rfc_norm: null }));
  const w = warnings.find((x) => x.code === 'into_rfc_missing');
  assert.ok(w);
  assert.match(w.note, /FNO900101AB1/);
});

test('팀·담당자가 다르면 각각 경고한다', () => {
  const { warnings } = checkMerge(C(), C({ id: 2, team_id: 3, team_name: '02_Merida', owner_id: 9, owner_name: 'Ana' }));
  assert.equal(warnings.some((w) => w.code === 'team_differs'), true);
  assert.equal(warnings.some((w) => w.code === 'owner_differs'), true);
});

test('남길 고객이 승인 대기면 경고한다', () => {
  const { warnings } = checkMerge(C(), C({ id: 2, approval_status: 'pending' }));
  assert.equal(warnings.some((w) => w.code === 'into_pending'), true);
});

// ---------------------------------------------------------------- 합계·문구
test('moveTotal 은 부모 건수만 더한다', () => {
  assert.equal(moveTotal([{ cnt: 3 }, { cnt: 0 }, { cnt: 2 }]), 5);
  assert.equal(moveTotal([]), 0);
  assert.equal(moveTotal(null), 0);
});

test('mergeNote — 0건 항목은 문구에서 빠지고, 종료 여부·잔여가 붙는다', () => {
  const n = mergeNote({ visits: 4, meetings: 0, consults: 2 },
    { fromName: 'A(C-0034)', intoName: 'B(C-0052)', closed: true, residualTotal: 7 });
  assert.match(n, /현장 방문 4건/);
  assert.match(n, /고객상담 2건/);
  assert.equal(/수기 미팅/.test(n), false, '0건은 언급하지 않는다');
  assert.match(n, /종료 처리/);
  assert.match(n, /7건은 옮기지 않았습니다/);
});

test('mergeNote — 옮길 게 없어도 문장이 깨지지 않는다', () => {
  const n = mergeNote({ visits: 0, meetings: 0, consults: 0 },
    { fromName: 'A', intoName: 'B', closed: false, residualTotal: 0 });
  assert.match(n, /옮길 기록이 없었습니다/);
  assert.match(n, /그대로 두었습니다/);
});

// =====================================================================
// 실제 Postgres 실증 — 라우트가 쓰는 SQL 을 그대로 돌린다.
// =====================================================================
const URL_ = process.env.TEST_PG_URL || '';

// 라우트의 잔여 FK 조회 SQL (문자 그대로 옮겨 온 것)
const SQL_RESIDUAL_REFS = `
  SELECT cl.relname AS tbl, a.attname AS col
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    JOIN unnest(c.conkey) WITH ORDINALITY k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
   WHERE c.contype = 'f'
     AND c.confrelid = 'customers'::regclass
     AND array_length(c.conkey, 1) = 1
     AND ns.nspname = 'public'
     AND cl.relname <> 'customers'
   ORDER BY cl.relname`;

// 라우트의 예외 복구 SQL (0194 재검사와 같은 규칙)
const SQL_EXEMPT_RELEASE = `
  UPDATE customers c SET rfc_claim_exempt = false
   WHERE c.id = $1 AND c.rfc_claim_exempt = true AND c.rfc_norm IS NOT NULL
     AND c.deleted_at IS NULL
     AND COALESCE(c.approval_status,'approved') <> 'rejected'
     AND NOT EXISTS (
       SELECT 1 FROM customers o
        WHERE o.id <> c.id AND o.rfc_norm = c.rfc_norm AND o.deleted_at IS NULL
          AND COALESCE(o.approval_status,'approved') <> 'rejected')`;

async function seed(cl) {
  await cl.query(`DELETE FROM sales_consult_pendings; DELETE FROM sales_consult_recordings;
                  DELETE FROM sales_consults; DELETE FROM sales_visit_pendings;
                  DELETE FROM sales_visit_recordings; DELETE FROM sales_visits;
                  DELETE FROM customer_meetings; DELETE FROM customer_stage_history;
                  DELETE FROM customer_registration_events; DELETE FROM customers;`);
  const u = (await cl.query(
    `INSERT INTO users (name, role, pin_hash) VALUES ('Oscar','sales','x') RETURNING id`)).rows[0].id;
  const t = (await cl.query(
    `INSERT INTO sales_teams (name) VALUES ('01_Monterrey')
     ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id`)).rows[0].id;
  // 같은 RFC 로 나뉜 두 고객 — 0188 규칙대로 나중 것이 선점 예외로 빠져 있다.
  const from = (await cl.query(
    `INSERT INTO customers (code,name,rfc,team_id,owner_id,rfc_claim_exempt,approval_status)
     VALUES ('C-0034','FRENOS NORTE','FNO900101AB1',$1,$2,false,'approved') RETURNING id`, [t, u])).rows[0].id;
  const into = (await cl.query(
    `INSERT INTO customers (code,name,rfc,team_id,owner_id,rfc_claim_exempt,approval_status)
     VALUES ('C-0052','FRENOS NORTE SUCURSAL','FNO900101AB1',$1,$2,true,'approved') RETURNING id`, [t, u])).rows[0].id;

  // 방문 2건(1건은 소프트삭제) + 후속조치 + 녹음
  const v1 = (await cl.query(
    `INSERT INTO sales_visits (visit_date,customer_id,place_name,geo_lat,geo_lng,created_by)
     VALUES ('2026-08-18',$1,'FRENOS NORTE',25.6,-100.3,$2) RETURNING id`, [from, u])).rows[0].id;
  await cl.query(
    `INSERT INTO sales_visits (visit_date,customer_id,place_name,geo_lat,geo_lng,created_by,deleted_at)
     VALUES ('2026-08-10',$1,'FRENOS NORTE',25.6,-100.3,$2, now())`, [from, u]);
  await cl.query(`INSERT INTO sales_visit_pendings (visit_id,content) VALUES ($1,'Enviar cotizacion')`, [v1]);
  await cl.query(`INSERT INTO sales_visit_recordings (visit_id,status,created_by) VALUES ($1,'done',$2)`, [v1, u]);

  // 수기 미팅 1건 + 체크인이 자동 생성한 [현장방문] 미팅 1건
  await cl.query(`INSERT INTO customer_meetings (customer_id,meeting_date,note,created_by)
                  VALUES ($1,'2026-08-15','Llamada: pago pendiente',$2)`, [from, u]);
  await cl.query(`INSERT INTO customer_meetings (customer_id,meeting_date,note,created_by)
                  VALUES ($1,'2026-08-18','[현장방문] FRENOS NORTE',$2)`, [from, u]);

  // 고객상담 1건 + 후속조치 + 녹음
  const s1 = (await cl.query(
    `INSERT INTO sales_consults (consult_date,company_name,customer_id,created_by)
     VALUES ('2026-08-20','FRENOS NORTE',$1,$2) RETURNING id`, [from, u])).rows[0].id;
  await cl.query(`INSERT INTO sales_consult_pendings (consult_id,content) VALUES ($1,'Mandar muestra')`, [s1]);
  await cl.query(`INSERT INTO sales_consult_recordings (consult_id,status,created_by) VALUES ($1,'done',$2)`, [s1, u]);

  // 옮기지 않는(=남는) 데이터 1건
  await cl.query(`INSERT INTO customer_stage_history (customer_id,entered_at) VALUES ($1,'2026-08-01')`, [from]);

  // 다른 고객의 기록 — 절대 건드리면 안 된다
  const other = (await cl.query(
    `INSERT INTO customers (code,name,rfc,team_id,owner_id) VALUES ('C-0099','OTRO','OTR900101AB1',$1,$2) RETURNING id`,
    [t, u])).rows[0].id;
  await cl.query(`INSERT INTO customer_meetings (customer_id,meeting_date,note,created_by)
                  VALUES ($1,'2026-08-16','ajeno',$2)`, [other, u]);
  return { u, from, into, other };
}

test('실 Postgres — 병합 트랜잭션이 상담·방문만 옮기고 선점을 복구한다', { skip: !URL_ }, async () => {
  const { default: pg } = await import('pg');
  const cl = new pg.Client({ connectionString: URL_ });
  await cl.connect();
  try {
    const { from, into, other } = await seed(cl);

    // ① 잔여 FK 조회 — 카탈로그에서 실제로 읽히는지(코드에 테이블을 박지 않았다는 증명)
    const refs = (await cl.query(SQL_RESIDUAL_REFS)).rows;
    assert.ok(refs.length > 10, '운영 스키마에는 customers 참조 FK 가 여러 개 있다');
    const refTables = new Set(refs.map((r) => r.tbl));
    for (const t of ['sales_visits', 'customer_meetings', 'sales_consults', 'customer_stage_history']) {
      assert.equal(refTables.has(t), true, `${t} 가 카탈로그에서 잡혀야 한다`);
    }
    // 이번에 옮기는 것을 빼면 남는 것만 남는다
    const residualTables = refs.map((r) => r.tbl).filter((t) => !MOVED_TABLES.has(t));
    assert.equal(residualTables.includes('sales_visits'), false);
    assert.equal(residualTables.includes('customer_stage_history'), true);

    // ② 병합 — 라우트와 같은 순서로
    await cl.query('BEGIN');
    await cl.query(`SELECT id FROM customers WHERE id = ANY($1) ORDER BY id FOR UPDATE`,
      [[from, into].sort((a, b) => a - b)]);
    const counts = {}; const countsAll = {};
    for (const m of MERGE_MOVES) {
      const soft = m.table === 'sales_visits' || m.table === 'sales_consults';
      const r = await cl.query(
        `UPDATE ${m.table} SET ${m.col} = $2 WHERE ${m.col} = $1
         RETURNING ${soft ? 'deleted_at' : 'NULL::timestamptz AS deleted_at'}`, [from, into]);
      countsAll[m.key] = r.rowCount;
      counts[m.key] = r.rows.filter((x) => x.deleted_at == null).length;
    }
    await cl.query(`UPDATE customers SET deleted_at = now() WHERE id = $1`, [from]);
    const rel = await cl.query(SQL_EXEMPT_RELEASE, [into]);
    await cl.query('COMMIT');

    // ③ 건수 — 살아있는 것과 전체를 따로 센다
    assert.deepEqual(counts, { visits: 1, meetings: 2, consults: 1 });
    assert.deepEqual(countsAll, { visits: 2, meetings: 2, consults: 1 });

    // ④ 실제로 옮겨졌는지 + 자식이 따라왔는지
    const q1 = (await cl.query(`SELECT count(*)::int n FROM sales_visits WHERE customer_id=$1`, [into])).rows[0].n;
    assert.equal(q1, 2, '소프트삭제된 방문도 함께 옮긴다(미아 방지)');
    const kid = (await cl.query(
      `SELECT count(*)::int n FROM sales_visit_pendings p
        JOIN sales_visits v ON v.id=p.visit_id WHERE v.customer_id=$1`, [into])).rows[0].n;
    assert.equal(kid, 1, '후속조치는 visit_id 로 따라온다 — 별도 UPDATE 없이');
    const recs = (await cl.query(
      `SELECT count(*)::int n FROM sales_consult_recordings r
        JOIN sales_consults s ON s.id=r.consult_id WHERE s.customer_id=$1`, [into])).rows[0].n;
    assert.equal(recs, 1);

    // ⑤ 원본에는 아무것도 남지 않았다 — 남는 것(단계 이력)만 빼고
    for (const t of ['sales_visits', 'customer_meetings', 'sales_consults']) {
      const n = (await cl.query(`SELECT count(*)::int n FROM ${t} WHERE customer_id=$1`, [from])).rows[0].n;
      assert.equal(n, 0, `${t} 는 원본에 남지 않는다`);
    }
    assert.equal((await cl.query(
      `SELECT count(*)::int n FROM customer_stage_history WHERE customer_id=$1`, [from])).rows[0].n, 1,
      '옮기지 않기로 한 것은 그대로 남는다');

    // ⑥ 남의 고객 기록은 건드리지 않았다
    assert.equal((await cl.query(
      `SELECT count(*)::int n FROM customer_meetings WHERE customer_id=$1`, [other])).rows[0].n, 1);

    // ⑦ 원본이 빠지면서 남길 고객의 선점 예외가 자동 복구된다
    assert.equal(rel.rowCount, 1, '중복이 해소됐으므로 예외 해제');
    assert.equal((await cl.query(
      `SELECT rfc_claim_exempt FROM customers WHERE id=$1`, [into])).rows[0].rfc_claim_exempt, false);

    // ⑧ 그리고 그 RFC 는 이제 유니크로 잠긴다(0188 uq_customers_rfc_claim)
    await assert.rejects(
      cl.query(`INSERT INTO customers (code,name,rfc,rfc_claim_exempt) VALUES ('C-0100','TERCERO','FNO900101AB1',false)`),
      /uq_customers_rfc_claim/);
  } finally { await cl.end(); }
});

test('실 Postgres — 진짜 중복이 남아 있으면 예외 복구는 일어나지 않는다', { skip: !URL_ }, async () => {
  const { default: pg } = await import('pg');
  const cl = new pg.Client({ connectionString: URL_ });
  await cl.connect();
  try {
    const { u, from, into } = await seed(cl);
    // 같은 RFC 를 쓰는 살아있는 고객을 하나 더 둔다 — 원본을 닫아도 중복이 안 풀린다.
    await cl.query(
      `INSERT INTO customers (code,name,rfc,owner_id,rfc_claim_exempt)
       VALUES ('C-0077','FRENOS NORTE 3','FNO900101AB1',$1,true)`, [u]);
    await cl.query(`UPDATE customers SET deleted_at = now() WHERE id = $1`, [from]);
    const rel = await cl.query(SQL_EXEMPT_RELEASE, [into]);
    assert.equal(rel.rowCount, 0, '아직 중복이므로 그대로 둔다 — 풀면 유니크가 깨진다');
  } finally { await cl.end(); }
});
