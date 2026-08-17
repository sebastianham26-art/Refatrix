import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';

// build 20260817a-zones
// 창고 존(zone) 지정 — 랙 번호를 4개의 "존 이동용 임시 팔렛"에 매핑한다(0172).
//   읽기: 창고 권한(검수 화면이 존을 표시해야 하므로)
//   쓰기: 디렉터 전용
// 재고·위치 데이터를 바꾸지 않는다. products.rack_location 은 읽기만 한다.

export const NEW_KEY = '__NEW__';           // 랙 미지정(신규) SKU 의 기본 존
const ZONES = [1, 2, 3, 4];

// 랙 번호 자연 정렬키: 숫자 구간을 0 패딩해서 A-2-10 이 A-2-9 뒤에 오게 한다.
//   (알파벳 순서 요구사항 + 사람이 기대하는 번호 순서를 동시에 만족)
export function rackSortKey(rack) {
  return String(rack || '')
    .toUpperCase()
    .replace(/\d+/g, (n) => n.padStart(6, '0'));
}
export function sortRacks(list) {
  return list.slice().sort((a, b) => {
    const ka = rackSortKey(a.rack), kb = rackSortKey(b.rack);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
// 랙 앞머리(그룹) — 일괄 지정 단위. 'A-01-03' → 'A', '12-B' → '12'
export function rackGroup(rack) {
  const s = String(rack || '').trim().toUpperCase();
  const m = s.match(/^[A-Z]+|^\d+/);
  return m ? m[0] : (s ? s.charAt(0) : '?');
}

export default async function zoneRoutes(app) {
  /* 존 지정 화면 데이터: 존 4개 + 현재 등록된 랙 목록(알파벳·번호순) + 매핑 현황 */
  app.get('/api/warehouse/zones', { preHandler: [authGuard, requirePage('warehouse')] }, async () => {
    const zones = (await query('SELECT zone, name, note FROM warehouse_zones ORDER BY zone')).rows;

    // 현재 제품마스터에 실제로 쓰이는 랙만 (빈 값·삭제 제품 제외) + 제품 수.
    // 존 조회는 대소문자를 무시하므로 목록도 UPPER 로 묶는다 — 'B-01-01' 과 'b-01-01' 이
    // 두 줄로 나뉘어 디렉터가 같은 랙을 두 번 지정하는 일을 막는다(표기는 최다 사용형을 보여준다).
    const rackRows = (await query(
      `SELECT (array_agg(TRIM(p.rack_location) ORDER BY cnt DESC, TRIM(p.rack_location)))[1] AS rack,
              SUM(cnt)::int AS products
         FROM (SELECT p.rack_location, COUNT(*)::int AS cnt
                 FROM products p
                WHERE p.deleted_at IS NULL
                  AND NULLIF(TRIM(p.rack_location), '') IS NOT NULL
                GROUP BY p.rack_location) p
        GROUP BY UPPER(TRIM(p.rack_location))`
    )).rows;

    const mapRows = (await query('SELECT rack, zone FROM rack_zones')).rows;
    const byRack = new Map();
    for (const r of mapRows) byRack.set(String(r.rack).toUpperCase(), r.zone);

    const racks = sortRacks(rackRows.map((r) => ({
      rack: r.rack,
      products: r.products,
      group: rackGroup(r.rack),
      zone: byRack.get(String(r.rack).toUpperCase()) || null,
    })));

    // 제품마스터에서 사라진 랙인데 매핑만 남아있는 것(참고용 — 화면에서 정리할 수 있게)
    const live = new Set(rackRows.map((r) => String(r.rack).toUpperCase()));
    const orphans = mapRows
      .filter((r) => r.rack !== NEW_KEY && !live.has(String(r.rack).toUpperCase()))
      .map((r) => ({ rack: r.rack, zone: r.zone }));

    // 랙 미지정(신규) SKU 수 + 그 기본 존
    const noRack = Number((await query(
      `SELECT COUNT(*)::int AS n FROM products p
        WHERE p.deleted_at IS NULL AND NULLIF(TRIM(p.rack_location), '') IS NULL`
    )).rows[0].n);

    return {
      zones,
      racks,
      orphans: sortRacks(orphans),
      new_zone: byRack.get(NEW_KEY) || null,
      no_rack_products: noRack,
      totals: {
        racks: racks.length,
        mapped: racks.filter((r) => r.zone).length,
        unmapped: racks.filter((r) => !r.zone).length,
      },
    };
  });

  /* 저장(디렉터) — 존 이름 + 랙 매핑을 한 번에.
     body: { zones:[{zone,name,note}], map:[{rack,zone}], new_zone:1|null }
     map 에 있는 랙만 갱신하고, zone 이 null/0 이면 그 랙의 매핑을 삭제한다(전체 삭제 아님). */
  app.put('/api/warehouse/zones', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const uid = req.user.sub;
    const body = req.body || {};
    const zoneIn = Array.isArray(body.zones) ? body.zones : [];
    const mapIn = Array.isArray(body.map) ? body.map : [];

    if (mapIn.length > 20000) return reply.code(400).send({ error: 'too_many_racks' });

    // 검증: zone 은 1~4 만
    for (const m of mapIn) {
      if (m && m.zone != null && m.zone !== '' && !ZONES.includes(Number(m.zone))) {
        return reply.code(400).send({ error: 'bad_zone', rack: m.rack });
      }
    }
    if (body.new_zone != null && body.new_zone !== '' && !ZONES.includes(Number(body.new_zone))) {
      return reply.code(400).send({ error: 'bad_zone', rack: NEW_KEY });
    }

    const result = await withTx(async (c) => {
      let renamed = 0, set = 0, cleared = 0;

      for (const z of zoneIn) {
        const zn = Number(z && z.zone);
        if (!ZONES.includes(zn)) continue;
        const name = String((z.name == null ? '' : z.name)).trim().slice(0, 60) || ('Zona ' + zn);
        const note = z.note == null ? null : String(z.note).trim().slice(0, 200) || null;
        const r = await c.query(
          `UPDATE warehouse_zones SET name=$2, note=$3, updated_by=$4, updated_at=now()
            WHERE zone=$1 AND (name IS DISTINCT FROM $2 OR note IS DISTINCT FROM $3)`,
          [zn, name, note, uid]
        );
        renamed += r.rowCount;
      }

      // 랙 매핑 — 신규 기본 존도 같은 테이블의 특수키로 처리
      const rows = mapIn.slice();
      if ('new_zone' in body) rows.push({ rack: NEW_KEY, zone: body.new_zone });

      for (const m of rows) {
        const rack = String((m && m.rack) || '').trim();
        if (!rack) continue;
        const zn = m.zone == null || m.zone === '' ? null : Number(m.zone);
        if (zn == null) {
          const r = await c.query('DELETE FROM rack_zones WHERE rack=$1', [rack]);
          cleared += r.rowCount;
        } else {
          await c.query(
            `INSERT INTO rack_zones (rack, zone, updated_by, updated_at)
                  VALUES ($1, $2, $3, now())
             ON CONFLICT (rack) DO UPDATE
                    SET zone=EXCLUDED.zone, updated_by=EXCLUDED.updated_by, updated_at=now()`,
            [rack, zn, uid]
          );
          set += 1;
        }
      }
      return { renamed, set, cleared };
    });

    // 감사로그: 0057 CHECK 에 없는 커스텀 액션은 조용히 실패하므로 표준 'update' 사용
    await logEvent({
      userId: uid, deviceId: req.ctx.deviceId, action: 'update',
      target: 'warehouse_zones', detail: result,
    });

    return { ok: true, ...result };
  });
}
