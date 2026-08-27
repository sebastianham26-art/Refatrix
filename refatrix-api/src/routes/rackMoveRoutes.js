import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { sortRacks, rackGroup, splitRacks } from './zoneRoutes.js';

// build 20260827a-relocate
// 창고 위치변경(Cambio de ubicación) — 카톤 랙 → fast moving rack 박스 이동 기록 (0187)
//   읽기: 창고 권한 / 이동 기록: 창고 권한 / 랙 유형 지정: 디렉터 전용
//
// 재고 총량(products.stock_qty)은 절대 건드리지 않는다. 바뀌는 것은 "위치"뿐이다.
//   · rack_moves      : 이동 1건(제품·출발랙·도착랙·카톤수·소입수량·EA) 기록 — 감사 원장
//   · products.rack_location : 디렉터 정책상 새 위치로 갱신(화면에서 끌 수 있다)

export const RACK_KINDS = ['carton', 'fast'];
export const DEFAULT_KIND = 'carton';           // rack_kinds 에 행이 없는 랙의 기본 유형

// 랙 비교키 — 대소문자·양끝 공백 무시. (존 지정과 같은 규칙: 랙은 '문자열' 기준)
export function normRack(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}
export function sameRack(a, b) {
  const x = normRack(a), y = normRack(b);
  return !!x && x === y;
}
// 제품번호 비교키 — 스캐너가 하이픈·공백을 다르게 흘려도 같은 제품으로 붙게 한다.
/* 마스터 랙 칸이 "AA3-2, B2-2" 처럼 여러 랙일 때, **옮긴 랙 하나만** 갈아끼운다.
   예전 코드는 rack_location 을 도착 랙으로 통째로 덮어써서 나머지 랙이 조용히 사라졌다.
     replaceRackToken('AA3-2, B2-2', 'AA3-2', 'F1-1') → 'F1-1, B2-2'
   일치하는 랙이 없으면 null 을 돌려주고, 호출부는 **마스터를 건드리지 않는다**(추측 금지). */
export function replaceRackToken(master, from, to) {
  const list = splitRacks(master);
  if (!list.length) return null;
  const i = list.findIndex((r) => sameRack(r, from));
  if (i < 0) return null;
  const next = list.slice();
  next[i] = to;
  const out = [];                                  // 같은 랙이 두 번 들어가지 않게(대소문자 무시)
  for (const r of next) if (!out.some((x) => sameRack(x, r))) out.push(r);
  return out.join(', ');
}
export function normCode(v) {
  return String(v == null ? '' : v).trim().toUpperCase().replace(/[\s‐-―'’`]/g, '');
}
export function bareCode(v) {
  return normCode(v).replace(/[^A-Z0-9]/g, '');
}

// 카톤 라벨 파서(서버측 방어) — `CTR-<제품번호>-<소입수량>`
//   프런트가 이미 분해해서 보내지만, 라벨 원문만 온 경우에도 동작하게 한다.
export function parseCartonLabel(raw) {
  const norm = normCode(raw);
  if (!norm) return { code: '', qty: 0, prefix: '' };
  let body = norm, prefix = '';
  const mp = norm.match(/^(CTR|SYD)-?(.+)$/);
  if (mp) { prefix = mp[1]; body = mp[2]; }
  const mq = body.match(/^(.*[A-Z0-9])-(\d{1,6})$/);
  if (mq) return { code: mq[1], qty: Number(mq[2]), prefix };
  return { code: body, qty: 0, prefix };
}

export default async function rackMoveRoutes(app) {
  const g = { preHandler: [authGuard, requirePage('warehouse')] };
  const gDir = { preHandler: [authGuard, requireDirector] };

  /* 랙 목록 + 유형 -----------------------------------------------------
     화면이 이 목록을 들고 있으면 스캔값이 "랙"인지 "카톤 라벨"인지 오프라인으로 즉시 판정할 수 있다.
     목록 = 제품마스터에 쓰이는 랙 ∪ 유형이 지정된 랙(아직 제품이 없는 신규 fast rack 포함). */
  app.get('/api/warehouse/racks', g, async () => {
    const rackRows = (await query(
      // ⚠ products.rack_location 한 칸에 "AA3-2, B2-2" 처럼 콤마로 여러 랙이 적힌 제품이 있다.
      //   통짜로 묶으면 랙 목록에 그 문자열이 랙 1개로 뜨고(앞글자만 보므로 AA 그룹에 B2 가 딸려 들어감)
      //   스캔값 판정·유형 지정도 안 된다. 존 지정(zoneRoutes)과 **같은 구분자**로 쪼갠다. (2026-08-27)
      `SELECT (array_agg(r.rack ORDER BY r.cnt DESC, r.rack))[1] AS rack,
              SUM(r.cnt)::int AS products
         FROM (SELECT TRIM(tok) AS rack, COUNT(DISTINCT p.id)::int AS cnt
                 FROM products p
                 CROSS JOIN LATERAL regexp_split_to_table(p.rack_location, '[,\n\r]+') AS tok
                WHERE p.deleted_at IS NULL
                  AND NULLIF(TRIM(tok), '') IS NOT NULL
                GROUP BY TRIM(tok)) r
        GROUP BY UPPER(r.rack)`
    )).rows;

    const kindRows = (await query('SELECT rack, kind, note FROM rack_kinds')).rows;
    const zoneRows = (await query('SELECT rack, zone FROM rack_zones')).rows;

    const byKind = new Map(), byZone = new Map();
    for (const r of kindRows) byKind.set(normRack(r.rack), { kind: r.kind, note: r.note || null });
    for (const r of zoneRows) byZone.set(normRack(r.rack), r.zone);

    const seen = new Map();
    for (const r of rackRows) seen.set(normRack(r.rack), { rack: r.rack, products: r.products });
    // 제품이 아직 없는 랙(신규 fast moving rack)도 목록에 넣는다 — 그래야 스캔이 인식된다.
    for (const r of kindRows) {
      const k = normRack(r.rack);
      if (k && k !== '__NEW__' && !seen.has(k)) seen.set(k, { rack: r.rack, products: 0 });
    }

    const racks = sortRacks([...seen.values()].map((r) => {
      const k = byKind.get(normRack(r.rack));
      return {
        rack: r.rack,
        products: r.products,
        group: rackGroup(r.rack),
        kind: k ? k.kind : DEFAULT_KIND,
        kind_set: !!k,                       // false = 기본값(carton)으로 간주된 것
        note: k ? k.note : null,
        zone: byZone.get(normRack(r.rack)) || null,
      };
    }));

    return {
      racks,
      default_kind: DEFAULT_KIND,
      totals: {
        racks: racks.length,
        fast: racks.filter((r) => r.kind === 'fast').length,
        carton: racks.filter((r) => r.kind !== 'fast').length,
        unset: racks.filter((r) => !r.kind_set).length,
      },
    };
  });

  /* 랙 유형 저장(디렉터) — body: { map:[{rack, kind:'carton'|'fast'|null, note}] }
     kind:null 이면 그 랙의 지정만 지운다(기본값 carton 으로 되돌림). 변경분만 보내면 된다. */
  app.put('/api/warehouse/rack-kinds', gDir, async (req, reply) => {
    const uid = req.user.sub;
    const mapIn = Array.isArray(req.body && req.body.map) ? req.body.map : [];
    if (mapIn.length > 20000) return reply.code(400).send({ error: 'too_many_racks' });

    for (const m of mapIn) {
      if (m && m.kind != null && m.kind !== '' && !RACK_KINDS.includes(String(m.kind))) {
        return reply.code(400).send({ error: 'bad_kind', rack: m && m.rack });
      }
      if (m && !String((m.rack == null ? '' : m.rack)).trim()) {
        return reply.code(400).send({ error: 'bad_rack' });
      }
    }

    const result = await withTx(async (c) => {
      let set = 0, cleared = 0;
      for (const m of mapIn) {
        const rack = String(m.rack).trim().slice(0, 40);
        const kind = m.kind == null || m.kind === '' ? null : String(m.kind);
        const note = m.note == null ? null : String(m.note).trim().slice(0, 200) || null;
        if (!kind) {
          const r = await c.query('DELETE FROM rack_kinds WHERE UPPER(TRIM(rack))=UPPER(TRIM($1))', [rack]);
          cleared += r.rowCount;
        } else {
          // 대소문자만 다른 중복 행이 생기지 않게, 기존 행이 있으면 그 표기를 유지한 채 갱신한다.
          const ex = (await c.query(
            'SELECT rack FROM rack_kinds WHERE UPPER(TRIM(rack))=UPPER(TRIM($1)) LIMIT 1', [rack]
          )).rows[0];
          if (ex) {
            await c.query(
              'UPDATE rack_kinds SET kind=$2, note=$3, updated_by=$4, updated_at=now() WHERE rack=$1',
              [ex.rack, kind, note, uid]
            );
          } else {
            await c.query(
              `INSERT INTO rack_kinds (rack, kind, note, updated_by, updated_at) VALUES ($1,$2,$3,$4,now())
               ON CONFLICT (rack) DO UPDATE SET kind=EXCLUDED.kind, note=EXCLUDED.note,
                     updated_by=EXCLUDED.updated_by, updated_at=now()`,
              [rack, kind, note, uid]
            );
          }
          set += 1;
        }
      }
      return { set, cleared };
    });

    await logEvent({
      userId: uid, deviceId: req.ctx && req.ctx.deviceId, action: 'update',
      target: 'rack_kinds', detail: result,
    });
    return { ok: true, ...result };
  });

  /* 스캔 1건 해석 — 카톤 라벨(또는 제품번호)을 제품으로 붙인다.
     GET /api/warehouse/relocate/lookup?q=CTR-CE0796-16   또는  ?code=CE0796 */
  app.get('/api/warehouse/relocate/lookup', g, async (req, reply) => {
    const q = req.query || {};
    const raw = String(q.q || q.code || '');
    if (!raw.trim()) return reply.code(400).send({ error: 'empty' });

    const parsed = q.code ? { code: normCode(q.code), qty: Number(q.qty || 0) || 0, prefix: '' }
      : parseCartonLabel(raw);

    // 후보: ① 라벨에서 분리한 제품번호 ② 접두어만 뗀 원문 ③ 원문 — 순서대로 찾는다.
    const cands = [];
    const push = (v) => { const n = normCode(v); if (n && !cands.includes(n)) cands.push(n); };
    push(parsed.code);
    push(normCode(raw).replace(/^(CTR|SYD)-?/, ''));
    push(raw);

    let row = null;
    for (const c of cands) {
      const r = (await query(
        `SELECT id, code, name, rack_location, stock_qty
           FROM products
          WHERE deleted_at IS NULL AND UPPER(TRIM(code)) = $1
          LIMIT 1`, [c]
      )).rows[0];
      if (r) { row = r; break; }
    }
    if (!row) {
      // 하이픈·공백을 뗀 형태로 한 번 더(제품번호 표기 흔들림 방어)
      for (const c of cands) {
        const b = bareCode(c);
        if (!b) continue;
        const r = (await query(
          `SELECT id, code, name, rack_location, stock_qty
             FROM products
            WHERE deleted_at IS NULL
              AND REGEXP_REPLACE(UPPER(TRIM(code)), '[^A-Z0-9]', '', 'g') = $1
            LIMIT 1`, [b]
        )).rows[0];
        if (r) { row = r; break; }
      }
    }
    if (!row) return reply.code(404).send({ error: 'product_not_found', read: parsed.code, raw });

    const rack = row.rack_location ? String(row.rack_location).trim() : null;
    // 마스터에 랙이 여러 개면(콤마) 유형은 **첫 랙** 기준으로 본다 — 통짜 문자열로는 매칭이 안 됐다.
    const rackList = splitRacks(rack);
    const kind = rackList.length ? await kindOf(rackList[0]) : null;
    return {
      product: {
        id: Number(row.id), code: row.code, name: row.name || null,
        rack: rack || null, racks: rackList, rack_kind: kind, stock_qty: Number(row.stock_qty || 0),
      },
      label: { raw, code: parsed.code, qty: parsed.qty || 0, prefix: parsed.prefix || '' },
    };
  });

  async function kindOf(rack) {
    const r = (await query(
      'SELECT kind FROM rack_kinds WHERE UPPER(TRIM(rack))=UPPER(TRIM($1)) LIMIT 1', [rack]
    )).rows[0];
    return r ? r.kind : DEFAULT_KIND;
  }

  /* 위치변경 저장 ------------------------------------------------------
     body: {
       from_rack: 'B-01-01' | null,      // 스캔한 기존 위치(없으면 제품마스터 위치를 쓴다)
       to_rack:   'FM-01',               // 스캔한 새 위치 (필수)
       update_master: true,              // products.rack_location 갱신 여부(기본 true)
       note: '...',
       lines: [{ product_id | code, cartons, per_carton, label }]
     }
     한 트랜잭션 — 한 줄이라도 실패하면 전부 롤백된다(부분 기록 방지). */
  app.post('/api/warehouse/rack-moves', g, async (req, reply) => {
    const uid = req.user.sub;
    const body = req.body || {};
    const toRack = String(body.to_rack == null ? '' : body.to_rack).trim().slice(0, 40);
    const fromRackIn = body.from_rack == null ? null : String(body.from_rack).trim().slice(0, 40) || null;
    const updateMaster = body.update_master === undefined ? true : !!body.update_master;
    const note = body.note == null ? null : String(body.note).trim().slice(0, 200) || null;
    const lines = Array.isArray(body.lines) ? body.lines : [];

    if (!toRack) return reply.code(400).send({ error: 'to_rack_required' });
    if (!lines.length) return reply.code(400).send({ error: 'no_lines' });
    if (lines.length > 500) return reply.code(400).send({ error: 'too_many_lines' });
    if (fromRackIn && sameRack(fromRackIn, toRack)) return reply.code(400).send({ error: 'same_rack' });

    const toKind = await kindOf(toRack);
    const fromKind = fromRackIn ? await kindOf(fromRackIn) : null;

    const out = await withTx(async (c) => {
      const moved = [];
      for (const l of lines) {
        const cartons = Math.max(1, Math.min(9999, Math.round(Number(l && l.cartons) || 1)));
        const per = Math.max(0, Number(l && l.per_carton) || 0);
        const label = l && l.label ? String(l.label).slice(0, 120) : null;

        let prod = null;
        if (l && l.product_id) {
          prod = (await c.query(
            'SELECT id, code, rack_location FROM products WHERE id=$1 AND deleted_at IS NULL', [Number(l.product_id)]
          )).rows[0] || null;
        }
        if (!prod && l && l.code) {
          prod = (await c.query(
            `SELECT id, code, rack_location FROM products
              WHERE deleted_at IS NULL AND UPPER(TRIM(code))=$1 LIMIT 1`, [normCode(l.code)]
          )).rows[0] || null;
        }
        if (!prod) { const e = new Error('product_not_found'); e.code4 = { error: 'product_not_found', line: l }; throw e; }

        const masterFrom = prod.rack_location ? String(prod.rack_location).trim() : null;
        // 출발 랙: 스캔값 우선, 없으면 제품마스터 위치. 둘 다 없으면 NULL(위치 미지정에서 올라온 박스).
        const fromRack = fromRackIn || masterFrom || null;
        if (fromRack && sameRack(fromRack, toRack)) {
          const e = new Error('same_rack'); e.code4 = { error: 'same_rack', line: l }; throw e;
        }

        // 마스터 갱신 — 랙이 여러 개면 **옮긴 랙만** 갈아끼운다(나머지 보존, 2026-08-27).
        //   · 랙 1개(기존 동작): 도착 랙으로 교체
        //   · 랙 여러 개 + 출발 랙이 그 안에 있음: 그 자리만 교체
        //   · 랙 여러 개인데 출발 랙이 목록에 없음: 어느 걸 바꿔야 할지 알 수 없으므로 건드리지 않는다
        let masterTo = null;
        if (updateMaster) {
          const list = splitRacks(masterFrom);
          if (list.length > 1) masterTo = replaceRackToken(masterFrom, fromRack, toRack);
          else if (!sameRack(masterFrom, toRack)) masterTo = toRack;
        }
        const willUpdate = !!masterTo;
        if (willUpdate) {
          await c.query('UPDATE products SET rack_location=$1, updated_by=$2 WHERE id=$3', [masterTo, uid, prod.id]);
        }

        const ins = (await c.query(
          `INSERT INTO rack_moves
             (product_id, product_code, from_rack, to_rack, from_kind, to_kind,
              cartons, per_carton, qty_ea, label, master_updated, master_from, note, moved_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING id, moved_at`,
          [prod.id, prod.code, fromRack, toRack,
            fromRack ? (fromRackIn ? fromKind : await kindOfTx(c, fromRack)) : null, toKind,
            cartons, per, cartons * per, label, willUpdate, masterFrom, note, uid]
        )).rows[0];

        moved.push({
          id: Number(ins.id), product_id: Number(prod.id), code: prod.code,
          from_rack: fromRack, to_rack: toRack, cartons, per_carton: per, qty_ea: cartons * per,
          master_updated: willUpdate, master_from: masterFrom,
        });
      }
      return { moved };
    }).catch((e) => {
      if (e && e.code4) return { _bad: e.code4 };
      throw e;
    });

    if (out && out._bad) return reply.code(400).send(out._bad);

    await logEvent({
      userId: uid, deviceId: req.ctx && req.ctx.deviceId, action: 'update',
      target: 'rack_moves',
      detail: {
        from_rack: fromRackIn, to_rack: toRack, update_master: updateMaster,
        lines: out.moved.map((m) => ({ code: m.code, cartons: m.cartons, qty_ea: m.qty_ea, from: m.from_rack })),
      },
    });

    return {
      ok: true,
      moved: out.moved,
      totals: {
        lines: out.moved.length,
        cartons: out.moved.reduce((s, m) => s + m.cartons, 0),
        qty_ea: out.moved.reduce((s, m) => s + m.qty_ea, 0),
        master_updated: out.moved.filter((m) => m.master_updated).length,
      },
    };
  });

  async function kindOfTx(c, rack) {
    const r = (await c.query(
      'SELECT kind FROM rack_kinds WHERE UPPER(TRIM(rack))=UPPER(TRIM($1)) LIMIT 1', [rack]
    )).rows[0];
    return r ? r.kind : DEFAULT_KIND;
  }

  /* 이동 기록 조회 — ?limit=&days=&rack=&code=&mine=1 */
  app.get('/api/warehouse/rack-moves', g, async (req) => {
    const q = req.query || {};
    const limit = Math.max(1, Math.min(500, Number(q.limit) || 100));
    const days = Math.max(0, Math.min(365, Number(q.days) || 0));
    const where = ['1=1'], params = [];
    if (days) { params.push(days); where.push(`m.moved_at >= now() - ($${params.length} || ' days')::interval`); }
    if (q.rack) {
      params.push(normRack(q.rack));
      where.push(`(UPPER(TRIM(m.from_rack)) = $${params.length} OR UPPER(TRIM(m.to_rack)) = $${params.length})`);
    }
    if (q.code) { params.push(normCode(q.code)); where.push(`UPPER(TRIM(m.product_code)) = $${params.length}`); }
    if (q.mine) { params.push(req.user.sub); where.push(`m.moved_by = $${params.length}`); }
    params.push(limit);

    const rows = (await query(
      `SELECT m.id, m.product_id, m.product_code, m.from_rack, m.to_rack, m.from_kind, m.to_kind,
              m.cartons, m.per_carton, m.qty_ea, m.master_updated, m.note, m.moved_at,
              u.name AS moved_by_name, p.name AS product_name
         FROM rack_moves m
         LEFT JOIN users u ON u.id = m.moved_by
         LEFT JOIN products p ON p.id = m.product_id
        WHERE ${where.join(' AND ')}
        ORDER BY m.moved_at DESC, m.id DESC
        LIMIT $${params.length}`, params
    )).rows.map((r) => ({
      ...r,
      id: Number(r.id), product_id: Number(r.product_id),
      cartons: Number(r.cartons), per_carton: Number(r.per_carton), qty_ea: Number(r.qty_ea),
    }));

    return { moves: rows, count: rows.length };
  });

  /* fast moving rack 현황 — 어느 랙에 어떤 SKU 가 얼마나 올라갔는지(이동 기록 합산) */
  app.get('/api/warehouse/rack-moves/summary', g, async (req) => {
    const days = Math.max(1, Math.min(365, Number((req.query || {}).days) || 90));
    const rows = (await query(
      `SELECT UPPER(TRIM(m.to_rack)) AS rack_key,
              (array_agg(TRIM(m.to_rack) ORDER BY m.moved_at DESC))[1] AS rack,
              m.product_code, (array_agg(p.name ORDER BY m.moved_at DESC))[1] AS product_name,
              SUM(m.cartons)::int AS cartons, SUM(m.qty_ea)::numeric AS qty_ea,
              MAX(m.moved_at) AS last_at
         FROM rack_moves m
         LEFT JOIN products p ON p.id = m.product_id
        WHERE m.moved_at >= now() - ($1 || ' days')::interval
        GROUP BY UPPER(TRIM(m.to_rack)), m.product_code
        ORDER BY MAX(m.moved_at) DESC`, [days]
    )).rows.map((r) => ({ ...r, cartons: Number(r.cartons), qty_ea: Number(r.qty_ea) }));
    return { days, rows, count: rows.length };
  });

  /* 되돌리기(직전 이동 취소) — 기록을 지우지 않고 반대 방향 이동을 새로 남긴다(원장 보존). */
  app.post('/api/warehouse/rack-moves/:id/undo', g, async (req, reply) => {
    const uid = req.user.sub;
    const id = Number(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });

    const m = (await query('SELECT * FROM rack_moves WHERE id=$1', [id])).rows[0];
    if (!m) return reply.code(404).send({ error: 'not_found' });
    if (!m.from_rack) return reply.code(400).send({ error: 'no_origin' });   // 출발지가 없으면 되돌릴 곳이 없다

    const out = await withTx(async (c) => {
      const prod = (await c.query(
        'SELECT id, code, rack_location FROM products WHERE id=$1 AND deleted_at IS NULL', [m.product_id]
      )).rows[0];
      const masterFrom = prod && prod.rack_location ? String(prod.rack_location).trim() : null;
      // 되돌리기도 같은 규칙 — 여러 랙이면 도착 랙 자리만 출발 랙으로 되돌린다(2026-08-27)
      let masterTo = null;
      if (prod && m.master_updated) {
        const list = splitRacks(masterFrom);
        if (list.length > 1) masterTo = replaceRackToken(masterFrom, m.to_rack, m.from_rack);
        else if (sameRack(masterFrom, m.to_rack)) masterTo = m.from_rack;
      }
      const willUpdate = !!masterTo;
      if (willUpdate) {
        await c.query('UPDATE products SET rack_location=$1, updated_by=$2 WHERE id=$3', [masterTo, uid, prod.id]);
      }
      const ins = (await c.query(
        `INSERT INTO rack_moves
           (product_id, product_code, from_rack, to_rack, from_kind, to_kind,
            cartons, per_carton, qty_ea, label, master_updated, master_from, note, moved_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [m.product_id, m.product_code, m.to_rack, m.from_rack, m.to_kind, m.from_kind,
          m.cartons, m.per_carton, m.qty_ea, m.label, willUpdate, masterFrom,
          '되돌리기 #' + id, uid]
      )).rows[0];
      return { undo_id: Number(ins.id), master_updated: willUpdate };
    });

    await logEvent({
      userId: uid, deviceId: req.ctx && req.ctx.deviceId, action: 'update',
      target: 'rack_moves:' + id, detail: { undo: true, ...out },
    });
    return { ok: true, ...out };
  });
}
