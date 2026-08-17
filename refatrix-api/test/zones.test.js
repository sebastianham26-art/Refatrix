// 창고 존(zone) 지정 — 실 PostgreSQL 16 + 전체 마이그레이션(0172 포함) 위에서
// zoneRoutes 의 실제 쿼리와 inboundRoutes 의 존 조인을 그대로 실행한다.
//   실행: DATABASE_URL=postgres://rf:rf@127.0.0.1:5432/refatrix node test/zones.test.js
import pg from 'pg';
import fs from 'node:fs';
import { rackSortKey, sortRacks, rackGroup, NEW_KEY } from '../src/routes/zoneRoutes.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, p) => pool.query(t, p);
let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); } };

/* ---------- 픽스처 ---------- */
async function seed() {
  await q('BEGIN');
  await q(`DELETE FROM rack_zones`);
  await q(`DELETE FROM inbound_pallet_items`);
  await q(`DELETE FROM inbound_pallets`);
  await q(`DELETE FROM inbound_shipments`);
  await q(`DELETE FROM products`);
  await q(`DELETE FROM users WHERE login_id LIKE 'zt_%'`);

  const uid = (await q(
    `INSERT INTO users (login_id, name, role, pin_hash) VALUES ('zt_dir','Dir','director','x') RETURNING id`
  )).rows[0].id;

  // 랙 정렬 확인용으로 일부러 뒤섞어 넣는다. A-2-10 / A-2-9 로 자연정렬도 검증.
  const prods = [
    ['CE0796', 'TERMINAL', 'B-01-01'],
    ['CE0152', 'TERMINAL', 'A-2-10'],
    ['CE0154', 'TERMINAL', 'A-2-9'],
    ['CE0168', 'TERMINAL', 'A-01-03'],
    ['CQ0271L', 'HORQUILLA', 'C-05-02'],
    ['CB0318', 'ROTULA', 'b-01-01'],          // 대소문자 다른 같은 랙
    ['CX0001', 'NUEVO', null],                 // 랙 미지정
    ['CX0002', 'NUEVO', '   '],                // 공백만 → 미지정 취급
    ['CZ9999', 'BORRADO', 'Z-09-09'],          // 삭제 제품 → 랙 목록에서 빠져야 함
  ];
  const ids = {};
  for (const [code, name, rack] of prods) {
    ids[code] = (await q(
      `INSERT INTO products (code, name, rack_location) VALUES ($1,$2,$3) RETURNING id`,
      [code, name, rack]
    )).rows[0].id;
  }
  await q(`UPDATE products SET deleted_at=now() WHERE code='CZ9999'`);

  // 수입 선적 1건 · 팔렛 1개 · 라인 4개(랙있음 / 랙없음 / rack_saved 우선 / 미등록SKU)
  const sid = (await q(
    `INSERT INTO inbound_shipments (invoice_no, status) VALUES ('D26-81319563','receiving') RETURNING id`
  )).rows[0].id;
  const pid = (await q(
    `INSERT INTO inbound_pallets (shipment_id, order_no, pl_no, status, cartons_expected, qty_expected)
          VALUES ($1,'100RA25K2C',12,'unloaded',4,64) RETURNING id`, [sid]
  )).rows[0].id;
  const line = async (code, pidOrNull, cartons, qty, rackSaved) => q(
    `INSERT INTO inbound_pallet_items (shipment_id, pallet_id, product_id, input_code, cartons, qty, rack_saved)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [sid, pid, pidOrNull, code, cartons, qty, rackSaved]
  );
  await line('CE0796', ids.CE0796, 1, 16, null);        // products.rack_location = B-01-01
  await line('CX0001', ids.CX0001, 1, 16, null);        // 랙 미지정 → __NEW__ 기본 존
  await line('CE0152', ids.CE0152, 1, 16, 'C-05-02');   // rack_saved 가 우선
  await line('NOEXISTE', null, 1, 16, null);            // 미등록 SKU
  await q('COMMIT');
  return { uid, sid, pid, ids };
}

/* ---------- 운영 쿼리를 소스에서 그대로 추출한다(복붙 아님 → 코드가 바뀌면 테스트도 같이 바뀜) ---------- */
const readSrc = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
function sqlWith(src, needle) {
  const hits = (src.match(/`[^`]*`/g) || []).filter((t) => t.includes(needle));
  if (!hits.length) throw new Error('운영 소스에서 SQL 을 찾지 못했습니다: ' + needle);
  return hits[0].slice(1, -1);
}
const ZSRC = readSrc('../src/routes/zoneRoutes.js');
const ISRC = readSrc('../src/routes/inboundRoutes.js');

const RACK_LIST_SQL = sqlWith(ZSRC, 'GROUP BY UPPER(TRIM(p.rack_location))');
const NO_RACK_SQL = sqlWith(ZSRC, "NULLIF(TRIM(p.rack_location), '') IS NULL");
const NEW_ZONE_SQL = sqlWith(ISRC, 'WHERE rz.rack = $1');   // 신규 기본 존 조회는 inboundRoutes 에 있다
const INBOUND_ITEMS_SQL = sqlWith(ISRC, 'rz.zone AS rack_zone');   // 운영 쿼리에 ORDER BY pi.id 포함(라인 순서)

// PUT 저장 로직과 동일한 upsert/delete
async function saveMap(rows, uid) {
  let set = 0, cleared = 0;
  for (const m of rows) {
    const rack = String(m.rack || '').trim();
    if (!rack) continue;
    if (m.zone == null) {
      cleared += (await q('DELETE FROM rack_zones WHERE rack=$1', [rack])).rowCount;
    } else {
      await q(
        `INSERT INTO rack_zones (rack, zone, updated_by, updated_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (rack) DO UPDATE SET zone=EXCLUDED.zone, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [rack, m.zone, uid]
      );
      set += 1;
    }
  }
  return { set, cleared };
}

async function main() {
  const { uid, sid, ids } = await seed();

  console.log('\n① 0172 스키마');
  const zones = (await q('SELECT zone, name FROM warehouse_zones ORDER BY zone')).rows;
  ok(zones.length === 4 && zones[0].name === 'Zona 1' && zones[3].zone === 4, '존 4개 시드', zones);
  const badZone = await q('INSERT INTO rack_zones (rack, zone) VALUES ($1,$2)', ['X-1', 9]).then(() => null).catch((e) => e.code);
  ok(badZone === '23503', '존 5 이상은 FK 로 거부', badZone);
  const badWz = await q('INSERT INTO warehouse_zones (zone, name) VALUES (5, $1)', ['x']).then(() => null).catch((e) => e.code);
  ok(badWz === '23514', 'warehouse_zones CHECK(1~4) 로 거부', badWz);
  // 멱등: 같은 마이그레이션을 다시 돌려도 시드가 중복되지 않는다
  await q(`INSERT INTO warehouse_zones (zone,name) VALUES (1,'Zona 1'),(2,'Zona 2'),(3,'Zona 3'),(4,'Zona 4') ON CONFLICT (zone) DO NOTHING`);
  ok(Number((await q('SELECT COUNT(*)::int n FROM warehouse_zones')).rows[0].n) === 4, '시드 재실행 멱등');

  console.log('\n② 랙 목록 — 알파벳·번호순, 삭제·빈값 제외');
  const rackRows = (await q(RACK_LIST_SQL)).rows;
  const racks = sortRacks(rackRows.map((r) => ({ rack: r.rack, products: r.products, group: rackGroup(r.rack) })));
  const order = racks.map((r) => r.rack);
  ok(!order.includes('Z-09-09'), '삭제 제품의 랙 제외', order);
  ok(order.length === 5, '랙 5종 — B-01-01 과 b-01-01 은 한 줄로 합쳐짐(빈값·미지정 제외)', order);
  ok(JSON.stringify(order) === JSON.stringify(['A-01-03', 'A-2-9', 'A-2-10', 'B-01-01', 'C-05-02']),
    '자연정렬: A-2-9 → A-2-10 (문자정렬이면 10이 먼저 옴)', order);
  ok(racks.find((r) => r.rack === 'B-01-01').products === 2, '대소문자 다른 표기의 제품 수가 합산됨',
    racks.find((r) => r.rack === 'B-01-01'));
  ok(rackSortKey('A-2-10') > rackSortKey('A-2-9'), 'rackSortKey 숫자 패딩');
  ok(rackGroup('A-01-03') === 'A' && rackGroup('12-B') === '12', 'rackGroup 앞머리 추출');
  ok(Number((await q(NO_RACK_SQL)).rows[0].n) === 2, '랙 미지정 제품 2건(null + 공백)');

  console.log('\n③ 저장 — upsert · 해제 · 앞글자 일괄지정');
  await saveMap([{ rack: 'A-01-03', zone: 1 }, { rack: 'A-2-9', zone: 1 }, { rack: 'A-2-10', zone: 1 },
                 { rack: 'B-01-01', zone: 2 }, { rack: 'C-05-02', zone: 3 }, { rack: NEW_KEY, zone: 4 }], uid);
  ok(Number((await q('SELECT COUNT(*)::int n FROM rack_zones')).rows[0].n) === 6, '6건 저장');
  await saveMap([{ rack: 'B-01-01', zone: 3 }], uid);
  ok((await q(`SELECT zone FROM rack_zones WHERE rack='B-01-01'`)).rows[0].zone === 3, '같은 랙 재지정(upsert)');
  await saveMap([{ rack: 'C-05-02', zone: null }], uid);
  ok((await q(`SELECT 1 FROM rack_zones WHERE rack='C-05-02'`)).rowCount === 0, 'zone=null 이면 매핑 삭제');
  ok(Number((await q('SELECT COUNT(*)::int n FROM rack_zones')).rows[0].n) === 5, '나머지 매핑은 유지(전체삭제 아님)');
  await saveMap([{ rack: 'C-05-02', zone: 3 }], uid);   // 되돌리기
  ok(String((await q(`SELECT updated_by FROM rack_zones WHERE rack='C-05-02'`)).rows[0].updated_by) === String(uid),
    'updated_by 기록 (users.id 는 BIGINT → pg 가 문자열로 반환)');

  console.log('\n④ 검수 화면이 받는 존 — 랙 지정 / rack_saved 우선 / 신규 기본 / 미등록');
  const nz = (await q(NEW_ZONE_SQL, [NEW_KEY])).rows[0];
  ok(nz && Number(nz.zone) === 4, '__NEW__ 기본 존 = 4', nz);
  const items = (await q(INBOUND_ITEMS_SQL, [sid])).rows.map((it) => ({
    code: it.input_code,
    rack: it.rack_saved || it.rack_location || null,
    zone: it.rack_zone != null ? Number(it.rack_zone) : (nz ? Number(nz.zone) : null),
    zone_name: it.rack_zone != null ? it.rack_zone_name : (nz ? nz.name : null),
    zone_is_default: it.rack_zone == null && !!nz,
  }));
  const by = (c) => items.find((x) => x.code === c);
  ok(by('CE0796').zone === 3 && by('CE0796').rack === 'B-01-01', 'products.rack_location 의 존(B-01-01→3)', by('CE0796'));
  ok(by('CE0152').zone === 3 && by('CE0152').rack === 'C-05-02', 'rack_saved 가 rack_location 을 덮어씀', by('CE0152'));
  ok(by('CX0001').zone === 4 && by('CX0001').zone_is_default === true, '랙 미지정 → 신규 기본 존 4', by('CX0001'));
  ok(by('NOEXISTE').zone === 4 && by('NOEXISTE').zone_is_default === true, '미등록 SKU → 신규 기본 존 4', by('NOEXISTE'));
  ok(by('CE0796').zone_name === 'Zona 3', '존 이름 함께 내려감', by('CE0796').zone_name);
  ok(items.every((x) => x.zone !== null), '모든 라인에 존이 정해짐(신규 기본값 덕분)');

  console.log('\n⑤ 대소문자 다른 랙도 같은 존으로 매칭');
  await q(`UPDATE inbound_pallet_items SET rack_saved='b-01-01' WHERE input_code='CE0796'`);
  const one = (await q(INBOUND_ITEMS_SQL, [sid])).rows.find((r) => r.input_code === 'CE0796');
  ok(Number(one.rack_zone) === 3, 'b-01-01 ↔ B-01-01 대소문자 무시 매칭', one.rack_zone);
  await q(`UPDATE inbound_pallet_items SET rack_saved=NULL WHERE input_code='CE0796'`);

  console.log('\n⑥ 신규 기본 존을 안 정한 경우 — 존 미지정으로 남는다(오배치 방지)');
  await q('DELETE FROM rack_zones WHERE rack=$1', [NEW_KEY]);
  const nz2 = (await q(NEW_ZONE_SQL, [NEW_KEY])).rows[0] || null;
  const items2 = (await q(INBOUND_ITEMS_SQL, [sid])).rows.map((it) => ({
    code: it.input_code, zone: it.rack_zone != null ? Number(it.rack_zone) : (nz2 ? Number(nz2.zone) : null),
  }));
  ok(items2.find((x) => x.code === 'CX0001').zone === null, '신규 SKU 는 존 null (임의 배치 안 함)');
  ok(items2.find((x) => x.code === 'CE0796').zone === 3, '랙이 있는 라인은 영향 없음');

  console.log('\n⑦ 제품 랙이 바뀌면 존도 따라 바뀐다(매핑은 랙 기준)');
  await q(`UPDATE products SET rack_location='A-01-03' WHERE code='CE0796'`);
  const one2 = (await q(INBOUND_ITEMS_SQL, [sid])).rows.find((r) => r.input_code === 'CE0796');
  ok(Number(one2.rack_zone) === 1, 'B-01-01(존3) → A-01-03(존1)', one2.rack_zone);

  console.log('\n' + (fail ? '❌' : '✅') + ` 결과: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error('테스트 오류:', e); await pool.end(); process.exit(2); });
