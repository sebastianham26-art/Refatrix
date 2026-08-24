import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { minimizeProduct, fieldVisible } from '../permissions.js';
import { logPageView, logEvent } from '../audit.js';
import { buildHeaderIndex, parseRow, diffProduct, buildPreview, UPDATABLE_FIELDS, parseApplications, splitSyd, normalizeMaterial } from '../productImport.js';
import { visibleTeamIds } from '../teams.js';
import { sweepDevRequestMatches } from '../devMatchSweep.js';
import { productOpenItems, BUCKETS as STATUS_BUCKETS } from '../productStatus.js';
import { changeParts, describeRow, sydForRow, signedQty, stockAtChange } from '../productHistory.js';

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

// ── 제품 변경 이력(product_change_log) ─────────────────────────────────
// 화면 직접 추가/수정 · 엑셀 업로드 · 소재 지정의 모든 마스터 변경을 한 테이블에 기록.
// 기록 실패가 실제 작업을 깨지 않도록 방어적으로 호출(감사로그와 동일 원칙).
async function logProductChange(exec, { productId = null, code = null, action, source = 'manual', changes = null, userId = null }) {
  try {
    await exec(
      `INSERT INTO product_change_log (product_id, code, action, source, changes, changed_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [productId, code, action, source, changes ? JSON.stringify(changes) : null, userId]);
  } catch (e) {
    try { console.error('[product_change_log] failed:', action, source, e.message); } catch (_) {}
  }
}

// 화면 직접 편집 대상 필드 = 업로드 갱신 필드 + rack_location(랙 위치).
// 재고(stock_qty)·평균원가(avg_cost)는 어디서도 편집 불가.
const EDITABLE_FIELDS = [...UPDATABLE_FIELDS, 'rack_location'];
const EDIT_NUMERIC = new Set(['list_price', 'iva_rate', 'list_price_syd', 'price_customer_syd', 'price_customer_ctr']);
function normEditValue(f, v) {
  if (f === 'material') return normalizeMaterial(v);
  if (EDIT_NUMERIC.has(f)) {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(/[, ]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
// 값 동일성(숫자/문자 정규화) — productImport.diffProduct 와 같은 의미
function editEq(a, b, isNum) {
  if (isNum) {
    const x = a == null || a === '' ? null : Number(a);
    const y = b == null || b === '' ? null : Number(b);
    if (x == null && y == null) return true;
    return x === y;
  }
  const x = a == null ? '' : String(a).trim();
  const y = b == null ? '' : String(b).trim();
  return x === y;
}

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
      rack:     `NULLIF(p.rack_location,'') ${dir} NULLS LAST, p.code`,
      backorder: `COALESCE(bo.backorder_qty,0) ${dir}, p.code`,
      incoming:  `COALESCE(inc.incoming_qty,0) ${dir}, p.code`,
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
    // 마케팅 상품(머천다이즈) 필터: 제품코드가 'PRO'로 시작하는 제품(예: PRO-CAP, PROGORRA).
    //   pro=1 → 마케팅 상품만. pro=0 → 마케팅 상품 제외(부품만). 파라미터 없으면 종전대로 전부.
    const proRaw = String(req.query.pro || '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'only'].includes(proRaw)) {
      where += " AND COALESCE(p.code,'') ILIKE 'PRO%'";
    } else if (['0', 'false', 'no', 'off', 'exclude'].includes(proRaw)) {
      where += " AND COALESCE(p.code,'') NOT ILIKE 'PRO%'";
    }
    // 활성/비활성 필터(0179). 기본(파라미터 없음)은 종전과 동일하게 전부 노출 —
    // 비활성은 "신규 사용 차단"일 뿐 목록에서 숨기지 않는다(과거 내역 확인 필요).
    //   active=1 → 활성만 / active=0 → 비활성만
    const activeRaw = String(req.query.active || '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'active'].includes(activeRaw)) where += ' AND p.is_active';
    else if (['0', 'false', 'no', 'off', 'inactive'].includes(activeRaw)) where += ' AND NOT p.is_active';
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
    // Backorder(미입고 발주잔량)는 구매모듈 뷰 v_backorder(Σ qty−received_qty, 취소 제외)에서 LEFT JOIN.
    const rows = (await query(
      `SELECT p.id, p.code, p.scode, p.app, p.ean, p.name, p.list_price, p.discount, p.iva_rate,
              p.stock_qty, p.avg_cost, p.rack_location, p.material,
              p.is_active, p.inactive_reason,
              COALESCE(bo.backorder_qty, 0) AS backorder_qty,
              COALESCE(inc.incoming_qty, 0) AS incoming_qty,
              inc.incoming_eta::text AS incoming_eta,
              COALESCE(sold.qty, 0) AS sold_qty
         FROM products p
         LEFT JOIN v_backorder bo ON bo.product_id = p.id
         LEFT JOIN v_incoming_stock inc ON inc.product_id = p.id
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
  //   - Backorder(미입고 발주잔량, v_backorder)도 정보용 포함 — 목록 화면의 Backorder 열과 동일 기준.
  //     업로드 파서(COLUMN_MAP)에 없는 헤더라 재업로드 시 자동 무시됨(Stock·Rack과 동일).
  app.get('/api/products/master-export', { preHandler: [authGuard, requirePage('products')] }, async (req) => {
    const { perm } = req.ctx;
    const rows = (await query(
      `SELECT p.code, p.scode, p.app, p.name, p.sat_code, p.origin,
              p.list_price, p.iva_rate, p.ean, p.location,
              p.list_price_syd, p.price_customer_syd, p.price_customer_ctr,
              p.material, p.rack_location, p.stock_qty,
              COALESCE(bo.backorder_qty, 0) AS backorder_qty
         FROM products p
         LEFT JOIN v_backorder bo ON bo.product_id = p.id
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
        backorder_qty: num(r.backorder_qty) || 0,
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
    const prod = (await query(`SELECT id, code, name, stock_qty, avg_cost, is_active, inactive_reason,
                                      status_changed_at
                                 FROM products WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
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
      product: {
        id: Number(prod.id), code: prod.code, name: prod.name, stock_qty: Number(prod.stock_qty || 0),
        // 0179 — 활성/비활성. 비활성이어도 아래 판매·원가 내역은 그대로 내려간다(과거 P&L 보존).
        is_active: prod.is_active !== false,
        inactive_reason: prod.inactive_reason || null,
        status_changed_at: prod.status_changed_at || null,
      },
      sales, total_sold: totalSold, customer_count: sales.length,
      can_manage_status: perm.role === 'director',
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
        `SELECT b.batch_no, to_char(b.import_date,'YYYY-MM-DD') AS import_date, b.currency, b.fx_rate, b.status,
                il.qty, il.import_price, il.unit_cost_mxn, il.po_ref
           FROM import_lines il
           JOIN import_batches b ON b.id=il.batch_id AND b.deleted_at IS NULL AND b.exclude_from_cost IS NOT TRUE
          WHERE il.product_id=$1
          ORDER BY b.import_date, b.id`, [id])).rows;
      const r2 = (n) => Math.round(n * 100) / 100;
      const lines = costRows.map((r) => {
        // 원가 반영 여부(2026-08-19): 승인된 배치의 계산 완료 라인만 평균원가에 들어간다.
        //   대기·반려 배치는 카드에 표시는 하되(감사 목적) 합계·평균에서 제외.
        const counted = (r.status !== 'pending' && r.status !== 'rejected') && r.unit_cost_mxn != null;
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
          status: r.status || null, counted,                       // 원가 반영 여부(2026-08-19)
          po_ref: r.po_ref || null,                                 // 구매 참조번호(0179)
        };
      });
      const cLines = lines.filter((l) => l.counted);
      const sumQty = cLines.reduce((s, l) => s + l.qty, 0);
      const sumAmount = cLines.reduce((s, l) => s + l.qty * (l.unit_cost_mxn || 0), 0);
      const computedAvg = sumQty > 0 ? sumAmount / sumQty : 0;
      out.cost = {
        stored_avg_cost: prod.avg_cost != null ? Number(prod.avg_cost) : null,
        lines, sum_qty: sumQty, sum_amount: Math.round(sumAmount * 100) / 100,
        computed_avg: Math.round(computedAvg * 100) / 100,
        excluded_count: lines.length - cLines.length,   // 대기·반려 등 원가 미반영 라인 수(2026-08-19)
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

  // 파생 데이터(SyD·적용차종) 동기화 — 화면 직접 추가/수정용 공용 헬퍼(트랜잭션 클라이언트 c 사용)
  async function syncSydShared(c, productId, codes) {
    await c.query(`DELETE FROM product_syd_codes WHERE product_id=$1`, [productId]);
    const uniq = [...new Set((codes || []).map(String))].filter(Boolean);
    for (const sc of uniq) {
      await c.query(`INSERT INTO product_syd_codes (product_id, syd_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [productId, sc]);
    }
  }
  async function syncAppShared(c, productId, applications) {
    await c.query(`DELETE FROM product_applications WHERE product_id=$1`, [productId]);
    for (const a of (applications || [])) {
      await c.query(
        `INSERT INTO product_applications (product_id, app_text, maker, model, year_from, year_to) VALUES ($1,$2,$3,$4,$5,$6)`,
        [productId, a.app_text, a.maker, a.model, a.year_from, a.year_to]);
    }
  }

  // ===== 화면 직접 추가/수정 (디렉터) =====
  // 편집용 전체 필드 조회 — 목록 응답은 권한 최소화로 필드가 빠질 수 있어 별도 제공.
  app.get('/api/products/:id/master', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'bad_id' });
    const r = (await query(
      `SELECT id, code, scode, app, name, sat_code, origin, list_price, iva_rate, ean, location,
              list_price_syd, price_customer_syd, price_customer_ctr, material, rack_location,
              stock_qty, avg_cost
         FROM products WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    const num = (v) => (v == null ? null : Number(v));
    return {
      id: Number(r.id), code: r.code, scode: r.scode, app: r.app, name: r.name,
      sat_code: r.sat_code, origin: r.origin, list_price: num(r.list_price), iva_rate: num(r.iva_rate),
      ean: r.ean, location: r.location, list_price_syd: num(r.list_price_syd),
      price_customer_syd: num(r.price_customer_syd), price_customer_ctr: num(r.price_customer_ctr),
      material: r.material, rack_location: r.rack_location,
      stock_qty: num(r.stock_qty) || 0, avg_cost: num(r.avg_cost),
    };
  });

  // 제품 직접 추가 — 엑셀 없이 1건 등록. 재고·평균원가는 0(기본값)으로 시작.
  //   body: { code, name(필수), scode, app, sat_code, origin, list_price, iva_rate, ean, location,
  //           list_price_syd, price_customer_syd, price_customer_ctr, material, rack_location }
  app.post('/api/products', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const b = req.body || {};
    const userId = req.ctx.perm.userId;
    const code = normEditValue('code', b.code);
    const name = normEditValue('name', b.name);
    if (!code) return reply.code(400).send({ error: 'code_required', detail: '제품코드(Clave CTR)를 입력하세요.' });
    if (!name) return reply.code(400).send({ error: 'name_required', detail: '제품명(Nombre del producto)을 입력하세요.' });
    // 코드 유니크 검사(삭제 행 포함 — DB UNIQUE 제약이 전체 기준이므로 미리 안내)
    const dup = (await query(`SELECT id, deleted_at FROM products WHERE code=$1`, [code])).rows[0];
    if (dup) {
      return reply.code(409).send({
        error: dup.deleted_at ? 'code_used_by_deleted' : 'code_exists',
        detail: dup.deleted_at ? '삭제된 제품이 이 코드를 사용 중입니다. 다른 코드를 쓰거나 관리자에게 문의하세요.' : '이미 존재하는 제품코드입니다.',
      });
    }
    const values = { code, name };
    for (const f of EDITABLE_FIELDS) {
      if (f === 'name') continue;
      if (b[f] === undefined) continue;
      values[f] = normEditValue(f, b[f]);
    }
    const sydCodes = splitSyd(values.scode);
    const apps = parseApplications(values.app);
    const created = await withTx(async (c) => {
      const cols = []; const vals = []; const ph = [];
      for (const [k, v] of Object.entries(values)) { vals.push(v); cols.push(k); ph.push(`$${vals.length}`); }
      vals.push(userId);
      const r = (await c.query(
        `INSERT INTO products (${cols.join(',')}, created_by, updated_by) VALUES (${ph.join(',')}, $${vals.length}, $${vals.length}) RETURNING id`, vals)).rows[0];
      await syncSydShared(c, r.id, sydCodes);
      await syncAppShared(c, r.id, apps);
      const changes = {};
      for (const [k, v] of Object.entries(values)) if (v != null) changes[k] = { from: null, to: v };
      await logProductChange(c.query.bind(c), { productId: Number(r.id), code, action: 'create', source: 'manual', changes, userId });
      return r;
    });
    await logEvent({ userId, action: 'create', target: 'product_manual', detail: { code, name } });
    // 신규 제품 생성 → 개발목록 자동 매칭 점검(매칭 시 개발완료 전환) — 실패해도 생성은 유지
    let devMatch = null;
    try { devMatch = await sweepDevRequestMatches({ userId }); } catch (_) {}
    return { ok: true, id: Number(created.id), code, dev_match: devMatch ? { matched: devMatch.matched } : null };
  });

  // 제품 화면 수정 — 보낸 필드만 비교해 변경분만 반영. 재고·평균원가는 절대 불변.
  //   code 변경도 허용(유니크 검사). scode/app 이 오면 파생 데이터 재동기화.
  app.patch('/api/products/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'bad_id' });
    const b = req.body || {};
    const userId = req.ctx.perm.userId;
    const cur = (await query(
      `SELECT id, code, scode, app, name, sat_code, origin, list_price, iva_rate, ean, location,
              list_price_syd, price_customer_syd, price_customer_ctr, material, rack_location
         FROM products WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });

    const changes = {};
    const nextVals = {};
    // 코드 변경(선택)
    if (b.code !== undefined) {
      const nc = normEditValue('code', b.code);
      if (!nc) return reply.code(400).send({ error: 'code_required', detail: '제품코드는 비울 수 없습니다.' });
      if (!editEq(nc, cur.code, false)) {
        const dup = (await query(`SELECT id FROM products WHERE code=$1 AND id<>$2`, [nc, id])).rows[0];
        if (dup) return reply.code(409).send({ error: 'code_exists', detail: '이미 다른 제품이 사용 중인 코드입니다.' });
        changes.code = { from: cur.code, to: nc };
        nextVals.code = nc;
      }
    }
    for (const f of EDITABLE_FIELDS) {
      if (b[f] === undefined) continue;
      const nv = normEditValue(f, b[f]);
      if (f === 'name' && nv == null) return reply.code(400).send({ error: 'name_required', detail: '제품명은 비울 수 없습니다.' });
      if (!editEq(nv, cur[f], EDIT_NUMERIC.has(f))) {
        changes[f] = { from: cur[f] ?? null, to: nv };
        nextVals[f] = nv;
      }
    }
    const chFields = Object.keys(nextVals);
    const wantSyd = b.scode !== undefined;
    const wantApp = b.app !== undefined;
    if (!chFields.length && !wantSyd && !wantApp) return { ok: true, unchanged: true };

    await withTx(async (c) => {
      if (chFields.length) {
        const sets = []; const vals = [];
        for (const f of chFields) { vals.push(nextVals[f]); sets.push(`${f}=$${vals.length}`); }
        vals.push(userId); sets.push(`updated_by=$${vals.length}`);
        vals.push(id);
        await c.query(`UPDATE products SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
      }
      // 파생 데이터는 보낸 값 기준으로 항상 재동기화(업로드와 동일 불변식)
      if (wantSyd) await syncSydShared(c, id, splitSyd(nextVals.scode !== undefined ? nextVals.scode : cur.scode));
      if (wantApp) await syncAppShared(c, id, parseApplications(nextVals.app !== undefined ? nextVals.app : cur.app));
      if (chFields.length) {
        await logProductChange(c.query.bind(c), {
          productId: id, code: nextVals.code || cur.code, action: 'update', source: 'manual', changes, userId });
      }
    });
    if (chFields.length) {
      await logEvent({ userId, action: 'update', target: 'product_manual', detail: { code: nextVals.code || cur.code, fields: chFields } });
    }
    return { ok: true, changed: chFields };
  });

  // 제품 변경 이력 조회(디렉터). ?product_id= / ?code=(부분일치) / limit / offset
  app.get('/api/products/changelog', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const pid = req.query.product_id ? Number(req.query.product_id) : null;
    const code = String(req.query.code || '').trim();
    const conds = []; const params = [];
    if (pid && Number.isFinite(pid)) { params.push(pid); conds.push(`l.product_id = $${params.length}`); }
    if (code) { params.push('%' + code + '%'); conds.push(`l.code ILIKE $${params.length}`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const countParams = params.slice();
    params.push(limit, offset);
    const rows = (await query(
      `SELECT l.id, l.product_id, l.code, l.action, l.source, l.changes, l.created_at,
              u.name AS changed_by_name
         FROM product_change_log l
         LEFT JOIN users u ON u.id = l.changed_by
        ${where}
        ORDER BY l.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
    const total = Number((await query(
      `SELECT COUNT(*)::int AS n FROM product_change_log l ${where}`, countParams)).rows[0].n);
    return {
      items: rows.map((r) => ({
        id: Number(r.id), product_id: r.product_id != null ? Number(r.product_id) : null,
        code: r.code, action: r.action, source: r.source,
        changes: typeof r.changes === 'string' ? JSON.parse(r.changes) : r.changes,
        changed_by_name: r.changed_by_name || null, created_at: r.created_at,
      })),
      total, limit, offset,
    };
  });

  // ===== 제품 이력(2026-08-24) — 마스터 변경 + 판매상태 전환 통합 =====
  // 제품 화면 「📜 제품 이력」 탭. 기존 /changelog(디렉터 전용, 마스터 변경만)는 그대로 두고,
  // 화면용으로 두 피드를 합친 새 엔드포인트를 추가한다(기존 호출부 무영향).
  //   열: 변경기록 날짜 · CTR Code · 변경내역 · SYD Code · Estado · 변경자
  //   권한: 제품 페이지 열람자 전체. 단 가격류 변경 항목은 sale_price 권한자에게만 보인다.
  //   필터: q(코드·제품명 부분일치) · product_id · kind(all|master|status) · action
  //         · estado(''|1|0 — 그 변경 직후 상태) · from/to(날짜) · source
  app.get('/api/products/history', { preHandler: [authGuard, requirePage('products')] }, async (req) => {
    const { perm } = req.ctx;
    const canPrice = fieldVisible(perm, 'sale_price');
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const conds = []; const args = [];
    const kind = ['master', 'status'].includes(String(req.query.kind)) ? String(req.query.kind) : '';
    if (kind) { args.push(kind); conds.push(`f.kind = $${args.length}`); }
    if (req.query.product_id && Number.isFinite(Number(req.query.product_id))) {
      args.push(Number(req.query.product_id)); conds.push(`f.product_id = $${args.length}`);
    }
    const q = String(req.query.q || '').trim();
    if (q) {
      args.push('%' + q + '%');
      // 코드는 이력 스냅샷(f.code)과 현재 마스터(p.code) 양쪽으로 — 코드가 바뀐 제품도 찾히게.
      conds.push(`(f.code ILIKE $${args.length} OR p.code ILIKE $${args.length} OR p.name ILIKE $${args.length} OR p.scode ILIKE $${args.length})`);
    }
    const act = String(req.query.action || '');
    if (['create', 'update', 'activate', 'deactivate'].includes(act)) { args.push(act); conds.push(`f.action = $${args.length}`); }
    const src = String(req.query.source || '');
    if (src && /^[a-z_]{1,20}$/.test(src)) { args.push(src); conds.push(`f.source = $${args.length}`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ''))) { args.push(req.query.from); conds.push(`f.ts >= $${args.length}::date`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || ''))) { args.push(req.query.to); conds.push(`f.ts < ($${args.length}::date + 1)`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    // estado(그 변경 직후의 판매상태)는 계산값이라 바깥에서 거른다.
    let estadoCond = '';
    if (req.query.estado === '1' || req.query.estado === '0') estadoCond = req.query.estado === '1' ? 'TRUE' : 'FALSE';

    // 두 피드를 UNION → 제품 조인/필터(joined) → 그 시점 상태를 LATERAL 로 산출.
    //  · status 행 자신은 action 이 곧 결과 상태.
    //  · master 행은 그 시각 이전(같은 시각 포함)의 마지막 상태 전환을 따르고, 없으면 활성(기본값 TRUE).
    // ⚡ product_change_log 는 엑셀 업로드가 SKU 당 1행을 남겨 수만 행까지 자란다.
    //    Estado 필터가 없을 때는 **정렬·페이징을 먼저** 끝내고 그 페이지(≤200행)에만
    //    LATERAL 을 태운다 — 전체 행에 상태 조회를 도는 것을 피한다.
    const base = `
      WITH feed AS (
        SELECT 'master'::text AS kind, l.id AS src_id, l.product_id, l.code, l.action,
               COALESCE(l.source,'manual') AS source, l.changes, NULL::text AS reason,
               NULL::bigint AS check_id, l.changed_by, l.created_at AS ts
          FROM product_change_log l
         -- ⚠ 한 건씩 전환(PATCH /:id/active)은 product_status_log 와 product_change_log 에
         --   **양쪽 모두** 기록한다(source='status'). 그대로 UNION 하면 같은 전환이 두 줄로 보이므로
         --   여기서 제외하고, 상태 전환은 아래 product_status_log 한 곳에서만 가져온다.
         --   (일괄 점검 적용은 애초에 product_status_log 에만 기록 — 두 경로가 이걸로 통일된다)
         WHERE COALESCE(l.source,'manual') <> 'status'
        UNION ALL
        SELECT 'status'::text, s.id, s.product_id, s.code, s.action,
               CASE WHEN s.check_id IS NULL THEN 'status' ELSE 'status_check' END,
               NULL::jsonb, s.reason, s.check_id, s.changed_by, s.changed_at
          FROM product_status_log s
      ),
      joined AS (
        SELECT f.kind, f.src_id, f.product_id, f.code, f.action, f.source, f.changes, f.reason,
               f.check_id, f.changed_by, f.ts,
               p.code AS cur_code, p.name AS product_name, p.scode AS cur_scode,
               p.is_active AS cur_active, p.deleted_at AS prod_deleted_at
          FROM feed f
          LEFT JOIN products p ON p.id = f.product_id
        ${where}
      )`;
    const ESTADO = `CASE WHEN j.kind = 'status' THEN (j.action = 'activate')
                         ELSE COALESCE(st.action = 'activate', TRUE) END AS estado_active`;
    const LATERAL = `
          LEFT JOIN users u ON u.id = j.changed_by
          LEFT JOIN LATERAL (
            SELECT s2.action
              FROM product_status_log s2
             WHERE s2.product_id = j.product_id AND s2.changed_at <= j.ts
             ORDER BY s2.changed_at DESC, s2.id DESC
             LIMIT 1
          ) st ON TRUE`;

    let rows; let total;
    if (!estadoCond) {
      rows = (await query(
        `${base}, page AS (
           SELECT * FROM joined ORDER BY ts DESC, src_id DESC
            LIMIT $${args.length + 1} OFFSET $${args.length + 2}
         )
         SELECT j.*, u.name AS changed_by_name, ${ESTADO}
           FROM page j ${LATERAL}
          ORDER BY j.ts DESC, j.src_id DESC`,
        args.concat([limit, offset]))).rows;
      total = Number((await query(`${base} SELECT COUNT(*)::int AS n FROM joined`, args)).rows[0].n);
    } else {
      const enriched = `${base}, enriched AS (
        SELECT j.*, u.name AS changed_by_name, ${ESTADO} FROM joined j ${LATERAL}
      )`;
      rows = (await query(
        `${enriched}
         SELECT * FROM enriched WHERE estado_active = ${estadoCond}
          ORDER BY ts DESC, src_id DESC
          LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
        args.concat([limit, offset]))).rows;
      total = Number((await query(
        `${enriched} SELECT COUNT(*)::int AS n FROM enriched WHERE estado_active = ${estadoCond}`,
        args)).rows[0].n);
    }

    return {
      can_price: canPrice,
      items: rows.map((r) => {
        const changes = typeof r.changes === 'string' ? JSON.parse(r.changes) : r.changes;
        const { parts, hidden_price: hiddenPrice } = changeParts(changes, canPrice);
        return {
          key: `${r.kind}:${r.src_id}`,
          kind: r.kind, id: Number(r.src_id),
          product_id: r.product_id != null ? Number(r.product_id) : null,
          changed_at: r.ts,
          // CTR Code — 이력 스냅샷 우선(코드가 바뀐 뒤에도 그때 코드를 보여줌), 없으면 현재 마스터.
          code: r.code || r.cur_code || null,
          current_code: r.cur_code || null,
          product_name: r.product_name || null,
          syd_codes: sydForRow(changes, r.cur_scode),
          action: r.action, source: r.source,
          desc: describeRow({ kind: r.kind, action: r.action, source: r.source, changes, reason: r.reason, canPrice }),
          parts, hidden_price: hiddenPrice,
          reason: r.reason || null,
          check_id: r.check_id != null ? Number(r.check_id) : null,
          estado_active: r.estado_active !== false,
          current_active: r.cur_active !== false,
          product_deleted: !!r.prod_deleted_at,
          changed_by_name: r.changed_by_name || null,
        };
      }),
      total, limit, offset,
    };
  });

  // 이력 행 드릴다운 — 그 변경 **이후**의 movement (+ 전체 기간 대조).
  //   ?since=ISO(필수) · ?until=ISO(선택, 다음 변경 시각까지) · ?all=1(전체 기간) · ?limit
  //   ① 재고 입출고 원장(stock_movements) ② 판매 인보이스 라인 ③ 견적 라인
  //   판매·견적은 제품 드릴다운과 **같은 팀 가시성 규칙**을 쓴다(담당 고객만).
  //   금액은 sale_price 권한자에게만. 수량·건수는 항상.
  //
  // ⚠ 2026-08-24 수정 — 두 가지를 고쳤다.
  //   (1) **판매/견적의 기준 날짜**: `created_at`(= ERP 에 입력한 시각)이 아니라
  //       **`inv_date` / `quote_date`(= 실제 매출일·견적일)** 로 자른다.
  //       과거 인보이스를 나중에 입력하면 created_at 이 미래라 「변경 이후」에 잘못 끼고,
  //       반대로 마감 후 입력하면 빠진다. 매출총이익·누적판매 등 다른 화면이 전부
  //       inv_date 기준이므로 여기서도 맞춘다.
  //   (2) **상태 조건을 `status='posted'` 로 통일**. 기존엔 `<> 'deleted'` 라
  //       승인 대기(edit_pending) 건이 여기서만 판매로 잡혀 매출총이익과 숫자가 어긋났다.
  //   또한 「변경 이후 0건」이 데이터 문제인지 그냥 그 전에 팔린 것인지 화면에서 바로
  //   구분되도록 **전체 기간 누계(lifetime)** 를 항상 함께 내려준다.
  app.get('/api/products/:id/movements', { preHandler: [authGuard, requirePage('products')] }, async (req, reply) => {
    const { perm } = req.ctx;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'bad_id' });
    const since = String(req.query.since || '').trim();
    if (!since || Number.isNaN(Date.parse(since))) return reply.code(400).send({ error: 'since_required' });
    const all = req.query.all === '1' || req.query.all === 'true';
    const until = String(req.query.until || '').trim();
    const hasUntil = !all && !!until && !Number.isNaN(Date.parse(until));
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    const canPrice = fieldVisible(perm, 'sale_price');

    const prod = (await query(
      `SELECT id, code, name, scode, stock_qty, is_active FROM products WHERE id=$1`, [id])).rows[0];
    if (!prod) return reply.code(404).send({ error: 'not_found' });

    // ① 재고 입출고 — 변경 이후 전부(재고 역산에 쓰므로 until 로 자르지 않는다).
    //    all=1 이면 원장 전체.
    const moves = (await query(
      `SELECT m.id, m.move_type, m.qty, m.ref, m.note, m.source, m.moved_at,
              m.sales_invoice_id, m.batch_id, m.event_no,
              u.name AS created_by_name, cu.name AS customer_name, si.sat_no
         FROM stock_movements m
         LEFT JOIN users u ON u.id=m.created_by
         LEFT JOIN sales_invoices si ON si.id=m.sales_invoice_id
         LEFT JOIN customers cu ON cu.id=si.customer_id
        WHERE m.product_id=$1 ${all ? '' : 'AND m.moved_at >= $2::timestamptz'}
        ORDER BY m.moved_at ASC, m.id ASC`, all ? [id] : [id, since])).rows;
    // 재고 역산은 항상 「변경 시점 이후」 원장으로 한다(all 모드여도 기준은 그 변경).
    const movesSince = all ? moves.filter((r) => new Date(r.moved_at) >= new Date(since)) : moves;

    const vis = visibleTeamIds(perm);
    // 판매 — 매출총이익·누적판매와 같은 조건(posted, 미삭제) + 같은 팀 가시성.
    const sArgs = [id];
    let teamCond = '';
    if (vis !== null) { sArgs.push(vis.length ? vis : [-1]); teamCond = ` AND cu.team_id = ANY($${sArgs.length})`; }
    let sinceCondS = '';
    if (!all) { sArgs.push(since); sinceCondS = ` AND si.inv_date >= ($${sArgs.length}::timestamptz)::date`; }
    let untilCondS = '';
    if (hasUntil) { sArgs.push(until); untilCondS = ` AND si.inv_date <= ($${sArgs.length}::timestamptz)::date`; }
    const salesRows = (await query(
      `SELECT si.id, si.sat_no, to_char(si.inv_date,'YYYY-MM-DD') AS inv_date, si.created_at, si.status,
              cu.name AS customer_name, sil.qty, sil.unit_price, sil.line_amount_mxn
         FROM sales_invoice_lines sil
         JOIN sales_invoices si ON si.id=sil.invoice_id
         JOIN customers cu ON cu.id=si.customer_id
        WHERE sil.product_id=$1 AND si.deleted_at IS NULL AND si.status='posted'
          ${teamCond}${sinceCondS}${untilCondS}
        ORDER BY si.inv_date ASC, si.id ASC
        LIMIT ${limit}`, sArgs)).rows;

    const qArgs = [id];
    let teamCondQ = '';
    if (vis !== null) { qArgs.push(vis.length ? vis : [-1]); teamCondQ = ` AND cu.team_id = ANY($${qArgs.length})`; }
    let sinceCondQ = '';
    if (!all) { qArgs.push(since); sinceCondQ = ` AND q.quote_date >= ($${qArgs.length}::timestamptz)::date`; }
    let untilCondQ = '';
    if (hasUntil) { qArgs.push(until); untilCondQ = ` AND q.quote_date <= ($${qArgs.length}::timestamptz)::date`; }
    const quoteRows = (await query(
      `SELECT q.id, q.quote_no, to_char(q.quote_date,'YYYY-MM-DD') AS quote_date, q.created_at, q.status,
              cu.name AS customer_name, ql.qty, ql.final_price, ql.line_subtotal
         FROM quote_lines ql
         JOIN quotes q ON q.id=ql.quote_id
         JOIN customers cu ON cu.id=q.customer_id
        WHERE ql.product_id=$1 AND q.deleted_at IS NULL${teamCondQ}${sinceCondQ}${untilCondQ}
        ORDER BY q.quote_date ASC, q.id ASC
        LIMIT ${limit}`, qArgs)).rows;

    // 전체 기간 누계 — 「변경 이후 0건」이 이상한 건지 아닌지 화면에서 바로 판단하도록.
    //   조건은 제품 드릴다운 매출총이익과 **완전히 동일**해서 두 화면 숫자가 반드시 맞는다.
    const lArgs = [id];
    let teamCondL = '';
    if (vis !== null) { lArgs.push(vis.length ? vis : [-1]); teamCondL = ` AND cu.team_id = ANY($${lArgs.length})`; }
    const life = (await query(
      `SELECT COUNT(DISTINCT si.id)::int AS cnt, COALESCE(SUM(sil.qty),0) AS qty,
              COALESCE(SUM(sil.line_amount_mxn),0) AS amount,
              to_char(MIN(si.inv_date),'YYYY-MM-DD') AS first_date,
              to_char(MAX(si.inv_date),'YYYY-MM-DD') AS last_date
         FROM sales_invoice_lines sil
         JOIN sales_invoices si ON si.id=sil.invoice_id
         JOIN customers cu ON cu.id=si.customer_id
        WHERE sil.product_id=$1 AND si.deleted_at IS NULL AND si.status='posted'${teamCondL}`,
      lArgs)).rows[0];
    const lifeQ = (await query(
      `SELECT COUNT(DISTINCT q.id)::int AS cnt, COALESCE(SUM(ql.qty),0) AS qty
         FROM quote_lines ql
         JOIN quotes q ON q.id=ql.quote_id
         JOIN customers cu ON cu.id=q.customer_id
        WHERE ql.product_id=$1 AND q.deleted_at IS NULL${teamCondL}`, lArgs)).rows[0];
    // 승인 대기(edit_pending/delete_pending)로 집계에서 빠진 건이 있으면 화면에 알려준다
    // — 「팔았는데 0으로 보인다」의 흔한 원인이라 숨기지 않는다.
    const pend = (await query(
      `SELECT COUNT(DISTINCT si.id)::int AS cnt, COALESCE(SUM(sil.qty),0) AS qty
         FROM sales_invoice_lines sil
         JOIN sales_invoices si ON si.id=sil.invoice_id
         JOIN customers cu ON cu.id=si.customer_id
        WHERE sil.product_id=$1 AND si.deleted_at IS NULL
          AND si.status IN ('edit_pending','delete_pending')${teamCondL}`, lArgs)).rows[0];

    const movesAll = movesSince.map((r) => ({ move_type: r.move_type, qty: Number(r.qty) }));
    const stockBefore = stockAtChange(prod.stock_qty, movesAll);
    const shown = hasUntil ? moves.filter((r) => new Date(r.moved_at) < new Date(until)) : moves;
    const capped = shown.length > limit;
    const stockItems = shown.slice(0, limit).map((r) => ({
      id: Number(r.id), move_type: r.move_type, qty: Number(r.qty),
      signed_qty: signedQty(r.move_type, r.qty), moved_at: r.moved_at,
      ref: r.ref || null, note: r.note || null, event_no: r.event_no == null ? null : Number(r.event_no),
      origin: r.sales_invoice_id ? '매출' : (r.batch_id ? '수입' : (r.source === 'manual' ? '수동' : '기타')),
      customer_name: r.customer_name || null, sat_no: r.sat_no || null,
      created_by_name: r.created_by_name || null,
    }));
    const inQty = shown.reduce((s, r) => s + (r.move_type === 'in' ? Number(r.qty) : 0), 0);
    const outQty = shown.reduce((s, r) => s + (r.move_type === 'out' ? Number(r.qty) : 0), 0);
    const adjQty = shown.reduce((s, r) => s + (r.move_type === 'adjust' ? Number(r.qty) : 0), 0);
    const r3 = (n) => Math.round(n * 1000) / 1000;
    const r2 = (n) => Math.round(n * 100) / 100;

    return {
      product: {
        id: Number(prod.id), code: prod.code, name: prod.name, scode: prod.scode || null,
        stock_qty: Number(prod.stock_qty) || 0, is_active: prod.is_active !== false,
      },
      since, until: hasUntil ? until : null, all, can_price: canPrice,
      // 변경 시점 재고 → 현재 재고 (원장이 재고의 유일한 변동원이므로 역산이 성립)
      stock_before: stockBefore, stock_now: Number(prod.stock_qty) || 0,
      // 전체 기간 누계 — 제품 드릴다운 「매출총이익」과 같은 조건이라 두 화면 숫자가 항상 일치.
      lifetime: {
        sales_count: Number(life.cnt) || 0,
        sales_qty: r3(Number(life.qty) || 0),
        sales_amount: canPrice ? r2(Number(life.amount) || 0) : null,
        first_sale_date: life.first_date || null,
        last_sale_date: life.last_date || null,
        quote_count: Number(lifeQ.cnt) || 0,
        quote_qty: r3(Number(lifeQ.qty) || 0),
        // 승인 대기라 매출 집계에 아직 안 잡히는 건(있으면 화면에 안내)
        pending_count: Number(pend.cnt) || 0,
        pending_qty: r3(Number(pend.qty) || 0),
      },
      basis: '판매·견적은 매출일(inv_date)·견적일(quote_date) 기준 · 발행(posted) 인보이스만 — 제품 드릴다운 매출총이익과 동일',
      totals: {
        move_count: shown.length, in_qty: r3(inQty), out_qty: r3(outQty), adjust_qty: r3(adjQty),
        sales_count: salesRows.length,
        sales_qty: r3(salesRows.reduce((s, r) => s + Number(r.qty), 0)),
        sales_amount: canPrice ? r2(salesRows.reduce((s, r) => s + Number(r.line_amount_mxn || 0), 0)) : null,
        quote_count: quoteRows.length,
        quote_qty: r3(quoteRows.reduce((s, r) => s + Number(r.qty), 0)),
        quote_amount: canPrice ? r2(quoteRows.reduce((s, r) => s + Number(r.line_subtotal || 0), 0)) : null,
      },
      stock: stockItems, capped,
      sales: salesRows.map((r) => ({
        id: Number(r.id), sat_no: r.sat_no || null, inv_date: r.inv_date, created_at: r.created_at,
        status: r.status, customer_name: r.customer_name, qty: Number(r.qty),
        unit_price: canPrice && r.unit_price != null ? Number(r.unit_price) : null,
        amount_mxn: canPrice && r.line_amount_mxn != null ? Number(r.line_amount_mxn) : null,
      })),
      quotes: quoteRows.map((r) => ({
        id: Number(r.id), quote_no: r.quote_no || null, quote_date: r.quote_date, created_at: r.created_at,
        status: r.status, customer_name: r.customer_name, qty: Number(r.qty),
        unit_price: canPrice && r.final_price != null ? Number(r.final_price) : null,
        amount_mxn: canPrice && r.line_subtotal != null ? Number(r.line_subtotal) : null,
      })),
    };
  });

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
          {
            const chg = {};
            for (const f of UPDATABLE_FIELDS) if (f in p && p[f] != null) chg[f] = { from: null, to: p[f] };
            await logProductChange(c.query.bind(c), { productId: Number(r.id), code: p.code, action: 'create', source: 'import', changes: chg, userId });
          }
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
          if (chFields.length > 0 || d.syd_changed || d.app_changed) {
            const chg = { ...d.changes };
            if (d.syd_changed) chg._syd = { from: ex.syd_codes || [], to: p.syd_codes };
            if (d.app_changed) chg._app = { from: (ex.app_texts || []).length, to: (p.applications || []).length };
            await logProductChange(c.query.bind(c), { productId: Number(ex.id), code: p.code, action: 'update', source: 'import', changes: chg, userId });
            updated++;
          } else unchanged++;
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
    // 마스터 업로드 커밋 → 개발목록 자동 매칭 점검(신규 CTR/SYD 코드가 개발요청과 매칭되면 개발완료 전환)
    let devMatch = null;
    try { devMatch = await sweepDevRequestMatches({ userId }); } catch (_) {}
    return { ok: true, created, updated, unchanged, skipped, dev_match: devMatch ? { matched: devMatch.matched } : null };
  });

  // ===== 소재(material) 지정 =====
  // 제품 1건 소재 인라인 편집(디렉터). body { material } — 빈값/null이면 해제.
  app.patch('/api/products/:id/material', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'bad_id' });
    const material = normalizeMaterial((req.body || {}).material);
    const prev = (await query(`SELECT material FROM products WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    const r = (await query(
      `UPDATE products SET material=$1, updated_by=$2 WHERE id=$3 AND deleted_at IS NULL RETURNING id, code, material`,
      [material, req.ctx.perm.userId, id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: 'product_material', detail: { code: r.code, material } });
    if (!editEq(prev ? prev.material : null, material, false)) {
      await logProductChange(query, {
        productId: Number(r.id), code: r.code, action: 'update', source: 'material',
        changes: { material: { from: prev ? prev.material : null, to: material } }, userId: req.ctx.perm.userId });
    }
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
    // 변경 전 값 스냅샷(이력용) — 실제로 값이 바뀌는 제품만 로그에 남김
    const prevRows = (await query(
      `SELECT id, code, material FROM products WHERE code = ANY($1) AND deleted_at IS NULL`, [codes])).rows;
    const updated = (await query(
      `UPDATE products SET material=$1, updated_by=$2
        WHERE code = ANY($3) AND deleted_at IS NULL
        RETURNING code`,
      [material, req.ctx.perm.userId, codes])).rows.map((r) => r.code);
    for (const pr of prevRows) {
      if (editEq(pr.material, material, false)) continue;
      await logProductChange(query, {
        productId: Number(pr.id), code: pr.code, action: 'update', source: 'material_bulk',
        changes: { material: { from: pr.material ?? null, to: material } }, userId: req.ctx.perm.userId });
    }
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
    // q에 '||'로 여러 모델명을 넘기면 OR 합집합으로 매칭 (예: 'Jetta 4 PTAS||Jetta').
    //   세대 표기 차이(적용차종=Jetta Vi, VIO=Jetta 4 PTAS)로 좁은 질의가 일부만 잡던 문제 해결.
    const terms = raw.split('||').map((t) => t.trim()).filter((t) => t.length >= 2);
    if (!terms.length) return empty;
    const likeParams = terms.map((t) => '%' + t.replace(/([%_\\])/g, '\\$1') + '%');
    const like = likeParams[0]; // VIO 순위 조회(vio_model ILIKE)용 — 대표 term 기준
    const orModel = terms.map((_, i) => `pa.model ILIKE $${i + 1}`).join(' OR ');
    const orApp = terms.map((_, i) => `pa.app_text ILIKE $${i + 1}`).join(' OR ');

    // 1) 검색 모델에 걸리는 개별 차량 적용 항목 + 제품 기본(코드=CTR, 이름=DESCRIPCIÓN)
    const appRows = (await query(
      `SELECT pa.product_id, pa.maker, pa.model, pa.year_from, pa.year_to,
              p.code AS ctr, p.name, p.stock_qty, p.list_price, p.list_price_syd
         FROM product_applications pa
         JOIN products p ON p.id = pa.product_id AND p.deleted_at IS NULL
        WHERE ((${orModel}) OR (${orApp}))
          AND pa.model IS NOT NULL AND pa.model <> ''`, likeParams)).rows;
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

    // 1-c) 고객별 판매 내역(툴팁용) — 제품별 고객명+수량, 수량 내림차순 상위 20명.
    //   sold 합계와 동일한 팀 가시성·게시·미삭제 조건. 가격 권한과 무관(수량·고객명만).
    const custParams = [pids];
    let custTeamCond = '';
    if (vis !== null) { custParams.push(vis.length ? vis : [-1]); custTeamCond = ' AND cu.team_id = ANY($2)'; }
    const custRows = (await query(
      `SELECT sil.product_id, cu.name AS customer, SUM(sil.qty) AS qty
         FROM sales_invoice_lines sil
         JOIN sales_invoices si ON si.id = sil.invoice_id
         JOIN customers cu ON cu.id = si.customer_id
        WHERE si.status = 'posted' AND si.deleted_at IS NULL
          AND sil.product_id = ANY($1)${custTeamCond}
        GROUP BY sil.product_id, cu.name`, custParams)).rows;
    const custByPid = {};
    for (const c of custRows) {
      const pid = Number(c.product_id);
      (custByPid[pid] ||= []).push({ customer: c.customer || '(미지정)', qty: Number(c.qty) });
    }
    for (const pid of Object.keys(custByPid)) {
      custByPid[pid].sort((a, b) => b.qty - a.qty);
      custByPid[pid] = custByPid[pid].slice(0, 20); // 상위 20명
    }

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
    const classify = (name, code) => {
      const n = String(name || '').toUpperCase();
      for (const c of CATS) if (c.test(n)) return c.key;
      const cd = String(code || '');
      if (/^CB/i.test(cd)) return 'rotula'; // CB* 코드 = Rótula(볼조인트)
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

      const catKey = classify(r.name, r.ctr);
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
          sold_by: custByPid[Number(r.product_id)] || [],
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

  // VIO 제품찾기 — CTR/SYD 코드로 적용 차종(모델) 역검색.
  //   입력 코드가 걸린 제품(들)의 product_applications 모델 목록을 반환 → 화면에서 해당 차종만 필터.
  //   매칭: products.code(CTR) 정확/부분 · products.scode · product_syd_codes.syd_code.
  app.get('/api/products/models-by-code', { preHandler: [authGuard, requirePage('products')] }, async (req) => {
    const code = String(req.query.code || '').trim();
    const out = { code, matched: [], models: [] };
    if (code.length < 2) return out;
    const esc = code.replace(/([%_\\])/g, '\\$1');
    const like = '%' + esc + '%';
    const prod = (await query(
      `SELECT DISTINCT p.id, p.code
         FROM products p
         LEFT JOIN product_syd_codes sc ON sc.product_id = p.id
        WHERE p.deleted_at IS NULL
          AND (p.code ILIKE $1 OR p.scode ILIKE $1 OR sc.syd_code ILIKE $1)
        LIMIT 200`, [like])).rows;
    if (!prod.length) return out;
    const pids = prod.map((r) => Number(r.id));
    out.matched = prod.map((r) => r.code);
    const models = (await query(
      `SELECT DISTINCT pa.maker, pa.model
         FROM product_applications pa
        WHERE pa.product_id = ANY($1) AND pa.model IS NOT NULL AND pa.model <> ''`, [pids])).rows;
    out.models = models.map((r) => ({ maker: r.maker || '', model: r.model }));
    return out;
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

  // ===================================================================
  // 0179 · 제품 활성/비활성 (디렉터 전용)
  //
  //   비활성 = 신규 사용 차단(견적 라인 추가·오퍼시트 생성). 과거 기록은 불변 —
  //   매출·매출총이익·원가 내역은 비활성 이후에도 그대로 조회된다.
  //   전환 자체는 막지 않고, 걸려 있는 항목을 업체별로 정리해 보여준 뒤 진행한다.
  // ===================================================================

  // 이 SKU 가 지금 걸려 있는 미결 항목(업체별) — 전환 전 확인용.
  app.get('/api/products/:id/pipeline', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_product' });
    const res = await productOpenItems(id);
    if (!res) return reply.code(404).send({ error: 'not_found' });
    return res;
  });

  // 활성/비활성 전환. body: { active: boolean, reason?: string, check_id?: number }
  //   미결 항목이 있어도 막지 않는다(경고 후 진행) — 전환 시점의 요약을 이력에 남긴다.
  app.patch('/api/products/:id/active', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const { perm } = req.ctx;
    const id = Number(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_product' });
    const active = req.body?.active === true || String(req.body?.active) === 'true';
    const reason = String(req.body?.reason || '').trim() || null;
    const checkId = Number(req.body?.check_id) || null;

    const cur = (await query(
      `SELECT id, code, is_active FROM products WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if ((cur.is_active !== false) === active) {
      return { ok: true, unchanged: true, id, is_active: active };
    }
    const snap = await productOpenItems(id);
    await withTx(async (client) => {
      const exec = (t, p) => client.query(t, p);
      await exec(
        `UPDATE products
            SET is_active=$2, inactive_reason=$3, status_changed_at=now(), status_changed_by=$4,
                updated_at=now(), updated_by=$4
          WHERE id=$1`, [id, active, active ? null : reason, perm.userId]);
      await exec(
        `INSERT INTO product_status_log (product_id, code, action, reason, check_id, open_summary, changed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, cur.code, active ? 'activate' : 'deactivate', reason, checkId,
          snap ? JSON.stringify({ open_total: snap.open_total, summary: snap.summary }) : null, perm.userId]);
      if (checkId) {
        await exec(
          `UPDATE product_status_check_items SET applied_at=now(), applied_by=$3
            WHERE check_id=$1 AND product_id=$2`, [checkId, id, perm.userId]);
      }
      await logProductChange(exec, {
        productId: id, code: cur.code, action: 'update', source: 'status',
        changes: { is_active: { from: cur.is_active !== false, to: active }, reason }, userId: perm.userId,
      });
    });
    // audit_log.action 의 CHECK 목록에 'deactivate' 가 없어 'update' 로 기록한다.
    await logEvent({
      userId: perm.userId, action: 'update', target: 'product_active',
      detail: { id, code: cur.code, to: active ? 'active' : 'inactive', reason, open_total: snap ? snap.open_total : null },
    });
    return { ok: true, id, is_active: active, open_total: snap ? snap.open_total : 0 };
  });

  // 여러 SKU 일괄 점검 → 배치로 저장(이력에서 재열람).
  // body: { ids:[productId...], title?, note?, mode? }  mode 미지정 시 현재 상태로 자동 판정
  //   (활성 SKU → 비활성 검토 / 비활성 SKU → 활성화(판매재개) 검토)
  app.post('/api/products/status-check', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const { perm } = req.ctx;
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : [])
      .map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))];
    if (!ids.length) return reply.code(400).send({ error: 'no_products' });
    if (ids.length > 300) return reply.code(400).send({ error: 'too_many', max: 300 });

    const results = [];
    for (const pid of ids) {
      const r = await productOpenItems(pid);
      if (!r) continue;
      results.push(r);
    }
    if (!results.length) return reply.code(404).send({ error: 'not_found' });

    const anyActive = results.some((r) => r.product.is_active);
    const anyInactive = results.some((r) => !r.product.is_active);
    const mode = ['deactivate', 'activate', 'mixed'].includes(req.body?.mode)
      ? req.body.mode
      : (anyActive && anyInactive ? 'mixed' : (anyActive ? 'deactivate' : 'activate'));
    const openCount = results.filter((r) => r.open_total > 0).length;
    const title = String(req.body?.title || '').trim()
      || `${results.length}개 SKU 점검 (${mode === 'activate' ? '판매재개' : mode === 'deactivate' ? '판매중단' : '혼합'})`;
    const note = String(req.body?.note || '').trim() || null;

    let checkId = null;
    await withTx(async (client) => {
      checkId = Number((await client.query(
        `INSERT INTO product_status_checks (title, mode, sku_count, open_count, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [title, mode, results.length, openCount, note, perm.userId])).rows[0].id);
      for (const r of results) {
        await client.query(
          `INSERT INTO product_status_check_items
             (check_id, product_id, code, name, was_active, target_active, open_total, summary, detail)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [checkId, r.product.id, r.product.code, r.product.name, r.product.is_active,
            !r.product.is_active, r.open_total,
            JSON.stringify(r.summary), JSON.stringify({ parties: r.parties })]);
      }
    });
    await logEvent({
      userId: perm.userId, action: 'read', target: 'product_status_check',
      detail: { check_id: checkId, skus: results.length, open: openCount, mode },
    });
    return { ok: true, check: { id: checkId, title, mode, sku_count: results.length, open_count: openCount, note },
      items: results.map((r) => ({
        product: r.product, open_total: r.open_total, summary: r.summary,
        parties: r.parties, target_active: !r.product.is_active,
      })),
      buckets: STATUS_BUCKETS };
  });

  // 점검 이력 목록
  app.get('/api/products/status-checks', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = (await query(
      `SELECT c.id, c.title, c.mode, c.sku_count, c.open_count, c.note, c.created_at,
              u.name AS created_by_name,
              (SELECT COUNT(*)::int FROM product_status_check_items i
                WHERE i.check_id=c.id AND i.applied_at IS NOT NULL) AS applied_count,
              (SELECT COUNT(*)::int FROM product_status_check_notes nt
                WHERE nt.check_id=c.id AND nt.state='done') AS done_notes
         FROM product_status_checks c
         LEFT JOIN users u ON u.id = c.created_by
        WHERE c.deleted_at IS NULL
        ORDER BY c.created_at DESC
        LIMIT $1`, [limit])).rows;
    return { items: rows.map((r) => ({ ...r, id: Number(r.id) })) };
  });

  // 점검 배치 상세(저장 당시 스냅샷 + 업체별 메모)
  app.get('/api/products/status-checks/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_check' });
    const chk = (await query(
      `SELECT c.*, u.name AS created_by_name FROM product_status_checks c
         LEFT JOIN users u ON u.id=c.created_by
        WHERE c.id=$1 AND c.deleted_at IS NULL`, [id])).rows[0];
    if (!chk) return reply.code(404).send({ error: 'not_found' });
    const items = (await query(
      `SELECT i.*, p.is_active AS current_active
         FROM product_status_check_items i
         JOIN products p ON p.id = i.product_id
        WHERE i.check_id=$1
        ORDER BY i.open_total DESC, i.code`, [id])).rows;
    const notes = (await query(
      `SELECT n.*, u.name AS updated_by_name FROM product_status_check_notes n
         LEFT JOIN users u ON u.id=n.updated_by
        WHERE n.check_id=$1`, [id])).rows;
    return {
      check: { ...chk, id: Number(chk.id) },
      items: items.map((i) => ({
        id: Number(i.id), product_id: Number(i.product_id), code: i.code, name: i.name,
        was_active: i.was_active, target_active: i.target_active, current_active: i.current_active,
        open_total: Number(i.open_total || 0), summary: i.summary,
        parties: (i.detail && i.detail.parties) || [],
        applied_at: i.applied_at,
      })),
      notes: notes.map((nt) => ({
        product_id: Number(nt.product_id), party: nt.party, state: nt.state, memo: nt.memo,
        updated_at: nt.updated_at, updated_by_name: nt.updated_by_name,
      })),
      buckets: STATUS_BUCKETS,
    };
  });

  // 업체별 처리결과 메모 저장(업서트). body: { product_id, party, state, memo }
  app.post('/api/products/status-checks/:id/note', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const { perm } = req.ctx;
    const checkId = Number(req.params.id);
    const productId = Number(req.body?.product_id);
    if (!checkId || !productId) return reply.code(400).send({ error: 'bad_request' });
    const party = String(req.body?.party ?? '').trim();
    const state = ['todo', 'doing', 'done'].includes(req.body?.state) ? req.body.state : 'todo';
    const memo = String(req.body?.memo || '').trim() || null;
    const exists = (await query(
      `SELECT 1 FROM product_status_check_items WHERE check_id=$1 AND product_id=$2`, [checkId, productId])).rows[0];
    if (!exists) return reply.code(404).send({ error: 'not_in_check' });
    await query(
      `INSERT INTO product_status_check_notes (check_id, product_id, party, state, memo, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (check_id, product_id, party)
       DO UPDATE SET state=EXCLUDED.state, memo=EXCLUDED.memo,
                     updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [checkId, productId, party, state, memo, perm.userId]);
    return { ok: true };
  });

  // 점검 배치에서 선택한 SKU 를 실제로 전환. body: { product_ids?: [], reason? }
  //   product_ids 미지정 시 배치의 전 SKU 를 target_active 대로 전환.
  app.post('/api/products/status-checks/:id/apply', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const { perm } = req.ctx;
    const checkId = Number(req.params.id);
    if (!checkId) return reply.code(400).send({ error: 'bad_check' });
    const only = Array.isArray(req.body?.product_ids)
      ? new Set(req.body.product_ids.map((x) => Number(x))) : null;
    const reason = String(req.body?.reason || '').trim() || null;
    const items = (await query(
      `SELECT i.product_id, i.code, i.target_active, p.is_active
         FROM product_status_check_items i
         JOIN products p ON p.id=i.product_id AND p.deleted_at IS NULL
        WHERE i.check_id=$1`, [checkId])).rows
      .filter((r) => !only || only.has(Number(r.product_id)));
    if (!items.length) return reply.code(400).send({ error: 'no_targets' });

    let changed = 0;
    await withTx(async (client) => {
      for (const r of items) {
        const target = r.target_active === true;
        if ((r.is_active !== false) === target) continue;
        await client.query(
          `UPDATE products SET is_active=$2, inactive_reason=$3, status_changed_at=now(),
                               status_changed_by=$4, updated_at=now(), updated_by=$4
            WHERE id=$1`, [r.product_id, target, target ? null : reason, perm.userId]);
        await client.query(
          `INSERT INTO product_status_log (product_id, code, action, reason, check_id, changed_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [r.product_id, r.code, target ? 'activate' : 'deactivate', reason, checkId, perm.userId]);
        await client.query(
          `UPDATE product_status_check_items SET applied_at=now(), applied_by=$3
            WHERE check_id=$1 AND product_id=$2`, [checkId, r.product_id, perm.userId]);
        changed += 1;
      }
    });
    await logEvent({
      userId: perm.userId, action: 'update', target: 'product_status_check_apply',
      detail: { check_id: checkId, targets: items.length, changed, reason },
    });
    return { ok: true, changed, targets: items.length };
  });

  // 점검 이력 삭제(소프트)
  app.delete('/api/products/status-checks/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const { perm } = req.ctx;
    const id = Number(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_check' });
    await query(`UPDATE product_status_checks SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL`, [id]);
    await logEvent({ userId: perm.userId, action: 'delete', target: 'product_status_check', detail: { id } });
    return { ok: true };
  });

}

