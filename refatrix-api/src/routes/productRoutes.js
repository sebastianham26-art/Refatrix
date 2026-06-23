import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { minimizeProduct, fieldVisible } from '../permissions.js';
import { logPageView, logEvent } from '../audit.js';
import { buildHeaderIndex, parseRow, diffProduct, buildPreview, UPDATABLE_FIELDS, parseApplications, splitSyd } from '../productImport.js';

export default async function productRoutes(app) {
  // 제품 목록: 검색 + 페이징 (SKU ~5,000 대비, 한 번에 다 보내지 않음)
  // 민감 필드(원가·마진 등)는 권한 없으면 응답에서 제거(데이터 최소 전송).
  app.get('/api/products', { preHandler: [authGuard, requirePage('products')] }, async (req) => {
    const { perm } = req.ctx;
    const q = (req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    // 정렬: 헤더 클릭 정렬(서버측, 전체 데이터 기준 — 현재 페이지만이 아님).
    //   stock=재고, sold=누적판매수량, avgcost=평균원가, stockval=재고 평가액, code=코드(기본).
    //   원가 기반 정렬(avgcost·stockval)은 unit_cost 권한이 있을 때만 허용(없으면 코드 정렬로 폴백).
    const dir = String(req.query.dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const canCost = fieldVisible(perm, 'unit_cost');
    const SORTS = {
      stock:    `p.stock_qty ${dir} NULLS LAST, p.code`,
      sold:     `COALESCE(sold.qty,0) ${dir}, p.code`,
      avgcost:  canCost ? `p.avg_cost ${dir} NULLS LAST, p.code` : null,
      stockval: canCost ? `(p.stock_qty * COALESCE(p.avg_cost,0)) ${dir}, p.code` : null,
    };
    const sortKey = String(req.query.sort || '').toLowerCase();
    const orderBy = SORTS[sortKey] || 'p.code ASC';

    const params = [];
    let where = 'p.deleted_at IS NULL';
    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      where += ` AND (p.code ILIKE $${i} OR p.ean ILIKE $${i} OR p.name ILIKE $${i}
                   OR p.scode ILIKE $${i} OR p.app ILIKE $${i}
                   OR EXISTS (SELECT 1 FROM product_syd_codes sc WHERE sc.product_id=p.id AND sc.syd_code ILIKE $${i})
                   OR EXISTS (SELECT 1 FROM product_applications pa WHERE pa.product_id=p.id AND pa.app_text ILIKE $${i}))`;
    }
    params.push(limit, offset);
    // 누적 판매수량(게시·미삭제 인보이스 기준)을 제품별로 합산해 LEFT JOIN. 파라미터 없음(인덱스 영향 없음).
    const rows = (await query(
      `SELECT p.id, p.code, p.scode, p.app, p.ean, p.name, p.list_price, p.discount, p.iva_rate,
              p.stock_qty, p.avg_cost, p.rack_location,
              COALESCE(sold.qty, 0) AS sold_qty
         FROM products p
         LEFT JOIN (
           SELECT sil.product_id, SUM(sil.qty) AS qty
             FROM sales_invoice_lines sil
             JOIN sales_invoices si ON si.id = sil.invoice_id
            WHERE si.status = 'posted' AND si.deleted_at IS NULL
            GROUP BY sil.product_id
         ) sold ON sold.product_id = p.id
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
    // 전체 건수(검색 조건 동일) — limit/offset 인자는 제외하고 카운트
    const countParams = params.slice(0, params.length - 2);
    const total = Number((await query(`SELECT COUNT(*)::int AS n FROM products p WHERE ${where}`, countParams)).rows[0].n);

    await logPageView(perm.userId, 'products');
    // 각 행을 권한에 맞게 최소화
    return { items: rows.map((p) => minimizeProduct(perm, p)), limit, offset, total };
  });

  // 제품 드릴다운: ① 지금까지 판매한 고객별 수량 ② 원가(평균원가) 계산 근거(수식).
  //   원가 근거는 unit_cost 권한 있는 경우(디렉터 등)만 포함.
  app.get('/api/products/:id/drilldown', { preHandler: [authGuard, requirePage('products')] }, async (req, reply) => {
    const { perm } = req.ctx;
    const id = Number(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_product' });
    const prod = (await query(`SELECT id, code, name, stock_qty, avg_cost FROM products WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!prod) return reply.code(404).send({ error: 'not_found' });

    // ① 판매 고객별 수량 + (권한 시) 매출·매출원가(게시된 인보이스 기준)
    const salesRows = (await query(
      `SELECT cu.name AS customer_name,
              COALESCE(SUM(sil.qty),0) AS qty,
              COUNT(DISTINCT si.id) AS inv_count,
              COALESCE(SUM(sil.line_amount_mxn),0) AS revenue,
              COALESCE(SUM(COALESCE(sil.cogs_mxn, sil.qty * sil.applied_unit_cost, 0)),0) AS cogs
         FROM sales_invoice_lines sil
         JOIN sales_invoices si ON si.id=sil.invoice_id
         JOIN customers cu ON cu.id=si.customer_id
        WHERE sil.product_id=$1 AND si.status='posted' AND si.deleted_at IS NULL
        GROUP BY cu.id, cu.name
        ORDER BY SUM(sil.qty) DESC, cu.name`, [id])).rows;
    const sales = salesRows.map((r) => ({ customer_name: r.customer_name, qty: Number(r.qty), inv_count: Number(r.inv_count) }));
    const totalSold = sales.reduce((s, r) => s + r.qty, 0);

    const out = {
      product: { id: Number(prod.id), code: prod.code, name: prod.name, stock_qty: Number(prod.stock_qty || 0) },
      sales, total_sold: totalSold, customer_count: sales.length,
    };

    // ②-매출총이익 — unit_cost 권한 있을 때만(원가가 노출되므로). 매출원가는 판매 시점 스냅샷(applied_unit_cost) 기준.
    if (fieldVisible(perm, 'unit_cost')) {
      const r2 = (n) => Math.round(n * 100) / 100;
      const byCustomer = salesRows.map((r) => {
        const qty = Number(r.qty), revenue = r2(Number(r.revenue)), cogs = r2(Number(r.cogs));
        const profit = r2(revenue - cogs);
        return {
          customer_name: r.customer_name, qty, inv_count: Number(r.inv_count),
          revenue, cogs, profit, margin_pct: revenue > 0 ? r2(profit / revenue * 100) : null,
          avg_price: qty > 0 ? r2(revenue / qty) : null, avg_cost: qty > 0 ? r2(cogs / qty) : null,
        };
      });
      const tQty = byCustomer.reduce((s, x) => s + x.qty, 0);
      const tRev = r2(byCustomer.reduce((s, x) => s + x.revenue, 0));
      const tCogs = r2(byCustomer.reduce((s, x) => s + x.cogs, 0));
      const tProfit = r2(tRev - tCogs);
      out.gross = {
        by_customer: byCustomer,
        total: {
          qty: tQty, revenue: tRev, cogs: tCogs, profit: tProfit,
          margin_pct: tRev > 0 ? r2(tProfit / tRev * 100) : null,
          avg_price: tQty > 0 ? r2(tRev / tQty) : null, avg_cost: tQty > 0 ? r2(tCogs / tQty) : null,
        },
        note: '매출원가(COGS)는 판매 시점에 동결된 적용원가 기준입니다 — 이후 평균원가를 바꿔도 과거 매출총이익은 변하지 않습니다.',
      };
    }

    // ② 원가 근거(수식) — unit_cost 권한 있을 때만
    if (fieldVisible(perm, 'unit_cost')) {
      const costRows = (await query(
        `SELECT b.batch_no, to_char(b.import_date,'YYYY-MM-DD') AS import_date, b.currency, b.fx_rate,
                il.qty, il.import_price, il.unit_cost_mxn
           FROM import_lines il
           JOIN import_batches b ON b.id=il.batch_id AND b.deleted_at IS NULL AND b.exclude_from_cost IS NOT TRUE
          WHERE il.product_id=$1
          ORDER BY b.import_date, b.id`, [id])).rows;
      const r2 = (n) => Math.round(n * 100) / 100;
      const lines = costRows.map((r) => {
        const qty = Number(r.qty);
        const importPrice = r.import_price != null ? Number(r.import_price) : null; // 원통화 수입단가
        const fx = (r.currency === 'USD' && r.fx_rate != null) ? Number(r.fx_rate) : 1; // USD만 환율 적용
        const unitCostMxn = r.unit_cost_mxn != null ? Number(r.unit_cost_mxn) : null;
        // 수입금액(원통화) = 수입수량 × 수입단가
        const baseAmountCur = importPrice != null ? r2(qty * importPrice) : null;
        // 기본원가(MXN) = 수입금액(원통화) × 환율
        const baseAmountMxn = baseAmountCur != null ? r2(baseAmountCur * fx) : null;
        // 라인 총원가(MXN) = 수입수량 × 입고단가(MXN, 부대비용 1/n 반영 후 단가)
        const lineTotalMxn = unitCostMxn != null ? r2(qty * unitCostMxn) : null;
        // 배분 부대비용(MXN, 이 라인 몫) = 라인총원가 − 기본원가  (음수면 0으로)
        const overheadMxn = (lineTotalMxn != null && baseAmountMxn != null)
          ? Math.max(0, r2(lineTotalMxn - baseAmountMxn)) : null;
        return {
          batch_no: r.batch_no, import_date: r.import_date, currency: r.currency,
          qty, import_price: importPrice, fx_rate: fx,
          base_amount_cur: baseAmountCur, base_amount_mxn: baseAmountMxn,
          overhead_mxn: overheadMxn, line_total_mxn: lineTotalMxn,
          unit_cost_mxn: unitCostMxn,
        };
      });
      const sumQty = lines.reduce((s, l) => s + l.qty, 0);
      const sumAmount = lines.reduce((s, l) => s + l.qty * (l.unit_cost_mxn || 0), 0);
      const computedAvg = sumQty > 0 ? sumAmount / sumQty : 0;
      out.cost = {
        stored_avg_cost: prod.avg_cost != null ? Number(prod.avg_cost) : null,
        lines, sum_qty: sumQty, sum_amount: Math.round(sumAmount * 100) / 100,
        computed_avg: Math.round(computedAvg * 100) / 100,
        // 수식: 평균원가 = Σ(수입수량 × 입고단가MXN) / Σ수입수량
        formula: '평균원가 = Σ(수입수량 × 입고단가) ÷ Σ수입수량',
        note: '입고단가는 통화별 입고가에 입고일 환율과 분배 부대비용(1/n)을 반영한 MXN 단가입니다.',
      };
    }
    return out;
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
          if (chFields.length > 0) {
            const sets = []; const vals = [];
            for (const f of chFields) { vals.push(p[f]); sets.push(`${f}=$${vals.length}`); }
            vals.push(userId); sets.push(`updated_by=$${vals.length}`);
            vals.push(ex.id);
            await c.query(`UPDATE products SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
          }
          // 파생 데이터(SyD·적용차종)는 항상 현재 파일 기준으로 재동기화 →
          // "동일"로 분류돼도 분해 데이터가 비지 않도록 보장.
          await syncSyd(c, ex.id, p.syd_codes);
          await syncApp(c, ex.id, p.applications);
          if (chFields.length > 0 || d.syd_changed || d.app_changed) updated++; else unchanged++;
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

  // 차종 드롭다운: 메이커 목록
  app.get('/api/products/app-makers', { preHandler: [authGuard, requirePage('products')] }, async () => {
    const rows = (await query(
      `SELECT DISTINCT maker FROM product_applications WHERE maker IS NOT NULL AND maker <> '' ORDER BY maker`)).rows;
    return { items: rows.map((r) => r.maker) };
  });

  // 차종 드롭다운: (메이커별) 모델 목록
  app.get('/api/products/app-models', { preHandler: [authGuard, requirePage('products')] }, async (req) => {
    const maker = String(req.query.maker || '').trim();
    const params = []; const conds = [`model IS NOT NULL AND model <> ''`];
    if (maker) { params.push(maker); conds.push(`maker = $${params.length}`); }
    const rows = (await query(
      `SELECT DISTINCT model FROM product_applications WHERE ${conds.join(' AND ')} ORDER BY model`, params)).rows;
    return { items: rows.map((r) => r.model) };
  });

  // 차종 드롭다운: (메이커·모델별) 개별 연도 목록(범위를 펼침)
  app.get('/api/products/app-years', { preHandler: [authGuard, requirePage('products')] }, async (req) => {
    const maker = String(req.query.maker || '').trim();
    const model = String(req.query.model || '').trim();
    const params = []; const conds = [`year_from IS NOT NULL AND year_to IS NOT NULL`];
    if (maker) { params.push(maker); conds.push(`maker = $${params.length}`); }
    if (model) { params.push(model); conds.push(`model = $${params.length}`); }
    const rows = (await query(
      `SELECT DISTINCT y FROM product_applications, generate_series(year_from, year_to) AS y
        WHERE ${conds.join(' AND ')} ORDER BY y DESC`, params)).rows;
    return { items: rows.map((r) => Number(r.y)) };
  });

  // 차종(메이커/모델/연식)으로 부품 역검색 — 드롭다운 정확매칭, 단계 건너뛰기 허용
  app.get('/api/products/by-vehicle', { preHandler: [authGuard, requirePage('products')] }, async (req) => {
    const maker = String(req.query.maker || '').trim();
    const model = String(req.query.model || '').trim();
    const q = String(req.query.q || '').trim();
    const year = req.query.year ? Number(req.query.year) : null;
    if (!maker && !model && !q && !year) return { items: [] };
    const conds = ['p.deleted_at IS NULL']; const params = [];
    if (maker) { params.push(maker); conds.push(`a.maker = $${params.length}`); }
    if (model) { params.push(model); conds.push(`a.model = $${params.length}`); }
    if (q) { params.push(`%${q}%`); conds.push(`(a.app_text ILIKE $${params.length} OR a.model ILIKE $${params.length})`); }
    if (year != null && Number.isFinite(year)) { params.push(year); conds.push(`a.year_from <= $${params.length} AND a.year_to >= $${params.length}`); }
    const rows = (await query(
      `SELECT p.id, p.code, p.name, p.scode, a.app_text, a.maker, a.model, a.year_from, a.year_to
         FROM product_applications a JOIN products p ON p.id=a.product_id
        WHERE ${conds.join(' AND ')}
        ORDER BY p.code, a.year_from
        LIMIT 300`, params)).rows;
    return { items: rows };
  });

  // 기존 제품의 파생 데이터(SyD·적용차종) 전체 재생성(디렉터).
  // 이미 올린 제품들의 분해 데이터를 한 번에 채울 때 사용.
  app.post('/api/products/resync-derived', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const userId = req.ctx.perm.userId;
    const prods = (await query(`SELECT id, scode, app FROM products WHERE deleted_at IS NULL`)).rows;
    let n = 0;
    for (const pr of prods) {
      const syd = splitSyd(pr.scode);
      const apps = parseApplications(pr.app);
      await withTx(async (c) => {
        await c.query(`DELETE FROM product_syd_codes WHERE product_id=$1`, [pr.id]);
        for (const sc of [...new Set(syd.map(String))].filter(Boolean)) {
          await c.query(`INSERT INTO product_syd_codes (product_id, syd_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [pr.id, sc]);
        }
        await c.query(`DELETE FROM product_applications WHERE product_id=$1`, [pr.id]);
        for (const a of apps) {
          await c.query(
            `INSERT INTO product_applications (product_id, app_text, maker, model, year_from, year_to) VALUES ($1,$2,$3,$4,$5,$6)`,
            [pr.id, a.app_text, a.maker, a.model, a.year_from, a.year_to]);
        }
      });
      n++;
    }
    await logEvent({ userId, action: 'update', target: 'product_resync', detail: { products: n } });
    return { ok: true, products: n };
  });
}

