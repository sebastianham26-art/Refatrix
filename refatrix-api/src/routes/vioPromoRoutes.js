// =====================================================================
// 0293 · VIO 프로모션(키트) — 번호 K0001… · 부품별 수량 · 정가 합계 · 할인 · 키트 제품
//   GET   /api/vio-promos              목록 (제품 화면)         ?q=&limit=
//   GET   /api/vio-promos/:id          한 건
//   POST  /api/vio-promos              저장 = 번호 받기 (제품 화면 「수정」)
//   PATCH /api/vio-promos/:id          고치기 — 키트 제품을 만든 뒤에는 품목·수량은 잠김
//   POST  /api/vio-promos/:id/kit      키트 제품 만들기 (디렉터 · 0294 kit_create 권한) — 제품 마스터에 코드 = 번호
//   금액(정가·할인 금액)은 판매가 열람 권한(sale_price)이 있는 사람에게만 보낸다.
// =====================================================================
import { query, withTx } from '../db.js';
import { authGuard, requirePage, requirePageEdit, requireDirector } from '../middleware/authGuard.js';
import { fieldVisible } from '../permissions.js';
import { logEvent } from '../audit.js';
import { recordPriceChange } from '../priceMaster.js';
import { promoNo, promoTotals, kitName, kitBuildable, setPromosReady } from '../vioPromos.js';
import { r2Config, r2Put, r2Why } from '../r2.js';   // 10-23 · 키트 사진 → R2 products/K0001/K0001_1.webp

const MAX_ITEMS = 40;
const str = (v, n) => { const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return s ? s.slice(0, n) : null; };
const ERR = { migration_required: 'npm run migrate (0293) 를 먼저 실행하세요.' };

async function ready() {
  try { const ok = !!(await query(`SELECT to_regclass('vio_promos') AS t`)).rows[0].t; if (ok) setPromosReady(true); return ok; } catch (_) { return false; }
}

/** 본문 items:[{code, qty}] → 제품 마스터에서 확인한 줄(코드 중복은 수량 합침) */
async function resolveItems(raw) {
  const want = new Map();
  for (const it of Array.isArray(raw) ? raw : []) {
    const c = String(it && (it.code || it.ctr_code) || '').trim().toUpperCase(); const q = Math.floor(Number(it && it.qty) || 0);
    if (!c || q <= 0) continue;
    want.set(c, (want.get(c) || 0) + Math.min(q, 9999));
  }
  if (!want.size) return { error: 'no_items' };
  if (want.size > MAX_ITEMS) return { error: 'too_many_items', max: MAX_ITEMS };
  const rows = (await query(
    `SELECT id, upper(code) AS code, name, list_price FROM products WHERE deleted_at IS NULL AND upper(code) = ANY($1::text[])`, [[...want.keys()]])).rows;
  const by = new Map(rows.map((r) => [r.code, r]));
  const missing = [...want.keys()].filter((c) => !by.has(c));
  if (missing.length) return { error: 'unknown_codes', codes: missing };
  if ([...want.keys()].some((c) => /^K\d{4,}$/.test(c))) return { error: 'kit_in_kit' };
  return { items: [...want.entries()].map(([c, q], i) => ({ line_no: i + 1, product_id: Number(by.get(c).id), ctr_code: c, name: by.get(c).name, qty: q, list_price: by.get(c).list_price == null ? null : Number(by.get(c).list_price) })) };
}

async function loadPromos(where, params, perm, limit = 200) {
  const canPrice = fieldVisible(perm, 'sale_price');
  const ps = (await query(
    `SELECT v.*, uc.name AS created_by_name, p.code AS kit_code, p.name AS kit_product_name, p.list_price AS kit_list_price
       FROM vio_promos v
       LEFT JOIN users uc ON uc.id = v.created_by
       LEFT JOIN products p ON p.id = v.product_id AND p.deleted_at IS NULL
      ${where}
      ORDER BY v.id DESC LIMIT ${Number(limit) || 200}`, params)).rows;
  if (!ps.length) return [];
  const items = (await query(
    `SELECT i.promo_id, i.line_no, i.product_id, i.ctr_code, i.name, i.qty, i.list_price, p.list_price AS cur_price, p.stock_qty
       FROM vio_promo_items i LEFT JOIN products p ON p.id = i.product_id
      WHERE i.promo_id = ANY($1::bigint[]) ORDER BY i.promo_id, i.line_no`, [ps.map((p) => p.id)])).rows;
  const by = {}; for (const it of items) (by[it.promo_id] ||= []).push(it);
  return ps.map((v) => {
    const its = by[v.id] || [];
    const o = {
      id: Number(v.id), promo_no: v.promo_no, model_key: v.model_key, title: v.title, years: v.years,
      discount_pct: Number(v.discount_pct), show_totals: v.show_totals, kit_name: v.kit_name,
      product_id: v.product_id ? Number(v.product_id) : null, kit_code: v.kit_code || null,
      image_id: v.image_id ? Number(v.image_id) : null, status: v.status, memo: v.memo,
      created_by: v.created_by ? Number(v.created_by) : null, created_by_name: v.created_by_name, created_at: v.created_at, updated_at: v.updated_at,
      buildable: kitBuildable(its),
      // 0301 · 디자인(다시 열면 그대로)
      design: v.design || null,
      veh_url: v.veh_key ? r2Config().publicBase + '/' + v.veh_key : null,
      bg_url: v.bg_key ? r2Config().publicBase + '/' + v.bg_key : null,
      items: its.map((it) => ({ line_no: it.line_no, product_id: Number(it.product_id), ctr_code: it.ctr_code, name: it.name, qty: Number(it.qty), stock: Number(it.stock_qty) || 0,
        ...(canPrice ? { list_price: it.list_price == null ? null : Number(it.list_price), cur_price: it.cur_price == null ? null : Number(it.cur_price) } : {}) })),
      price_included: canPrice,
    };
    if (canPrice) {
      o.total_list = Number(v.total_list); o.total_promo = Number(v.total_promo); o.discount_amt = Math.round((o.total_list - o.total_promo) * 100) / 100;
      o.kit_list_price = v.kit_list_price == null ? null : Number(v.kit_list_price);
    }
    return o;
  });
}

function readHead(b) {
  const disc = Number(b.discount_pct);
  return {
    model_key: str(b.model_key, 120), model: str(b.model, 80), title: str(b.title, 120), years: str(b.years, 30),
    discount_pct: Number.isFinite(disc) ? Math.min(99.99, Math.max(0, disc)) : 0, show_totals: !!b.show_totals,
    image_id: b.image_id ? Number(b.image_id) || null : null, memo: str(b.memo, 500), kit_name: str(b.kit_name, 250),
  };
}

export default async function vioPromoRoutes(app) {
  const R = { preHandler: [authGuard, requirePage('products')] };
  const W = { preHandler: [authGuard, requirePageEdit('products')] };
  // 0294 · 키트 제품 등록·키트 사진 = 디렉터 또는 「🧰 키트 등록」(kit_create) 권한을 받은 사람(제품 화면 수정 권한도 필요)
  const canKit = (perm) => fieldVisible(perm, 'kit_create');
  const requireKit = async (req, reply) => { if (!canKit(req.ctx.perm)) return reply.code(403).send({ error: 'kit_permission', note: '키트 제품 등록 권한이 없습니다 — 디렉터에게 관리 › 사용자·권한 「🧰 키트 등록」을 요청하세요.' }); };
  const K = { preHandler: [authGuard, requirePageEdit('products'), requireKit] };

  app.get('/api/vio-promos', R, async (req, reply) => {
    if (!(await ready())) return { ready: false, items: [] };
    const q = String(req.query.q || '').trim();
    const params = []; let where = '';
    if (q) {
      params.push('%' + q + '%');
      where = `WHERE v.promo_no ILIKE $1 OR v.title ILIKE $1 OR v.years ILIKE $1 OR p.code ILIKE $1
               OR EXISTS (SELECT 1 FROM vio_promo_items i WHERE i.promo_id = v.id AND i.ctr_code ILIKE $1)`;
    }
    return { ready: true, can_kit: canKit(req.ctx.perm), items: await loadPromos(where, params, req.ctx.perm, Math.min(500, Number(req.query.limit) || 200)) };
  });

  app.get('/api/vio-promos/:id', R, async (req, reply) => {
    if (!(await ready())) return reply.code(503).send({ error: 'migration_required', note: ERR.migration_required });
    const key = String(req.params.id);
    const [p] = await loadPromos(/^\d+$/.test(key) ? `WHERE v.id = $1` : `WHERE upper(v.promo_no) = upper($1)`, [key], req.ctx.perm, 1);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    return p;
  });

  app.post('/api/vio-promos', W, async (req, reply) => {
    if (!(await ready())) return reply.code(503).send({ error: 'migration_required', note: ERR.migration_required });
    const b = req.body || {}; const h = readHead(b);
    if (!h.title) return reply.code(400).send({ error: 'title_required' });
    const r = await resolveItems(b.items);
    if (r.error) return reply.code(400).send(r);
    const t = promoTotals(r.items, h.discount_pct);
    const name = h.kit_name || kitName({ model: h.model, title: h.title, years: h.years, items: r.items });
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const n = (await c.query(`SELECT nextval('vio_promo_no_seq') AS n`)).rows[0].n;
      const v = (await c.query(
        `INSERT INTO vio_promos (promo_no, model_key, title, years, discount_pct, show_totals, total_list, total_promo, kit_name, image_id, memo, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id, promo_no`,
        [promoNo(n), h.model_key, h.title, h.years, t.discount_pct, h.show_totals, t.total_list, t.total_promo, name, h.image_id, h.memo, userId])).rows[0];
      await insertItems(c, v.id, r.items);
      return v;
    });
    await logEvent({ userId, action: 'create', target: 'vio_promo:' + out.id, detail: { promo_no: out.promo_no, items: r.items.length, total_list: t.total_list } });
    const [p] = await loadPromos(`WHERE v.id = $1`, [out.id], req.ctx.perm, 1);
    return p;
  });

  app.patch('/api/vio-promos/:id', W, async (req, reply) => {
    if (!(await ready())) return reply.code(503).send({ error: 'migration_required', note: ERR.migration_required });
    const id = Number(req.params.id); const b = req.body || {}; const perm = req.ctx.perm;
    const cur = (await query(`SELECT * FROM vio_promos WHERE id = $1`, [id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (perm.role !== 'director' && Number(cur.created_by) !== Number(perm.userId)) return reply.code(403).send({ error: 'not_owner' });
    const set = {}; const h = readHead({ ...cur, ...b, model_key: b.model_key ?? cur.model_key });
    for (const k of ['title', 'years', 'discount_pct', 'show_totals', 'image_id', 'memo', 'kit_name']) if (b[k] !== undefined) set[k] = h[k];
    if (b.status !== undefined) { if (!['active', 'closed'].includes(b.status)) return reply.code(400).send({ error: 'bad_status' }); set.status = b.status; }
    let items = null;
    if (b.items !== undefined) {
      if (cur.product_id) return reply.code(409).send({ error: 'kit_exists', note: '키트 제품을 만든 뒤에는 품목·수량을 바꿀 수 없습니다. 새 프로모션으로 저장하세요.' });
      const r = await resolveItems(b.items); if (r.error) return reply.code(400).send(r); items = r.items;
    }
    if (cur.product_id) delete set.kit_name;   // 키트를 만든 뒤 이름은 제품 마스터에서 고친다
    await withTx(async (c) => {
      if (items) { await c.query(`DELETE FROM vio_promo_items WHERE promo_id = $1`, [id]); await insertItems(c, id, items); }
      const its = items || (await c.query(`SELECT qty, list_price FROM vio_promo_items WHERE promo_id = $1`, [id])).rows;
      const t = promoTotals(its, set.discount_pct !== undefined ? set.discount_pct : cur.discount_pct);
      set.total_list = t.total_list; set.total_promo = t.total_promo;
      if (items && b.kit_name === undefined && !cur.product_id) set.kit_name = kitName({ model: b.model, title: set.title || cur.title, years: set.years !== undefined ? set.years : cur.years, items });
      const keys = Object.keys(set); const vals = keys.map((k) => set[k]);
      await c.query(`UPDATE vio_promos SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_by = $${keys.length + 2}, updated_at = now() WHERE id = $1`, [id, ...vals, perm.userId]);
    });
    await logEvent({ userId: perm.userId, action: 'update', target: 'vio_promo:' + id, detail: { fields: Object.keys(set), items: items ? items.length : undefined } });
    const [p] = await loadPromos(`WHERE v.id = $1`, [id], perm, 1);
    return p;
  });

  // 10-23 · 삭제 — 키트 제품이 제품 카탈로그(제품 마스터)에 아직 없을 때만. 만든 사람 또는 디렉터.
  //   번호는 다시 쓰지 않는다(연번 시퀀스 그대로) — 이미지·WhatsApp 에 나간 번호와 겹치지 않게.
  // 10-23 · 키트 사진(구성품 사진을 화면에서 한 장으로 합친 것) → R2 products/{키트코드}/{키트코드}_1.webp
  //   키트 코드 폴더(K + 숫자)에만 쓴다 — 기존 제품 사진은 건드리지 않는다. 디렉터 또는 kit_create 권한(키트 제품 등록과 같은 규칙).
  app.get('/api/vio-promos/r2-status', R, async () => { const c = r2Config(); return { ready: c.ready, missing: c.missing, public_base: c.publicBase }; });
  /**
   * 10-23 · R2 점검 — 작은 파일을 올려 보고(쓰기), 공개 주소로 다시 읽어 본다(읽기).
   *   키트 사진이 저장되지 않을 때 어디가 막혔는지 한 번에 본다. 사진은 건드리지 않는다.
   */
  app.post('/api/vio-promos/r2-check', K, async () => {
    const c = r2Config();
    const out = { config: { ready: c.ready, missing: c.missing, bucket: c.bucket ? '설정됨' : '(없음)',
      account: c.account ? c.account.slice(0, 6) + '…' : '(없음)', public_base: c.publicBase } };
    const key = 'products/_diag/r2_check.txt';
    const cuerpo = Buffer.from('refatrix r2 check ' + new Date().toISOString());
    const put = await r2Put(key, cuerpo, { contentType: 'text/plain' });
    out.escritura = { ok: !!put.ok, status: put.status || null, error: put.error || null, why: put.ok ? '' : r2Why(put) };
    if (put.ok) {
      try {
        const res = await fetch(put.url + '?t=' + Date.now(), { signal: AbortSignal.timeout(10000) });
        out.lectura = { ok: res.ok, status: res.status, url: put.url,
          why: res.ok ? '' : '올리기는 됐지만 공개 주소로 읽히지 않습니다 — 버킷의 공개 접근(r2.dev) 또는 R2_PUBLIC_BASE 를 확인하세요.' };
      } catch (e) { out.lectura = { ok: false, status: null, url: put.url, why: '공개 주소에 닿지 못했습니다: ' + String(e && e.message || e).slice(0, 120) }; }
    }
    out.ok = !!(put.ok && out.lectura && out.lectura.ok);
    return out;
  });

  const IMG_MIME = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpeg' };
  app.post('/api/vio-promos/:id/kit-image', { ...K, bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    if (!(await ready())) return reply.code(503).send({ error: 'migration_required', note: ERR.migration_required });
    const id = Number(req.params.id); const b = req.body || {};
    const cur = (await query(
      `SELECT v.id, v.promo_no, p.code AS kit_code FROM vio_promos v LEFT JOIN products p ON p.id = v.product_id AND p.deleted_at IS NULL WHERE v.id = $1`, [id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (!cur.kit_code) return reply.code(409).send({ error: 'no_kit_product', note: '먼저 키트 제품을 만드세요.' });
    if (!/^K\d{4,}$/.test(cur.kit_code)) return reply.code(409).send({ error: 'not_kit_code', note: '키트 코드(K숫자)에만 사진을 씁니다.' });
    const m = /^data:(image\/[a-z]+);base64,(.+)$/s.exec(String(b.image_b64 || ''));
    const mime = m ? m[1] : String(b.mime || '');
    if (!IMG_MIME[mime]) return reply.code(415).send({ error: 'bad_image_type' });
    const buf = Buffer.from(m ? m[2] : String(b.image_b64 || ''), 'base64');
    if (buf.length < 200) return reply.code(400).send({ error: 'image_required' });
    if (buf.length > 5 * 1024 * 1024) return reply.code(413).send({ error: 'image_too_large' });
    const sig = { webp: [0x52, 0x49, 0x46, 0x46], png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff] }[IMG_MIME[mime]];
    if (!sig.every((x, i) => buf[i] === x)) return reply.code(415).send({ error: 'bad_image_type', note: '이미지 내용이 형식과 다릅니다.' });
    const key = `products/${cur.kit_code}/${cur.kit_code}_1.webp`;   // 확장자는 기존 사진 규칙 그대로(내용 형식은 Content-Type 으로)
    const r = await r2Put(key, buf, { contentType: mime });
    if (!r.ok) {
      const code = r.error === 'r2_not_configured' ? 503 : 502;
      const why = r2Why(r);
      try { console.error('[r2] 키트 사진 저장 실패', cur.kit_code, r.error, r.status || '', String(r.detail || '').slice(0, 300)); } catch (_) {}
      await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: 'vio_kit_image_fail:' + cur.kit_code,
        detail: { promo: id, error: r.error, status: r.status || null, why } });
      return reply.code(code).send({ ...r, why, note: 'R2 저장 실패 — ' + (why || r.error) });
    }
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: 'vio_kit_image:' + cur.kit_code, detail: { promo: id, key, bytes: buf.length, mime } });
    return { ok: true, code: cur.kit_code, key, url: r.url, bytes: buf.length };
  });

  app.delete('/api/vio-promos/:id', W, async (req, reply) => {
    if (!(await ready())) return reply.code(503).send({ error: 'migration_required', note: ERR.migration_required });
    const id = Number(req.params.id); const perm = req.ctx.perm;
    const cur = (await query(
      `SELECT v.id, v.promo_no, v.created_by, v.product_id, p.code AS kit_code
         FROM vio_promos v LEFT JOIN products p ON p.id = v.product_id AND p.deleted_at IS NULL
        WHERE v.id = $1`, [id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (perm.role !== 'director' && Number(cur.created_by) !== Number(perm.userId)) return reply.code(403).send({ error: 'not_owner' });
    if (cur.kit_code) return reply.code(409).send({ error: 'kit_exists', kit_code: cur.kit_code, note: `키트 제품 ${cur.kit_code} 이(가) 제품 카탈로그에 등록돼 있어 삭제할 수 없습니다.` });
    const n = (await query(`SELECT count(*)::int n FROM vio_promo_items WHERE promo_id = $1`, [id])).rows[0].n;
    await query(`DELETE FROM vio_promos WHERE id = $1 AND (product_id IS NULL OR NOT EXISTS (SELECT 1 FROM products p WHERE p.id = vio_promos.product_id AND p.deleted_at IS NULL))`, [id]);
    await logEvent({ userId: perm.userId, action: 'delete', target: 'vio_promo:' + id, detail: { promo_no: cur.promo_no, items: n } });
    return { ok: true, id, promo_no: cur.promo_no };
  });

  // 0301 · 디자인 저장 — 만든 사람 또는 디렉터. 화면이 바뀔 때마다 조용히(1.5초 모아서) 부른다.
  async function ownPromo(req, reply) {
    if (!(await ready())) { reply.code(503).send({ error: 'migration_required', note: ERR.migration_required }); return null; }
    const id = Number(req.params.id); const perm = req.ctx.perm;
    const cur = (await query(`SELECT id, promo_no, created_by FROM vio_promos WHERE id = $1`, [id])).rows[0];
    if (!cur) { reply.code(404).send({ error: 'not_found' }); return null; }
    if (perm.role !== 'director' && Number(cur.created_by) !== Number(perm.userId)) { reply.code(403).send({ error: 'not_owner' }); return null; }
    return cur;
  }
  app.put('/api/vio-promos/:id/design', { ...W, bodyLimit: 256 * 1024 }, async (req, reply) => {
    const cur = await ownPromo(req, reply); if (!cur) return;
    const d = req.body && req.body.design;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return reply.code(400).send({ error: 'design_required' });
    const txt = JSON.stringify(d);
    if (txt.length > 60000) return reply.code(413).send({ error: 'design_too_large' });
    const set = ['design = $2::jsonb']; const vals = [cur.id, txt];
    if (req.body.veh_key === null) set.push('veh_key = NULL');   // 위키 사진으로 바꾸면 저장한 차량 사진은 안 씀
    if (req.body.bg_key === null) set.push('bg_key = NULL');
    try { await query(`UPDATE vio_promos SET ${set.join(', ')}, updated_at = now() WHERE id = $1`, vals); }
    catch (e) { if (/design|veh_key|bg_key/.test(String(e.message))) return reply.code(503).send({ error: 'migration_required', note: 'npm run migrate (0301) 를 먼저 실행하세요.' }); throw e; }
    return { ok: true };
  });
  // 0301 · 차량 사진(내 사진 · 누끼) / B 배경 → R2 vio-promos/{번호}/{veh|bg}-{시각}.{png|webp|jpg}
  app.post('/api/vio-promos/:id/asset', { ...W, bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const cur = await ownPromo(req, reply); if (!cur) return;
    const b = req.body || {}; const kind = b.kind === 'bg' ? 'bg' : (b.kind === 'veh' ? 'veh' : null);
    if (!kind) return reply.code(400).send({ error: 'bad_kind' });
    const m = /^data:(image\/(png|webp|jpeg));base64,(.+)$/s.exec(String(b.image_b64 || ''));
    if (!m) return reply.code(415).send({ error: 'bad_image_type' });
    const buf = Buffer.from(m[3], 'base64');
    if (buf.length < 100) return reply.code(400).send({ error: 'image_required' });
    if (buf.length > 8 * 1024 * 1024) return reply.code(413).send({ error: 'image_too_large' });
    const sig = { webp: [0x52, 0x49, 0x46, 0x46], png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff] }[m[2]];
    if (!sig.every((x, i) => buf[i] === x)) return reply.code(415).send({ error: 'bad_image_type' });
    const key = `vio-promos/${cur.promo_no}/${kind}-${Date.now()}.${m[2] === 'jpeg' ? 'jpg' : m[2]}`;
    const r = await r2Put(key, buf, { contentType: m[1], cacheControl: 'public, max-age=31536000, immutable' });
    if (!r.ok) return reply.code(r.error === 'r2_not_configured' ? 503 : 502).send({ ...r, why: r2Why(r) });
    try { await query(`UPDATE vio_promos SET ${kind === 'veh' ? 'veh_key' : 'bg_key'} = $2, updated_at = now() WHERE id = $1`, [cur.id, key]); }
    catch (e) { return reply.code(503).send({ error: 'migration_required', note: 'npm run migrate (0301) 를 먼저 실행하세요.' }); }
    return { ok: true, key, url: r.url, bytes: buf.length };
  });

  app.post('/api/vio-promos/:id/kit', K, async (req, reply) => {
    if (!(await ready())) return reply.code(503).send({ error: 'migration_required', note: ERR.migration_required });
    const id = Number(req.params.id); const userId = req.ctx.perm.userId;
    const cur = (await query(`SELECT * FROM vio_promos WHERE id = $1`, [id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (cur.product_id) return reply.code(409).send({ error: 'kit_exists', product_id: Number(cur.product_id) });
    const its = (await query(
      `SELECT i.*, p.id AS pid, p.list_price AS cur_price, p.deleted_at FROM vio_promo_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.promo_id = $1 ORDER BY line_no`, [id])).rows;
    if (!its.length) return reply.code(400).send({ error: 'no_items' });
    const gone = its.filter((x) => !x.pid || x.deleted_at).map((x) => x.ctr_code);
    if (gone.length) return reply.code(409).send({ error: 'item_deleted', codes: gone });
    const noPrice = its.filter((x) => !(Number(x.cur_price) > 0)).map((x) => x.ctr_code);
    if (noPrice.length) return reply.code(409).send({ error: 'item_no_price', codes: noPrice, note: '정가가 없는 부품이 있어 키트 정가를 정할 수 없습니다.' });
    // 정가 합계 = 지금 부품 정가 × 수량 (디렉터 결정: 키트 List price = 정가 합계)
    const t = promoTotals(its.map((x) => ({ qty: x.qty, list_price: x.cur_price })), cur.discount_pct);
    const name = str(req.body && req.body.name, 250) || cur.kit_name || kitName({ title: cur.title, years: cur.years, items: its });
    const code = cur.promo_no;
    const dup = (await query(`SELECT id FROM products WHERE upper(code) = upper($1)`, [code])).rows[0];
    if (dup) return reply.code(409).send({ error: 'code_exists', note: `제품코드 ${code} 가 이미 있습니다.` });
    const app_text = [cur.title, cur.years].filter(Boolean).join(' ');
    const out = await withTx(async (c) => {
      const p = (await c.query(
        `INSERT INTO products (code, name, app, list_price, iva_rate, created_by, updated_by) VALUES ($1,$2,$3,$4,16,$5,$5) RETURNING id`,
        [code, name, app_text || null, t.total_list, userId])).rows[0];
      await c.query(`UPDATE vio_promos SET product_id = $2, kit_name = $3, total_list = $4, total_promo = $5, updated_by = $6, updated_at = now() WHERE id = $1`,
        [id, p.id, name, t.total_list, t.total_promo, userId]);
      await c.query(`UPDATE vio_promo_items i SET list_price = p.list_price FROM products p WHERE p.id = i.product_id AND i.promo_id = $1`, [id]);
      await recordPriceChange(c, { productId: Number(p.id), oldPrice: null, newPrice: t.total_list, source: 'manual', userId });
      try {
        await c.query('SAVEPOINT kit_log');
        await c.query(`INSERT INTO product_change_log (product_id, code, action, source, changes, changed_by) VALUES ($1,$2,'create','vio_kit',$3,$4)`,
          [p.id, code, JSON.stringify({ name: { from: null, to: name }, list_price: { from: null, to: t.total_list }, kit: { from: null, to: its.map((x) => x.ctr_code + (x.qty > 1 ? 'x' + x.qty : '')).join(' + ') } }), userId]);
      } catch (_) { await c.query('ROLLBACK TO SAVEPOINT kit_log'); }
      return p;
    });
    await logEvent({ userId, action: 'create', target: 'product_vio_kit', detail: { code, name, promo: id, list_price: t.total_list } });
    const [pv] = await loadPromos(`WHERE v.id = $1`, [id], req.ctx.perm, 1);
    return { ok: true, product_id: Number(out.id), code, name, list_price: t.total_list, promo: pv };
  });
}

async function insertItems(c, promoId, items) {
  const col = (k) => items.map((x) => x[k]);
  await c.query(
    `INSERT INTO vio_promo_items (promo_id, line_no, product_id, ctr_code, name, qty, list_price)
     SELECT $1, * FROM unnest($2::int[], $3::bigint[], $4::text[], $5::text[], $6::int[], $7::numeric[])`,
    [promoId, col('line_no'), col('product_id'), col('ctr_code'), col('name'), col('qty'), col('list_price')]);
}
