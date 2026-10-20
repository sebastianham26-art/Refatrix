import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { orderCoverage } from '../shortageReceipt.js';
import { ACTIVE_RESERVATION_SQL } from '../reservations.js';
import { PAIR_KEY_SQL, pairCode } from '../lrPair.js';   // 2026-10-20 · L/R 짝맞춤
import { FACTORY_STATUS, MOQ_BY_ORIGIN, planFactoryChanges, tableToRows } from '../factoryInfo.js';   // 2026-10-20 · 공장 SKU 정보   // 2026-10-19 · 가용재고 = 재고 − 살아 있는 견적 예약   // 2026-10-15 · 부족분 ↔ 발주 ↔ 입고
import { fobAtDate, fobMismatchByPo, fobStatus, mxToday, isYmd } from '../priceMaster.js';   // 0229 — 가격 마스터 FOB 로 구매 단가 검증

// 구매단가(USD) 열람 권한: 디렉터·소시오만 공개. 그 외 역할은 값 자체를 내려주지 않음(null).
export function canSeeCost(perm) {
  return perm.role === 'director' || perm.role === 'socio';
}

// "1,234.50" / " 100 " / 빈칸 등 방어적 숫자 파싱 → 실패 시 null
export function parseNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/,/g, '').replace(/\s+/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// 업로드 행 정규화·검증. 반환: { valid:[{code,qty,cost,amount,ref}], errors:[{i,code,reason}] }
// (미등록 코드는 valid 로 남기고 매칭 단계에서 product_id=null 로 보존 — 기록은 잃지 않음)
export function normalizeRows(rows) {
  const valid = [];
  const errors = [];
  (rows || []).forEach((r, i) => {
    const code = (r.code == null ? '' : String(r.code)).trim();
    const ref = (r.ref == null ? '' : String(r.ref)).trim();
    const qty = parseNum(r.qty);
    const cost = parseNum(r.cost_usd);
    const rowNo = r._row || (i + 1);
    if (!code) { errors.push({ i: rowNo, code, reason: '제품코드 없음' }); return; }
    if (!ref) { errors.push({ i: rowNo, code, reason: '구매참조번호 없음' }); return; }
    if (qty === null || qty <= 0) { errors.push({ i: rowNo, code, reason: '수량 오류(숫자·>0)' }); return; }
    if (cost === null || cost < 0) { errors.push({ i: rowNo, code, reason: '구매원가 오류(숫자·≥0)' }); return; }
    valid.push({ code, ref, qty, cost, amount: Math.round(qty * cost * 100) / 100 });
  });
  return { valid, errors };
}

// 코드 → 제품 매칭 맵(소문자 기준). rows: [{code,...}]
async function matchProducts(codes) {
  const lc = [...new Set(codes.map((c) => c.toLowerCase()))];
  if (!lc.length) return new Map();
  const r = await query(
    `SELECT id, code FROM products WHERE lower(code) = ANY($1) AND deleted_at IS NULL`, [lc]);
  const m = new Map();
  for (const row of r.rows) m.set(String(row.code).toLowerCase(), { id: Number(row.id), code: row.code });
  return m;
}

export default async function purchaseRoutes(app) {
  const gate = { preHandler: [authGuard, requirePage('purchase')] };

  // 미리보기: 검증·매칭 결과만 반환(DB 기록 없음)
  app.post('/api/purchases/preview', gate, async (req, reply) => {
    const { rows = [] } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) return reply.code(400).send({ error: 'rows_required' });
    const seeCost = canSeeCost(req.ctx.perm);
    const { valid, errors } = normalizeRows(rows);
    const matched = await matchProducts(valid.map((v) => v.code));
    const lines = valid.map((v) => {
      const p = matched.get(v.code.toLowerCase());
      const base = { ...v, product_id: p ? p.id : null, matched: !!p };
      if (!seeCost) { base.cost = null; base.amount = null; }   // 구매단가 비공개
      return base;
    });
    // 0229 — 가격 마스터 FOB(주문일 기준)와 비교. 구매단가를 볼 수 있는 사람에게만(디렉터·소시오).
    let fobBad = 0;
    if (seeCost) {
      const od = isYmd(req.body && req.body.order_date) ? req.body.order_date : mxToday();
      const fobs = await fobAtDate(lines.map((l) => l.product_id), od);
      if (fobs) for (const l of lines) {
        const f = l.product_id != null && fobs.has(l.product_id) ? fobs.get(l.product_id) : null;
        l.fob_usd = f;
        l.fob_status = fobStatus(l.cost, f, l.product_id, 0);
        if (l.fob_status === 'over' || l.fob_status === 'under') fobBad++;
      }
    }
    // 참조번호별 그룹 요약
    const groups = {};
    for (const l of lines) {
      const g = groups[l.ref] || (groups[l.ref] = { ref: l.ref, line_count: 0, total_qty: 0, total_usd: 0, unmatched: 0 });
      g.line_count += 1; g.total_qty += l.qty; g.total_usd += (l.amount || 0); if (!l.matched) g.unmatched += 1;
    }
    // 이미 기록된 동일 참조번호 경고
    const refs = Object.keys(groups);
    let existing = [];
    if (refs.length) {
      const er = await query(
        `SELECT ref_no, COUNT(*)::int AS n FROM purchase_orders
         WHERE deleted_at IS NULL AND ref_no = ANY($1) GROUP BY ref_no`, [refs]);
      existing = er.rows.map((x) => ({ ref: x.ref_no, n: Number(x.n) }));
    }
    return {
      cost_visible: seeCost,
      lines,
      errors,
      groups: Object.values(groups).map((g) => ({ ...g, total_qty: Math.round(g.total_qty * 1000) / 1000, total_usd: seeCost ? Math.round(g.total_usd * 100) / 100 : null })),
      existing_refs: existing,
      summary: { total: lines.length, matched: lines.filter((l) => l.matched).length, unmatched: lines.filter((l) => !l.matched).length, error_rows: errors.length, fob_mismatch: seeCost ? fobBad : null },
    };
  });

  // 기록(커밋): 유효행을 참조번호 단위 PO 로 그룹핑해 저장. 오류행은 건너뛰고 요약 반환(전체 롤백 아님).
  app.post('/api/purchases', gate, async (req, reply) => {
    const { rows = [], note = null, order_date = null } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) return reply.code(400).send({ error: 'rows_required' });
    const { valid, errors } = normalizeRows(rows);
    if (!valid.length) return reply.code(400).send({ error: 'no_valid_rows', errors });
    const matched = await matchProducts(valid.map((v) => v.code));
    const userId = req.ctx.perm.userId;

    // 참조번호 단위 그룹
    const byRef = new Map();
    for (const v of valid) {
      const p = matched.get(v.code.toLowerCase());
      const item = { input_code: v.code, product_id: p ? p.id : null, qty: v.qty, unit_cost_usd: v.cost, amount_usd: v.amount };
      if (!byRef.has(v.ref)) byRef.set(v.ref, []);
      byRef.get(v.ref).push(item);
    }

    const out = await withTx(async (c) => {
      const created = [];
      for (const [ref, items] of byRef) {
        const po = (await c.query(
          `INSERT INTO purchase_orders (ref_no, order_date, currency, status, note, created_by)
           VALUES ($1, COALESCE($2::date, CURRENT_DATE), 'USD', 'recorded', $3, $4) RETURNING id`,
          [ref, order_date, note, userId])).rows[0];
        for (const it of items) {
          await c.query(
            `INSERT INTO purchase_order_lines (po_id, product_id, input_code, qty, unit_cost_usd, amount_usd)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [po.id, it.product_id, it.input_code, it.qty, it.unit_cost_usd, it.amount_usd]);
        }
        created.push({ po_id: Number(po.id), ref, lines: items.length, unmatched: items.filter((x) => x.product_id == null).length });
      }
      return created;
    });

    await logEvent({ userId, deviceId: req.ctx.deviceId, action: 'create', target: `purchase:${out.map((o) => o.po_id).join(',')}` });
    return {
      created: out,
      po_count: out.length,
      inserted_lines: valid.length,
      unmatched: out.reduce((s, o) => s + o.unmatched, 0),
      skipped_rows: errors.length,
      errors,
    };
  });

  // 구매내역 목록(참조번호·기간·코드 검색) + 집계
  app.get('/api/purchases', gate, async (req) => {
    const q = (req.query.q || '').trim();
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const params = [];
    const where = ['p.deleted_at IS NULL'];
    if (from) { params.push(from); where.push(`p.order_date >= $${params.length}`); }
    if (to) { params.push(to); where.push(`p.order_date <= $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      const pi = params.length;
      where.push(`(p.ref_no ILIKE $${pi} OR EXISTS (SELECT 1 FROM purchase_order_lines lx WHERE lx.po_id = p.id AND lx.input_code ILIKE $${pi}))`);
    }
    params.push(limit);
    const r = await query(
      `SELECT p.id, p.ref_no, p.order_date, p.currency, p.status, p.note, p.created_at,
              u.name AS created_by_name,
              COUNT(l.id)::int AS line_count,
              COALESCE(SUM(l.qty),0) AS total_qty,
              COALESCE(SUM(l.received_qty),0) AS total_received,
              COALESCE(SUM(l.amount_usd),0) AS total_usd,
              SUM(CASE WHEN l.product_id IS NOT NULL THEN 1 ELSE 0 END)::int AS matched_cnt,
              SUM(CASE WHEN l.product_id IS NULL THEN 1 ELSE 0 END)::int AS unmatched_cnt
       FROM purchase_orders p
       LEFT JOIN purchase_order_lines l ON l.po_id = p.id
       LEFT JOIN users u ON u.id = p.created_by
       WHERE ${where.join(' AND ')}
       GROUP BY p.id, u.name
       ORDER BY p.order_date DESC, p.id DESC
       LIMIT $${params.length}`, params);
    const seeCost = canSeeCost(req.ctx.perm);
    const items = r.rows.map((x) => ({
      id: Number(x.id), ref_no: x.ref_no, order_date: x.order_date, currency: x.currency,
      status: x.status, note: x.note, created_at: x.created_at, created_by_name: x.created_by_name,
      line_count: Number(x.line_count), total_qty: Number(x.total_qty),
      // 입고 현황(2026-08-18) — 창고 마감이 received_qty 를 채우면 목록에서 바로 보이게
      total_received: Number(x.total_received),
      backorder_qty: Math.round((Number(x.total_qty) - Number(x.total_received)) * 1000) / 1000,
      total_usd: seeCost ? Number(x.total_usd) : null,        // 구매단가 비공개
      matched_cnt: Number(x.matched_cnt), unmatched_cnt: Number(x.unmatched_cnt),
    }));
    // 0229 — PO 별 FOB 불일치 줄 수(비쌈·쌈). 구매단가 권한자에게만.
    if (seeCost) {
      const fm = await fobMismatchByPo(items.map((i) => i.id));
      for (const i of items) { const m = fm.get(i.id); i.fob_bad = m ? m.bad : null; i.fob_over = m ? m.over : null; i.fob_under = m ? m.under : null; i.fob_none = m ? m.no_fob : null; }
    }
    const summary = {
      po_count: items.length,
      total_usd: seeCost ? Math.round(r.rows.reduce((s, x) => s + Number(x.total_usd), 0) * 100) / 100 : null,
      total_qty: Math.round(items.reduce((s, i) => s + i.total_qty, 0) * 1000) / 1000,
      unmatched_lines: items.reduce((s, i) => s + i.unmatched_cnt, 0),
    };
    return { cost_visible: seeCost, items, summary };
  });

  // 구매검토: 보유 SKU 전체 종합 — CTR · SYD · 적용차종 · 현재재고 · backorder · 누적판매 · 견적부족.
  //   순수 읽기·집계(원가 없음 → 마스킹 불필요). q 검색 · 서버정렬 · 페이지네이션. 누적판매는 전사 기준(구매 판단용).
  // 2026-10-20 · 디렉터 결정
  //   ① 별도관리 SKU — 시장 수요가 커서 「실구매 필요」 계산을 쓰지 않고 구매·판매 의지로 수량을 정한다.
  //      추천발주수량을 계산하지 않고(0), 상단 실구매·추천 합계에서도 뺀다. 목록을 바꾸려면 여기만 고치면 된다.
  //   ② 추천발주수량 = 실구매 필요 + 놓친 수요(최근 6개월) — 단, 놓친 수요도 남는 가용재고·발주로 먼저 채우고 모자란 만큼만.
  //      (그대로 더하면 재고 80개인 CB0089 에도 발주가 추천된다.) 6개월 기준일 = 원 견적일(없으면 부족 기록일).
  //   ③ MOQ — SKU 별 MOQ(공장 정보 업로드)가 우선, 없으면 원산지 기본값 CN 10 · TR 40 · 그 외 없음.
  //      추천이 0 보다 크고 MOQ 보다 작으면 MOQ 로 올린다.
  //   ④ 공장 생산 상태 단산·개발·개발보류 = 지금 주문할 수 없음 → 추천 0(계산값은 참고로 보여준다).
  //   ⑤ L/R 짝맞춤 — 짝(CE0351L ↔ CE0351R)은 나란히 보여주고, 수요는 짝 중 큰 쪽을 양쪽에 적용한다
  //      (L 만 팔렸어도 R 도 같은 만큼 필요하다고 본다). 각 쪽은 자기 재고·발주를 빼고 모자란 만큼만 추천 →
  //      발주 뒤 L·R 재고가 맞춰진다. 검색·「수요만」도 짝 단위 — L 만 걸려도 R 이 같이 나온다.
  const MANUAL_SKUS = ['CQ0280L', 'CQ0280R', 'CQ1291L', 'CQ1291R', 'CQ280L', 'CQ280R'];
  const MISSED_MONTHS = 6;
  const BLOCKED_FACTORY = ['discontinued', 'development', 'dev_hold'];

  // 구매검토 집계 SQL — 목록·합계·발주서 초안이 같은 식을 쓴다.
  //   반환: { sql(CTE … fin), params }  · fin 의 각 행 = SKU 1개(필터 반영)
  function reviewSql({ q = '', onlyDemand = false } = {}) {
    const params = [];
    let hit = 'TRUE';
    if (q) {
      params.push(`%${q}%`); const i = params.length;
      hit = `(p.code ILIKE $${i} OR p.name ILIKE $${i} OR p.scode ILIKE $${i} OR p.app ILIKE $${i}
              OR EXISTS (SELECT 1 FROM product_syd_codes sc WHERE sc.product_id=p.id AND sc.syd_code ILIKE $${i})
              OR EXISTS (SELECT 1 FROM product_xref_codes xc WHERE xc.product_id=p.id AND xc.xref_code ILIKE $${i})
              OR EXISTS (SELECT 1 FROM product_applications pa WHERE pa.product_id=p.id AND pa.app_text ILIKE $${i}))`;
    }
    // 원 견적이 끝난(만료·취소·삭제대기·삭제) 부족 = 「놓친 수요」
    const DEAD_Q = `(sq.id IS NOT NULL AND (sq.deleted_at IS NOT NULL OR sq.status IN ('expired','cancelled','delete_pending')))`;
    const ORIG = `(CASE
        WHEN UPPER(TRIM(COALESCE(p.origin,''))) ~ '^(CN|CHN)$|CHIN' THEN 'CN'
        WHEN UPPER(TRIM(COALESCE(p.origin,''))) ~ '^(TR|TUR)$|TURK|TURQ' THEN 'TR'
        WHEN UPPER(TRIM(COALESCE(p.origin,''))) ~ '^(KR|KOR)$|KOREA|COREA' THEN 'KR'
        WHEN UPPER(TRIM(COALESCE(p.origin,''))) ~ '^(VN|VNM)$|VIET' THEN 'VN'
        ELSE NULLIF(UPPER(TRIM(COALESCE(p.origin,''))),'') END)`;
    const ORIG_MOQ = `(CASE ${ORIG} ${Object.entries(MOQ_BY_ORIGIN).map(([k, v]) => `WHEN '${k}' THEN ${Number(v)}`).join(' ')} ELSE 0 END)`;
    const COVER = `(COALESCE(bo.backorder_qty,0) + COALESCE(ps.qty,0))`;
    const AVAIL = `GREATEST(COALESCE(p.stock_qty,0) - COALESCE(rsv.qty,0), 0)`;
    const sql = `
      WITH base AS (
        SELECT p.id, p.code AS ctr, p.name, p.stock_qty, p.origin, p.is_active, p.inactive_reason,
               p.moq AS sku_moq, p.factory_status,
               ${PAIR_KEY_SQL} AS pk,
               ${hit} AS hit,
               COALESCE(sold.qty,0)          AS sold_qty,
               COALESCE(bo.backorder_qty,0)  AS backorder_qty,
               COALESCE(sh.qty,0)            AS shortage_qty,
               COALESCE(sh.live,0)           AS live_qty,
               COALESCE(sh.missed,0)         AS missed_qty,
               COALESCE(sh.missed6,0)        AS missed6_qty,
               ${COVER}                      AS cover_qty,
               COALESCE(ps.qty,0)            AS prestock_qty,
               COALESCE(rsv.qty,0)           AS reserved_qty,
               ${AVAIL}                      AS avail_qty,
               ${ORIG}                       AS origin_code,
               COALESCE(p.moq, ${ORIG_MOQ})  AS moq_eff,
               (UPPER(p.code) IN (${MANUAL_SKUS.map((c) => `'${c}'`).join(',')})) AS manual,
               (COALESCE(p.factory_status,'') IN (${BLOCKED_FACTORY.map((c) => `'${c}'`).join(',')})) AS blocked,
               (COALESCE(bo.backorder_qty,0) > 0 OR COALESCE(sh.qty,0) > 0) AS has_demand
          FROM products p
          LEFT JOIN (SELECT sil.product_id, SUM(sil.qty) AS qty
                       FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id=sil.invoice_id
                      WHERE si.status='posted' AND si.deleted_at IS NULL
                      GROUP BY sil.product_id) sold ON sold.product_id=p.id
          LEFT JOIN v_backorder bo ON bo.product_id=p.id
          LEFT JOIN (SELECT ss.product_id,
                            SUM(ss.shortage_qty - ss.resolved_qty) AS qty,
                            SUM(CASE WHEN ${DEAD_Q} THEN ss.shortage_qty - ss.resolved_qty ELSE 0 END) AS missed,
                            SUM(CASE WHEN ${DEAD_Q} THEN 0 ELSE ss.shortage_qty - ss.resolved_qty END) AS live,
                            SUM(CASE WHEN ${DEAD_Q} AND COALESCE(sq.quote_date, ss.occurred_at::date) >= (CURRENT_DATE - interval '${MISSED_MONTHS} months')
                                     THEN ss.shortage_qty - ss.resolved_qty ELSE 0 END) AS missed6
                       FROM stock_shortages ss LEFT JOIN quotes sq ON sq.id=ss.source_quote_id
                      WHERE ss.status='open' GROUP BY ss.product_id) sh ON sh.product_id=p.id
          LEFT JOIN inbound_prestock ps ON ps.product_id=p.id
          LEFT JOIN (SELECT ql.product_id, SUM(ql.reserved_qty) AS qty
                       FROM quote_lines ql JOIN quotes q ON q.id=ql.quote_id
                      WHERE ${ACTIVE_RESERVATION_SQL} AND ql.reserved_qty > 0
                      GROUP BY ql.product_id) rsv ON rsv.product_id=p.id
         WHERE p.deleted_at IS NULL
      ),
      calc AS (
        SELECT b.*,
               LEAST(live_qty, cover_qty)                              AS covered_qty,
               GREATEST(live_qty - cover_qty, 0)                       AS unordered_qty,
               GREATEST(live_qty - cover_qty - avail_qty, 0)           AS need_qty,
               GREATEST(live_qty + missed6_qty - cover_qty - avail_qty, 0) AS rec_own,
               (live_qty + missed6_qty)                                AS demand6
          FROM base b
      ),
      pr AS (
        SELECT c.*,
               COUNT(*) OVER w                                         AS pair_n,
               BOOL_OR(hit) OVER w                                     AS pair_hit,
               BOOL_OR(has_demand) OVER w                              AS pair_has_demand,
               MAX(CASE WHEN manual OR blocked THEN 0 ELSE demand6 END) OVER w AS pair_demand
          FROM calc c
        WINDOW w AS (PARTITION BY pk)
      ),
      fin AS (
        SELECT pr.*,
               (CASE WHEN pair_n > 1 THEN GREATEST(pair_demand - cover_qty - avail_qty, 0) ELSE rec_own END) AS rec_raw,
               (CASE WHEN manual OR blocked THEN 0
                     ELSE (CASE WHEN (CASE WHEN pair_n > 1 THEN GREATEST(pair_demand - cover_qty - avail_qty, 0) ELSE rec_own END) > 0
                                THEN GREATEST((CASE WHEN pair_n > 1 THEN GREATEST(pair_demand - cover_qty - avail_qty, 0) ELSE rec_own END), moq_eff)
                                ELSE 0 END) END) AS rec_qty
          FROM pr
         WHERE pair_hit ${onlyDemand ? 'AND pair_has_demand' : ''}
      )`;
    return { sql, params };
  }

  const REVIEW_SORTS = {
    code: null, stock: 'stock_qty', backorder: 'backorder_qty', sold: 'sold_qty', shortage: 'shortage_qty',
    unordered: 'unordered_qty', missed: 'missed_qty', need: 'need_qty', avail: 'avail_qty', rec: 'rec_qty',
  };

  function reviewItem(r, sydBy = {}, appBy = {}) {
    const n = (v) => Number(v) || 0;
    const moqSrc = r.sku_moq != null ? 'sku' : (n(r.moq_eff) > 0 ? 'origin' : null);
    return {
      product_id: Number(r.id), ctr: r.ctr, name: r.name,
      syd: sydBy[r.id] || [], applications: appBy[r.id] || [],
      stock_qty: n(r.stock_qty), backorder_qty: n(r.backorder_qty), sold_qty: n(r.sold_qty),
      shortage_qty: n(r.shortage_qty),
      shortage_covered_qty: n(r.covered_qty),         // 발주·입고대기로 이미 덮인 부족
      shortage_unordered_qty: n(r.unordered_qty),     // 미발주 부족(살아 있는 견적 기준)
      shortage_missed_qty: n(r.missed_qty),           // 놓친 수요(원 견적 만료·취소·삭제)
      missed6_qty: n(r.missed6_qty),                  // 놓친 수요 중 최근 6개월
      need_qty: n(r.need_qty),                        // 실구매 필요(미발주 부족 − 가용재고)
      reserved_qty: n(r.reserved_qty), avail_qty: n(r.avail_qty), prestock_qty: n(r.prestock_qty),
      rec_own_qty: n(r.rec_own),                      // 짝 맞춤 전 자기 수요 기준
      rec_raw_qty: n(r.rec_raw),                      // MOQ 적용 전(짝 맞춤 후)
      rec_qty: n(r.rec_qty),                          // 추천발주수량(짝 · MOQ · 공장상태 반영)
      moq: n(r.moq_eff), moq_source: moqSrc, sku_moq: r.sku_moq == null ? null : n(r.sku_moq),
      origin: r.origin || null, origin_code: r.origin_code || null,
      factory_status: r.factory_status || null, blocked: !!r.blocked,
      is_active: r.is_active !== false, inactive_reason: r.inactive_reason || null,
      manual: !!r.manual,
      pair_code: Number(r.pair_n) > 1 ? pairCode(r.ctr) : null,   // 짝이 마스터에 있을 때만
      pair_demand: Number(r.pair_n) > 1 ? n(r.pair_demand) : null,
      pair_adjusted: Number(r.pair_n) > 1 && n(r.rec_raw) > n(r.rec_own),
    };
  }

  // SYD 표시 — 제품마스터 SYD(product_syd_codes) + 제품 카탈로그 교차참조의 SYD 브랜드(product_xref_codes).
  async function sydAndApps(ids) {
    const sydBy = {}, appBy = {};
    if (!ids.length) return { sydBy, appBy };
    const sy = await query(
      `SELECT product_id, syd_code FROM (
         SELECT product_id, syd_code, 1 AS pri FROM product_syd_codes WHERE product_id = ANY($1)
         UNION ALL
         SELECT product_id, xref_code, 2 FROM product_xref_codes
          WHERE product_id = ANY($1) AND UPPER(COALESCE(brand,'')) LIKE 'SYD%'
       ) t ORDER BY product_id, pri, syd_code`, [ids]);
    for (const s of sy.rows) {
      const a = (sydBy[s.product_id] ||= []);
      const k = String(s.syd_code || '').trim();
      if (k && !a.some((x) => x.replace(/[^0-9A-Z]/gi, '').toUpperCase() === k.replace(/[^0-9A-Z]/gi, '').toUpperCase())) a.push(k);
    }
    const ap = await query(`SELECT product_id, app_text FROM product_applications WHERE product_id = ANY($1)`, [ids]);
    for (const a of ap.rows) (appBy[a.product_id] ||= []).push(a.app_text);
    return { sydBy, appBy };
  }

  // 구매검토: 보유 SKU 전체 종합 — CTR · SYD · 적용차종 · 현재재고 · backorder · 누적판매 · 견적부족 · 추천발주.
  //   q 검색 · 서버정렬 · 페이지네이션. 짝(L/R)은 정렬·페이지가 갈라 놓지 않게 짝 단위로 묶어 정렬한다.
  app.get('/api/purchases/review', gate, async (req) => {
    const q = (req.query.q || '').trim();
    const dir = String(req.query.dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(Number(req.query.limit) || 500, 5000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const onlyDemand = ['1', 'true', 'yes'].includes(String(req.query.demand || '').toLowerCase());
    const { sql, params } = reviewSql({ q, onlyDemand });
    const col = REVIEW_SORTS[String(req.query.sort || '').toLowerCase()];
    // 짝 단위 정렬 키: 내림차순은 짝 중 큰 값, 오름차순은 작은 값 → 그다음 짝 키 → CTR(L 이 R 앞)
    const orderBy = col
      ? `${dir === 'DESC' ? 'MAX' : 'MIN'}(${col}) OVER (PARTITION BY pk) ${dir} NULLS LAST, pk ASC, ctr ASC`
      : `pk ${dir}, ctr ASC`;
    const pageParams = params.slice(); pageParams.push(limit, offset);
    const rows = (await query(
      `${sql} SELECT * FROM fin ORDER BY ${orderBy}
        LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`, pageParams)).rows;
    const agg = (await query(
      `${sql} SELECT COUNT(*)::int AS n,
              COALESCE(SUM(stock_qty),0) AS stock, COALESCE(SUM(backorder_qty),0) AS backorder,
              COALESCE(SUM(sold_qty),0) AS sold, COALESCE(SUM(shortage_qty),0) AS shortage,
              COALESCE(SUM(unordered_qty),0) AS unordered, COALESCE(SUM(missed_qty),0) AS missed,
              COALESCE(SUM(CASE WHEN manual THEN 0 ELSE need_qty END),0) AS need,
              COALESCE(SUM(reserved_qty),0) AS reserved, COALESCE(SUM(avail_qty),0) AS avail,
              COALESCE(SUM(rec_qty),0) AS rec,
              COUNT(*) FILTER (WHERE rec_qty > 0)::int AS rec_skus,
              COUNT(*) FILTER (WHERE is_active = FALSE)::int AS inactive_skus,
              COUNT(*) FILTER (WHERE blocked)::int AS blocked_skus
         FROM fin`, params)).rows[0];
    const { sydBy, appBy } = await sydAndApps(rows.map((r) => Number(r.id)));
    const items = rows.map((r) => reviewItem(r, sydBy, appBy));
    const r3 = (v) => Math.round(Number(v) * 1000) / 1000;
    return {
      items, total: Number(agg.n), limit, offset,
      summary: {
        sku_count: Number(agg.n),
        total_stock: r3(agg.stock), total_backorder: r3(agg.backorder), total_sold: r3(agg.sold),
        total_shortage: r3(agg.shortage), total_unordered: r3(agg.unordered), total_missed: r3(agg.missed),
        total_need: r3(agg.need), total_reserved: r3(agg.reserved), total_avail: r3(agg.avail),
        total_rec: r3(agg.rec), rec_skus: Number(agg.rec_skus) || 0,
        inactive_skus: Number(agg.inactive_skus) || 0, blocked_skus: Number(agg.blocked_skus) || 0,
        manual_skus: MANUAL_SKUS.filter((c) => !/^CQ280/.test(c)),
        missed_months: MISSED_MONTHS, moq_by_origin: MOQ_BY_ORIGIN,
      },
    };
  });

  // 2026-10-20 · 이번달 발주검토 · 발주서 초안 — 추천발주수량 > 0 인 SKU 전부(짝 포함), 원산지별로 묶어 출력용으로.
  //   발주서 정식 출력 기능이 생기면 이 목록을 그대로 넘기면 된다.
  app.get('/api/purchases/review/po-draft', gate, async () => {
    const { sql, params } = reviewSql({});
    const rows = (await query(
      `${sql} SELECT * FROM (SELECT f.*, MAX(rec_qty) OVER (PARTITION BY pk) AS pair_rec FROM fin f) x
        WHERE rec_qty > 0 OR (pair_n > 1 AND pair_rec > 0) OR manual
        ORDER BY COALESCE(origin_code,'~'), pk, ctr`, params)).rows;
    const { sydBy, appBy } = await sydAndApps(rows.map((r) => Number(r.id)));
    const items = rows.map((r) => reviewItem(r, sydBy, appBy));
    const groups = new Map();
    const manual = items.filter((x) => x.manual);
    for (const it of items.filter((x) => !x.manual)) {
      const k = it.origin_code || '원산지 미등록';
      if (!groups.has(k)) groups.set(k, { origin: k, items: [], skus: 0, qty: 0 });
      const g = groups.get(k); g.items.push(it); g.skus++; g.qty += it.rec_qty;
    }
    const month = (await query(`SELECT to_char(now() AT TIME ZONE 'America/Mexico_City','YYYY-MM') AS m, to_char(now() AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD') AS d`)).rows[0];
    return { month: month.m, date: month.d, groups: [...groups.values()], manual,
      total_skus: items.filter((x) => x.rec_qty > 0).length, total_qty: items.reduce((a, x) => a + x.rec_qty, 0) };
  });

  // ── 2026-10-20 · 공장 SKU 정보(원산지 · MOQ · 생산 상태) — 구매검토 화면 업로드/붙여넣기 ──
  //   GET  현재값(양식 내려받기용) · POST preview(바뀔 내용만) · POST apply(디렉터, 한 트랜잭션 + 이력)
  async function factoryCurrent(codes) {
    const r = codes
      ? await query(`SELECT id, UPPER(code) AS code, name, origin, moq, factory_status FROM products WHERE deleted_at IS NULL AND UPPER(code) = ANY($1::text[])`, [codes])
      : await query(`SELECT id, UPPER(code) AS code, name, origin, moq, factory_status, is_active FROM products WHERE deleted_at IS NULL ORDER BY code`);
    return r.rows;
  }
  function factoryPlanFromBody(b) {
    // 화면은 표(엑셀 시트·붙여넣기)를 그대로 보낸다 — 머리글 해석은 서버 한 곳(factoryInfo.tableToRows)에서.
    if (Array.isArray(b.table)) return tableToRows(b.table.slice(0, 20001)).rows;
    const rows = Array.isArray(b.rows) ? b.rows.slice(0, 20000) : [];
    return rows.map((r, i) => ({
      row: Number(r.row) || i + 1, code: String(r.code == null ? '' : r.code).trim().toUpperCase(),
      origin: r.origin, moq: r.moq, status: r.status,
    }));
  }
  app.get('/api/purchases/factory-info', gate, async () => {
    const rows = await factoryCurrent(null);
    return { items: rows.map((r) => ({ code: r.code, name: r.name, origin: r.origin || '', moq: r.moq == null ? null : Number(r.moq),
      factory_status: r.factory_status || null, is_active: r.is_active !== false })), statuses: FACTORY_STATUS, moq_by_origin: MOQ_BY_ORIGIN };
  });
  app.post('/api/purchases/factory-info/preview', gate, async (req, reply) => {
    const rows = factoryPlanFromBody(req.body || {});
    if (!rows.length) return reply.code(400).send({ error: 'no_rows' });
    const cur = new Map((await factoryCurrent([...new Set(rows.map((r) => r.code).filter(Boolean))])).map((p) => [p.code, p]));
    const plan = planFactoryChanges(rows, cur);
    return { total: rows.length, changed: plan.items.length, unchanged: plan.unchanged, dup: plan.dup,
      errors: plan.errors.slice(0, 500), error_count: plan.errors.length,
      not_found: plan.not_found.slice(0, 500), not_found_count: plan.not_found.length,
      items: plan.items.slice(0, 3000), statuses: FACTORY_STATUS };
  });
  app.post('/api/purchases/factory-info/apply', { preHandler: [authGuard, requirePage('purchase'), requireDirector] }, async (req, reply) => {
    const b = req.body || {};
    const rows = factoryPlanFromBody(b);
    if (!rows.length) return reply.code(400).send({ error: 'no_rows' });
    const source = b.source === 'paste' ? 'paste' : 'excel';
    const uid = Number(req.ctx.perm.userId) || null;
    const batchId = `F${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`.toUpperCase();
    const res = await withTx(async (c) => {
      const exec = (s, p) => c.query(s, p);
      const cur = new Map((await exec(
        `SELECT id, UPPER(code) AS code, name, origin, moq, factory_status FROM products
          WHERE deleted_at IS NULL AND UPPER(code) = ANY($1::text[]) FOR UPDATE`,
        [[...new Set(rows.map((r) => r.code).filter(Boolean))]])).rows.map((p) => [p.code, p]));
      const plan = planFactoryChanges(rows, cur);
      for (const it of plan.items) {
        const ch = it.changes;
        const sets = [], vals = [];
        for (const f of ['origin', 'moq', 'factory_status']) if (ch[f]) { vals.push(ch[f].to); sets.push(`${f}=$${vals.length}`); }
        vals.push(uid); sets.push(`factory_info_updated_by=$${vals.length}`, 'factory_info_updated_at=now()');
        vals.push(it.product_id);
        await exec(`UPDATE products SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
        for (const [f, v] of Object.entries(ch)) {
          await exec(`INSERT INTO product_factory_log (batch_id, product_id, code, field, old_value, new_value, source, changed_by)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [batchId, it.product_id, it.code, f, v.from == null ? null : String(v.from), v.to == null ? null : String(v.to), source, uid]);
        }
      }
      return plan;
    });
    logEvent({ userId: uid, deviceId: req.ctx.deviceId, action: 'update', target: 'product_factory_info',
      detail: { batch_id: batchId, source, rows: rows.length, changed: res.items.length, errors: res.errors.length, not_found: res.not_found.length } });
    return { ok: true, batch_id: batchId, updated: res.items.length, unchanged: res.unchanged,
      error_count: res.errors.length, errors: res.errors.slice(0, 200), not_found_count: res.not_found.length, not_found: res.not_found.slice(0, 200) };
  });

  // 2026-10-15 · 구매검토 드릴다운 ②: 이 SKU 의 부족분이 어디까지 왔나 — 발생(견적·고객) → 발주됨 → 입고 해소 / 판매 해소.
  //   발주 연결은 FIFO 계산(shortageReceipt.orderCoverage): 오래된 발주 잔량이 오래된 부족분부터 덮는다.
  //   해소 이력은 원장(stock_shortage_resolutions): receipt=입고(배치) · sale/scan=판매(인보이스) · manual=수동.
  const DEAD_ST = new Set(['expired', 'cancelled', 'delete_pending']);
  app.get('/api/purchases/review/:productId/shortages', gate, async (req, reply) => {
    const pid = Number(req.params.productId);
    if (!pid) return reply.code(400).send({ error: 'bad_id' });
    const prod = (await query(`SELECT id, code, name, stock_qty FROM products WHERE id=$1`, [pid])).rows[0];
    if (!prod) return reply.code(404).send({ error: 'not_found' });
    const cov = await orderCoverage(query, pid);
    const covBy = new Map(cov.rows.map((r) => [r.id, r]));
    // 미해소 전부 + 해소·정리된 최근 200건
    const rows = (await query(
      `(SELECT sh.id FROM stock_shortages sh WHERE sh.product_id=$1 AND sh.status='open')
       UNION
       (SELECT sh.id FROM stock_shortages sh WHERE sh.product_id=$1 AND sh.status<>'open'
         ORDER BY sh.occurred_at DESC, sh.id DESC LIMIT 200)`, [pid])).rows.map((r) => Number(r.id));
    if (!rows.length) {
      return { product: { id: Number(prod.id), code: prod.code, name: prod.name, stock_qty: Number(prod.stock_qty) || 0 },
        summary: { remaining: 0, covered: 0, unordered: 0, missed: 0, need: 0, reserved: 0, avail: 0, backorder: cov.backorder }, po: cov.po, items: [] };
    }
    const det = (await query(
      `SELECT sh.id, to_char(sh.occurred_at,'YYYY-MM-DD') AS occurred_at, sh.status, sh.note,
              sh.requested_qty, sh.fulfilled_qty, sh.shortage_qty, sh.resolved_qty,
              (sh.shortage_qty - sh.resolved_qty) AS remaining_qty,
              c.name AS customer_name, sh.source_quote_id, qq.quote_no, qq.status AS quote_status,
              (qq.deleted_at IS NOT NULL) AS quote_deleted, sh.sales_invoice_id, si.sat_no AS invoice_sat_no
         FROM stock_shortages sh
         LEFT JOIN customers c ON c.id=sh.customer_id
         LEFT JOIN quotes qq ON qq.id=sh.source_quote_id
         LEFT JOIN sales_invoices si ON si.id=sh.sales_invoice_id
        WHERE sh.id = ANY($1::bigint[])
        ORDER BY (sh.status='open') DESC, sh.occurred_at, sh.id`, [rows])).rows;
    const res = (await query(
      `SELECT r.shortage_id, r.qty, r.source, r.resolved_at, r.note, r.sales_invoice_id,
              si.sat_no, ib.batch_no, NULLIF(to_jsonb(r)->>'import_batch_id','')::bigint AS import_batch_id,
              u.name AS resolved_by_name
         FROM stock_shortage_resolutions r
         LEFT JOIN sales_invoices si ON si.id=r.sales_invoice_id
         LEFT JOIN import_batches ib ON ib.id = NULLIF(to_jsonb(r)->>'import_batch_id','')::bigint
         LEFT JOIN users u ON u.id=r.resolved_by
        WHERE r.shortage_id = ANY($1::bigint[])
        ORDER BY r.resolved_at, r.id`, [rows])).rows;
    const resBy = new Map();
    for (const r of res) {
      const k = Number(r.shortage_id);
      if (!resBy.has(k)) resBy.set(k, []);
      resBy.get(k).push({ qty: Number(r.qty), source: r.source, resolved_at: r.resolved_at, note: r.note || null,
        sat_no: r.sat_no || null, sales_invoice_id: r.sales_invoice_id == null ? null : Number(r.sales_invoice_id),
        batch_no: r.batch_no || null, import_batch_id: r.import_batch_id == null ? null : Number(r.import_batch_id),
        resolved_by_name: r.resolved_by_name || null });
    }
    const items = det.map((r) => {
      const cv = covBy.get(Number(r.id));
      const remaining = Number(r.remaining_qty) || 0;
      const ordered = cv ? cv.ordered : 0;
      // 2026-10-19 · 원 견적이 끝난 부족 = 놓친 수요 — 구매 판단(미발주)에서 뺀다(목록 화면과 같은 기준)
      const missed = r.status === 'open' && !!r.source_quote_id && (!!r.quote_deleted || DEAD_ST.has(r.quote_status));
      return {
        missed,
        id: Number(r.id), occurred_at: r.occurred_at, status: r.status, note: r.note || null,
        customer_name: r.customer_name || null,
        source_quote_id: r.source_quote_id == null ? null : Number(r.source_quote_id),
        quote_no: r.quote_no || null, quote_status: r.quote_status || null, quote_deleted: !!r.quote_deleted,
        sales_invoice_id: r.sales_invoice_id == null ? null : Number(r.sales_invoice_id), invoice_sat_no: r.invoice_sat_no || null,
        requested_qty: Number(r.requested_qty) || 0, fulfilled_qty: Number(r.fulfilled_qty) || 0,
        shortage_qty: Number(r.shortage_qty) || 0, resolved_qty: Number(r.resolved_qty) || 0,
        remaining_qty: remaining,
        ordered_qty: ordered,                                       // 발주(또는 창고 입고 대기)로 덮인 몫
        unordered_qty: r.status === 'open' && !missed ? Math.max(0, Math.round((remaining - ordered) * 1000) / 1000) : 0,
        covers: cv ? cv.covers : [],                                // [{kind, ref_no, order_date, qty}]
        live_quote: !!(cv && cv.live),
        resolutions: resBy.get(Number(r.id)) || [],
      };
    });
    // 요약은 목록 화면과 같은 식: 살아 있는 부족만 발주·재고로 차감, 놓친 수요는 따로.
    const rr = (n) => Math.round(n * 1000) / 1000;
    const openItems = items.filter((x) => x.status === 'open');
    const liveRem = rr(openItems.filter((x) => !x.missed).reduce((a, x) => a + x.remaining_qty, 0));
    const missedRem = rr(openItems.filter((x) => x.missed).reduce((a, x) => a + x.remaining_qty, 0));
    const covered = rr(Math.min(liveRem, cov.backorder));
    const unordered = rr(Math.max(0, liveRem - covered));
    const rsvQ = Number((await query(
      `SELECT COALESCE(SUM(ql.reserved_qty),0) AS r FROM quote_lines ql JOIN quotes q ON q.id=ql.quote_id
        WHERE ql.product_id=$1 AND ql.reserved_qty > 0 AND ${ACTIVE_RESERVATION_SQL}`, [pid])).rows[0].r) || 0;
    const stockQ = Math.max(0, (Number(prod.stock_qty) || 0) - rsvQ);
    return {
      product: { id: Number(prod.id), code: prod.code, name: prod.name, stock_qty: Number(prod.stock_qty) || 0 },
      summary: { remaining: cov.remaining, covered, unordered, missed: missedRem,
        need: rr(Math.max(0, unordered - stockQ)), reserved: rr(rsvQ), avail: rr(stockQ), backorder: cov.backorder },
      po: cov.po, items,
    };
  });

  // 구매검토 드릴다운: SKU별 입출고 이력 — 언제 입고 몇개 / 언제 출고 어디로 몇개 + 전체 이동수량 대비 %.
  //   qty 관례: in/out 양수(방향은 move_type), adjust 부호유지. % 분모 = Σ|qty|(전체 이동수량).
  app.get('/api/purchases/review/:productId/movements', gate, async (req, reply) => {
    const pid = Number(req.params.productId);
    if (!pid) return reply.code(400).send({ error: 'bad_id' });
    const prod = (await query(`SELECT id, code, name, stock_qty FROM products WHERE id=$1`, [pid])).rows[0];
    if (!prod) return reply.code(404).send({ error: 'not_found' });
    const rows = (await query(
      `SELECT m.id, m.move_type, m.qty, m.ref, m.note, m.source, m.moved_at,
              m.sales_invoice_id, m.batch_id,
              cu.name AS customer_name, si.sat_no AS sat_no, ib.batch_no AS batch_no
         FROM stock_movements m
         LEFT JOIN sales_invoices si ON si.id = m.sales_invoice_id
         LEFT JOIN customers cu ON cu.id = si.customer_id
         LEFT JOIN import_batches ib ON ib.id = m.batch_id
        WHERE m.product_id = $1
        ORDER BY m.moved_at DESC, m.id DESC
        LIMIT 5000`, [pid])).rows;
    let totalAbs = 0, inQty = 0, outQty = 0, adjQty = 0;
    for (const r of rows) {
      const q = Number(r.qty) || 0; totalAbs += Math.abs(q);
      if (r.move_type === 'in') inQty += Math.abs(q);
      else if (r.move_type === 'out') outQty += Math.abs(q);
      else adjQty += q;
    }
    const items = rows.map((r) => {
      const q = Number(r.qty) || 0; const absq = Math.abs(q);
      const origin = r.move_type === 'in' ? '입고' : (r.move_type === 'out' ? '출고' : '조정');
      let destination;
      if (r.move_type === 'out') destination = r.customer_name || (r.sat_no ? `SAT ${r.sat_no}` : (r.ref || '—'));
      else if (r.move_type === 'in') destination = r.batch_no ? `수입 ${r.batch_no}` : (r.ref ? `수입 ${r.ref}` : '수입입고');
      else destination = r.note || r.ref || '조정';
      return {
        id: Number(r.id), moved_at: r.moved_at, move_type: r.move_type, origin,
        qty: absq, signed_qty: q, destination, sat_no: r.sat_no || null, ref: r.ref || null, note: r.note || null,
        source: r.sales_invoice_id ? '매출' : (r.batch_id ? '수입' : (r.source === 'manual' ? '수동' : '기타')),
        pct: totalAbs > 0 ? Math.round((absq / totalAbs) * 10000) / 100 : 0,   // 전체 이동수량 대비 %
      };
    });
    return {
      product: { id: Number(prod.id), code: prod.code, name: prod.name, stock_qty: Number(prod.stock_qty) || 0 },
      totals: {
        count: rows.length,
        in_qty: Math.round(inQty * 1000) / 1000,
        out_qty: Math.round(outQty * 1000) / 1000,
        adjust_qty: Math.round(adjQty * 1000) / 1000,
        total_abs: Math.round(totalAbs * 1000) / 1000,
        net: Math.round((inQty - outQty + adjQty) * 1000) / 1000,
      },
      items, capped: rows.length >= 5000,
    };
  });

  // 입고예정 요약(언제·얼만큼 도착): 선적(ETA)별 요약 + SKU 드릴다운 + 미선적(발주만) 잔량.
  //   출처: ① inbound_shipments(incoming/receiving) — 패킹리스트 기반, ETA 보유(도착 예정)
  //         ② 발주 backorder 중 활성 선적에 안 담긴 잔량 — "발주됨·선적 미정"
  app.get('/api/purchases/incoming', gate, async () => {
    // ① 활성 선적 헤더(ETA·상태·규모)
    const ships = (await query(
      `SELECT s.id, s.invoice_no, s.eta, s.status, s.note, s.created_at,
              COUNT(DISTINCT COALESCE(pr.code, pi.input_code)) FILTER (WHERE pi.id IS NOT NULL)::int AS sku_count,
              COALESCE(SUM(pi.qty),0)      AS total_qty,
              COALESCE(SUM(pi.cartons),0)  AS cartons,
              (SELECT COALESCE(array_agg(DISTINCT ip.order_no), '{}') FROM inbound_pallets ip WHERE ip.shipment_id=s.id) AS refs
         FROM inbound_shipments s
         LEFT JOIN inbound_pallet_items pi ON pi.shipment_id=s.id
         LEFT JOIN products pr ON pr.id=pi.product_id
        WHERE s.deleted_at IS NULL AND s.status IN ('incoming','receiving')
        GROUP BY s.id
        ORDER BY s.eta ASC NULLS LAST, s.id ASC`)).rows;
    // ① 드릴다운: 선적별 SKU 라인
    const lines = (await query(
      `SELECT pi.shipment_id, COALESCE(pr.code, pi.input_code) AS sku, pr.name AS product_name,
              (pi.product_id IS NOT NULL) AS matched, pr.stock_qty,
              SUM(pi.qty) AS qty, SUM(pi.cartons)::int AS cartons
         FROM inbound_pallet_items pi
         JOIN inbound_shipments s ON s.id=pi.shipment_id
         LEFT JOIN products pr ON pr.id=pi.product_id
        WHERE s.deleted_at IS NULL AND s.status IN ('incoming','receiving')
        GROUP BY pi.shipment_id, COALESCE(pr.code, pi.input_code), pr.name, pi.product_id IS NOT NULL, pr.stock_qty
        ORDER BY sku`)).rows;
    // ① 첨부: 선적별 패킹리스트 원본 파일 메타(다운로드 버튼용 — file_data 는 다운로드 API에서)
    const fileRows = (await query(
      `SELECT f.id, f.shipment_id, f.file_name, f.file_size
         FROM inbound_packing_files f
         JOIN inbound_shipments s ON s.id=f.shipment_id
        WHERE s.deleted_at IS NULL AND s.status IN ('incoming','receiving')
        ORDER BY f.uploaded_at DESC, f.id DESC`)).rows;
    // ② 발주 backorder 중 활성 선적에 안 담긴 잔량(선적 미정)
    const unshipped = (await query(
      `WITH bo AS (
         SELECT l.product_id, SUM(l.qty - l.received_qty) AS backorder,
                MIN(p.order_date) AS first_order,
                array_agg(DISTINCT p.ref_no) AS refs
           FROM purchase_order_lines l
           JOIN purchase_orders p ON p.id=l.po_id
          WHERE p.deleted_at IS NULL AND p.status <> 'cancelled'
            AND l.product_id IS NOT NULL AND (l.qty - l.received_qty) > 0
          GROUP BY l.product_id),
       inc AS (
         SELECT pi.product_id, SUM(pi.qty) AS qty
           FROM inbound_pallet_items pi
           JOIN inbound_shipments s ON s.id=pi.shipment_id
          WHERE s.deleted_at IS NULL AND s.status IN ('incoming','receiving')
            AND pi.product_id IS NOT NULL
          GROUP BY pi.product_id)
       SELECT bo.product_id, pr.code AS sku, pr.name AS product_name, pr.stock_qty,
              bo.backorder, COALESCE(inc.qty,0) AS incoming_qty,
              GREATEST(bo.backorder - COALESCE(inc.qty,0), 0) AS unshipped_qty,
              bo.first_order, bo.refs
         FROM bo
         LEFT JOIN inc ON inc.product_id=bo.product_id
         JOIN products pr ON pr.id=bo.product_id
        WHERE bo.backorder - COALESCE(inc.qty,0) > 0
        ORDER BY unshipped_qty DESC, sku`)).rows;
    const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
    const filesByShip = {};
    for (const f of fileRows) {
      (filesByShip[f.shipment_id] ||= []).push({ id: Number(f.id), file_name: f.file_name, file_size: f.file_size == null ? null : Number(f.file_size) });
    }
    const linesByShip = {};
    for (const l of lines) {
      (linesByShip[l.shipment_id] ||= []).push({
        sku: l.sku, product_name: l.product_name || null, matched: !!l.matched,
        stock_qty: l.stock_qty == null ? null : Number(l.stock_qty),
        qty: r3(l.qty), cartons: Number(l.cartons) || 0,
      });
    }
    const shipments = ships.map((s) => ({
      id: Number(s.id), invoice_no: s.invoice_no || null,
      eta: s.eta ? String(s.eta).slice(0, 10) : null,
      uploaded_at: s.created_at ? String(s.created_at instanceof Date ? s.created_at.toISOString() : s.created_at).slice(0, 10) : null, // 패킹리스트 업로드일
      status: s.status, note: s.note || null,
      sku_count: Number(s.sku_count) || 0, total_qty: r3(s.total_qty), cartons: Number(s.cartons) || 0,
      refs: s.refs || [],
      files: filesByShip[s.id] || [],
      lines: linesByShip[s.id] || [],
    }));
    const un = unshipped.map((u) => ({
      product_id: Number(u.product_id), sku: u.sku, product_name: u.product_name,
      stock_qty: u.stock_qty == null ? null : Number(u.stock_qty),
      backorder: r3(u.backorder), incoming_qty: r3(u.incoming_qty), unshipped_qty: r3(u.unshipped_qty),
      first_order: u.first_order ? String(u.first_order).slice(0, 10) : null,
      refs: u.refs || [],
    }));
    return {
      shipments,
      unshipped: un,
      summary: {
        shipment_count: shipments.length,
        arriving_qty: r3(shipments.reduce((a, s) => a + s.total_qty, 0)),
        arriving_sku: new Set(lines.map((l) => l.sku)).size,
        next_eta: shipments.find((s) => s.eta)?.eta || null,
        unshipped_qty: r3(un.reduce((a, u) => a + u.unshipped_qty, 0)),
        unshipped_sku: un.length,
      },
    };
  });

  // 상세(라인)
  app.get('/api/purchases/:id', gate, async (req, reply) => {
    const id = Number(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const h = (await query(
      `SELECT p.id, p.ref_no, p.order_date, p.currency, p.status, p.note, p.created_at,
              u.name AS created_by_name, to_char(p.order_date,'YYYY-MM-DD') AS od
       FROM purchase_orders p LEFT JOIN users u ON u.id = p.created_by
       WHERE p.id = $1 AND p.deleted_at IS NULL`, [id])).rows[0];
    if (!h) return reply.code(404).send({ error: 'not_found' });
    const lr = await query(
      `SELECT l.id, l.input_code, l.product_id, pr.code AS matched_code, pr.name AS product_name,
              pr.stock_qty, l.qty, l.unit_cost_usd, l.amount_usd, l.received_qty
       FROM purchase_order_lines l
       LEFT JOIN products pr ON pr.id = l.product_id
       WHERE l.po_id = $1 ORDER BY l.id`, [id]);
    const seeCost = canSeeCost(req.ctx.perm);
    const lines = lr.rows.map((x) => ({
      id: Number(x.id), input_code: x.input_code, product_id: x.product_id ? Number(x.product_id) : null,
      matched_code: x.matched_code, product_name: x.product_name,
      stock_qty: x.stock_qty == null ? null : Number(x.stock_qty),
      qty: Number(x.qty),
      unit_cost_usd: seeCost ? Number(x.unit_cost_usd) : null,   // 구매단가 비공개
      amount_usd: seeCost ? Number(x.amount_usd) : null,
      received_qty: Number(x.received_qty), backorder_qty: Number(x.qty) - Number(x.received_qty),
      matched: x.product_id != null,
    }));
    // 0229 — 주문일 당시 FOB 와 비교(1센트라도 다르면 표시)
    if (seeCost) {
      const fobs = await fobAtDate(lines.map((l) => l.product_id), h.od);
      if (fobs) for (const l of lines) {
        const f = l.product_id != null && fobs.has(l.product_id) ? fobs.get(l.product_id) : null;
        l.fob_usd = f; l.fob_status = fobStatus(l.unit_cost_usd, f, l.product_id, 0);
      }
    }
    return {
      cost_visible: seeCost,
      header: { id: Number(h.id), ref_no: h.ref_no, order_date: h.order_date, currency: h.currency, status: h.status, note: h.note, created_at: h.created_at, created_by_name: h.created_by_name },
      lines,
      total_qty: Math.round(lines.reduce((s, l) => s + l.qty, 0) * 1000) / 1000,
      total_usd: seeCost ? Math.round(lr.rows.reduce((s, x) => s + Number(x.amount_usd), 0) * 100) / 100 : null,
    };
  });

  // 전체 라인 평면 뷰 — 참조번호 무관, SKU·구매참조번호·backorder·현재고·예상재고(현재+추가)
  app.get('/api/purchases/lines', gate, async (req) => {
    const seeCost = canSeeCost(req.ctx.perm);
    const q = (req.query.q || '').trim();
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();
    const boOnly = req.query.backorder_only === '1' || req.query.backorder_only === 'true';
    const limit = Math.min(Number(req.query.limit) || 1000, 3000);
    const params = [];
    const where = ['p.deleted_at IS NULL', "p.status <> 'cancelled'"];
    if (boOnly) where.push('(l.qty - l.received_qty) > 0');
    if (from) { params.push(from); where.push(`p.order_date >= $${params.length}`); }
    if (to) { params.push(to); where.push(`p.order_date <= $${params.length}`); }
    if (q) {
      params.push(`%${q}%`); const pi = params.length;
      where.push(`(l.input_code ILIKE $${pi} OR pr.code ILIKE $${pi} OR pr.name ILIKE $${pi} OR p.ref_no ILIKE $${pi})`);
    }
    params.push(limit);
    const r = await query(
      `SELECT l.id, p.id AS po_id, p.ref_no, p.order_date,
              l.input_code, l.product_id, pr.code AS matched_code, pr.name AS product_name,
              pr.stock_qty, l.qty, l.received_qty,
              (l.qty - l.received_qty) AS backorder,
              l.unit_cost_usd, l.amount_usd
       FROM purchase_order_lines l
       JOIN purchase_orders p ON p.id = l.po_id
       LEFT JOIN products pr ON pr.id = l.product_id
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(pr.code, l.input_code) ASC, p.order_date DESC, l.id DESC
       LIMIT $${params.length}`, params);
    const items = r.rows.map((x) => {
      const stock = x.stock_qty == null ? null : Number(x.stock_qty);
      const backorder = Number(x.backorder);
      return {
        id: Number(x.id), po_id: Number(x.po_id), ref_no: x.ref_no, order_date: x.order_date,
        input_code: x.input_code, product_id: x.product_id ? Number(x.product_id) : null,
        matched_code: x.matched_code, product_name: x.product_name, matched: x.product_id != null,
        stock_qty: stock, qty: Number(x.qty), received_qty: Number(x.received_qty),
        backorder, projected: stock == null ? null : Math.round((stock + backorder) * 1000) / 1000,   // 현재고 + backorder = 입고 후 예상재고
        unit_cost_usd: seeCost ? Number(x.unit_cost_usd) : null,
        amount_usd: seeCost ? Number(x.amount_usd) : null,
      };
    });
    const skuSet = new Set(items.map((i) => (i.matched ? i.matched_code : i.input_code)));
    const summary = {
      line_count: items.length,
      total_backorder: Math.round(items.reduce((s, i) => s + i.backorder, 0) * 1000) / 1000,
      sku_count: skuSet.size,
      total_usd: seeCost ? Math.round(items.reduce((s, i) => s + (i.amount_usd || 0), 0) * 100) / 100 : null,
    };
    return { cost_visible: seeCost, items, summary };
  });

  // 소프트 삭제(디렉터 전용) — 오기입 정정용
  app.delete('/api/purchases/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const r = await query(
      `UPDATE purchase_orders SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id]);
    if (!r.rows.length) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, deviceId: req.ctx.deviceId, action: 'delete', target: `purchase:${id}` });
    return { ok: true, id };
  });
}
