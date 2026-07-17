// build fsr-20260717a — 누적판매 대조(소진) 체크리스트 추가 (엑셀 대량 업로드 + xref 매칭 유지)
import { query, withTx } from '../db.js';
import { authGuard } from '../middleware/authGuard.js';
import { visibleTeamIds } from '../teams.js';
import { logEvent } from '../audit.js';
import { notifyProductMarketing } from './devRequestRoutes.js';
import { customerSoldItems, customerSoldSkuCount, soldSnapFor, sellThrough, replenishSort, SOLD_DEFAULT_LIMIT } from '../customerSold.js';

// 현장재고조사 (field stock survey)
//  · 권한: 로그인 사용자 모두(authGuard). 조사 데이터는 본인 것만(디렉터는 전체).
//  · 코드 한 건 입력 = 즉시 저장(데이터 분실 차단). 서버가 코드를 자동 분류.
//  · 가용재고 = 현재고 − 타 미결·미만료 견적 예약분 (견적화면과 동일 기준).
//  · 분류: imm(즉시매출가능, 가용>0) / short(재고부족, 매칭됐으나 가용≤0) / dev(개발필요, 미등록).
//
//  ── 누적판매 대조(소진) — 2026-07-17 추가 ──
//  · 기존고객(customer_id) 조사에서만 활성. 미등록 고객은 누적판매가 없어 비활성.
//  · 줄 origin: 'code'(현장 코드입력 = 기존 동작 그대로) / 'history'(누적판매 체크리스트 점검분).
//  · 소진량 = 누적판매 스냅샷(sold_qty_snap) − 현장재고(observed_qty) → 보충 제안(소진율 내림차순).
//  · history 줄은 imm/short/dev 3분류 집계에서 제외 → 기존 화면·견적 동작 회귀 없음.
export default async function fieldSurveyRoutes(app) {
  // node-pg 정규화 헬퍼
  const num = (v) => (v == null ? null : Number(v));
  const nint = (v) => (v == null ? null : Number(v));

  // 가용재고 = 현재고 − 타 미결·미만료 견적 예약 합 (음수면 0)
  async function availFor(productId, exec = query) {
    const r = (await exec(
      `SELECT p.stock_qty,
              COALESCE((SELECT SUM(ql.reserved_qty)
                          FROM quote_lines ql JOIN quotes q ON q.id = ql.quote_id
                         WHERE ql.product_id = p.id
                           AND q.status IN ('draft','confirmed')
                           AND (q.reserve_expires_at > now() OR q.packing_printed_at IS NOT NULL)
                           AND q.deleted_at IS NULL), 0) AS reserved
         FROM products p WHERE p.id = $1`, [productId])).rows[0];
    if (!r) return 0;
    const phys = r.stock_qty != null ? Number(r.stock_qty) : 0;
    const resd = Number(r.reserved) || 0;
    return Math.max(0, phys - resd);
  }

  // 코드 정규화 (매칭용): 대문자 + 영숫자 외 제거 — 'DS-1045-S' == 'DS1045S'
  const normCode = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');

  // 코드 분류: CTR 정확매칭(대소문자 무시) → SYD 역검색 → 교차참조(전 브랜드, 정규화)
  //           → SYD 정규화 폴백 → 미등록
  async function resolveCode(codeRaw, exec = query) {
    const c = String(codeRaw || '').trim();
    if (!c) return { source: 'none', product: null };
    let rows = (await exec(
      `SELECT id, code, name, app FROM products
        WHERE deleted_at IS NULL AND UPPER(code) = UPPER($1) ORDER BY code LIMIT 1`, [c])).rows;
    let source = 'ctr';
    if (!rows.length) {
      rows = (await exec(
        `SELECT p.id, p.code, p.name, p.app
           FROM product_syd_codes s JOIN products p ON p.id = s.product_id AND p.deleted_at IS NULL
          WHERE UPPER(s.syd_code) = UPPER($1) ORDER BY p.code LIMIT 1`, [c])).rows;
      source = rows.length ? 'syd' : 'none';
    }
    const nc = normCode(c);
    if (!rows.length && nc) {
      // 교차참조(BAW·GROB·VASLO·KYB·MOOG·YOKOMITSU 등 — product_xref_codes)
      rows = (await exec(
        `SELECT p.id, p.code, p.name, p.app
           FROM product_xref_codes x JOIN products p ON p.id = x.product_id AND p.deleted_at IS NULL
          WHERE x.norm_code = $1 ORDER BY p.code LIMIT 1`, [nc])).rows;
      source = rows.length ? 'xref' : source;
    }
    if (!rows.length && nc) {
      // SYD 정규화 폴백 (하이픈 유무 등 표기 차이)
      rows = (await exec(
        `SELECT p.id, p.code, p.name, p.app
           FROM product_syd_codes s JOIN products p ON p.id = s.product_id AND p.deleted_at IS NULL
          WHERE regexp_replace(upper(s.syd_code), '[^A-Z0-9]', '', 'g') = $1 ORDER BY p.code LIMIT 1`, [nc])).rows;
      source = rows.length ? 'syd' : 'none';
    }
    if (!rows.length) return { source: 'none', product: null };
    return { source, product: rows[0] };
  }

  // 코드 → 분류 결과(가용재고 포함)
  async function classifyCode(codeRaw, exec = query) {
    const { source, product } = await resolveCode(codeRaw, exec);
    if (!product) {
      return { source: 'none', product_id: null, ctr_code: null, name: null, app: null, avail: null, classification: 'dev' };
    }
    const avail = await availFor(product.id, exec);
    return {
      source, product_id: Number(product.id), ctr_code: product.code, name: product.name, app: product.app,
      avail, classification: avail > 0 ? 'imm' : 'short',
    };
  }

  // product_id 직행 분류 (누적판매 체크리스트 — 코드 해석 없이 제품이 이미 특정됨)
  async function classifyProduct(productId, exec = query) {
    const p = (await exec(
      `SELECT id, code, name, app FROM products WHERE id = $1 AND deleted_at IS NULL`, [Number(productId)])).rows[0];
    if (!p) return null;
    const avail = await availFor(p.id, exec);
    return {
      source: 'ctr', product_id: Number(p.id), ctr_code: p.code, name: p.name, app: p.app,
      avail, classification: avail > 0 ? 'imm' : 'short',
    };
  }

  const d10 = (d) => (!d ? null : (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)));

  function lineRow(r) {
    return {
      id: Number(r.id), survey_id: Number(r.survey_id), line_no: nint(r.line_no),
      input_code: r.input_code, product_id: r.product_id != null ? Number(r.product_id) : null,
      ctr_code: r.ctr_code, product_name: r.product_name, app_text: r.app_text, match_source: r.match_source,
      avail_stock: num(r.avail_stock), observed_qty: num(r.observed_qty),
      classification: r.classification, dev_request_id: r.dev_request_id != null ? Number(r.dev_request_id) : null,
      note: r.note,
      origin: r.origin || 'code',                       // 'code' | 'history'
      sold_qty_snap: num(r.sold_qty_snap),              // 누적판매 스냅샷(A)
      last_sold_at: d10(r.last_sold_at),
    };
  }
  function surveyRow(s, creatorName) {
    return {
      id: Number(s.id), customer_id: s.customer_id != null ? Number(s.customer_id) : null,
      customer_name: s.customer_name, discount_rate: s.discount_rate != null ? Number(s.discount_rate) : null,
      survey_date: s.survey_date, status: s.status,
      geo_lat: s.geo_lat != null ? Number(s.geo_lat) : null, geo_lng: s.geo_lng != null ? Number(s.geo_lng) : null,
      quote_id: s.quote_id != null ? Number(s.quote_id) : null, dev_req_count: nint(s.dev_req_count),
      created_by: Number(s.created_by), creator_name: creatorName || '',
      completed_at: s.completed_at,
    };
  }
  // 3분류 + CTR 알파벳 정렬(개발필요는 입력코드 정렬)
  //  · imm/short/dev 는 **코드입력 줄(origin='code')만** 집계 — 기존 동작 그대로.
  //  · 누적판매 체크리스트 줄(origin='history')은 소진 계산 → replenish/kept/anomaly 로 분리.
  function summarize(lines) {
    const byCtr = (a, b) => String(a.ctr_code || '').localeCompare(String(b.ctr_code || ''));
    const byInput = (a, b) => String(a.input_code || '').localeCompare(String(b.input_code || ''));
    const code = lines.filter((l) => (l.origin || 'code') !== 'history');
    const hist = lines.filter((l) => (l.origin || 'code') === 'history');

    const imm = code.filter((l) => l.classification === 'imm').sort(byCtr);
    const short = code.filter((l) => l.classification === 'short').sort(byCtr);
    const dev = code.filter((l) => l.classification === 'dev').sort(byInput);

    const replenish = [], kept = [], anomaly = [];
    for (const l of hist) {
      const st = sellThrough(l.sold_qty_snap, l.observed_qty);
      const row = { ...l, sell_status: st.status, sold_out: st.sold_out, sell_pct: st.pct };
      if (st.status === 'anomaly') anomaly.push(row);
      else if (st.status === 'kept') kept.push(row);
      else replenish.push(row);                       // gone(완전소진) + partial(부분소진)
    }
    const rep = replenishSort(replenish);             // 소진율 ▼ → 소진량 ▼ → CTR
    const goneN = rep.filter((r) => r.sell_status === 'gone').length;

    return {
      imm, short, dev,
      counts: { imm: imm.length, short: short.length, dev: dev.length, total: code.length },
      replenish: rep,
      kept: kept.sort(byCtr),
      anomaly: anomaly.sort(byCtr),
      sell: {
        checked: hist.length,
        gone: goneN,
        partial: rep.length - goneN,
        kept: kept.length,
        anomaly: anomaly.length,
        replenish_lines: rep.length,
        replenish_qty: rep.reduce((s, r) => s + (Number(r.sold_out) || 0), 0),
      },
    };
  }

  // 미점검 건수 = 이 고객 누적판매 SKU 총 종수 − 점검한 줄 수
  async function soldMeta(survey, lines) {
    if (!survey.customer_id) return { enabled: false, total: 0, checked: 0, unchecked: 0 };
    const total = await customerSoldSkuCount(survey.customer_id);
    const checked = lines.filter((l) => (l.origin || 'code') === 'history').length;
    return { enabled: true, total, checked, unchecked: Math.max(0, total - checked) };
  }

  // 소유/접근 확인: 디렉터=전체, 그 외=본인 생성분만
  async function loadSurvey(id, perm) {
    const s = (await query(`SELECT * FROM field_surveys WHERE id = $1 AND deleted_at IS NULL`, [Number(id)])).rows[0];
    if (!s) return { err: 'not_found' };
    if (perm.role !== 'director' && Number(s.created_by) !== Number(perm.userId)) return { err: 'forbidden' };
    return { survey: s };
  }

  // ── 고객 옵션(팀 가시성 적용) — 고객 페이지 권한 없이도 사용 가능 ──
  app.get('/api/field-surveys/customer-options', { preHandler: [authGuard] }, async (req) => {
    const vis = visibleTeamIds(req.ctx.perm);
    const q = String(req.query.q || '').trim();
    const params = []; const conds = ['c.deleted_at IS NULL'];
    if (vis !== null) {
      if (!vis.length) return { items: [] };
      params.push(vis); conds.push(`c.team_id = ANY($${params.length})`);
    }
    if (q) { params.push(`%${q}%`); conds.push(`(c.name ILIKE $${params.length} OR c.code ILIKE $${params.length})`); }
    const rows = (await query(
      `SELECT id, code, name, discount FROM customers c WHERE ${conds.join(' AND ')} ORDER BY name LIMIT 1000`, params)).rows;
    return { items: rows.map((r) => ({ id: Number(r.id), code: r.code, name: r.name, discount: Number(r.discount) || 0 })) };
  });

  // ── 내 진행중(또는 상태별) 조사 목록 — 이어쓰기/데이터 분실 방지 ──
  app.get('/api/field-surveys', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm; const params = []; const conds = ['s.deleted_at IS NULL'];
    if (perm.role !== 'director') { params.push(perm.userId); conds.push(`s.created_by = $${params.length}`); }
    if (['open', 'completed', 'quoted', 'cancelled'].includes(String(req.query.status))) {
      params.push(String(req.query.status)); conds.push(`s.status = $${params.length}`);
    }
    const rows = (await query(
      `SELECT s.id, s.customer_id, s.customer_name, s.survey_date, s.status, s.created_at,
              (SELECT COUNT(*) FROM field_survey_lines l WHERE l.survey_id = s.id) AS line_count
         FROM field_surveys s WHERE ${conds.join(' AND ')}
        ORDER BY s.created_at DESC LIMIT 50`, params)).rows;
    return { items: rows.map((r) => ({
      id: Number(r.id), customer_id: r.customer_id != null ? Number(r.customer_id) : null,
      customer_name: r.customer_name, survey_date: r.survey_date, status: r.status,
      created_at: r.created_at, line_count: Number(r.line_count),
    })) };
  });

  // ── 조사 생성(고객 특정) ──
  //  · 등록 고객: { customer_id }
  //  · 미등록 고객: { guest_name, discount_rate }  (견적화면 불특정 고객과 동일 포맷)
  //  · 위치 승인 필수: { geo_lat, geo_lng } 없으면 거부
  app.post('/api/field-surveys', { preHandler: [authGuard] }, async (req, reply) => {
    const b = req.body || {};
    const lat = (b.geo_lat != null && b.geo_lat !== '') ? Number(b.geo_lat) : null;
    const lng = (b.geo_lng != null && b.geo_lng !== '') ? Number(b.geo_lng) : null;
    if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) {
      return reply.code(400).send({ error: 'location_required' });
    }
    const custId = b.customer_id ? Number(b.customer_id) : null;
    let custName = null, disc = null;
    if (custId) {
      const c = (await query(`SELECT name FROM customers WHERE id = $1 AND deleted_at IS NULL`, [custId])).rows[0];
      if (!c) return reply.code(404).send({ error: 'customer_not_found' });
      custName = c.name;                                   // 등록 고객: 할인율은 고객 등록값 사용(NULL 저장)
    } else {
      custName = String(b.guest_name || b.customer_name || '').trim() || null;
      if (!custName) return reply.code(400).send({ error: 'customer_required' });
      if (b.discount_rate == null || b.discount_rate === '') return reply.code(400).send({ error: 'discount_required' });
      disc = Number(b.discount_rate) || 0;                 // 미등록 고객: 입력 할인율 보관(견적 전환 시 사용)
    }
    const r = (await query(
      `INSERT INTO field_surveys (customer_id, customer_name, discount_rate, geo_lat, geo_lng, geo_at, survey_date, created_by)
       VALUES ($1,$2,$3,$4,$5,now(),COALESCE($6,CURRENT_DATE),$7) RETURNING id, survey_date`,
      [custId, custName, disc, lat, lng, b.survey_date || null, req.ctx.perm.userId])).rows[0];
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `field_survey:${r.id}` });
    return { id: Number(r.id), customer_id: custId, customer_name: custName, discount_rate: disc, survey_date: r.survey_date };
  });

  // ── 조사 + 줄 조회(정리 화면 / 이어쓰기) ──
  app.get('/api/field-surveys/:id', { preHandler: [authGuard] }, async (req, reply) => {
    const { survey, err } = await loadSurvey(req.params.id, req.ctx.perm);
    if (err) return reply.code(err === 'forbidden' ? 403 : 404).send({ error: err });
    const lines = (await query(
      `SELECT * FROM field_survey_lines WHERE survey_id = $1 ORDER BY line_no`, [survey.id])).rows.map(lineRow);
    const cb = (await query(`SELECT name FROM users WHERE id = $1`, [survey.created_by])).rows[0];
    return { survey: surveyRow(survey, cb && cb.name), lines, summary: summarize(lines), sold_meta: await soldMeta(survey, lines) };
  });

  // ── 기존 판매품목 점검 체크리스트: 이 고객 누적판매 목록 ──
  //   기본 = 누적수량 상위 30 / ?all=1 = 전체 / ?q= 코드·품명 검색
  //   미등록 고객(customer_id 없음) → enabled:false (누적판매가 없으므로 비활성)
  app.get('/api/field-surveys/:id/sold-history', { preHandler: [authGuard] }, async (req, reply) => {
    const { survey, err } = await loadSurvey(req.params.id, req.ctx.perm);
    if (err) return reply.code(err === 'forbidden' ? 403 : 404).send({ error: err });
    if (!survey.customer_id) return { enabled: false, items: [], total: 0, shown: 0, all: false, limit: SOLD_DEFAULT_LIMIT };
    const d = await customerSoldItems(survey.customer_id, {
      all: String(req.query.all || '') === '1',
      q: req.query.q,
      limit: SOLD_DEFAULT_LIMIT,
    });
    return { enabled: true, limit: SOLD_DEFAULT_LIMIT, ...d };
  });

  // ── 코드 한 건 추가(입력 즉시 저장 + 자동분류) ──
  //   body ⓐ 코드입력(기존):  { input_code, observed_qty? }                  → origin='code'
  //        ⓑ 체크리스트 점검: { product_id, observed_qty, origin:'history' } → origin='history'
  //          · observed_qty=0 = 「없음(0)」 = 완전소진.
  //          · 같은 조사에 같은 제품 줄이 이미 있으면 새로 만들지 않고 갱신(중복 줄 방지).
  app.post('/api/field-surveys/:id/lines', { preHandler: [authGuard] }, async (req, reply) => {
    const { survey, err } = await loadSurvey(req.params.id, req.ctx.perm);
    if (err) return reply.code(err === 'forbidden' ? 403 : 404).send({ error: err });
    const b = req.body || {};
    const origin = String(b.origin || '') === 'history' ? 'history' : 'code';
    const pidIn = (b.product_id != null && b.product_id !== '') ? Number(b.product_id) : null;
    const obs = (b.observed_qty != null && b.observed_qty !== '') ? Number(b.observed_qty) : 1;

    // ⓑ 체크리스트 점검 경로
    if (origin === 'history') {
      if (!pidIn) return reply.code(400).send({ error: 'product_required' });
      if (!survey.customer_id) return reply.code(400).send({ error: 'sold_history_unavailable' }); // 미등록 고객
      const cl = await classifyProduct(pidIn);
      if (!cl) return reply.code(404).send({ error: 'product_not_found' });
      const sn = await soldSnapFor(survey.customer_id, pidIn);

      const dup = (await query(
        `SELECT id FROM field_survey_lines WHERE survey_id = $1 AND product_id = $2 ORDER BY line_no LIMIT 1`,
        [survey.id, pidIn])).rows[0];
      let r;
      if (dup) {
        r = (await query(
          `UPDATE field_survey_lines
              SET observed_qty=$1, origin='history', sold_qty_snap=$2, last_sold_at=$3,
                  avail_stock=$4, classification=$5, updated_at=now()
            WHERE id=$6 RETURNING *`,
          [obs, sn.sold, sn.last, cl.avail, cl.classification, dup.id])).rows[0];
      } else {
        const lineNo = Number((await query(
          `SELECT COALESCE(MAX(line_no),0)+1 AS n FROM field_survey_lines WHERE survey_id = $1`, [survey.id])).rows[0].n);
        r = (await query(
          `INSERT INTO field_survey_lines
             (survey_id, line_no, input_code, product_id, ctr_code, product_name, app_text, match_source,
              avail_stock, observed_qty, classification, origin, sold_qty_snap, last_sold_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'history',$12,$13) RETURNING *`,
          [survey.id, lineNo, cl.ctr_code, cl.product_id, cl.ctr_code, cl.name, cl.app, cl.source,
           cl.avail, obs, cl.classification, sn.sold, sn.last])).rows[0];
      }
      await query(`UPDATE field_surveys SET updated_by = $1, updated_at = now() WHERE id = $2`, [req.ctx.perm.userId, survey.id]);
      return { line: lineRow(r) };
    }

    // ⓐ 코드입력 경로 (기존 동작 그대로)
    const code = String(b.input_code || '').trim();
    if (!code) return reply.code(400).send({ error: 'code_required' });
    const cl = await classifyCode(code);
    const lineNo = Number((await query(
      `SELECT COALESCE(MAX(line_no),0)+1 AS n FROM field_survey_lines WHERE survey_id = $1`, [survey.id])).rows[0].n);
    const r = (await query(
      `INSERT INTO field_survey_lines
         (survey_id, line_no, input_code, product_id, ctr_code, product_name, app_text, match_source, avail_stock, observed_qty, classification)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [survey.id, lineNo, code, cl.product_id, cl.ctr_code, cl.name, cl.app, cl.source, cl.avail, obs, cl.classification])).rows[0];
    await query(`UPDATE field_surveys SET updated_by = $1, updated_at = now() WHERE id = $2`, [req.ctx.perm.userId, survey.id]);
    return { line: lineRow(r) };
  });

  // ── 엑셀 대량 업로드: 코드+수량 목록 일괄 추가 ──
  //  body: { items: [ { code, qty } ] }  (청크 최대 1000건)
  //  · 수량 방어 파싱: '1,000' 쉼표 제거, 빈칸/NaN/0 이하 → 1 (한 행 때문에 전체 실패하지 않음)
  //  · 각 코드는 단건 입력과 동일한 resolveCode(CTR→SYD→xref)로 자동 분류
  app.post('/api/field-surveys/:id/lines/bulk', { preHandler: [authGuard] }, async (req, reply) => {
    const { survey, err } = await loadSurvey(req.params.id, req.ctx.perm);
    if (err) return reply.code(err === 'forbidden' ? 403 : 404).send({ error: err });
    const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 1000) : [];
    if (!items.length) return reply.code(400).send({ error: 'no_items' });

    const parseQty = (v) => {
      if (v == null || v === '') return 1;
      const n = Number(String(v).replace(/[,\s]/g, ''));
      return (Number.isFinite(n) && n > 0) ? n : 1;
    };

    const out = await withTx(async (c) => {
      const exec = c.query.bind(c);
      let lineNo = Number((await exec(
        `SELECT COALESCE(MAX(line_no),0) AS n FROM field_survey_lines WHERE survey_id = $1`, [survey.id])).rows[0].n);
      const lines = []; let skipped = 0;
      for (const it of items) {
        const code = String((it && it.code) || '').trim();
        if (!code) { skipped++; continue; }
        const obs = parseQty(it && it.qty);
        const cl = await classifyCode(code, exec);
        lineNo += 1;
        const r = (await exec(
          `INSERT INTO field_survey_lines
             (survey_id, line_no, input_code, product_id, ctr_code, product_name, app_text, match_source, avail_stock, observed_qty, classification)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [survey.id, lineNo, code, cl.product_id, cl.ctr_code, cl.name, cl.app, cl.source, cl.avail, obs, cl.classification])).rows[0];
        lines.push(lineRow(r));
      }
      await exec(`UPDATE field_surveys SET updated_by = $1, updated_at = now() WHERE id = $2`, [req.ctx.perm.userId, survey.id]);
      return { lines, skipped };
    });

    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `field_survey:${survey.id}`,
      detail: { bulk_lines: out.lines.length, skipped: out.skipped } });
    const counts = { imm: 0, short: 0, dev: 0 };
    for (const l of out.lines) counts[l.classification] = (counts[l.classification] || 0) + 1;
    return { lines: out.lines, added: out.lines.length, skipped: out.skipped, counts };
  });

  // ── 관측수량/메모 수정(스테퍼 즉시 저장) ──
  app.patch('/api/field-surveys/lines/:lineId', { preHandler: [authGuard] }, async (req, reply) => {
    const ln = (await query(
      `SELECT l.*, s.created_by AS owner FROM field_survey_lines l
         JOIN field_surveys s ON s.id = l.survey_id
        WHERE l.id = $1 AND s.deleted_at IS NULL`, [Number(req.params.lineId)])).rows[0];
    if (!ln) return reply.code(404).send({ error: 'not_found' });
    if (req.ctx.perm.role !== 'director' && Number(ln.owner) !== Number(req.ctx.perm.userId)) return reply.code(403).send({ error: 'forbidden' });
    const b = req.body || {};
    const obs = (b.observed_qty != null && b.observed_qty !== '') ? Number(b.observed_qty) : ln.observed_qty;
    const r = (await query(
      `UPDATE field_survey_lines SET observed_qty = $1, note = COALESCE($2, note), updated_at = now()
        WHERE id = $3 RETURNING *`, [obs, (b.note != null ? b.note : null), ln.id])).rows[0];
    return { line: lineRow(r) };
  });

  // ── 줄 삭제 ──
  app.delete('/api/field-surveys/lines/:lineId', { preHandler: [authGuard] }, async (req, reply) => {
    const ln = (await query(
      `SELECT l.id, s.created_by AS owner FROM field_survey_lines l
         JOIN field_surveys s ON s.id = l.survey_id WHERE l.id = $1 AND s.deleted_at IS NULL`, [Number(req.params.lineId)])).rows[0];
    if (!ln) return reply.code(404).send({ error: 'not_found' });
    if (req.ctx.perm.role !== 'director' && Number(ln.owner) !== Number(req.ctx.perm.userId)) return reply.code(403).send({ error: 'forbidden' });
    await query(`DELETE FROM field_survey_lines WHERE id = $1`, [ln.id]);
    return { ok: true };
  });

  // ── 모두 완료: 재분류(최신 가용재고) + 개발필요 자동 개발요청 등록 ──
  app.post('/api/field-surveys/:id/complete', { preHandler: [authGuard] }, async (req, reply) => {
    const { survey, err } = await loadSurvey(req.params.id, req.ctx.perm);
    if (err) return reply.code(err === 'forbidden' ? 403 : 404).send({ error: err });

    const out = await withTx(async (c) => {
      const lines = (await c.query(`SELECT * FROM field_survey_lines WHERE survey_id = $1 ORDER BY line_no`, [survey.id])).rows;
      const custName = survey.customer_name
        || (survey.customer_id ? (await c.query(`SELECT name FROM customers WHERE id = $1`, [survey.customer_id])).rows[0] : null)?.name
        || '';
      let devCreated = 0;
      for (const ln of lines) {
        // ── 누적판매 체크리스트 줄: 가용재고 + 누적판매 스냅샷만 최신화. 개발요청 대상 아님. ──
        if ((ln.origin || 'code') === 'history' && ln.product_id) {
          const cp = await classifyProduct(ln.product_id, c.query.bind(c));
          const sn = await soldSnapFor(survey.customer_id, ln.product_id, c.query.bind(c));
          if (cp) {
            await c.query(
              `UPDATE field_survey_lines
                  SET avail_stock=$1, classification=$2, sold_qty_snap=$3, last_sold_at=$4, updated_at=now()
                WHERE id=$5`, [cp.avail, cp.classification, sn.sold, sn.last, ln.id]);
          }
          continue;
        }
        // 최신 상태로 재분류(가용재고 변동·신규 등록 코드 반영)
        const cl = await classifyCode(ln.input_code, c.query.bind(c));
        await c.query(
          `UPDATE field_survey_lines
              SET product_id=$1, ctr_code=$2, product_name=$3, app_text=$4, match_source=$5,
                  avail_stock=$6, classification=$7, updated_at=now()
            WHERE id=$8`,
          [cl.product_id, cl.ctr_code, cl.name, cl.app, cl.source, cl.avail, cl.classification, ln.id]);

        if (cl.classification === 'dev') {
          // 중복가드: 같은 조사 + 같은 입력코드
          const dup = (await c.query(
            `SELECT id FROM product_dev_requests
              WHERE field_survey_id = $1 AND input_code IS NOT DISTINCT FROM $2 AND deleted_at IS NULL`,
            [survey.id, ln.input_code])).rows[0];
          let drId = dup ? Number(dup.id) : null;
          if (!dup) {
            const dr = (await c.query(
              `INSERT INTO product_dev_requests
                 (input_code, customer_id, requested_qty, requested_at, field_survey_id, status, created_by)
               VALUES ($1,$2,$3,CURRENT_DATE,$4,'received',$5) RETURNING id`,
              [ln.input_code, survey.customer_id || null, Number(ln.observed_qty) || null, survey.id, req.ctx.perm.userId])).rows[0];
            drId = Number(dr.id); devCreated++;
            await notifyProductMarketing(c, {
              title: `개발검토 요청: ${ln.input_code}`,
              detail: `${custName ? custName + ' 고객 ' : ''}현장재고조사에서 미등록 코드 ${ln.input_code} 개발 검토가 필요합니다. (관측수량 ${ln.observed_qty || '-'})`,
              createdBy: req.ctx.perm.userId,
            });
          }
          await c.query(`UPDATE field_survey_lines SET dev_request_id = $1 WHERE id = $2`, [drId, ln.id]);
        } else {
          await c.query(`UPDATE field_survey_lines SET dev_request_id = NULL WHERE id = $1`, [ln.id]);
        }
      }
      await c.query(
        `UPDATE field_surveys SET status = 'completed', completed_at = now(), dev_req_count = dev_req_count + $1,
                updated_by = $2, updated_at = now() WHERE id = $3`,
        [devCreated, req.ctx.perm.userId, survey.id]);
      return { devCreated };
    });

    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `field_survey:${survey.id}`, detail: { completed: true, dev_requests: out.devCreated } });

    const lines = (await query(`SELECT * FROM field_survey_lines WHERE survey_id = $1 ORDER BY line_no`, [survey.id])).rows.map(lineRow);
    const cb = (await query(`SELECT name FROM users WHERE id = $1`, [survey.created_by])).rows[0];
    const s2 = (await query(`SELECT * FROM field_surveys WHERE id = $1`, [survey.id])).rows[0];
    return { survey: surveyRow(s2, cb && cb.name), lines, summary: summarize(lines),
             sold_meta: await soldMeta(s2, lines), dev_requests_created: out.devCreated };
  });

  // ── 견적 전환 기록(프런트가 /api/quotes 생성 후 호출) ──
  //  · 미등록 고객 견적 전환 시 자동 등록된 customer_id 를 받아 조사에도 backfill
  app.post('/api/field-surveys/:id/mark-quoted', { preHandler: [authGuard] }, async (req, reply) => {
    const { survey, err } = await loadSurvey(req.params.id, req.ctx.perm);
    if (err) return reply.code(err === 'forbidden' ? 403 : 404).send({ error: err });
    const qid = req.body && req.body.quote_id ? Number(req.body.quote_id) : null;
    const newCust = (req.body && req.body.customer_id) ? Number(req.body.customer_id) : null;
    const custId = survey.customer_id != null ? Number(survey.customer_id) : newCust;  // 기존 null 이면 backfill
    await query(
      `UPDATE field_surveys SET status = 'quoted', quote_id = $1, customer_id = $2, updated_by = $3, updated_at = now() WHERE id = $4`,
      [qid, custId, req.ctx.perm.userId, survey.id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `field_survey:${survey.id}`, detail: { quoted: qid } });
    return { ok: true };
  });
}
