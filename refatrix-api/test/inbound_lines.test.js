// 패킹리스트 라인별 저장(합산 제거, 2026-08-17) — aggregate() 를 운영 소스에서 추출해 실행 +
// 실 PostgreSQL 위에서 GET items 쿼리(0173 box_from/box_to 포함)를 검증한다.
//   실행: DATABASE_URL=postgres://rf:rf@127.0.0.1:5432/refatrix node test/inbound_lines.test.js
import pg from 'pg';
import fs from 'node:fs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, p) => pool.query(t, p);
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };

/* ---------- 운영 소스에서 aggregate() 추출(복붙 아님) ---------- */
const SRC = fs.readFileSync(new URL('../src/routes/inboundRoutes.js', import.meta.url), 'utf8');
function fnSrc(name) {
  const i = SRC.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(name + ' not found');
  let d = 0, j = SRC.indexOf('{', i);
  for (let k = j; k < SRC.length; k++) {
    if (SRC[k] === '{') d++;
    else if (SRC[k] === '}') { d--; if (!d) return SRC.slice(i, k + 1); }
  }
  throw new Error('unbalanced');
}
const helpers = SRC.match(/const num = [^\n]+\nconst int = [^\n]+/)[0];
const aggregate = new Function(helpers + '\n' + fnSrc('aggregate') + '\nreturn aggregate;')();

async function main() {
  console.log('\n① aggregate — 같은 SKU 라인을 합산하지 않는다');
  const rows = [
    { order_no: '100RA25K2C', pl_no: 12, code: 'CE0796', cartons: 20, qty: 320, desc: 'TERMINAL', box_from: 1, box_to: 20 },   // ×16
    { order_no: '100RA25K2C', pl_no: 12, code: 'CE0152', cartons: 2, qty: 32, desc: 'T', box_from: 21, box_to: 22 },
    { order_no: '100RA25K2C', pl_no: 12, code: 'CE0796', cartons: 3, qty: 36, desc: 'TERMINAL', box_from: 23, box_to: 25 },    // ×12 — 병합 금지!
    { order_no: '100RA25K2C', pl_no: 12, code: 'CE0796', cartons: 0, qty: 10, desc: '낱개', box_from: null, box_to: null },     // 카톤 0 행도 별도 라인
    { order_no: '', pl_no: 0, code: 'XX', cartons: 1, qty: 5 },                                                                  // ORDER 없음 → 제외(기존 규칙)
    { order_no: '100RA25K2C', pl_no: 12, code: 'CE0154', cartons: 1, qty: 0 },                                                   // qty 0 → 제외(기존 규칙)
  ];
  const pallets = aggregate(rows);
  ok(pallets.length === 1, '팔렛 1개');
  const items = pallets[0].items;
  ok(items.length === 4, '라인 4개 보존(CE0796 3라인 + CE0152)', items.map((i) => i.code + ':' + i.cartons));
  const ce = items.filter((i) => i.code === 'CE0796');
  ok(ce.length === 3, 'CE0796 은 3라인 그대로(합산 없음)', ce.map((i) => i.cartons + 'x' + i.qty));
  ok(ce[0].cartons === 20 && ce[0].qty === 320 && ce[1].cartons === 3 && ce[1].qty === 36, '라인별 카톤·수량 유지');
  ok(Math.round(ce[0].qty / ce[0].cartons) === 16 && Math.round(ce[1].qty / ce[1].cartons) === 12, '라인별 소입수(16·12) 구분 가능');
  ok(ce[0].box_from === 1 && ce[0].box_to === 20 && ce[1].box_from === 23 && ce[1].box_to === 25, '카톤 번호 범위 보존');
  ok(items[0].code === 'CE0796' && items[1].code === 'CE0152' && items[2].code === 'CE0796', '파일 등장 순서 유지', items.map((i) => i.code));
  ok(ce[2].cartons === 0 && ce[2].qty === 10 && ce[2].box_from === null, '카톤 0 행(낱개)도 별도 라인, 범위 null');
  const total = items.reduce((a, i) => a + i.qty, 0);
  ok(total === 398, '수량 합계 = 라인 합(320+32+36+10)', total);

  console.log('\n② DB — 두 라인 저장 + GET items 쿼리(0173 컬럼·라인 순서)');
  await q('BEGIN');
  await q('DELETE FROM rack_zones'); await q('DELETE FROM inbound_pallet_items');
  await q('DELETE FROM inbound_pallets'); await q('DELETE FROM inbound_shipments');
  await q('DELETE FROM products');
  const pid = (await q(`INSERT INTO products (code, name, rack_location) VALUES ('CE0796','TERMINAL','A-01-03') RETURNING id`)).rows[0].id;
  const sid = (await q(`INSERT INTO inbound_shipments (invoice_no, status) VALUES ('D26-1','receiving') RETURNING id`)).rows[0].id;
  const palId = (await q(`INSERT INTO inbound_pallets (shipment_id, order_no, pl_no, status, cartons_expected, qty_expected)
                          VALUES ($1,'PO1',1,'unloaded',23,356) RETURNING id`, [sid])).rows[0].id;
  // 운영 INSERT 와 동일 형태(같은 product 두 라인)
  const ins = SRC.match(/`INSERT INTO inbound_pallet_items[\s\S]*?VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8\)`/)[0].slice(1, -1);
  await q(ins, [palId, sid, pid, 'CE0796', 20, 320, 1, 20]);
  await q(ins, [palId, sid, pid, 'CE0796', 3, 36, 23, 25]);
  await q('COMMIT');
  ok(true, '운영 INSERT 문으로 같은 SKU 2행 저장 성공(유니크 제약 없음 확인)');

  const itemsSql = ('`' + SRC.split('rz.zone AS rack_zone')[1] ? null : null, (SRC.match(/`SELECT pi\.id, pi\.pallet_id[\s\S]*?ORDER BY pi\.id`/) || [])[0]);
  const sql = itemsSql.slice(1, -1);
  const got = (await q(sql, [sid])).rows;
  ok(got.length === 2, 'GET items 2행', got.length);
  ok(Number(got[0].box_from) === 1 && Number(got[0].box_to) === 20, '1행 box 범위 1–20');
  ok(Number(got[1].box_from) === 23 && Number(got[1].box_to) === 25, '2행 box 범위 23–25');
  ok(got[0].id < got[1].id, 'id 순 = 파일 라인 순');
  ok(Number(got[0].cartons) === 20 && Number(got[1].cartons) === 3, '라인별 카톤 유지');

  console.log('\n③ 하위 흐름 — 마감·입고예정 합계는 라인 분리와 무관하게 동일');
  const inc = (await q(`SELECT product_id, SUM(qty) AS qty FROM inbound_pallet_items WHERE shipment_id=$1 GROUP BY product_id`, [sid])).rows[0];
  ok(Number(inc.qty) === 356, 'SUM(qty) = 356 (마감 received_qty 연동 동일)', inc.qty);
  // 검수 증분도 라인별로 독립 동작(운영 check SQL 의 핵심식)
  await q(`UPDATE inbound_pallet_items SET scanned_cartons = LEAST(scanned_cartons + 2, cartons) WHERE shipment_id=$1 AND box_from=23`, [sid]);
  const sc = (await q(`SELECT box_from, scanned_cartons FROM inbound_pallet_items WHERE shipment_id=$1 ORDER BY id`, [sid])).rows;
  ok(sc[0].scanned_cartons === 0 && sc[1].scanned_cartons === 2, '라인별 검수 증분 독립(다른 라인 무영향)', sc);

  console.log('\n④ 라인 재분할(applyRelines) — 수량 불변·카톤 교정·팔렛별 보호');
  {
    const { applyRelines } = await import('../src/routes/inboundRoutes.js');
    await q('BEGIN');
    await q('DELETE FROM inbound_pallet_items'); await q('DELETE FROM inbound_pallets'); await q('DELETE FROM inbound_shipments');
    const pid2 = (await q(`SELECT id FROM products WHERE code='CE0796'`)).rows[0].id;
    const sid2 = (await q(`INSERT INTO inbound_shipments (invoice_no, status) VALUES ('26B2C','receiving') RETURNING id`)).rows[0].id;
    // 팔렛4: FROM/TO 기준으로 잘못 등재(1카톤 24EA) — 실제는 CARTON UNIT 2 × 12EA
    const palA = (await q(`INSERT INTO inbound_pallets (shipment_id, order_no, pl_no, status, cartons_expected, qty_expected)
                           VALUES ($1,'26B2C',4,'unloaded',1,24) RETURNING id`, [sid2])).rows[0].id;
    await q(`INSERT INTO inbound_pallet_items (pallet_id, shipment_id, product_id, input_code, cartons, qty)
             VALUES ($1,$2,$3,'CE0796',1,24)`, [palA, sid2, pid2]);
    // 팔렛5: 이미 검수 진행 — 보호 대상
    const palB = (await q(`INSERT INTO inbound_pallets (shipment_id, order_no, pl_no, status, cartons_expected, qty_expected)
                           VALUES ($1,'26B2C',5,'checking',2,32) RETURNING id`, [sid2])).rows[0].id;
    await q(`INSERT INTO inbound_pallet_items (pallet_id, shipment_id, product_id, input_code, cartons, qty, scanned_cartons)
             VALUES ($1,$2,$3,'CE0796',2,32,1)`, [palB, sid2, pid2]);
    await q('COMMIT');

    const pmap = { CE0796: { id: Number(pid2), rack: 'A-01-03' } };
    // 교정된 파서 결과: 팔렛4 = 2카톤 ×12 = 24EA (수량 동일·카톤 1→2)
    const filePallets = aggregate([
      { order_no: '26B2C', pl_no: 4, code: 'CE0796', cartons: 2, qty: 24, box_from: 1, box_to: 2 },
      { order_no: '26B2C', pl_no: 5, code: 'CE0796', cartons: 2, qty: 32, box_from: 3, box_to: 4 },
    ]);

    // ⚠ 수량이 다른 파일은 거부(불변식)
    const bad = await applyRelines(q, sid2, aggregate([
      { order_no: '26B2C', pl_no: 4, code: 'CE0796', cartons: 2, qty: 30 },
      { order_no: '26B2C', pl_no: 5, code: 'CE0796', cartons: 2, qty: 32 },
    ]), pmap);
    ok(bad.error === 'file_mismatch', '수량 다른 파일 거부', bad);

    const r = await applyRelines(q, sid2, filePallets, pmap);
    ok(r.ok && r.pallets === 1 && r.skipped.length === 1, '미스캔 팔렛만 교체 + 검수 진행 팔렛 건너뜀', r);
    const a4 = (await q(`SELECT cartons, qty, box_from FROM inbound_pallet_items WHERE pallet_id=$1`, [palA])).rows[0];
    ok(a4.cartons === 2 && Number(a4.qty) === 24, '카톤 1→2 교정(소입수 12 복원)', a4);
    const pal4 = (await q(`SELECT cartons_expected, qty_expected FROM inbound_pallets WHERE id=$1`, [palA])).rows[0];
    ok(pal4.cartons_expected === 2 && Number(pal4.qty_expected) === 24, '팔렛 예상 카톤도 갱신·수량 유지', pal4);
    const b5 = (await q(`SELECT cartons, scanned_cartons FROM inbound_pallet_items WHERE pallet_id=$1`, [palB])).rows[0];
    ok(b5.cartons === 2 && b5.scanned_cartons === 1, '검수 진행 팔렛은 원본 그대로 보호', b5);

    // 전 팔렛이 진행 중이면 already_scanned
    await q(`UPDATE inbound_pallet_items SET scanned_cartons=1 WHERE pallet_id=$1`, [palA]);
    const r2 = await applyRelines(q, sid2, filePallets, pmap);
    ok(r2.error === 'already_scanned', '교체 가능한 팔렛이 없으면 already_scanned', r2);
  }

  console.log('\n' + (fail ? '❌' : '✅') + ` 결과: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error('테스트 오류:', e); await pool.end(); process.exit(2); });
