// 검수 개편(2026-08-17, 0174) — "스캔은 기록, 판정은 보고서"
//   allocScans() 를 운영 소스에서 import 해 배정 규칙을 검증하고,
//   실 PostgreSQL 위에서 스캔 기록·tally·취소·확정(클램프 없음)·리셋 SQL 의미를 검증한다.
//   실행: DATABASE_URL=postgres://rf:rf@127.0.0.1:5432/refatrix node test/inbound_scans.test.js
import pg from 'pg';
import { allocScans } from '../src/routes/inboundRoutes.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, p) => pool.query(t, p);
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };

async function main() {
  console.log('\n① allocScans — 소입수 우선 → 파일 순서 → 초과는 마지막 라인 누적');
  // 26B2C 실제 패턴: 같은 SKU 가 소입수 다른 두 라인(16개들이 20박스 + 12개들이 3박스)
  const items = [
    { id: 1, input_code: 'CE0796', cartons: 20, qty: 320 },  // ×16
    { id: 2, input_code: 'CE0152', cartons: 2, qty: 32 },    // ×16
    { id: 3, input_code: 'CE0796', cartons: 3, qty: 36 },    // ×12
  ];
  const mk = (code, qty, n) => Array.from({ length: n }, () => ({ code, qty }));
  {
    const r = allocScans(items, [...mk('CE0796', 16, 20), ...mk('CE0796', 12, 3), ...mk('CE0152', 16, 2)]);
    ok(r.alloc[1] === 20 && r.alloc[3] === 3 && r.alloc[2] === 2, '정상 스캔 전량 라인별 정확 배정', r.alloc);
    ok(!Object.keys(r.extras).length && !Object.keys(r.unknown).length && r.known === 25, '초과·미확인 없음', r);
  }
  {
    const r = allocScans(items, mk('CE0796', 12, 2));
    ok(r.alloc[3] === 2 && !r.alloc[1], '소입수 12 라벨은 첫 라인(×16)이 아니라 ×12 라인으로', r.alloc);
  }
  {
    const r = allocScans(items, mk('CE0796', 0, 2));   // 라벨에 수량 없음
    ok(r.alloc[1] === 2, '수량 없는 라벨은 파일 순서 첫 라인부터', r.alloc);
  }
  {
    const r = allocScans(items, mk('CE0796', 16, 25)); // 총 용량 23 초과
    ok(r.alloc[1] === 20 && r.alloc[3] === 5, '용량 차면 다음 라인 → 그래도 차면 마지막 라인에 실측 누적', r.alloc);
    ok(r.extras['CE0796'] === 2, '초과 2건 extras 보고', r.extras);
  }
  {
    const r = allocScans(items, [{ code: 'CE-0796', qty: 16 }, { code: 'ce0796', qty: 16 }]);
    ok(r.alloc[1] === 2, '구분자·대소문자 무시(bare) 매칭', r.alloc);
  }
  {
    const r = allocScans(items, [{ code: 'ZZ999', qty: 5 }]);
    ok(!r.known && r.unknown['ZZ999'] === 1, '라인에 없는 코드는 unknown 집계만', r.unknown);
  }

  console.log('\n② DB — 스캔 기록·tally(code,qty 별)·취소(IS NOT DISTINCT FROM)');
  await q('BEGIN');
  await q('DELETE FROM inbound_scans'); await q('DELETE FROM rack_zones');
  await q('DELETE FROM inbound_pallet_items'); await q('DELETE FROM inbound_pallets');
  await q('DELETE FROM inbound_shipments'); await q('DELETE FROM products');
  const sid = (await q(`INSERT INTO inbound_shipments (invoice_no, status) VALUES ('D26-2','receiving') RETURNING id`)).rows[0].id;
  const pal = (await q(`INSERT INTO inbound_pallets (shipment_id, order_no, pl_no, status, cartons_expected, qty_expected)
                        VALUES ($1,'26B2C',4,'unloaded',23,388) RETURNING id`, [sid])).rows[0].id;
  const it1 = (await q(`INSERT INTO inbound_pallet_items (pallet_id, shipment_id, input_code, cartons, qty)
                        VALUES ($1,$2,'CE0796',20,320) RETURNING id`, [pal, sid])).rows[0].id;
  const it2 = (await q(`INSERT INTO inbound_pallet_items (pallet_id, shipment_id, input_code, cartons, qty)
                        VALUES ($1,$2,'CE0796',3,36) RETURNING id`, [pal, sid])).rows[0].id;
  // 스캔 기록(운영 INSERT 와 동일 형태) — 16개들이 2번, 12개들이 1번, qty 없는 1번
  for (const [code, qty] of [['CE0796', 16], ['CE0796', 16], ['CE0796', 12], ['CE0796', null]]) {
    await q(`INSERT INTO inbound_scans (shipment_id, pallet_id, code, qty, matched, scanned_by)
             VALUES ($1,$2,$3,$4,true,NULL)`, [sid, pal, code, qty]);
  }
  let tally = (await q(`SELECT code, qty, COUNT(*)::int AS n FROM inbound_scans
                         WHERE pallet_id=$1 AND voided_at IS NULL GROUP BY code, qty ORDER BY MIN(id)`, [pal])).rows;
  ok(tally.length === 3, 'tally 는 (code,qty) 별 — 소입수 다른 스캔이 안 섞임', tally);
  ok(tally[0].qty === 16 && tally[0].n === 2 && tally[1].qty === 12 && tally[1].n === 1, '건수 정확', tally);
  // 취소: qty=16 인 최근 1건만
  await q(`UPDATE inbound_scans SET voided_at=now()
            WHERE id = (SELECT id FROM inbound_scans
                         WHERE pallet_id=$1 AND code=$2 AND qty IS NOT DISTINCT FROM $3 AND voided_at IS NULL
                         ORDER BY id DESC LIMIT 1)`, [pal, 'CE0796', 16]);
  // 취소: qty NULL 건 (IS NOT DISTINCT FROM 이 NULL 매칭)
  await q(`UPDATE inbound_scans SET voided_at=now()
            WHERE id = (SELECT id FROM inbound_scans
                         WHERE pallet_id=$1 AND code=$2 AND qty IS NOT DISTINCT FROM $3 AND voided_at IS NULL
                         ORDER BY id DESC LIMIT 1)`, [pal, 'CE0796', null]);
  tally = (await q(`SELECT code, qty, COUNT(*)::int AS n FROM inbound_scans
                     WHERE pallet_id=$1 AND voided_at IS NULL GROUP BY code, qty ORDER BY MIN(id)`, [pal])).rows;
  ok(tally.length === 2 && tally[0].n === 1 && tally[0].qty === 16 && tally[1].qty === 12, '취소는 (code,qty) 최근 1건씩만', tally);
  const voided = (await q(`SELECT COUNT(*)::int AS n FROM inbound_scans WHERE pallet_id=$1 AND voided_at IS NOT NULL`, [pal])).rows[0].n;
  ok(voided === 2, '취소 행도 삭제되지 않고 보존(감사)', voided);

  console.log('\n③ 확정 — scanned_cartons 는 실측 그대로(클램프 없음)');
  // 초과 시나리오: 라인 용량(3)보다 많은 4건을 마지막 라인에 배정했다고 가정
  const scans = (await q(`SELECT code, qty FROM inbound_scans WHERE pallet_id=$1 AND voided_at IS NULL ORDER BY id`, [pal])).rows;
  const a = allocScans([{ id: it1, input_code: 'CE0796', cartons: 20, qty: 320 }, { id: it2, input_code: 'CE0796', cartons: 3, qty: 36 }], scans);
  ok(a.alloc[it1] === 1 && a.alloc[it2] === 1, '남은 유효 스캔(16×1, 12×1) 라인별 배정', a.alloc);
  await q(`UPDATE inbound_pallet_items SET scanned_cartons=$1 WHERE id=$2`, [7, it2]);   // 용량 3 < 실측 7
  const over = (await q(`SELECT scanned_cartons, cartons FROM inbound_pallet_items WHERE id=$1`, [it2])).rows[0];
  ok(over.scanned_cartons === 7 && over.cartons === 3, '초과 실측도 그대로 저장(LEAST 클램프 없음)', over);
  await q(`UPDATE inbound_pallets SET status='checked', checked_at=now() WHERE id=$1`, [pal]);

  console.log('\n④ 리셋 — 스캔 void + 카운터 0 + 상태 되돌림(wait 은 유지)');
  const palW = (await q(`INSERT INTO inbound_pallets (shipment_id, order_no, pl_no, status, cartons_expected, qty_expected)
                         VALUES ($1,'26B2C',9,'wait',5,80) RETURNING id`, [sid])).rows[0].id;
  await q(`UPDATE inbound_pallet_items SET put_cartons=2 WHERE id=$1`, [it1]);
  // 리셋 SQL(운영과 동일 의미)
  for (const p of [pal, palW]) {
    await q(`UPDATE inbound_scans SET voided_at=now() WHERE pallet_id=$1 AND voided_at IS NULL`, [p]);
    await q(`UPDATE inbound_pallet_items SET scanned_cartons=0, put_cartons=0 WHERE pallet_id=$1`, [p]);
    await q(`UPDATE inbound_pallets SET status = CASE WHEN status='wait' THEN 'wait' ELSE 'unloaded' END,
             checked_by=NULL, checked_at=NULL WHERE id=$1`, [p]);
  }
  const after = (await q(`SELECT status, checked_at FROM inbound_pallets WHERE id=$1`, [pal])).rows[0];
  ok(after.status === 'unloaded' && after.checked_at === null, '검수됐던 팔렛 → 하차됨 + 확정 해제', after);
  const afterW = (await q(`SELECT status FROM inbound_pallets WHERE id=$1`, [palW])).rows[0];
  ok(afterW.status === 'wait', '하차 전(wait) 팔렛은 wait 유지', afterW);
  const cnt = (await q(`SELECT COALESCE(SUM(scanned_cartons),0)::int AS sc, COALESCE(SUM(put_cartons),0)::int AS pc
                         FROM inbound_pallet_items WHERE pallet_id=$1`, [pal])).rows[0];
  ok(cnt.sc === 0 && cnt.pc === 0, '검수·적치 카운터 0', cnt);
  const live = (await q(`SELECT COUNT(*)::int AS n FROM inbound_scans WHERE pallet_id=$1 AND voided_at IS NULL`, [pal])).rows[0].n;
  const kept = (await q(`SELECT COUNT(*)::int AS n FROM inbound_scans WHERE pallet_id=$1`, [pal])).rows[0].n;
  ok(live === 0 && kept === 4, '유효 스캔 0 · 원본 4건 보존(감사 추적)', { live, kept });

  console.log('\n⑤ 리셋 후 재스캔·재확정 — 새 사이클이 깨끗하게 시작된다');
  for (const [code, qty] of [['CE0796', 16], ['CE0796', 16]]) {
    await q(`INSERT INTO inbound_scans (shipment_id, pallet_id, code, qty, matched, scanned_by)
             VALUES ($1,$2,$3,$4,true,NULL)`, [sid, pal, code, qty]);
  }
  const scans2 = (await q(`SELECT code, qty FROM inbound_scans WHERE pallet_id=$1 AND voided_at IS NULL ORDER BY id`, [pal])).rows;
  const a2 = allocScans([{ id: it1, input_code: 'CE0796', cartons: 20, qty: 320 }, { id: it2, input_code: 'CE0796', cartons: 3, qty: 36 }], scans2);
  ok(scans2.length === 2 && a2.alloc[it1] === 2 && !a2.alloc[it2], '옛 스캔이 되살아나지 않고 새 스캔만 배정', a2.alloc);

  console.log('\n⑥ 멱등 키(0175) — 재전송이 이중 기록되지 않는다("한 순간에 2회" 버그 수정)');
  const insByKey = (key) => q(
    `INSERT INTO inbound_scans (shipment_id, pallet_id, code, qty, matched, scanned_by, client_key)
     VALUES ($1,$2,'CE0796',16,true,NULL,$3)
     ON CONFLICT (client_key) WHERE client_key IS NOT NULL DO NOTHING`, [sid, pal, key]);
  const liveN = async () => (await q(`SELECT COUNT(*)::int AS n FROM inbound_scans WHERE pallet_id=$1 AND voided_at IS NULL`, [pal])).rows[0].n;
  const base = await liveN();
  await insByKey('k-aaa'); await insByKey('k-aaa'); await insByKey('k-aaa');   // 응답 유실 → 같은 배치 3회 재전송 상황
  ok(await liveN() === base + 1, '같은 client_key 3회 전송 → 1행만 기록', await liveN() - base);
  await insByKey('k-bbb');
  ok(await liveN() === base + 2, '다른 키는 정상 기록');
  await insByKey(null); await insByKey(null);                                   // 구버전 클라이언트(키 없음)는 기존 동작
  ok(await liveN() === base + 4, '키 없는(NULL) 스캔은 유니크 제약을 받지 않음', await liveN() - base);

  // 취소(undo) 멱등 — 같은 void_key 재시도가 두 건을 지우지 않는다
  const undoByKey = (vk) => q(
    `UPDATE inbound_scans SET voided_at=now(), void_key=$4
      WHERE id = (SELECT id FROM inbound_scans
                   WHERE pallet_id=$1 AND code=$2 AND qty IS NOT DISTINCT FROM $3 AND voided_at IS NULL
                   ORDER BY id DESC LIMIT 1)
        AND ($4::text IS NULL OR NOT EXISTS (SELECT 1 FROM inbound_scans WHERE void_key=$4::text))`,
    [pal, 'CE0796', 16, vk]);
  const beforeUndo = await liveN();
  await undoByKey('u-111'); await undoByKey('u-111'); await undoByKey('u-111'); // 취소 응답 유실 → 3회 재전송
  ok(await liveN() === beforeUndo - 1, '같은 void_key 3회 → 1건만 취소', beforeUndo - await liveN());
  await undoByKey('u-222');
  ok(await liveN() === beforeUndo - 2, '다른 키의 취소는 정상 동작');

  console.log('\n⑦ 적치 수정(음수 delta) — GREATEST(0, LEAST(put+d, cap)) 의미');
  await q(`UPDATE inbound_pallet_items SET scanned_cartons=5, put_cartons=3 WHERE id=$1`, [it1]);
  const putUpd = (d, cap) => q(
    `UPDATE inbound_pallet_items
        SET put_cartons = GREATEST(0, LEAST(put_cartons + $1, $2)), rack_saved = COALESCE($3, rack_saved)
      WHERE id=$4`, [d, cap, null, it1]);
  await putUpd(-2, 5);
  let pv = (await q(`SELECT put_cartons FROM inbound_pallet_items WHERE id=$1`, [it1])).rows[0];
  ok(pv.put_cartons === 1, '−2 빼기 → 3에서 1로', pv);
  await putUpd(-5, 5);
  pv = (await q(`SELECT put_cartons FROM inbound_pallet_items WHERE id=$1`, [it1])).rows[0];
  ok(pv.put_cartons === 0, '과도한 빼기도 0 바닥에서 멈춤', pv);
  await putUpd(9, 5);
  pv = (await q(`SELECT put_cartons FROM inbound_pallet_items WHERE id=$1`, [it1])).rows[0];
  ok(pv.put_cartons === 5, '더하기는 목표(cap) 천장 유지', pv);
  await q(`UPDATE inbound_pallet_items SET rack_saved='C-03-05' WHERE id=$1`, [it1]);
  await putUpd(0, 5);   // 위치만 바꿀 때 delta 0 — rack COALESCE(null) 이 기존 값을 지우지 않는다
  pv = (await q(`SELECT put_cartons, rack_saved FROM inbound_pallet_items WHERE id=$1`, [it1])).rows[0];
  ok(pv.put_cartons === 5 && pv.rack_saved === 'C-03-05', 'delta 0 은 수량 불변 + 랙 보존', pv);

  console.log('\n⑧ 마감(입고) 집계 — 실측 스캔 기준 (운영 SQL 추출 실행)');
  // 운영 소스에서 마감 집계 SELECT 를 그대로 추출해 실행한다(복붙 아님 — 드리프트 감지)
  const fs2 = await import('node:fs');
  const SRC = fs2.readFileSync(new URL('../src/routes/inboundRoutes.js', import.meta.url), 'utf8');
  const mClose = SRC.match(/`(SELECT pl\.order_no, pi\.product_id,[\s\S]*?GROUP BY pl\.order_no, pi\.product_id)`/);
  ok(!!mClose, '마감 집계 SQL 추출(실측 CASE 포함)', !!mClose);
  ok(/CASE WHEN pi\.cartons > 0/.test(mClose[1]) && /scanned_cartons/.test(mClose[1]), '집계가 scanned_cartons 실측 기준');
  ok(/pl\.id = ANY\(\$1\)/.test(mClose[1]), '집계는 이번에 반영할 팔렛 목록 기준(received_at 연동)');
  // 픽스처: 검수된 팔렛 — 20ct×320(16/box) 중 18카톤 실측, 3ct×36(12/box) 초과 4카톤, 낱개 qty 10
  const prod = (await q(`INSERT INTO products (code, name) VALUES ('CE0796','TERMINAL') RETURNING id`)).rows[0].id;
  const sid3 = (await q(`INSERT INTO inbound_shipments (invoice_no, status) VALUES ('D26-3','receiving') RETURNING id`)).rows[0].id;
  const pal3 = (await q(`INSERT INTO inbound_pallets (shipment_id, order_no, pl_no, status, cartons_expected, qty_expected)
                         VALUES ($1,'26B2C',7,'checked',23,366) RETURNING id`, [sid3])).rows[0].id;
  const palU = (await q(`INSERT INTO inbound_pallets (shipment_id, order_no, pl_no, status, cartons_expected, qty_expected)
                         VALUES ($1,'26B2C',8,'unloaded',2,32) RETURNING id`, [sid3])).rows[0].id;
  await q(`INSERT INTO inbound_pallet_items (pallet_id, shipment_id, product_id, input_code, cartons, qty, scanned_cartons)
           VALUES ($1,$2,$3,'CE0796',20,320,18), ($1,$2,$3,'CE0796',3,36,4), ($1,$2,$3,'CE0796',0,10,0)`, [pal3, sid3, prod]);
  await q(`INSERT INTO inbound_pallet_items (pallet_id, shipment_id, product_id, input_code, cartons, qty, scanned_cartons)
           VALUES ($1,$2,$3,'CE0796',2,32,0)`, [palU, sid3, prod]);   // 미검수 팔렛 — 집계 제외
  const conf3 = (await q(
    `SELECT id FROM inbound_pallets
      WHERE shipment_id=$1 AND received_at IS NULL
        AND (checked_at IS NOT NULL OR status IN ('checked','done'))`, [sid3])).rows.map((r) => Number(r.id));
  ok(conf3.length === 1 && conf3[0] === Number(pal3), '마감 대상 팔렛 선별(검수만)', conf3);
  const agg = (await q(mClose[1], [conf3])).rows;
  ok(agg.length === 1, '검수된 팔렛만 집계(미검수 제외)', agg);
  // 18×16 + 4×12 + 10(낱개) = 288 + 48 + 10 = 346 (부족·초과·낱개 모두 실측대로)
  ok(Number(agg[0].qty) === 346, '실측 수량 346 (부족 288 + 초과 48 + 낱개 10)', agg[0]);

  console.log('\n⑨ 마감 개편(0176) — 적치중 팔렛 포함·received_at·즉시 재고·승인 이중 방지');
  ok(/checked_at IS NOT NULL OR status IN \('checked','done'\)/.test(SRC), '마감 대상 = checked_at 기준(적치중 포함)');
  ok(/received_at IS NULL/.test(SRC) && /SET received_at = now\(\)/.test(SRC), 'received_at 마킹(재마감 이중 방지)');
  ok(/inbound_prestock/.test(SRC), '선반영 풀 기록');
  const SRC_IMP = fs2.readFileSync(new URL('../src/routes/importRoutes.js', import.meta.url), 'utf8');
  ok(/inbound_prestock/.test(SRC_IMP) && /preOff/.test(SRC_IMP), '수입원가 승인이 선반영분을 차감');
  // DB 의미: 적치중(checking+checked_at) 팔렛 포함, received_at 마킹, 재실행 시 제외, 재고/풀 증가
  const prod9 = (await q(`INSERT INTO products (code, name, stock_qty) VALUES ('CE9990','T',100) RETURNING id`)).rows[0].id;
  const sid9 = (await q(`INSERT INTO inbound_shipments (invoice_no, status) VALUES ('D26-9','receiving') RETURNING id`)).rows[0].id;
  // 팔렛 A: 적치가 진행돼 status='checking' 이지만 checked_at 있음(예전 버그: 마감에서 제외되던 케이스)
  const palA9 = (await q(`INSERT INTO inbound_pallets (shipment_id, order_no, pl_no, status, cartons_expected, qty_expected, checked_at)
                          VALUES ($1,'26B2C',1,'checking',2,32,now()) RETURNING id`, [sid9])).rows[0].id;
  const palB9 = (await q(`INSERT INTO inbound_pallets (shipment_id, order_no, pl_no, status, cartons_expected, qty_expected)
                          VALUES ($1,'26B2C',2,'unloaded',2,32) RETURNING id`, [sid9])).rows[0].id;
  await q(`INSERT INTO inbound_pallet_items (pallet_id, shipment_id, product_id, input_code, cartons, qty, scanned_cartons)
           VALUES ($1,$2,$3,'CE9990',2,32,2)`, [palA9, sid9, prod9]);
  await q(`INSERT INTO inbound_pallet_items (pallet_id, shipment_id, product_id, input_code, cartons, qty, scanned_cartons)
           VALUES ($1,$2,$3,'CE9990',2,32,0)`, [palB9, sid9, prod9]);
  const confirmedSql = `SELECT id FROM inbound_pallets
          WHERE shipment_id=$1 AND received_at IS NULL
            AND (checked_at IS NOT NULL OR status IN ('checked','done'))`;
  let sel9 = (await q(confirmedSql, [sid9])).rows;
  ok(sel9.length === 1 && Number(sel9[0].id) === Number(palA9), '적치중(checking+checked_at) 팔렛이 마감 대상에 포함, 미검수는 제외', sel9);
  // 마감 처리 재현: 실측 32EA → 재고 +32, 풀 +32, received_at 마킹
  await q(`UPDATE products SET stock_qty = stock_qty + 32 WHERE id=$1`, [prod9]);
  await q(`INSERT INTO inbound_prestock (product_id, qty) VALUES ($1,32)
           ON CONFLICT (product_id) DO UPDATE SET qty = inbound_prestock.qty + 32`, [prod9]);
  await q(`UPDATE inbound_pallets SET received_at=now() WHERE id=$1`, [palA9]);
  sel9 = (await q(confirmedSql, [sid9])).rows;
  ok(sel9.length === 0, '재마감 시 이미 반영된 팔렛은 제외(이중 반영 없음)');
  let st9 = (await q(`SELECT stock_qty FROM products WHERE id=$1`, [prod9])).rows[0];
  ok(Number(st9.stock_qty) === 132, '마감 즉시 실재고 +32 (100→132)', st9);
  // 수입원가 승인 재현: 배치 라인 32EA → 선반영 32 차감 → 재고 그대로, 풀 0
  const pre9 = (await q(`SELECT qty FROM inbound_prestock WHERE product_id=$1 FOR UPDATE`, [prod9])).rows[0];
  const off9 = Math.min(Number(pre9.qty), 32);
  await q(`UPDATE inbound_prestock SET qty = qty - $1 WHERE product_id=$2`, [off9, prod9]);
  const newStock9 = 132 + 32 - off9;   // computeImportCosting 의 (기존+배치수량) − 선반영
  await q(`UPDATE products SET stock_qty=$1 WHERE id=$2`, [newStock9, prod9]);
  st9 = (await q(`SELECT stock_qty FROM products WHERE id=$1`, [prod9])).rows[0];
  ok(Number(st9.stock_qty) === 132 && off9 === 32, '승인 시 선반영분 차감 — 재고 이중 증가 없음(132 유지)', { stock: st9.stock_qty, off: off9 });
  const pool9 = (await q(`SELECT qty FROM inbound_prestock WHERE product_id=$1`, [prod9])).rows[0];
  ok(Number(pool9.qty) === 0, '선반영 풀 소진', pool9);

  await q('ROLLBACK');
  console.log('\n' + (fail ? '❌' : '✅') + ` 결과: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error('테스트 오류:', e); await pool.end(); process.exit(2); });
