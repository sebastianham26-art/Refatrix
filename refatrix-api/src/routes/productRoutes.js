import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { minimizeProduct, fieldVisible } from '../permissions.js';
import { logPageView, logEvent } from '../audit.js';
import { buildHeaderIndex, parseRow, diffProduct, buildPreview, UPDATABLE_FIELDS, parseApplications, splitSyd, normalizeMaterial } from '../productImport.js';
import { visibleTeamIds } from '../teams.js';

// ── 중국 자동차 브랜드 분류 ──────────────────────────────────────────────
// 필터 기준은 product_applications.maker(적용차종 앞쪽 대문자 토큰, 대문자로 저장).
// 아래는 "분류(화이트리스트)"이며, 실제 UI/카운트는 DB에 존재하는 브랜드만 노출한다
// (cn-makers 엔드포인트가 이 목록과 DB의 교집합만 반환). 신규 중국차 적용차종이
// 마스터에 추가되면 별도 코드 수정 없이 자동으로 목록/필터에 잡힌다.
const CN_MAKERS = [
  'MG', 'JAC', 'CHIREY', 'CHERY', 'OMODA', 'JAECOO', 'CHANGAN', 'BYD',
  'GWM', 'GREAT WALL', 'HAVAL', 'GEELY', 'DONGFENG', 'FAW', 'BAIC', 'FOTON',
  'JETOUR', 'EXEED', 'WULING', 'BAOJUN', 'MAXUS', 'JMC', 'ZEEKR', 'HONGQI',
  'LYNK', 'NIO', 'XPENG', 'LEAPMOTOR', 'SERES', 'BESTUNE', 'ORA', 'TANK', 'ROEWE',
];
// 표시명(브랜드 계열 병기). 목록에 없으면 저장값 그대로 노출.
const CN_MAKER_LABEL = {
  MG: 'MG', JAC: 'JAC', BYD: 'BYD', FAW: 'FAW', BAIC: 'BAIC', JMC: 'JMC', ORA: 'ORA', NIO: 'NIO',
  GWM: 'GWM (Great Wall)', 'GREAT WALL': 'Great Wall',
  CHIREY: 'Chirey (Chery)', OMODA: 'Omoda (Chery)', JAECOO: 'Jaecoo (Chery)', CHERY: 'Chery',
  CHANGAN: 'Changan', HAVAL: 'Haval', GEELY: 'Geely', DONGFENG: 'Dongfeng', FOTON: 'Foton',
  JETOUR: 'Jetour', EXEED: 'Exeed', WULING: 'Wuling', BAOJUN: 'Baojun', MAXUS: 'Maxus',
  ZEEKR: 'Zeekr', HONGQI: 'Hongqi', LYNK: 'Lynk & Co', XPENG: 'Xpeng', LEAPMOTOR: 'Leapmotor',
  SERES: 'Seres', BESTUNE: 'Bestune', TANK: 'Tank', ROEWE: 'Roewe',
};
const cnLabel = (m) => CN_MAKER_LABEL[m] || m;

export default async function productRoutes(app) {
  // 제품 목록: 검색 + 페이징 (SKU ~5,000 대비, 한 번에 다 보내지 않음)
  // 민감 필드(원가·마진 등)는 권한 없으면 응답에서 제거(데이터 최소 전송).
  app.get('/api/products', { preHandler: [authGuard, requirePage('products')] }, async (req) => {
    const { perm } = req.ctx;
    const q = (req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    // 소재 필터: material=aluminio 이면 알루미늄 제품만. material=__none__ 이면 미지정만.
    const materialFilter = String(req.query.material || '').trim().toLowerCase();

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
    if (materialFilter === '__none__') {
      where += ' AND p.material IS NULL';
    } else if (materialFilter) {
      params.push(normalizeMaterial(materialFilter));
      where += ` AND p.material = $${params.length}`;
    }
    // 중국차 필터: cn=1 이면 중국 브랜드 적용차종을 가진 제품만.
    //   cnbrand=MG,JAC 처럼 특정 브랜드를 다중선택하면 그 브랜드들로 좁힌다(화이트리스트 검증).
    //   선택이 없고 cn=1 이면 전체 중국 브랜드(CN_MAKERS) 대상.
    const cnOn = ['1', 'true', 'yes', 'on'].includes(String(req.query.cn || '').trim().toLowerCase());
    const cnSel = String(req.query.cnbrand || '')
      .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
      .filter((m) => CN_MAKERS.includes(m));   // 임의 값 주입 방지(화이트리스트만 허용)
    if (cnOn || cnSel.length) {
      const cnList = cnSel.length ? cnSel : CN_MAKERS;
      params.push(cnList);
      where += ` AND EXISTS (SELECT 1 FROM product_applications pa
                             WHERE pa.product_id = p.id AND pa.maker = ANY($${params.length}))`;
    }
    // 전체 건수용 파라미터(검색 조건만) — 팀/limit/offset 추가 전에 스냅샷.
    const countParams = params.slice();
    // 누적 판매수량을 영업팀 가시성으로 제한 — 담당 외 고객 판매수량이 합산되지 않도록.
    //   디렉터·영업지원(vis=null)은 전체 집계, 그 외는 소속/부여팀 고객만 집계.
    const vis = visibleTeamIds(perm);
    let soldTeamJoin = '', soldTeamCond = '';
    if (vis !== null) {
      params.push(vis.length ? vis : [-1]);
      soldTeamJoin = ' JOIN customers cu ON cu.id = si.customer_id';
      soldTeamCond = ` AND cu.team_id = ANY($${params.length})`;
    }
    params.push(limit, offset);
    // 누적 판매수량(게시·미삭제 인보이스 기준)을 제품별로 합산해 LEFT JOIN.
    const rows = (await query(
      `SELECT p.id, p.code, p.scode, p.app, p.ean, p.name, p.list_price, p.discount, p.iva_rate,
              p.stock_qty, p.avg_cost, p.rack_location, p.material,
              COALESCE(sold.qty, 0) AS sold_qty
         FROM products p
         LEFT JOIN (
           SELECT sil.product_id, SUM(sil.qty) AS qty
             FROM sales_invoice_lines sil
             JOIN sales_invoices si ON si.id = sil.invoice_id${soldTeamJoin}
            WHERE si.status = 'posted' AND si.deleted_at IS NULL${soldTeamCond}
            GROUP BY sil.product_id
         ) sold ON sold.product_id = p.id
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
    // 전체 건수(검색 조건 동일) — countParams 는 위에서 팀/limit/offset 추가 전 스냅샷.
    const total = Number((await query(`SELECT COUNT(*)::int AS n FROM products p WHERE ${where}`, countParams)).rows[0].n);

    await logPageView(perm.userId, 'products');
    // 각 행을 권한에 맞게 최소화
    return { items: rows.map((p) => minimizeProduct(perm, p)), limit, offset, total };
  });

  // 제품 마스터 다운로드용 전체 목록(프런트가 엑셀로 변환).
  //   - 컬럼은 마스터 "업로드"와 같은 필드 구성 → 내려받아 수정 후 그대로 재업로드 가능.
  //   - 가격류(List Price·SYD/CTR 고객가)는 sale_price 권한 있을 때만 포함(없으면 필드 자체 생략).
  //   - 재고·랙은 정보용으로 포함(업로드는 어차피 재고·평균원가를 절대 건드리지 않음). 원가는 미포함.
  app.get('/api/products/master-export', { preHandler: [authGuard, requirePage('products')] }, async (req) => {
    const { perm } = req.ctx;
    const rows = (await query(
      `SELECT p.code, p.scode, p.app, p.name, p.sat_code, p.origin,
              p.list_price, p.iva_rate, p.ean, p.location,
              p.list_price_syd, p.price_customer_syd, p.price_customer_ctr,
              p.material, p.rack_location, p.stock_qty
         FROM products p
        WHERE p.deleted_at IS NULL
        ORDER BY p.code ASC`)).rows;
    const canPrice = fieldVisible(perm, 'sale_price');
    const num = (v) => (v == null ? null : Number(v));
    const items = rows.map((r) => {
      const o = {
        code: r.code, scode: r.scode, app: r.app, name: r.name,
        sat_code: r.sat_code, origin: r.origin, iva_rate: num(r.iva_rate),
        ean: r.ean, location: r.location, material: r.material,
        rack_location: r.rack_location, stock_qty: num(r.stock_qty) || 0,
      };
      if (canPrice) {
        o.list_price = num(r.list_price);
        o.list_price_syd = num(r.list_price_syd);
        o.price_customer_syd = num(r.price_customer_syd);
        o.price_customer_ctr = num(r.price_customer_ctr);
      }
      return o;
    });
    await logEvent({ userId: perm.userId, action: 'read', target: 'product_master_export',
      detail: { rows: items.length, price_included: canPrice } });
    return { items, total: items.length, price_included: canPrice };
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
    //   영업팀 가시성 필터: 담당(소속/부여팀) 고객의 판매만 노출. 디렉터·영업지원(vis=null)=전체.
    const vis = visibleTeamIds(perm);
    const sParams = [id];
    let teamCond = '';
    if (vis !== null) { sParams.push(vis.length ? vis : [-1]); teamCond = ` AND cu.team_id = ANY($${sParams.length})`; }
    const salesRows = (await query(
      `SELECT cu.name AS customer_name,
              COALESCE(SUM(sil.qty),0) AS qty,
              COUNT(DISTINCT si.id) AS inv_count,
              COALESCE(SUM(sil.line_amount_mxn),0) AS revenue,
              COALESCE(SUM(COALESCE(sil.cogs_mxn, sil.qty * sil.applied_unit_cost, 0)),0) AS cogs
         FROM sales_invoice_lines sil
         JOIN sales_invoices si ON si.id=sil.invoice_id
         JOIN customers cu ON cu.id=si.customer_id
        WHERE sil.product_id=$1 AND si.status='posted' AND si.deleted_at IS NULL${teamCond}
        GROUP BY cu.id, cu.name
        ORDER BY SUM(sil.qty) DESC, cu.name`, sParams)).rows;
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
              list_price_syd, price_customer_syd, price_customer_ctr, stock_qty, avg_cost, material
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

  // ===== 소재(material) 지정 =====
  // 제품 1건 소재 인라인 편집(디렉터). body { material } — 빈값/null이면 해제.
  app.patch('/api/products/:id/material', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'bad_id' });
    const material = normalizeMaterial((req.body || {}).material);
    const r = (await query(
      `UPDATE products SET material=$1, updated_by=$2 WHERE id=$3 AND deleted_at IS NULL RETURNING id, code, material`,
      [material, req.ctx.perm.userId, id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: 'product_material', detail: { code: r.code, material } });
    return { ok: true, id: r.id, code: r.code, material: r.material };
  });

  // CTR 코드 목록으로 소재 일괄 지정(디렉터). body { codes:[...], material }
  //   material 빈값/null → 해당 코드들의 소재 해제. 반환: 매칭 수 + 미매칭 코드 목록.
  app.post('/api/products/material/bulk-set', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const b = req.body || {};
    const material = normalizeMaterial(b.material);
    const codes = [...new Set((Array.isArray(b.codes) ? b.codes : [])
      .map((c) => String(c == null ? '' : c).trim()).filter(Boolean))];
    if (!codes.length) return reply.code(400).send({ error: 'no_codes' });
    const updated = (await query(
      `UPDATE products SET material=$1, updated_by=$2
        WHERE code = ANY($3) AND deleted_at IS NULL
        RETURNING code`,
      [material, req.ctx.perm.userId, codes])).rows.map((r) => r.code);
    const matchedSet = new Set(updated);
    const unmatched = codes.filter((c) => !matchedSet.has(c));
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: 'product_material_bulk',
      detail: { material, matched: updated.length, unmatched: unmatched.length } });
    return { ok: true, material, requested: codes.length, matched: updated.length, unmatched };
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

  // 중국차 필터용: DB에 실제 존재하는 중국 브랜드 + 제품수(다중선택 칩 소스).
  //   count = 브랜드별 제품수(제품 기준 DISTINCT), total = 전체 중국차 제품 중복제거 수.
  app.get('/api/products/cn-makers', { preHandler: [authGuard, requirePage('products')] }, async () => {
    const rows = (await query(
      `SELECT maker, COUNT(DISTINCT product_id)::int AS cnt
         FROM product_applications
        WHERE maker = ANY($1)
        GROUP BY maker
        ORDER BY cnt DESC, maker`, [CN_MAKERS])).rows;
    const items = rows.map((r) => ({ maker: r.maker, label: cnLabel(r.maker), count: Number(r.cnt) }));
    const tot = (await query(
      `SELECT COUNT(DISTINCT product_id)::int AS n
         FROM product_applications WHERE maker = ANY($1)`, [CN_MAKERS])).rows[0].n;
    return { items, total: Number(tot) };
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

  // 차종별 부품 매트릭스: 모델 검색 → 카테고리별 정렬. 세대(모델·연식)를 열 머리로, 그 아래에 CTR/SYD 코드.
  // 각 세대 열에는 그 연식대의 VIO(멕시코 등록대수) 순위·수량을 표시(출처: ctr_vio_rank).
  // 마이그레이션 불필요 — product_applications / product_syd_codes / ctr_vio_rank / products 재사용.
  app.get('/api/products/by-model', { preHandler: [authGuard, requirePage('products')] }, async (req) => {
    const { perm } = req.ctx;
    const canPrice = fieldVisible(perm, 'sale_price'); // 정가류(list_price·list_price_syd)는 sale_price 권한자에게만
    const raw = String(req.query.q || '').trim();
    const empty = { query: raw, model_label: '', headline_vio: null, variants: [], categories: [], total: 0, price_included: canPrice };
    if (raw.length < 2) return empty;
    const esc = raw.replace(/([%_\\])/g, '\\$1');
    const like = '%' + esc + '%';

    // 1) 검색 모델에 걸리는 개별 차량 적용 항목 + 제품 기본(코드=CTR, 이름=DESCRIPCIÓN)
    const appRows = (await query(
      `SELECT pa.product_id, pa.maker, pa.model, pa.year_from, pa.year_to,
              p.code AS ctr, p.name, p.stock_qty, p.list_price, p.list_price_syd
         FROM product_applications pa
         JOIN products p ON p.id = pa.product_id AND p.deleted_at IS NULL
        WHERE (pa.model ILIKE $1 OR pa.app_text ILIKE $1)
          AND pa.model IS NOT NULL AND pa.model <> ''`, [like])).rows;
    if (!appRows.length) return empty;

    const pids = [...new Set(appRows.map((r) => Number(r.product_id)))];

    // 1-b) 누적 판매수량(게시·미삭제 인보이스) — 제품 목록과 동일하게 영업팀 가시성 제한.
    //   디렉터·영업지원(vis=null)은 전체 집계, 그 외는 소속/부여팀 고객 판매만 합산.
    const vis = visibleTeamIds(perm);
    const soldParams = [pids];
    let soldTeamJoin = '', soldTeamCond = '';
    if (vis !== null) {
      soldParams.push(vis.length ? vis : [-1]);
      soldTeamJoin = ' JOIN customers cu ON cu.id = si.customer_id';
      soldTeamCond = ' AND cu.team_id = ANY($2)';
    }
    const soldRows = (await query(
      `SELECT sil.product_id, SUM(sil.qty) AS qty
         FROM sales_invoice_lines sil
         JOIN sales_invoices si ON si.id = sil.invoice_id${soldTeamJoin}
        WHERE si.status = 'posted' AND si.deleted_at IS NULL
          AND sil.product_id = ANY($1)${soldTeamCond}
        GROUP BY sil.product_id`, soldParams)).rows;
    const soldByPid = {};
    for (const s of soldRows) soldByPid[Number(s.product_id)] = Number(s.qty);

    // 2) SYD 코드(제품:다)
    const sydRows = (await query(
      `SELECT product_id, syd_code FROM product_syd_codes WHERE product_id = ANY($1)`, [pids])).rows;
    const sydByPid = {};
    for (const s of sydRows) (sydByPid[Number(s.product_id)] ||= []).push(s.syd_code);

    // 3) VIO — 검색 모델의 연식대별 순위/등록대수
    const vioRows = (await query(
      `SELECT DISTINCT vio_year, vio_rank, vio_units FROM ctr_vio_rank WHERE vio_model ILIKE $1`, [like])).rows;
    const vioBands = [];
    for (const v of vioRows) {
      const m = String(v.vio_year || '').match(/(\d{4})\s*-\s*(\d{4})/);
      if (!m) continue;
      vioBands.push({ a: Number(m[1]), b: Number(m[2]), rank: Number(v.vio_rank), units: v.vio_units != null ? Number(v.vio_units) : null });
    }
    const vioFor = (minY, maxY) => {
      if (minY == null || maxY == null) return null;
      let best = null;
      for (const v of vioBands) if (v.a <= maxY && v.b >= minY) { if (!best || v.rank < best.rank) best = v; }
      return best ? { rank: best.rank, units: best.units } : null;
    };

    // 모델 표기 정규화(로마숫자 대문자: Tsuru Iii → Tsuru III)
    const normModel = (mm) => String(mm || '').trim().split(/\s+/)
      .map((t) => (/^[ivx]{1,4}$/i.test(t) ? t.toUpperCase() : (t.charAt(0).toUpperCase() + t.slice(1).toLowerCase())))
      .join(' ');

    // 카테고리 분류(제품명 기준). 대표 지정 6종 우선 → 흔한 계열 → 나머지=기타.
    const CATS = [
      { key: 'rotula', es: 'Rótula', ko: '볼조인트', test: (n) => /ROTULA/.test(n) },
      { key: 'terminal_ext', es: 'Terminal exterior', ko: '타이로드엔드(외측)', test: (n) => /TERMINAL/.test(n) && /EXTERIOR/.test(n) },
      { key: 'terminal_int', es: 'Terminal interior', ko: '타이로드엔드(내측)', test: (n) => /TERMINAL/.test(n) && /INTERIOR/.test(n) },
      { key: 'horquilla', es: 'Horquilla', ko: '컨트롤암(로어암)', test: (n) => /HORQUILLA/.test(n) },
      { key: 'buje', es: 'Buje', ko: '부싱', test: (n) => /BUJE/.test(n) },
      { key: 'tornillo', es: 'Tornillo estabilizador', ko: '스태빌라이저 링크', test: (n) => /TORNILLO/.test(n) && /ESTABILIZADOR/.test(n) },
      { key: 'amortiguador', es: 'Amortiguador', ko: '쇼크업소버', test: (n) => /AMORTIGUADOR/.test(n) },
      { key: 'junta', es: 'Junta homocinética', ko: '등속조인트', test: (n) => /JUNTA/.test(n) || /HOMOCIN/.test(n) },
      { key: 'maza', es: 'Maza / Balero', ko: '허브·베어링', test: (n) => /MAZA/.test(n) || /BALERO/.test(n) },
      { key: 'mangueta', es: 'Mangueta', ko: '너클', test: (n) => /MANGUETA/.test(n) },
      { key: 'resorte', es: 'Resorte', ko: '스프링', test: (n) => /RESORTE|MUELLE/.test(n) },
      { key: 'cremallera', es: 'Cremallera', ko: '스티어링 랙', test: (n) => /CREMALLERA/.test(n) },
      { key: 'soporte', es: 'Soporte', ko: '마운트·서포트', test: (n) => /SOPORTE/.test(n) },
      { key: 'goma', es: 'Goma', ko: '고무부품', test: (n) => /GOMA/.test(n) },
    ];
    const OTROS = { key: 'otros', es: 'Otros', ko: '기타' };
    const classify = (name) => {
      const n = String(name || '').toUpperCase();
      for (const c of CATS) if (c.test(n)) return c.key;
      return 'otros';
    };

    // 4) 변형(열) + 셀 구성
    const varMap = new Map();   // model -> {key, model, minY, maxY}
    const catCells = new Map(); // catKey -> Map(model -> Map(ctr -> cell))
    const makerCount = {};
    for (const r of appRows) {
      const model = normModel(r.model);
      if (!model) continue;
      const yf = r.year_from != null ? Number(r.year_from) : null;
      const yt = r.year_to != null ? Number(r.year_to) : yf;
      if (r.maker) makerCount[r.maker] = (makerCount[r.maker] || 0) + 1;
      let v = varMap.get(model);
      if (!v) { v = { key: model, model, minY: yf, maxY: yt }; varMap.set(model, v); }
      if (yf != null) v.minY = v.minY == null ? yf : Math.min(v.minY, yf);
      if (yt != null) v.maxY = v.maxY == null ? yt : Math.max(v.maxY, yt);

      const catKey = classify(r.name);
      if (!catCells.has(catKey)) catCells.set(catKey, new Map());
      const byVar = catCells.get(catKey);
      if (!byVar.has(model)) byVar.set(model, new Map());
      const byCtr = byVar.get(model);
      if (!byCtr.has(r.ctr)) {
        const yStr = yf != null ? (yt != null && yt !== yf ? yf + '-' + yt : String(yf)) : '';
        const cell = {
          ctr: r.ctr, syd: sydByPid[Number(r.product_id)] || [], name: r.name || '', year: yStr,
          stock: r.stock_qty != null ? Number(r.stock_qty) : 0,
          sold: soldByPid[Number(r.product_id)] || 0,
        };
        if (canPrice) {
          cell.lp = r.list_price != null ? Number(r.list_price) : null;          // CTR List Price
          cell.lp_syd = r.list_price_syd != null ? Number(r.list_price_syd) : null; // SYD List Price
        }
        byCtr.set(r.ctr, cell);
      }
    }

    const variants = [...varMap.values()]
      .sort((a, b) => (a.minY == null ? 99999 : a.minY) - (b.minY == null ? 99999 : b.minY))
      .map((v) => ({
        key: v.key, model: v.model,
        years: v.minY != null ? (v.maxY != null && v.maxY !== v.minY ? v.minY + '-' + v.maxY : String(v.minY)) : '',
        vio: vioFor(v.minY, v.maxY),
      }));

    const order = CATS.map((c) => c.key).concat(['otros']);
    const meta = {}; CATS.forEach((c) => (meta[c.key] = c)); meta.otros = OTROS;
    const categories = [];
    for (const ck of order) {
      const byVar = catCells.get(ck);
      if (!byVar) continue;
      const cells = {}; let cnt = 0;
      for (const [vk, byCtr] of byVar) { cells[vk] = [...byCtr.values()]; cnt += cells[vk].length; }
      categories.push({ key: ck, es: meta[ck].es, ko: meta[ck].ko, count: cnt, cells });
    }

    const maker = Object.keys(makerCount).sort((a, b) => makerCount[b] - makerCount[a])[0] || '';
    const model_label = (maker ? maker + ' ' : '') + raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    let headline_vio = null;
    for (const v of variants) if (v.vio && (!headline_vio || v.vio.rank < headline_vio.rank)) headline_vio = v.vio;

    return { query: raw, model_label, headline_vio, variants, categories, total: pids.length, price_included: canPrice };
  });

  // VIO 제품찾기 — 적용차종에 존재하는 차종(maker/model) 목록.
  //   VIO(커버리지) 목록에 없는 차종(예: Audi Q2)도 화면에 노출하기 위한 보충 소스.
  //   제품이 1개 이상 걸린(미삭제) 차종만, 연식 범위·제품수 포함.
  app.get('/api/products/applied-models', { preHandler: [authGuard, requirePage('products')] }, async () => {
    const rows = (await query(
      `SELECT pa.maker, pa.model, COUNT(DISTINCT pa.product_id)::int AS products,
              MIN(pa.year_from) AS y_from, MAX(pa.year_to) AS y_to
         FROM product_applications pa
         JOIN products p ON p.id = pa.product_id AND p.deleted_at IS NULL
        WHERE pa.model IS NOT NULL AND pa.model <> ''
        GROUP BY pa.maker, pa.model
        ORDER BY pa.maker NULLS LAST, pa.model`)).rows;
    return {
      items: rows.map((r) => ({
        maker: r.maker || '', model: r.model, products: Number(r.products),
        y_from: r.y_from != null ? Number(r.y_from) : null,
        y_to: r.y_to != null ? Number(r.y_to) : null,
      })),
      total: rows.length,
    };
  });

  // VIO 제품찾기 — 기준품목(SYD 코드)의 SYD 정가 조회.
  //   화면에서 "1516049를 고객이 얼마에 사는지" 입력받아 할인율(1 − 구매단가÷정가)을 산출하고,
  //   그 할인율을 SYD 전 품목 정가에 적용(SYD 고객구매가) → CTR = SYD 고객구매가 × 0.95.
  //   정가는 sale_price 권한자에게만 제공. 매칭: product_syd_codes 정확일치 우선 → products.scode ILIKE 폴백.
  app.get('/api/products/syd-baseline', { preHandler: [authGuard, requirePage('products')] }, async (req, reply) => {
    const { perm } = req.ctx;
    if (!fieldVisible(perm, 'sale_price')) { reply.code(403); return { error: 'forbidden' }; }
    const code = String(req.query.code || '').trim();
    if (!code) return { found: false, code };
    const esc = code.replace(/([%_\\])/g, '\\$1');
    let row = (await query(
      `SELECT p.code, p.name, p.list_price_syd
         FROM product_syd_codes sc
         JOIN products p ON p.id = sc.product_id AND p.deleted_at IS NULL
        WHERE sc.syd_code = $1
        ORDER BY p.code LIMIT 1`, [code])).rows[0];
    if (!row) {
      row = (await query(
        `SELECT code, name, list_price_syd
           FROM products
          WHERE deleted_at IS NULL AND scode ILIKE $1
          ORDER BY code LIMIT 1`, ['%' + esc + '%'])).rows[0];
    }
    if (!row) return { found: false, code };
    return {
      found: true, code,
      ctr_code: row.code, name: row.name,
      list_price_syd: row.list_price_syd != null ? Number(row.list_price_syd) : null,
    };
  });
}

