import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { minimizeProduct } from '../permissions.js';
import { logPageView, logEvent } from '../audit.js';
import { buildHeaderIndex, parseRow, diffProduct, buildPreview, UPDATABLE_FIELDS, parseApplications } from '../productImport.js';

export default async function productRoutes(app) {
  // 제품 목록: 검색 + 페이징 (SKU ~5,000 대비, 한 번에 다 보내지 않음)
  // 민감 필드(원가·마진 등)는 권한 없으면 응답에서 제거(데이터 최소 전송).
  app.get('/api/products', { preHandler: [authGuard, requirePage('products')] }, async (req) => {
    const { perm } = req.ctx;
    const q = (req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const params = [];
    let where = 'deleted_at IS NULL';
    if (q) {
      params.push(`%${q}%`);
      where += ` AND (code ILIKE $${params.length} OR ean ILIKE $${params.length} OR name ILIKE $${params.length})`;
    }
    params.push(limit, offset);
    const rows = (await query(
      `SELECT id, code, scode, app, ean, name, list_price, discount, iva_rate, stock_qty, avg_cost
         FROM products WHERE ${where}
         ORDER BY code LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;

    await logPageView(perm.userId, 'products');
    // 각 행을 권한에 맞게 최소화
    return { items: rows.map((p) => minimizeProduct(perm, p)), limit, offset };
  });

  // 제품코드 여러 개로 한 번에 조회 (엑셀 업로드 매칭용).
  // body: { codes: ['CTR-1001', ...] }  → { found: {코드: {id,code,name}}, missing: [코드...] }
  app.post('/api/products/lookup', { preHandler: [authGuard, requirePage('products')] }, async (req) => {
    const codes = Array.isArray(req.body?.codes) ? req.body.codes.map((c) => String(c).trim()).filter(Boolean) : [];
    if (!codes.length) return { found: {}, missing: [] };
    const rows = (await query(
      `SELECT id, code, name FROM products WHERE deleted_at IS NULL AND code = ANY($1)`, [codes])).rows;
    const found = {};
    for (const r of rows) found[r.code] = { id: r.id, code: r.code, name: r.name };
    const missing = [...new Set(codes)].filter((c) => !found[c]);
    return { found, missing };
  });

  // ===== 제품 마스터 업로드 =====
  // 프런트에서 xlsx를 파싱해 rows(헤더 + 데이터 배열의 배열)를 보냄.
  // requireDirector: 마스터 업로드는 디렉터만.
  async function loadExistingByCodes(codes) {
    if (!codes.length) return {};
    const rows = (await query(
      `SELECT id, code, scode, app, name, sat_code, origin, list_price, iva_rate, ean, location,
              list_price_syd, price_customer_syd, price_customer_ctr, stock_qty, avg_cost
         FROM products WHERE deleted_at IS NULL AND code = ANY($1)`, [codes])).rows;
    const sydRows = rows.length ? (await query(
      `SELECT product_id, syd_code FROM product_syd_codes WHERE product_id = ANY($1)`,
      [rows.map((r) => r.id)])).rows : [];
    const sydByPid = {};
    for (const s of sydRows) (sydByPid[s.product_id] ||= []).push(s.syd_code);
    const appRows = rows.length ? (await query(
      `SELECT product_id, app_text FROM product_applications WHERE product_id = ANY($1)`,
      [rows.map((r) => r.id)])).rows : [];
    const appByPid = {};
    for (const a of appRows) (appByPid[a.product_id] ||= []).push(a.app_text);
    const byCode = {};
    for (const r of rows) byCode[r.code] = { ...r, syd_codes: sydByPid[r.id] || [], app_texts: appByPid[r.id] || [] };
    return byCode;
  }

  // 미리보기: 변경 없이 신규/변경/동일/오류만 계산
  app.post('/api/products/import/preview', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const { header, rows } = req.body || {};
    if (!Array.isArray(header) || !Array.isArray(rows)) return reply.code(400).send({ error: 'bad_payload' });
    const headerIdx = buildHeaderIndex(header);
    if (headerIdx.code == null) return reply.code(400).send({ error: 'no_code_column', detail: 'Clave CTR 컬럼을 찾을 수 없습니다.' });
    const parsed = rows.map((r) => parseRow(r, headerIdx)).filter(Boolean);
    const existing = await loadExistingByCodes([...new Set(parsed.map((p) => p.code))]);
    const preview = buildPreview(parsed, existing);
    return preview;
  });

  // 반영: 코드 기준 upsert(변경된 필드만), 재고·평균원가 보존, SyD 코드 재동기화.
  app.post('/api/products/import/commit', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const { header, rows } = req.body || {};
    if (!Array.isArray(header) || !Array.isArray(rows)) return reply.code(400).send({ error: 'bad_payload' });
    const headerIdx = buildHeaderIndex(header);
    if (headerIdx.code == null) return reply.code(400).send({ error: 'no_code_column' });
    const parsed = rows.map((r) => parseRow(r, headerIdx)).filter(Boolean);
    const existing = await loadExistingByCodes([...new Set(parsed.map((p) => p.code))]);
    const userId = req.ctx.perm.userId;
    let created = 0, updated = 0, unchanged = 0, skipped = 0;
    const seen = new Set();

    const result = await withTx(async (c) => {
      for (const p of parsed) {
        if (seen.has(p.code)) { skipped++; continue; }
        seen.add(p.code);
        if (!p.name) { skipped++; continue; }
        const ex = existing[p.code];
        const d = diffProduct(p, ex);
        if (d.isNew) {
          // 신규: 파일에 있는 필드만 입력, 재고·원가 0(기본값)
          const cols = ['code']; const vals = [p.code]; const ph = ['$1'];
          for (const f of UPDATABLE_FIELDS) if (f in p) { vals.push(p[f]); cols.push(f); ph.push(`$${vals.length}`); }
          vals.push(userId);
          const r = (await c.query(
            `INSERT INTO products (${cols.join(',')}, created_by) VALUES (${ph.join(',')}, $${vals.length}) RETURNING id`, vals)).rows[0];
          await syncSyd(c, r.id, p.syd_codes);
          await syncApp(c, r.id, p.applications);
          created++;
        } else {
          const chFields = Object.keys(d.changes);
          if (chFields.length === 0 && !d.syd_changed) { unchanged++; continue; }
          if (chFields.length > 0) {
            const sets = []; const vals = [];
            for (const f of chFields) { vals.push(p[f]); sets.push(`${f}=$${vals.length}`); }
            vals.push(userId); sets.push(`updated_by=$${vals.length}`);
            vals.push(ex.id);
            await c.query(`UPDATE products SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
          }
          if (d.syd_changed) await syncSyd(c, ex.id, p.syd_codes);
          if (d.app_changed) await syncApp(c, ex.id, p.applications);
          updated++;
        }
      }
      return { ok: true };
    });

    async function syncSyd(c, productId, codes) {
      await c.query(`DELETE FROM product_syd_codes WHERE product_id=$1`, [productId]);
      const uniq = [...new Set(codes.map(String))].filter(Boolean);
      for (const sc of uniq) {
        await c.query(`INSERT INTO product_syd_codes (product_id, syd_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [productId, sc]);
      }
    }

    async function syncApp(c, productId, applications) {
      await c.query(`DELETE FROM product_applications WHERE product_id=$1`, [productId]);
      for (const a of (applications || [])) {
        await c.query(
          `INSERT INTO product_applications (product_id, app_text, maker, model, year_from, year_to) VALUES ($1,$2,$3,$4,$5,$6)`,
          [productId, a.app_text, a.maker, a.model, a.year_from, a.year_to]);
      }
    }

    await logEvent({ userId, action: 'create', target: 'product_import', detail: { created, updated, unchanged, skipped } });
    return { ok: true, created, updated, unchanged, skipped };
  });

  // SyD(경쟁사) 코드로 CTR 제품 역검색 (적용차종 포함)
  app.get('/api/products/by-syd', { preHandler: [authGuard, requirePage('products')] }, async (req) => {
    const code = String(req.query.code || '').trim();
    if (!code) return { items: [] };
    const rows = (await query(
      `SELECT p.id, p.code, p.name, p.scode, p.app, s.syd_code
         FROM product_syd_codes s JOIN products p ON p.id=s.product_id AND p.deleted_at IS NULL
        WHERE s.syd_code = $1`, [code])).rows;
    return { items: rows };
  });

  // 차종(메이커/모델/연식)으로 부품 역검색
  // q: 모델/원문 텍스트, maker: 메이커, year: 해당 연식 포함 차종
  app.get('/api/products/by-vehicle', { preHandler: [authGuard, requirePage('products')] }, async (req) => {
    const q = String(req.query.q || '').trim();
    const maker = String(req.query.maker || '').trim();
    const year = req.query.year ? Number(req.query.year) : null;
    if (!q && !maker && !year) return { items: [] };
    const conds = ['p.deleted_at IS NULL']; const params = [];
    if (q) { params.push(`%${q}%`); conds.push(`(a.app_text ILIKE $${params.length} OR a.model ILIKE $${params.length})`); }
    if (maker) { params.push(`%${maker}%`); conds.push(`a.maker ILIKE $${params.length}`); }
    if (year != null && Number.isFinite(year)) { params.push(year); conds.push(`(a.year_from IS NULL OR a.year_from <= $${params.length}) AND (a.year_to IS NULL OR a.year_to >= $${params.length})`); }
    const rows = (await query(
      `SELECT p.id, p.code, p.name, p.scode, a.app_text, a.maker, a.model, a.year_from, a.year_to
         FROM product_applications a JOIN products p ON p.id=a.product_id
        WHERE ${conds.join(' AND ')}
        ORDER BY p.code, a.year_from
        LIMIT 200`, params)).rows;
    return { items: rows };
  });
}

