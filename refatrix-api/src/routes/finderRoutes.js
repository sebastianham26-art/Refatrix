// build fdr-0713a — 경쟁사 제품검색(제품찾기) 백엔드
//   · /api/finder/search   : CTR·SYD·교차참조(BAW/GROB/VASLO/KYB/MOOG/YOKOMITSU…) 아무 코드로 제품 검색
//   · /api/finder/compare  : 코드+수량 목록 → CTR 매칭 일괄 비교(견적 비교용)
//   · 가격: CTR=products.list_price · SYD=products.list_price_syd · 경쟁사=product_xref_codes.list_price
//     (sale_price 권한자에게만 포함 — viofinder와 동일 기준)
//   · VIO: ctr_vio_rank(모델·연식·대수) + product_applications(모델·연식) 보조
import { query, withTx } from '../db.js';
import { authGuard, requirePage } from '../middleware/authGuard.js';
import { fieldVisible } from '../permissions.js';

const norm = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const escLike = (s) => s.replace(/([%_\\])/g, '\\$1');

export default async function finderRoutes(app) {
  // pids → 화면 번들(코드·브랜드별 코드/가격·VIO·적용차종)
  async function bundle(pids, canPrice, exec = query) {
    if (!pids.length) return [];
    const prows = (await exec(
      `SELECT id, code, name, app, list_price, list_price_syd
         FROM products WHERE id = ANY($1) AND deleted_at IS NULL`, [pids])).rows;
    if (!prows.length) return [];
    const ids = prows.map((r) => Number(r.id));
    const syd = (await exec(
      `SELECT product_id, syd_code FROM product_syd_codes WHERE product_id = ANY($1) ORDER BY syd_code`, [ids])).rows;
    const xref = (await exec(
      `SELECT product_id, xref_code, brand, list_price
         FROM product_xref_codes WHERE product_id = ANY($1) ORDER BY brand, xref_code`, [ids])).rows;
    const vio = (await exec(
      `SELECT p.id AS product_id, v.vio_model, v.vio_year, v.vio_units
         FROM ctr_vio_rank v JOIN products p ON p.code = v.ctr_code WHERE p.id = ANY($1)`, [ids])).rows;
    const apps = (await exec(
      `SELECT product_id, model, year_from, year_to
         FROM product_applications
        WHERE product_id = ANY($1) AND model IS NOT NULL AND model <> ''
        ORDER BY year_to DESC NULLS LAST`, [ids])).rows;

    const by = new Map(prows.map((p) => [Number(p.id), {
      id: Number(p.id), ctr: p.code, name: p.name, app: p.app || '',
      ctr_price: canPrice && p.list_price != null ? Number(p.list_price) : null,
      syd_price: canPrice && p.list_price_syd != null ? Number(p.list_price_syd) : null,
      syd_codes: [], brands: {}, brand_prices: {}, vio: []
    }]));
    for (const s of syd) { const b = by.get(Number(s.product_id)); if (b && b.syd_codes.length < 4) b.syd_codes.push(s.syd_code); }
    for (const x of xref) {
      const b = by.get(Number(x.product_id)); if (!b) continue;
      const brand = (x.brand || 'ETC').toUpperCase();
      const root = brand.replace(/[0-9]+$/, '');                 // SYD1→SYD, GROB2→GROB
      if (root === 'SYD') {                                       // 교차참조의 SYD 추가분 → SYD 코드 목록에 합류
        if (b.syd_codes.length < 4 && !b.syd_codes.some((c) => norm(c) === norm(x.xref_code))) b.syd_codes.push(x.xref_code);
      } else {
        (b.brands[root] = b.brands[root] || []);
        if (b.brands[root].length < 4 && !b.brands[root].some((c) => norm(c) === norm(x.xref_code))) b.brands[root].push(x.xref_code);
      }
      if (canPrice && x.list_price != null && b.brand_prices[root] == null) b.brand_prices[root] = Number(x.list_price);
    }
    for (const v of vio) {
      const b = by.get(Number(v.product_id)); if (!b) continue;
      b.vio.push({ model: v.vio_model || '', years: v.vio_year || '', units: v.vio_units != null ? Number(v.vio_units) : null });
    }
    for (const a of apps) {
      const b = by.get(Number(a.product_id)); if (!b || b.vio.length >= 3) continue;
      const years = a.year_from && a.year_to ? `${a.year_from}-${a.year_to}` : (a.year_from ? String(a.year_from) : '');
      if (b.vio.some((x) => x.model === a.model)) continue;
      b.vio.push({ model: a.model, years, units: null });
    }
    if (!canPrice) for (const b of by.values()) { b.brand_prices = {}; }
    return [...by.values()];
  }

  // ── 코드 검색 (부분일치, 정규화) ──
  app.get('/api/finder/search', { preHandler: [authGuard, requirePage('products')] }, async (req) => {
    const { perm } = req.ctx;
    const canPrice = fieldVisible(perm, 'sale_price');
    const nq = norm(req.query.q || '');
    const out = { q: String(req.query.q || ''), items: [], price_included: canPrice };
    if (nq.length < 2) return out;
    const like = '%' + escLike(nq) + '%';
    const pids = (await query(
      `SELECT DISTINCT pid FROM (
         SELECT p.id AS pid FROM products p
          WHERE p.deleted_at IS NULL
            AND regexp_replace(upper(p.code), '[^A-Z0-9]', '', 'g') LIKE $1
         UNION ALL
         SELECT s.product_id FROM product_syd_codes s
          WHERE regexp_replace(upper(s.syd_code), '[^A-Z0-9]', '', 'g') LIKE $1
         UNION ALL
         SELECT x.product_id FROM product_xref_codes x WHERE x.norm_code LIKE $1
       ) t LIMIT 30`, [like])).rows.map((r) => Number(r.pid));
    out.items = await bundle(pids, canPrice);
    out.items.sort((a, b) => a.ctr.localeCompare(b.ctr));
    return out;
  });

  // ── 코드+수량 일괄 비교 (엑셀 업로드) ──
  //  body { items: [ { code, qty } ] } 최대 1000건 · 수량: 쉼표 제거, 빈칸/0 이하 → 1
  app.post('/api/finder/compare', { preHandler: [authGuard, requirePage('products')] }, async (req, reply) => {
    const { perm } = req.ctx;
    const canPrice = fieldVisible(perm, 'sale_price');
    const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 1000) : [];
    if (!items.length) return reply.code(400).send({ error: 'no_items' });
    const clean = items.map((it) => {
      const code = String((it && it.code) || '').trim();
      let qty = 1;
      if (it && it.qty != null && it.qty !== '') {
        const n = Number(String(it.qty).replace(/[,\s]/g, ''));
        if (Number.isFinite(n) && n > 0) qty = n;
      }
      return { code, qty, norm: norm(code) };
    }).filter((it) => it.norm);
    if (!clean.length) return reply.code(400).send({ error: 'no_items' });

    const norms = [...new Set(clean.map((c) => c.norm))];
    const map = new Map();
    const rows = (await query(
      `SELECT norm, pid, pri FROM (
         SELECT regexp_replace(upper(p.code), '[^A-Z0-9]', '', 'g') AS norm, p.id AS pid, 1 AS pri
           FROM products p WHERE p.deleted_at IS NULL
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
    for (const r of rows) if (!map.has(r.norm)) map.set(r.norm, Number(r.pid));

    const pids = [...new Set([...map.values()])];
    const products = await bundle(pids, canPrice);
    const lines = clean.map((c) => ({ code: c.code, qty: c.qty, product_id: map.get(c.norm) || null }));
    return { lines, products, price_included: canPrice, matched: lines.filter((l) => l.product_id).length, unmatched: lines.filter((l) => !l.product_id).length };
  });
}
