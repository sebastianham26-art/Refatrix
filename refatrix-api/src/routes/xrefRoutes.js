import { query, withTx } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';

// 경쟁사 교차참조 (product_xref_codes)
//  · 업로드 엑셀(예: LISTA GENERAL — BAW·SYD1~3·GROB·VASLO·KYB·MOOG·YOKOMITSU)의 각 행을
//    행 내 아무 코드 하나가 기존 제품(CTR 코드 / SyD 코드 / 기존 xref)과 매칭되면
//    그 행의 나머지 코드 전부를 해당 CTR 제품의 교차참조로 등록한다.
//  · 매칭·저장 모두 정규화 코드(norm = UPPER + 영숫자 외 제거) 기준 — 'DS-1045-S' == 'DS1045S'.
//  · 디렉터 전용. 재업로드 멱등(ON CONFLICT 갱신).

export const normCode = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');

export default async function xrefRoutes(app) {
  // 청크 내 모든 norm 코드 → product_id 매핑 (우선순위: CTR 코드 > SyD > 기존 xref)
  async function resolveMap(norms, exec = query) {
    if (!norms.length) return new Map();
    const rows = (await exec(
      `SELECT norm, product_id, pri FROM (
         SELECT regexp_replace(upper(p.code), '[^A-Z0-9]', '', 'g') AS norm, p.id AS product_id, 1 AS pri
           FROM products p
          WHERE p.deleted_at IS NULL
            AND regexp_replace(upper(p.code), '[^A-Z0-9]', '', 'g') = ANY($1)
         UNION ALL
         SELECT regexp_replace(upper(s.syd_code), '[^A-Z0-9]', '', 'g'), s.product_id, 2
           FROM product_syd_codes s JOIN products p ON p.id = s.product_id AND p.deleted_at IS NULL
          WHERE regexp_replace(upper(s.syd_code), '[^A-Z0-9]', '', 'g') = ANY($1)
         UNION ALL
         SELECT x.norm_code, x.product_id, 3
           FROM product_xref_codes x JOIN products p ON p.id = x.product_id AND p.deleted_at IS NULL
          WHERE x.norm_code = ANY($1)
       ) t ORDER BY pri`, [norms])).rows;
    const map = new Map();
    for (const r of rows) if (!map.has(r.norm)) map.set(r.norm, Number(r.product_id));
    return map;
  }

  // ── 교차참조 일괄 등록 (디렉터) ──
  //  body: { rows: [ { codes: [ { brand, code } ] } ] }   (청크 최대 1000행)
  app.post('/api/products/xref/bulk-upsert', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const b = req.body || {};
    const rows = Array.isArray(b.rows) ? b.rows.slice(0, 1000) : [];
    if (!rows.length) return reply.code(400).send({ error: 'no_rows' });

    // 행 정제: 코드 원문 + norm 준비, 빈 코드 제거
    const clean = rows.map((r) => {
      const codes = (Array.isArray(r && r.codes) ? r.codes : [])
        .map((c) => ({ brand: String((c && c.brand) || '').trim() || null, code: String((c && c.code) || '').trim() }))
        .filter((c) => c.code)
        .map((c) => ({ ...c, norm: normCode(c.code) }))
        .filter((c) => c.norm);
      return { codes };
    }).filter((r) => r.codes.length);

    const allNorms = [...new Set(clean.flatMap((r) => r.codes.map((c) => c.norm)))];

    const out = await withTx(async (c) => {
      const exec = c.query.bind(c);
      const map = await resolveMap(allNorms, exec);
      // 매칭된 제품들의 CTR norm (자기 CTR 코드는 xref로 중복 저장 안 함)
      const pids = [...new Set([...map.values()])];
      const ctrNorm = new Map();
      if (pids.length) {
        const pr = (await exec(
          `SELECT id, regexp_replace(upper(code), '[^A-Z0-9]', '', 'g') AS norm
             FROM products WHERE id = ANY($1)`, [pids])).rows;
        for (const p of pr) ctrNorm.set(Number(p.id), p.norm);
      }
      let matchedRows = 0, inserted = 0, unmatchedRows = 0;
      const unmatchedSample = [];
      for (const row of clean) {
        let pid = null;
        for (const cd of row.codes) { const hit = map.get(cd.norm); if (hit) { pid = hit; break; } }
        if (!pid) {
          unmatchedRows++;
          if (unmatchedSample.length < 20) unmatchedSample.push(row.codes[0].code);
          continue;
        }
        matchedRows++;
        const own = ctrNorm.get(pid);
        const seen = new Set();
        for (const cd of row.codes) {
          if (cd.norm === own || seen.has(cd.norm)) continue;   // 자기 CTR 코드·행 내 중복 제외
          seen.add(cd.norm);
          const r = await exec(
            `INSERT INTO product_xref_codes (product_id, xref_code, norm_code, brand, created_by)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (product_id, norm_code)
             DO UPDATE SET xref_code = EXCLUDED.xref_code, brand = EXCLUDED.brand
             RETURNING (xmax = 0) AS is_new`, [pid, cd.code, cd.norm, cd.brand, req.ctx.perm.userId]);
          if (r.rows[0] && r.rows[0].is_new) inserted++;
        }
      }
      return { rows: clean.length, matchedRows, inserted, unmatchedRows, unmatchedSample };
    });

    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: 'product_xref_codes',
      detail: { bulk: true, rows: out.rows, matched: out.matchedRows, inserted: out.inserted } });
    return out;
  });

  // ── 브랜드별 등록 현황 (디렉터) ──
  app.get('/api/products/xref/stats', { preHandler: [authGuard, requireDirector] }, async () => {
    const rows = (await query(
      `SELECT COALESCE(brand,'(미지정)') AS brand, COUNT(*) AS n, COUNT(DISTINCT product_id) AS products
         FROM product_xref_codes GROUP BY brand ORDER BY brand`)).rows;
    return { items: rows.map((r) => ({ brand: r.brand, codes: Number(r.n), products: Number(r.products) })) };
  });

  // ── 교차참조 삭제 (디렉터, 롤백/재업로드용) — body { brand } 없으면 전체 ──
  app.post('/api/products/xref/clear', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const brand = req.body && req.body.brand ? String(req.body.brand).trim() : null;
    const r = brand
      ? await query(`DELETE FROM product_xref_codes WHERE brand = $1`, [brand])
      : await query(`DELETE FROM product_xref_codes`);
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: 'product_xref_codes', detail: { brand: brand || 'ALL', deleted: r.rowCount } });
    return { deleted: r.rowCount };
  });
}
