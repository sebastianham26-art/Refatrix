import { query } from '../db.js';
import { authGuard, requirePage } from '../middleware/authGuard.js';
import { minimizeProduct } from '../permissions.js';
import { logPageView } from '../audit.js';

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
}
