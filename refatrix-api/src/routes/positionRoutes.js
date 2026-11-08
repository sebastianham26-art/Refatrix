// =====================================================================
// 0292 · 제품 장착 위치(앞/뒤 · 상/하 · 좌/우)
//   POST /api/products/positions/preview  (디렉터)  { file_name, rows:[{ctr, ctr4, block, position, part, brand, model, gen, years, status}] }
//        → 저장하지 않고 통계 · 예시 · 마스터에 없는 코드
//   POST /api/products/positions/commit   (디렉터)  같은 본문 → 전체 교체(새 배치 저장 · 예전 줄 삭제) 한 트랜잭션
//   POST /api/products/positions/lookup   (제품 화면) { codes:[…], detail:true|false } → 코드별 요약(+ 차종별 줄)
//        1108 · 우선순위 = CTR 확인값(products.mount_pos · 0323 · 플랫폼 확인완료) → 업로드 요약.
//        응답 항목 {blocks, levels, sides, ko, es, src:'erp'|'upload', upload:{…}|null, rows?}
//        — 제품 찾기(코드 검색 · 차종 검색) · VIO 화면이 모두 이 한 곳을 읽으므로 어디서나 같은 위치가 보인다.
//   GET  /api/products/positions/status   (제품 화면) 마지막 업로드 정보
//   POST /api/products/syd-names          (제품 화면) { codes:[SYD 코드…] } → SYD 리스트 품명(DESCRIPCIÓN · 0324) · 품목
//        가격은 주지 않는다(가격 권한과 무관하게 이름만). 프로모션 만들기 · 제품 찾기에서 CTR 코드 옆에 쓴다.
//   화면: 제품 마스터 업로드(올리기) · 제품 찾기(배지 · 내역) · VIO 제품찾기·프로모션(부품 목록)
// =====================================================================
import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { buildPositionRows, summarize, parsePosText, posText, koText } from '../productPositions.js';
import { sydNamesFor } from '../priceMaster.js';

const MAX_ROWS = 60000;
const BIG = { bodyLimit: 20 * 1024 * 1024 };

async function knownCodes() {
  return new Set((await query(`SELECT upper(code) AS c FROM products WHERE deleted_at IS NULL`)).rows.map((r) => r.c));
}
function readBody(req, reply) {
  const b = req.body || {};
  const rows = Array.isArray(b.rows) ? b.rows : null;
  if (!rows || !rows.length) { reply.code(400).send({ error: 'no_rows' }); return null; }
  if (rows.length > MAX_ROWS) { reply.code(400).send({ error: 'too_many_rows', max: MAX_ROWS }); return null; }
  return { rows, file_name: String(b.file_name || '').slice(0, 200) || null };
}

export default async function positionRoutes(app) {
  app.post('/api/products/positions/preview', { preHandler: [authGuard, requireDirector], ...BIG }, async (req, reply) => {
    const b = readBody(req, reply); if (!b) return;
    const { rows, stats } = buildPositionRows(b.rows, await knownCodes());
    if (!rows.length) return reply.code(400).send({ error: 'no_position_rows', stats, note: 'Block · Position · CTR 열을 확인하세요.' });
    const by = {}; for (const r of rows) (by[r.ctr_code] ||= []).push(r);
    const sample = Object.keys(by).slice(0, 12).map((c) => ({ code: c, ...summarize(by[c]), n: by[c].length }));
    const cur = (await query(`SELECT count(*)::int n, count(DISTINCT ctr_code)::int codes FROM product_positions`)).rows[0];
    return { dry_run: true, stats, sample, current: cur };
  });

  app.post('/api/products/positions/commit', { preHandler: [authGuard, requireDirector], ...BIG }, async (req, reply) => {
    const b = readBody(req, reply); if (!b) return;
    const { rows, stats } = buildPositionRows(b.rows, await knownCodes());
    if (!rows.length) return reply.code(400).send({ error: 'no_position_rows', stats });
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const batch = (await c.query(
        `INSERT INTO product_position_batches (file_name, rows_in, rows_saved, codes, codes_known, side_fixed, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, uploaded_at`,
        [b.file_name, stats.rows_in, stats.rows_saved, stats.codes, stats.codes_known, stats.side_fixed, userId])).rows[0];
      const removed = (await c.query(`DELETE FROM product_positions`)).rowCount;
      const col = (k) => rows.map((r) => r[k]);
      await c.query(
        `INSERT INTO product_positions (batch_id, ctr_code, block, level, side, side_fixed, pos_raw, part, brand, model, generation, years, y_from, y_to, status, src_col)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::boolean[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::int[], $14::int[], $15::text[], $16::text[])`,
        [batch.id, col('ctr_code'), col('block'), col('level'), col('side'), col('side_fixed'), col('pos_raw'), col('part'), col('brand'), col('model'),
          col('generation'), col('years'), col('y_from'), col('y_to'), col('status'), col('src_col')]);
      return { batch_id: Number(batch.id), uploaded_at: batch.uploaded_at, removed };
    });
    await logEvent({ userId, action: 'update', target: 'product_positions', detail: { batch: out.batch_id, file: b.file_name, rows: stats.rows_saved, codes: stats.codes, removed: out.removed } });
    return { ok: true, ...out, stats };
  });

  app.post('/api/products/positions/lookup', { preHandler: [authGuard, requirePage('products')] }, async (req, reply) => {
    const b = req.body || {};
    const codes = [...new Set((Array.isArray(b.codes) ? b.codes : []).map((c) => String(c || '').trim().toUpperCase()).filter(Boolean))].slice(0, 3000);
    if (!codes.length) return { items: {} };
    const rows = (await query(
      `SELECT ctr_code, block, level, side, side_fixed, pos_raw, part, brand, model, generation, years, y_from, y_to, status
         FROM product_positions WHERE ctr_code = ANY($1::text[])
        ORDER BY ctr_code, block, level NULLS FIRST, side NULLS FIRST, brand, model, y_from NULLS LAST`, [codes])).rows;
    const by = {}; for (const r of rows) (by[r.ctr_code] ||= []).push(r);
    // 1108 · CTR 확인값 — 0323 전(칸 없음)이면 업로드만 쓴다
    const own = {};
    try {
      const o = (await query(
        `SELECT upper(btrim(code)) AS c, btrim(mount_pos) AS v FROM products
          WHERE deleted_at IS NULL AND upper(btrim(code)) = ANY($1::text[]) AND COALESCE(btrim(mount_pos),'') <> ''`, [codes])).rows;
      for (const r of o) { const p = parsePosText(r.v); if (p && !p.error) own[r.c] = p; }
    } catch (_) { /* 0323 전 */ }
    const items = {};
    for (const c of new Set([...Object.keys(by), ...Object.keys(own)])) {
      const up = by[c] ? summarize(by[c]) : null;
      const upView = up ? { blocks: up.blocks, levels: up.levels, sides: up.sides, ko: up.ko, es: posText(up) } : null;
      const base = own[c] ? { ...own[c], ko: koText(own[c]), es: posText(own[c]), src: 'erp' } : { ...upView, src: 'upload' };
      items[c] = { ...base, upload: upView };
      if (b.detail) items[c].rows = (by[c] || []).map((r) => ({ block: r.block, level: r.level, side: r.side, fixed: r.side_fixed, pos: r.pos_raw, part: r.part,
        brand: r.brand, model: r.model, gen: r.generation, years: r.years, y_from: r.y_from, y_to: r.y_to, status: r.status }));
    }
    return { items };
  });

  app.post('/api/products/syd-names', { preHandler: [authGuard, requirePage('products')] }, async (req) => {
    const b = req.body || {};
    const codes = (Array.isArray(b.codes) ? b.codes : []).map((c) => String(c == null ? '' : c)).slice(0, 5000);
    try { return await sydNamesFor(codes); } catch (_) { return { list_date: null, items: {} }; }   // 0229 전 · 오류여도 화면은 이름 없이
  });

  app.get('/api/products/positions/status', { preHandler: [authGuard, requirePage('products')] }, async () => {
    try {
      const last = (await query(
        `SELECT b.id, b.file_name, b.rows_in, b.rows_saved, b.codes, b.codes_known, b.side_fixed, b.uploaded_at, u.name AS uploaded_by_name
           FROM product_position_batches b LEFT JOIN users u ON u.id = b.uploaded_by ORDER BY b.id DESC LIMIT 1`)).rows[0] || null;
      const cur = (await query(`SELECT count(*)::int n, count(DISTINCT ctr_code)::int codes FROM product_positions`)).rows[0];
      return { ready: true, last: last ? { ...last, id: Number(last.id) } : null, current: cur };
    } catch (_) { return { ready: false }; }   // 0292 전
  });
}
