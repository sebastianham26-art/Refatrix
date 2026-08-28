// stockCountRoutes.js · rev 20260827spot2 (redeploy marker — 기동 성공 시 아래 로그가 찍힘)
import { query, withTx } from '../db.js';
import { authGuard, requirePage, requirePageEdit } from '../middleware/authGuard.js';
import { fieldVisible, round2 } from '../permissions.js';
import { logEvent } from '../audit.js';
import { verifyPin } from '../auth.js';
import { splitRacks } from './zoneRoutes.js';

// =====================================================================
// Refatrix ERP · stockCountRoutes.js  (재고실사 / Inventory Count)
//   · 권한: 'warehouse' 페이지(창고담당) + 디렉터 바이패스.
//   · 대조 기준 = 실물 시스템 재고 products.stock_qty (가용재고 아님).
//     가용재고(= 현재고 − 미결·미만료 견적 예약)는 참고 컬럼으로만 제공.
//   · 감사 전용: 실사 기록은 재고를 바꾸지 않음.
//     디렉터 "실물로 맞추기"(apply) 시에만 stock_movements(adjust) + stock_qty 갱신.
//   · 금액 영향(원가/정가 환산)은 unit_cost 권한자(또는 디렉터)에게만 반환.
//
//   세션 모드 2종 (0188) --------------------------------------------
//   · mode='full' — 기존 전체 재고실사. SC-YYYY-NNNN. 라인 기록 → 대조 →
//                   디렉터 PIN 검토·반영(stock_qty 조정). 동작 완전 불변.
//   · mode='spot' — SKU 스팟점검. SP-YYYY-NNNN. 제품 스캔 → 시스템 수량·위치
//                   확인 → 랙 스캔(맞음) / [틀림]. **기록 전용 — 재고를 절대
//                   바꾸지 않는다.** 그래서 라인·대조·반영 경로는 spot 세션을
//                   서버에서 거부한다(아래 assertMode / spotBlocked).
// =====================================================================

export default async function stockCountRoutes(app) {
  try { console.log("[stockCountRoutes] loaded rev 20260827spot2"); } catch (e) {}
  const isDirector = (req) => req.ctx.perm.role === 'director';
  const canSeeValue = (req) => isDirector(req) || fieldVisible(req.ctx.perm, 'unit_cost');
  const num = (v) => (v == null ? 0 : Number(v));

  // ---- Code-128 카톤 라벨 파서 ----------------------------------------
  //   창고 라벨은 `CTR-<제품번호>-<소입수량>` 이다 (CTR-CE0796-16 → CE0796 · 16 EA).
  //   스캐너는 이 한 줄을 통째로 흘려보내므로, **가운데 제품번호만** 뽑아야 매칭이 된다.
  //
  //   방식은 수입입고 화면(refatrix-inbound.html parseLabel)에서 검증된 것을 그대로 쓴다:
  //   후보를 순서대로 만들고 DB 에 하나씩 물어보고 **첫 히트**를 쓴다. 라벨 변종
  //   (접두어 없음 / 수량 없음 / 제품번호 자체에 하이픈)에 견딘다.
  //
  //   ⚠ 핵심 안전장치: **접두어(CTR|SYD)가 없으면 뒤쪽 -숫자를 수량으로 단정하지 않는다.**
  //      랙 라벨 `A-01-03` 이나 사내 코드 `ABC-12` 를 제멋대로 잘라 엉뚱한 제품에
  //      붙이는 사고를 막는다(수입입고와 같은 규칙).
  const LABEL_PREFIX = /^(CTR|SYD)-?(.+)$/;
  const LABEL_QTY = /^(.*[A-Z0-9])-(\d{1,6})$/;
  // 스캐너 자판 보정('→-) · 공백 제거 · 대문자. 프런트도 같은 일을 하지만 서버가 최종 방어선이다.
  const normScanCode = (v) => String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/['´`‘’′ʼ]/g, '-')
    .replace(/\s+/g, '')
    .toUpperCase();
  const bareOf = (v) => normScanCode(v).replace(/[^A-Z0-9]/g, '');

  // 스캔 원문 → 시도할 코드 후보 목록(순서 = 우선순위). 첫 항목은 항상 원문이라
  // 기존 동작(정확매칭)이 먼저 걸린다 — 이 파서는 **덧붙이는 폴백**이다.
  function labelCandidates(raw) {
    const norm = normScanCode(raw);
    const out = [{ code: norm, qty: 0, prefix: '', from_label: false }];
    if (!norm) return out;
    const mp = norm.match(LABEL_PREFIX);
    const pre = mp ? mp[1] : '';
    const body = mp ? mp[2] : norm;
    if (pre) {
      const mq = body.match(LABEL_QTY);
      if (mq) out.push({ code: mq[1], qty: Number(mq[2]), prefix: pre, from_label: true }); // ① 접두어 제거 + 수량 분리
      out.push({ code: body, qty: 0, prefix: pre, from_label: true });                      // ② 접두어만 제거
      const mq2 = norm.match(LABEL_QTY);
      if (mq2) out.push({ code: mq2[1], qty: Number(mq2[2]), prefix: '', from_label: true });// ③ 접두어를 코드로 취급
    }
    // 중복 제거(같은 후보를 두 번 조회하지 않게)
    const seen = new Set();
    return out.filter((c) => c.code && !seen.has(c.code) && seen.add(c.code));
  }

  // ---- 코드 해석: CTR → EAN → SYD → 프로모(코드/바코드) → 미등록 --------
  //   codeRaw 가 카톤 라벨이면 위 후보를 순서대로 시도한다. 반환에 라벨 정보를 덧붙인다:
  //   from_label(라벨에서 뽑은 코드로 붙었는지) · label_qty(라벨의 소입수량) · scanned(정규화된 원문)
  async function resolveCode(codeRaw, exec = query) {
    const cands = labelCandidates(codeRaw);
    if (!cands.length || !cands[0].code) return { item_kind: 'unknown', source: 'none' };
    for (const cand of cands) {
      const r = await resolveExact(cand.code, exec);
      if (r.item_kind !== 'unknown') {
        return { ...r, from_label: !!cand.from_label, label_qty: cand.qty || 0, scanned: cands[0].code };
      }
    }
    // 마지막 폴백 — **구분자가 사라진 라벨** (스캐너 자판 미설정 / ALT 모드 → `CTRCE079616`).
    //   접두어(CTR|SYD)가 있을 때만, 몸통 뒤 1~6자리를 소입수량으로 떼어 본다.
    //   어디까지가 제품번호인지 원리적으로 알 수 없으므로(CE0796+16 / CE07961+6 …)
    //   **후보 중 정확히 한 제품에만 걸릴 때** 채택한다. 둘 이상이면 추측하지 않는다.
    const mp = cands[0].code.match(LABEL_PREFIX);
    if (mp) {
      const body = bareOf(mp[2]);
      const tries = new Map();                          // 벗긴 코드 → 떼어낸 수량
      if (body.length >= 4) tries.set(body, 0);
      for (let n = 1; n <= 6; n += 1) {
        const m2 = body.match(new RegExp(`^(.*[A-Z0-9])(\\d{${n}})$`));
        if (m2 && m2[1].length >= 4) tries.set(m2[1], Number(m2[2]));
      }
      if (tries.size) {
        const rows = (await exec(
          `SELECT id, code, name, app,
                  REGEXP_REPLACE(UPPER(code), '[^A-Z0-9]', '', 'g') AS barecode
             FROM products
            WHERE deleted_at IS NULL
              AND REGEXP_REPLACE(UPPER(code), '[^A-Z0-9]', '', 'g') = ANY($1::text[])
            ORDER BY code`, [[...tries.keys()]])).rows;
        const uniq = [...new Map(rows.map((x) => [String(x.id), x])).values()];
        if (uniq.length === 1) {
          return { item_kind: 'part', source: 'ctr', product: uniq[0],
            from_label: true, label_qty: tries.get(uniq[0].barecode) || 0, scanned: cands[0].code };
        }
        if (uniq.length > 1) {
          // 여러 제품에 걸린다 — 조용히 하나를 고르지 않고, 왜 못 정했는지 알려 준다.
          return { item_kind: 'unknown', source: 'none', scanned: cands[0].code,
            ambiguous: uniq.map((x) => x.code) };
        }
      }
    }
    return { item_kind: 'unknown', source: 'none', scanned: cands[0].code };
  }

  // 정확매칭 4단계(기존 로직 그대로 — 순서·의미 불변)
  async function resolveExact(codeRaw, exec = query) {
    const c = String(codeRaw || '').trim();
    if (!c) return { item_kind: 'unknown', source: 'none' };

    // 1) 자동차부품 CTR 코드 정확매칭
    let rows = (await exec(
      `SELECT id, code, name, app FROM products
        WHERE deleted_at IS NULL AND UPPER(code) = UPPER($1) ORDER BY code LIMIT 1`, [c])).rows;
    if (rows.length) return { item_kind: 'part', source: 'ctr', product: rows[0] };

    // 2) EAN-13 바코드
    rows = (await exec(
      `SELECT id, code, name, app FROM products
        WHERE deleted_at IS NULL AND ean IS NOT NULL AND TRIM(ean) <> ''
          AND UPPER(TRIM(ean)) = UPPER($1) ORDER BY code LIMIT 1`, [c])).rows;
    if (rows.length) return { item_kind: 'part', source: 'ean', product: rows[0] };

    // 3) SYD(경쟁사) 역검색
    rows = (await exec(
      `SELECT p.id, p.code, p.name, p.app
         FROM product_syd_codes s JOIN products p ON p.id = s.product_id AND p.deleted_at IS NULL
        WHERE UPPER(s.syd_code) = UPPER($1) ORDER BY p.code LIMIT 1`, [c])).rows;
    if (rows.length) return { item_kind: 'part', source: 'syd', product: rows[0] };

    // 4) 프로모션 코드/바코드
    rows = (await exec(
      `SELECT id, code, name FROM promo_items
        WHERE deleted_at IS NULL AND active = TRUE
          AND (UPPER(code) = UPPER($1)
               OR (barcode IS NOT NULL AND TRIM(barcode) <> '' AND UPPER(TRIM(barcode)) = UPPER($1)))
        ORDER BY code LIMIT 1`, [c])).rows;
    if (rows.length) return { item_kind: 'promo', source: 'promo', promo: rows[0] };

    return { item_kind: 'unknown', source: 'none' };
  }

  // 부품 가용재고(참고용) = 현재고 − 미결·미만료 견적 예약분 (견적/현장조사와 동일 정의)
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
    return Math.max(0, num(r.stock_qty) - num(r.reserved));
  }

  // 세션 모드 — 'full'(전체 재고실사) | 'spot'(SKU 스팟점검). 알 수 없는 값은 full 로.
  const MODES = ['full', 'spot'];
  const normMode = (v) => (MODES.includes(String(v || '').trim()) ? String(v).trim() : 'full');
  const codePrefix = (mode) => (mode === 'spot' ? 'SP' : 'SC');

  async function nextCode(exec = query, mode = 'full') {
    // exec 은 query(함수) 또는 withTx 클라이언트(.query) 둘 다 올 수 있음 → 정규화
    const run = typeof exec === 'function' ? exec : (s, p) => exec.query(s, p);
    const year = new Date().getFullYear();
    const pre = codePrefix(mode);
    const r = (await run(`SELECT COUNT(*)::int AS n FROM stock_counts WHERE code LIKE $1`, [`${pre}-${year}-%`])).rows[0];
    return `${pre}-${year}-${String((r.n || 0) + 1).padStart(4, '0')}`;
  }

  // 세션 모드 확인 — 전체실사 전용 경로가 스팟 세션에 잘못 쓰이는 것을 서버에서 막는다.
  // 반환: { row } 또는 { err:{code,body} }
  async function loadSession(id, exec = query) {
    const run = typeof exec === 'function' ? exec : (s, p) => exec.query(s, p);
    return (await run(`SELECT id, code, status, mode FROM stock_counts WHERE id=$1`, [id])).rows[0] || null;
  }
  const SPOT_ONLY = { error: 'spot_only', note: 'SKU 스팟점검 세션에서는 쓸 수 없는 기능입니다.' };
  const FULL_ONLY = { error: 'full_only', note: '전체 재고실사 세션에서만 쓸 수 있는 기능입니다.' };

  function sessRow(r) {
    return {
      id: Number(r.id), code: r.code, status: r.status, mode: normMode(r.mode), scope_note: r.scope_note || '',
      started_by: r.started_by != null ? Number(r.started_by) : null, started_by_name: r.started_by_name || '',
      started_at: r.started_at, submitted_at: r.submitted_at, reconciled_at: r.reconciled_at,
      lines: r.lines != null ? Number(r.lines) : 0,
      checks: r.checks != null ? Number(r.checks) : 0,      // 스팟점검 건수(mode='spot')
      del_requested_at: r.del_requested_at || null,
      del_requested_by: r.del_requested_by != null ? Number(r.del_requested_by) : null,
      del_requested_by_name: r.del_requested_by_name || '',
    };
  }

  // ================= 세션 =================

  // 목록(최근 순). 창고담당은 전부 볼 수 있게(협업). 디렉터도 전체.
  app.get('/api/stock-counts', { preHandler: [authGuard, requirePage('warehouse')] }, async (req) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    // mode 필터(선택) — 없으면 전부. 화면의 「전체실사 / 스팟점검」 탭이 쓴다.
    const mode = MODES.includes(String(req.query.mode || '')) ? String(req.query.mode) : null;
    const rows = (await query(
      `SELECT sc.*, u.name AS started_by_name, du.name AS del_requested_by_name,
              (SELECT COUNT(*) FROM stock_count_lines l WHERE l.count_id = sc.id) AS lines,
              (SELECT COUNT(*) FROM stock_count_spot_checks k WHERE k.count_id = sc.id) AS checks
         FROM stock_counts sc
         LEFT JOIN users u ON u.id = sc.started_by
         LEFT JOIN users du ON du.id = sc.del_requested_by
        WHERE sc.status <> 'canceled'
          AND ($2::text IS NULL OR sc.mode = $2)
        ORDER BY sc.started_at DESC LIMIT $1`, [limit, mode])).rows;
    return { items: rows.map(sessRow) };
  });

  // 진행중(draft) 세션 — 이어쓰기용
  app.get('/api/stock-counts/active', { preHandler: [authGuard, requirePage('warehouse')] }, async (req) => {
    const rows = (await query(
      `SELECT sc.*, u.name AS started_by_name,
              (SELECT COUNT(*) FROM stock_count_lines l WHERE l.count_id = sc.id) AS lines,
              (SELECT COUNT(*) FROM stock_count_spot_checks k WHERE k.count_id = sc.id) AS checks
         FROM stock_counts sc LEFT JOIN users u ON u.id = sc.started_by
        WHERE sc.status = 'draft'
        ORDER BY sc.started_at DESC`, [])).rows;
    return { items: rows.map(sessRow) };
  });

  // 새 실사 세션. body.mode = 'full'(기본) | 'spot'
  app.post('/api/stock-counts', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req) => {
    const scope = String((req.body && req.body.scope_note) || '').trim().slice(0, 300) || null;
    const mode = normMode(req.body && req.body.mode);
    const uid = req.ctx.perm.userId;
    const row = await withTx(async (c) => {
      const code = await nextCode(c, mode);
      return (await c.query(
        `INSERT INTO stock_counts (code, status, scope_note, started_by, mode)
         VALUES ($1,'draft',$2,$3,$4) RETURNING *`, [code, scope, uid, mode])).rows[0];
    });
    await logEvent({ userId: uid, action: 'create', target: `stock_count:${row.id}`, detail: { code: row.code, mode } });
    return sessRow(row);
  });

  // 세션 상세 + 라인
  app.get('/api/stock-counts/:id', { preHandler: [authGuard, requirePage('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const sc = (await query(
      `SELECT sc.*, u.name AS started_by_name FROM stock_counts sc
         LEFT JOIN users u ON u.id = sc.started_by WHERE sc.id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    const lines = (await query(
      `SELECT l.*, COALESCE(p.name, pi.name) AS item_name, ru.name AS del_requested_by_name,
              (SELECT STRING_AGG(DISTINCT s.syd_code, ', ') FROM product_syd_codes s
                 WHERE s.product_id = l.product_id AND s.syd_code IS NOT NULL AND TRIM(s.syd_code) <> '') AS syd_code
         FROM stock_count_lines l
         LEFT JOIN products p ON p.id = l.product_id
         LEFT JOIN promo_items pi ON pi.id = l.promo_item_id
         LEFT JOIN users ru ON ru.id = l.del_requested_by
        WHERE l.count_id=$1 ORDER BY l.id`, [id])).rows;
    return {
      ...sessRow(sc),
      lines: lines.map((l) => ({
        id: Number(l.id), item_kind: l.item_kind,
        product_id: l.product_id != null ? Number(l.product_id) : null,
        promo_item_id: l.promo_item_id != null ? Number(l.promo_item_id) : null,
        raw_code: l.raw_code, matched_code: l.matched_code || '', match_source: l.match_source || '',
        syd_code: l.syd_code || '',
        item_name: l.item_name || '', rack_scanned: l.rack_scanned || '', counted_qty: num(l.counted_qty),
        del_requested_at: l.del_requested_at || null, del_requested_by: l.del_requested_by != null ? Number(l.del_requested_by) : null, del_requested_by_name: l.del_requested_by_name || '',
      })),
    };
  });

  // 코드 해석(입력 즉시 미리보기) — 저장은 별도
  app.get('/api/stock-counts/resolve', { preHandler: [authGuard, requirePage('warehouse')] }, async (req) => {
    const r = await resolveCode(req.query.code);
    // 카톤 라벨로 붙었는지(from_label)와 라벨의 소입수량(label_qty)을 함께 알려 준다 —
    // 화면이 "라벨 소입수 16 EA"를 안내해, 작업자가 총 재고와 헷갈리지 않게 하려는 것.
    const lbl = { from_label: !!r.from_label, label_qty: num(r.label_qty), scanned: r.scanned || '' };
    if (r.item_kind === 'part') {
      const avail = await availFor(r.product.id);
      const sys = (await query(`SELECT stock_qty, rack_location FROM products WHERE id=$1`, [r.product.id])).rows[0];
      return {
        item_kind: 'part', source: r.source, product_id: Number(r.product.id),
        matched_code: r.product.code, name: r.product.name || '', app: r.product.app || '',
        system_qty: num(sys && sys.stock_qty), avail_qty: avail, rack_location: (sys && sys.rack_location) || '',
        ...lbl,
      };
    }
    if (r.item_kind === 'promo') {
      const p = (await query(`SELECT stock_qty, rack_location FROM promo_items WHERE id=$1`, [r.promo.id])).rows[0];
      return {
        item_kind: 'promo', source: 'promo', promo_item_id: Number(r.promo.id),
        matched_code: r.promo.code, name: r.promo.name || '',
        system_qty: num(p && p.stock_qty), avail_qty: null, rack_location: (p && p.rack_location) || '',
        ...lbl,
      };
    }
    return { item_kind: 'unknown', source: 'none', scanned: r.scanned || '',
      from_label: false, label_qty: 0, ...(r.ambiguous ? { ambiguous: r.ambiguous } : {}) };
  });

  // 라인 기록(건별 자동저장). body: { raw_code, rack_scanned, counted_qty }
  app.post('/api/stock-counts/:id/lines', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const raw = String(b.raw_code || '').trim();
    if (!raw) return reply.code(400).send({ error: 'empty_code' });
    let qty = Number(b.counted_qty);
    if (!isFinite(qty)) qty = 1;
    if (qty < 0) return reply.code(400).send({ error: 'bad_qty' });
    const rack = String(b.rack_scanned || '').trim().slice(0, 120) || null;

    const sc = await loadSession(id);
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (normMode(sc.mode) === 'spot') return reply.code(409).send(FULL_ONLY);
    if (sc.status !== 'draft') return reply.code(409).send({ error: 'not_draft' });

    const r = await resolveCode(raw);
    const kind = r.item_kind;
    const productId = kind === 'part' ? Number(r.product.id) : null;
    const promoId = kind === 'promo' ? Number(r.promo.id) : null;
    const matched = kind === 'part' ? r.product.code : (kind === 'promo' ? r.promo.code : null);

    const row = (await query(
      `INSERT INTO stock_count_lines
         (count_id, item_kind, product_id, promo_item_id, raw_code, matched_code, match_source, rack_scanned, counted_qty, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [id, kind, productId, promoId, raw, matched, r.source, rack, qty, req.ctx.perm.userId])).rows[0];

    const name = kind === 'part' ? (r.product.name || '') : (kind === 'promo' ? (r.promo.name || '') : '');
    let systemQty = null, availQty = null, sydCode = '';
    if (kind === 'part') {
      systemQty = num((await query(`SELECT stock_qty FROM products WHERE id=$1`, [productId])).rows[0].stock_qty);
      availQty = await availFor(productId);
      sydCode = (await query(`SELECT STRING_AGG(DISTINCT syd_code, ', ') AS s FROM product_syd_codes WHERE product_id=$1 AND syd_code IS NOT NULL AND TRIM(syd_code) <> ''`, [productId])).rows[0].s || '';
    }
    else if (kind === 'promo') { systemQty = num((await query(`SELECT stock_qty FROM promo_items WHERE id=$1`, [promoId])).rows[0].stock_qty); }

    return {
      id: Number(row.id), item_kind: kind, source: r.source, product_id: productId, promo_item_id: promoId,
      raw_code: raw, matched_code: matched || '', syd_code: sydCode, item_name: name, rack_scanned: rack || '',
      counted_qty: qty, system_qty: systemQty, avail_qty: availQty,
    };
  });

  // 라인 수정(수량/랙)
  app.patch('/api/stock-counts/:id/lines/:lineId', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id); const lineId = Number(req.params.lineId);
    const sc = (await query(`SELECT status FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (sc.status !== 'draft') return reply.code(409).send({ error: 'not_draft' });
    const b = req.body || {};
    const sets = []; const args = [];
    if (b.counted_qty != null) {
      const q = Number(b.counted_qty);
      if (!isFinite(q) || q < 0) return reply.code(400).send({ error: 'bad_qty' });
      args.push(q); sets.push(`counted_qty=$${args.length}`);
    }
    if (b.rack_scanned != null) { args.push(String(b.rack_scanned).trim().slice(0, 120) || null); sets.push(`rack_scanned=$${args.length}`); }
    if (!sets.length) return { ok: true };
    args.push(lineId); args.push(id);
    const r = (await query(`UPDATE stock_count_lines SET ${sets.join(', ')} WHERE id=$${args.length - 1} AND count_id=$${args.length} RETURNING id`, args)).rows[0];
    if (!r) return reply.code(404).send({ error: 'line_not_found' });
    return { ok: true };
  });

  // 라인 삭제
  app.delete('/api/stock-counts/:id/lines/:lineId', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    if (!isDirector(req)) return reply.code(403).send({ error: 'director_only', note: '\ub514\ub809\ud130 \uc2b9\uc778\uc774 \ud544\uc694\ud569\ub2c8\ub2e4.' });
    const id = Number(req.params.id); const lineId = Number(req.params.lineId);
    const sc = (await query(`SELECT status FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (sc.status !== 'draft') return reply.code(409).send({ error: 'not_draft' });
    await query(`DELETE FROM stock_count_lines WHERE id=$1 AND count_id=$2`, [lineId, id]);
    return { ok: true };
  });

  // 선택 라인 삭제 요청(담당자) — draft 만, 플래그만 세팅
  app.post('/api/stock-counts/:id/lines/delete-request', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const ids = (req.body && Array.isArray(req.body.line_ids)) ? req.body.line_ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) return reply.code(400).send({ error: 'no_lines' });
    const sc = (await query(`SELECT status FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (sc.status !== 'draft') return reply.code(409).send({ error: 'not_draft' });
    const r = await query(`UPDATE stock_count_lines SET del_requested_at=now(), del_requested_by=$3 WHERE count_id=$1 AND id = ANY($2::bigint[]) AND del_requested_at IS NULL`, [id, ids, req.ctx.perm.userId]);
    return { ok: true, requested: r.rowCount };
  });

  // 선택 라인 삭제 승인(디렉터) — 실제 삭제
  app.post('/api/stock-counts/:id/lines/delete-approve', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    if (!isDirector(req)) return reply.code(403).send({ error: 'director_only', note: '\ub514\ub809\ud130 \uc2b9\uc778\uc774 \ud544\uc694\ud569\ub2c8\ub2e4.' });
    const id = Number(req.params.id);
    const ids = (req.body && Array.isArray(req.body.line_ids)) ? req.body.line_ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) return reply.code(400).send({ error: 'no_lines' });
    const sc = (await query(`SELECT status FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (sc.status !== 'draft') return reply.code(409).send({ error: 'not_draft' });
    const r = await query(`DELETE FROM stock_count_lines WHERE count_id=$1 AND id = ANY($2::bigint[])`, [id, ids]);
    return { ok: true, deleted: r.rowCount };
  });

  // 선택 라인 삭제요청 반려(디렉터) — 플래그 해제
  app.post('/api/stock-counts/:id/lines/delete-reject', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    if (!isDirector(req)) return reply.code(403).send({ error: 'director_only', note: '\ub514\ub809\ud130 \uc2b9\uc778\uc774 \ud544\uc694\ud569\ub2c8\ub2e4.' });
    const id = Number(req.params.id);
    const ids = (req.body && Array.isArray(req.body.line_ids)) ? req.body.line_ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) return reply.code(400).send({ error: 'no_lines' });
    await query(`UPDATE stock_count_lines SET del_requested_at=NULL, del_requested_by=NULL WHERE count_id=$1 AND id = ANY($2::bigint[])`, [id, ids]);
    return { ok: true };
  });

  // 선택 라인 직접 삭제(담당자) — draft 상태에서 승인 없이 즉시 삭제
  app.post('/api/stock-counts/:id/lines/delete', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const ids = (req.body && Array.isArray(req.body.line_ids)) ? req.body.line_ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) return reply.code(400).send({ error: 'no_lines' });
    const sc = (await query(`SELECT status FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (sc.status !== 'draft') return reply.code(409).send({ error: 'not_draft', note: '제출 후에는 직접 삭제할 수 없습니다.' });
    const r = await query(`DELETE FROM stock_count_lines WHERE count_id=$1 AND id = ANY($2::bigint[])`, [id, ids]);
    return { ok: true, deleted: r.rowCount };
  });

  // 제출(대조 확정) draft → submitted
  app.post('/api/stock-counts/:id/submit', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const sc = (await query(`SELECT status FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (sc.status !== 'draft') return reply.code(409).send({ error: 'not_draft' });
    await query(`UPDATE stock_counts SET status='submitted', submitted_at=now() WHERE id=$1`, [id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `stock_count:${id}`, detail: { step: 'submit' } });
    return { ok: true };
  });

  // 세션 취소(draft만)
  app.post('/api/stock-counts/:id/cancel', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const sc = (await query(`SELECT status FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (sc.status !== 'draft') return reply.code(409).send({ error: 'not_draft' });
    await query(`UPDATE stock_counts SET status='canceled' WHERE id=$1`, [id]);
    return { ok: true };
  });

  // ===== 세션 삭제: 담당자 요청 → 디렉터 승인 =====
  // 담당자가 세션 삭제를 요청(진행중/제출됨 대상). 반영완료·이미취소는 불가.
  app.post('/api/stock-counts/:id/delete-request', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const sc = (await query(`SELECT status FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (!['draft', 'submitted'].includes(sc.status)) return reply.code(409).send({ error: 'not_deletable', note: '진행중/제출된 실사만 삭제 요청할 수 있습니다.' });
    await query(`UPDATE stock_counts SET del_requested_at=now(), del_requested_by=$2 WHERE id=$1`, [id, req.ctx.perm.userId]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `stock_count:${id}`, detail: { step: 'delete_request' } });
    return { ok: true };
  });

  // 디렉터 승인 → 세션 취소(목록에서 사라짐, 데이터는 보존)
  app.post('/api/stock-counts/:id/delete-approve', { preHandler: [authGuard] }, async (req, reply) => {
    if (!isDirector(req)) return reply.code(403).send({ error: 'director_only', note: '디렉터만 승인할 수 있습니다.' });
    const id = Number(req.params.id);
    const sc = (await query(`SELECT status, del_requested_at FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (!sc.del_requested_at) return reply.code(409).send({ error: 'not_requested', note: '삭제 요청이 없습니다.' });
    if (!['draft', 'submitted'].includes(sc.status)) return reply.code(409).send({ error: 'not_deletable' });
    await query(`UPDATE stock_counts SET status='canceled', del_requested_at=NULL, del_requested_by=NULL WHERE id=$1`, [id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `stock_count:${id}`, detail: { step: 'delete_approve' } });
    return { ok: true };
  });

  // 디렉터 반려 → 요청 해제
  app.post('/api/stock-counts/:id/delete-reject', { preHandler: [authGuard] }, async (req, reply) => {
    if (!isDirector(req)) return reply.code(403).send({ error: 'director_only', note: '디렉터만 반려할 수 있습니다.' });
    const id = Number(req.params.id);
    await query(`UPDATE stock_counts SET del_requested_at=NULL, del_requested_by=NULL WHERE id=$1`, [id]);
    return { ok: true };
  });

  // =====================================================================
  // SKU 스팟점검 (mode='spot') — 0188
  //   현장 흐름:  ① 제품 바코드 스캔 → 시스템 수량·위치를 화면에 크게 표시
  //              ② 실물이 맞으면 랙 바코드 스캔        → result='ok'
  //              ③ 다르면 화면의 [✖ 틀림] 버튼        → result='mismatch'
  //   기록 전용이다. 여기서는 products/promo_items 를 **읽기만** 한다.
  //   수량도 위치도 이 경로로는 바뀌지 않는다(디렉터 결정 2026-08-27).
  // =====================================================================

  // 랙 비교 — 위치변경(rackMoveRoutes)과 같은 규칙: 대소문자·공백 무시,
  // 구분자 표기가 흔들리면(A'01'03 / A0103) 영숫자만 남겨 한 번 더 본다.
  const normRack = (v) => String(v == null ? '' : v).trim().toUpperCase();
  const bareRack = (v) => normRack(v).replace(/[^A-Z0-9]/g, '');
  function rackInMaster(scanned, master) {
    const list = splitRacks(master);
    if (!list.length) return null;                       // 마스터 위치가 비어 있으면 판정 불가
    const s = normRack(scanned), b = bareRack(scanned);
    if (!s) return null;
    return list.some((x) => normRack(x) === s || (bareRack(x) && bareRack(x) === b));
  }

  // 점검 시점 스냅샷(품명·시스템수량·마스터위치)을 읽어온다.
  async function spotSnapshot(r) {
    if (r.item_kind === 'part') {
      const p = (await query(`SELECT code, name, stock_qty, rack_location FROM products WHERE id=$1`, [r.product.id])).rows[0] || {};
      return { kind: 'part', product_id: Number(r.product.id), promo_item_id: null,
        code: p.code || r.product.code, name: p.name || '', system_qty: num(p.stock_qty), master_rack: p.rack_location || '' };
    }
    const p = (await query(`SELECT code, name, stock_qty, rack_location FROM promo_items WHERE id=$1`, [r.promo.id])).rows[0] || {};
    return { kind: 'promo', product_id: null, promo_item_id: Number(r.promo.id),
      code: p.code || r.promo.code, name: p.name || '', system_qty: num(p.stock_qty), master_rack: p.rack_location || '' };
  }

  function checkRow(k) {
    return {
      id: Number(k.id), count_id: Number(k.count_id), count_code: k.count_code || '',
      item_kind: k.item_kind,
      product_id: k.product_id != null ? Number(k.product_id) : null,
      promo_item_id: k.promo_item_id != null ? Number(k.promo_item_id) : null,
      raw_code: k.raw_code, matched_code: k.matched_code || '', match_source: k.match_source || '',
      item_name: k.item_name || k.cur_name || '',
      system_qty: num(k.system_qty), master_rack: k.master_rack || '',
      result: k.result, rack_scanned: k.rack_scanned || '',
      rack_match: k.rack_match == null ? null : !!k.rack_match,
      note: k.note || '',
      current_qty: k.cur_qty == null ? null : num(k.cur_qty),      // 지금 시스템 수량(점검 후 움직였는지)
      current_rack: k.cur_rack || '',
      checked_by: k.checked_by != null ? Number(k.checked_by) : null,
      checked_by_name: k.checked_by_name || '',
      checked_at: k.checked_at,
    };
  }

  // 요약 — 같은 SKU 를 여러 번 점검했으면 **가장 최근 결과**가 그 SKU 의 결과다.
  function spotSummary(rows) {
    const latest = new Map();
    for (const r of rows) {                                   // rows 는 최신순(id DESC)
      const key = r.item_kind + ':' + (r.product_id != null ? r.product_id : r.promo_item_id);
      if (!latest.has(key)) latest.set(key, r);
    }
    const last = [...latest.values()];
    return {
      checks: rows.length,
      skus: last.length,
      ok: last.filter((r) => r.result === 'ok').length,
      mismatch: last.filter((r) => r.result === 'mismatch').length,
      rack_diff: last.filter((r) => r.rack_match === false).length,
      no_rack_scan: last.filter((r) => r.result === 'ok' && !r.rack_scanned).length,
    };
  }

  const SPOT_SELECT = `
      k.*, sc.code AS count_code,
      COALESCE(p.name, pi.name)          AS cur_name,
      COALESCE(p.stock_qty, pi.stock_qty) AS cur_qty,
      COALESCE(p.rack_location, pi.rack_location) AS cur_rack,
      u.name AS checked_by_name
    FROM stock_count_spot_checks k
    JOIN stock_counts sc ON sc.id = k.count_id
    LEFT JOIN products p    ON p.id  = k.product_id
    LEFT JOIN promo_items pi ON pi.id = k.promo_item_id
    LEFT JOIN users u       ON u.id  = k.checked_by`;

  // 세션의 점검 내역 + 요약
  app.get('/api/stock-counts/:id/spot-checks', { preHandler: [authGuard, requirePage('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const sc = await loadSession(id);
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (normMode(sc.mode) !== 'spot') return reply.code(409).send(SPOT_ONLY);
    const rows = (await query(`SELECT ${SPOT_SELECT} WHERE k.count_id=$1 ORDER BY k.id DESC`, [id])).rows.map(checkRow);
    // 필드명 status 는 쓰지 않는다 — 프런트 api() 가 HTTP status 와 한 객체에 펼쳐 담아 덮어쓴다.
    return { count_id: id, code: sc.code, count_status: sc.status, summary: spotSummary(rows), checks: rows };
  });

  // 점검 1건 기록. body: { raw_code, result:'ok'|'mismatch', rack_scanned?, note? }
  //   · 수량은 받지 않는다(디렉터 결정) — 현장은 맞음/틀림만 남기고, 정확한 수량은 전체 재고실사에서 센다.
  //   · system_qty·master_rack 은 **서버가 지금 다시 읽어** 스냅샷으로 저장한다(프런트 값을 믿지 않는다).
  app.post('/api/stock-counts/:id/spot-checks', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const raw = String(b.raw_code || '').trim();
    if (!raw) return reply.code(400).send({ error: 'empty_code' });
    const result = (b.result === 'ok' || b.result === 'mismatch') ? b.result : null;
    if (!result) return reply.code(400).send({ error: 'bad_result', note: "result 는 'ok' 또는 'mismatch' 여야 합니다." });
    const rack = String(b.rack_scanned || '').trim().slice(0, 120) || null;
    const note = String(b.note || '').trim().slice(0, 300) || null;

    const sc = await loadSession(id);
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (normMode(sc.mode) !== 'spot') return reply.code(409).send(SPOT_ONLY);
    if (sc.status !== 'draft') return reply.code(409).send({ error: 'not_draft', note: '완료된 점검에는 추가할 수 없습니다.' });

    const r = await resolveCode(raw);
    if (r.item_kind === 'unknown') {
      if (r.ambiguous) {
        return reply.code(409).send({ error: 'ambiguous_code', ambiguous: r.ambiguous,
          note: '라벨을 여러 제품으로 읽을 수 있습니다 (' + r.ambiguous.join(' / ') + ') — 제품번호를 직접 입력하세요.' });
      }
      return reply.code(404).send({ error: 'unknown_code', note: '등록되지 않은 코드입니다.' });
    }
    const snap = await spotSnapshot(r);
    const rackMatch = rack ? rackInMaster(rack, snap.master_rack) : null;

    const ins = (await query(
      `INSERT INTO stock_count_spot_checks
         (count_id, item_kind, product_id, promo_item_id, raw_code, matched_code, match_source,
          item_name, system_qty, master_rack, result, rack_scanned, rack_match, note, checked_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [id, snap.kind, snap.product_id, snap.promo_item_id, raw, snap.code, r.source,
       snap.name, snap.system_qty, snap.master_rack || null, result, rack, rackMatch, note, req.ctx.perm.userId])).rows[0];

    const row = (await query(`SELECT ${SPOT_SELECT} WHERE k.id=$1`, [Number(ins.id)])).rows[0];
    return { ok: true, check: checkRow(row) };
  });

  // 점검 1건 취소(오스캔 정정) — 진행중 세션에서 본인 기록, 디렉터는 전부.
  app.delete('/api/stock-counts/:id/spot-checks/:checkId', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id); const cid = Number(req.params.checkId);
    const sc = await loadSession(id);
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (normMode(sc.mode) !== 'spot') return reply.code(409).send(SPOT_ONLY);
    if (sc.status !== 'draft') return reply.code(409).send({ error: 'not_draft', note: '완료된 점검은 수정할 수 없습니다.' });
    const k = (await query(`SELECT id, checked_by FROM stock_count_spot_checks WHERE id=$1 AND count_id=$2`, [cid, id])).rows[0];
    if (!k) return reply.code(404).send({ error: 'check_not_found' });
    if (!isDirector(req) && Number(k.checked_by) !== Number(req.ctx.perm.userId)) {
      return reply.code(403).send({ error: 'not_owner', note: '본인이 기록한 점검만 취소할 수 있습니다.' });
    }
    await query(`DELETE FROM stock_count_spot_checks WHERE id=$1 AND count_id=$2`, [cid, id]);
    return { ok: true };
  });

  // 세션을 넘나드는 점검 이력 — "이 SKU 를 마지막으로 언제 확인했나"
  //   필터: days(기본 30) 또는 from/to · code(제품번호 부분일치) · result · rack · 세션
  app.get('/api/stock-counts/spot/history', { preHandler: [authGuard, requirePage('warehouse')] }, async (req) => {
    const q = req.query || {};
    const limit = Math.min(Number(q.limit) || 300, 2000);
    const args = [];
    const where = [`sc.mode='spot'`, `sc.status <> 'canceled'`];
    if (q.from) { args.push(String(q.from)); where.push(`k.checked_at >= $${args.length}::date`); }
    if (q.to) { args.push(String(q.to)); where.push(`k.checked_at < ($${args.length}::date + 1)`); }
    if (!q.from && !q.to) {
      const days = Math.min(Math.max(Number(q.days) || 30, 1), 730);
      where.push(`k.checked_at >= now() - INTERVAL '${days} days'`);
    }
    if (q.code) { args.push('%' + String(q.code).trim().toUpperCase() + '%'); where.push(`UPPER(COALESCE(k.matched_code,k.raw_code)) LIKE $${args.length}`); }
    if (q.result === 'ok' || q.result === 'mismatch') { args.push(q.result); where.push(`k.result = $${args.length}`); }
    if (q.rack) { args.push(String(q.rack).trim().toUpperCase()); where.push(`(UPPER(COALESCE(k.rack_scanned,'')) = $${args.length} OR UPPER(COALESCE(k.master_rack,'')) LIKE '%'||$${args.length}||'%')`); }
    if (q.count_id) { args.push(Number(q.count_id)); where.push(`k.count_id = $${args.length}`); }
    args.push(limit);

    const rows = (await query(
      `SELECT ${SPOT_SELECT} WHERE ${where.join(' AND ')} ORDER BY k.checked_at DESC, k.id DESC LIMIT $${args.length}`,
      args)).rows.map(checkRow);

    // SKU별 최근 점검(이력 화면의 두 번째 표) — 위 필터 결과 안에서 집계
    const bySku = new Map();
    for (const r of rows) {                                   // 최신순이므로 첫 등장 = 최근 점검
      const key = r.item_kind + ':' + (r.product_id != null ? r.product_id : r.promo_item_id);
      const cur = bySku.get(key);
      if (!cur) bySku.set(key, { code: r.matched_code || r.raw_code, name: r.item_name, item_kind: r.item_kind,
        product_id: r.product_id, promo_item_id: r.promo_item_id, last_at: r.checked_at, last_result: r.result,
        last_rack: r.rack_scanned || r.master_rack, checks: 1, mismatch: r.result === 'mismatch' ? 1 : 0 });
      else { cur.checks += 1; if (r.result === 'mismatch') cur.mismatch += 1; }
    }
    return { summary: spotSummary(rows), checks: rows, by_sku: [...bySku.values()], truncated: rows.length >= limit };
  });

  // ================= 대조(reconcile) =================
  // 세션 내 항목별 실사합계 vs 시스템 재고. 5분류.
  //   match / short(실물<시스템) / over(실물>시스템) / uncounted(재고有·미실사) / unknown(미등록)
  app.get('/api/stock-counts/:id/reconcile', { preHandler: [authGuard, requirePage('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const withValue = canSeeValue(req);
    const sc = (await query(
      `SELECT sc.*, u.name AS started_by_name FROM stock_counts sc
         LEFT JOIN users u ON u.id=sc.started_by WHERE sc.id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    // 스팟점검 세션은 대조 대상이 아니다 — 센 적 없는 SKU 를 전부 「미실사」로 잡아 무의미하다.
    if (normMode(sc.mode) === 'spot') return reply.code(409).send(FULL_ONLY);

    // 실사한 부품(집계) + 시스템 재고
    const parts = (await query(
      `SELECT g.product_id, g.counted, g.racks,
              p.code, p.name, p.rack_location, p.stock_qty, p.avg_cost, p.list_price,
              (SELECT STRING_AGG(DISTINCT s.syd_code, ', ') FROM product_syd_codes s
                 WHERE s.product_id=p.id AND s.syd_code IS NOT NULL AND TRIM(s.syd_code) <> '') AS syd_code,
              COALESCE((SELECT SUM(ql.reserved_qty)
                          FROM quote_lines ql JOIN quotes q ON q.id=ql.quote_id
                         WHERE ql.product_id=p.id AND q.status IN ('draft','confirmed')
                           AND (q.reserve_expires_at > now() OR q.packing_printed_at IS NOT NULL)
                           AND q.deleted_at IS NULL),0) AS reserved
         FROM (SELECT product_id, SUM(counted_qty) AS counted,
                      STRING_AGG(DISTINCT NULLIF(rack_scanned,''), ', ') AS racks
                 FROM stock_count_lines
                WHERE count_id=$1 AND item_kind='part' AND product_id IS NOT NULL
                GROUP BY product_id) g
         JOIN products p ON p.id=g.product_id`, [id])).rows;

    // 실사한 프로모(집계)
    const promos = (await query(
      `SELECT g.promo_item_id, g.counted, g.racks, pi.code, pi.name, pi.rack_location, pi.stock_qty, pi.unit_cost
         FROM (SELECT promo_item_id, SUM(counted_qty) AS counted,
                      STRING_AGG(DISTINCT NULLIF(rack_scanned,''), ', ') AS racks
                 FROM stock_count_lines
                WHERE count_id=$1 AND item_kind='promo' AND promo_item_id IS NOT NULL
                GROUP BY promo_item_id) g
         JOIN promo_items pi ON pi.id=g.promo_item_id`, [id])).rows;

    // 미등록 스캔(집계)
    const unknowns = (await query(
      `SELECT raw_code, SUM(counted_qty) AS counted,
              STRING_AGG(DISTINCT NULLIF(rack_scanned,''), ', ') AS racks
         FROM stock_count_lines
        WHERE count_id=$1 AND item_kind='unknown'
        GROUP BY raw_code ORDER BY raw_code`, [id])).rows;

    // 재고 있으나 실사되지 않은 부품(미실사) — 놓친 랙 탐지
    // 개수는 정확히 세되(요약용), 표시 행은 상위 N건만(부분 실사 중 카탈로그 전체 반환 방지)
    const UNCOUNTED_LIMIT = 300;
    const uncountedTotal = Number((await query(
      `SELECT COUNT(*)::int AS n FROM products p
        WHERE p.deleted_at IS NULL AND COALESCE(p.stock_qty,0) > 0
          AND NOT EXISTS (SELECT 1 FROM stock_count_lines l WHERE l.count_id=$1 AND l.product_id=p.id)`, [id])).rows[0].n);
    const uncounted = (await query(
      `SELECT p.id AS product_id, p.code, p.name, p.rack_location, p.stock_qty, p.avg_cost, p.list_price,
              (SELECT STRING_AGG(DISTINCT s.syd_code, ', ') FROM product_syd_codes s
                 WHERE s.product_id=p.id AND s.syd_code IS NOT NULL AND TRIM(s.syd_code) <> '') AS syd_code
         FROM products p
        WHERE p.deleted_at IS NULL AND COALESCE(p.stock_qty,0) > 0
          AND NOT EXISTS (SELECT 1 FROM stock_count_lines l
                           WHERE l.count_id=$1 AND l.product_id=p.id)
        ORDER BY p.stock_qty DESC LIMIT ${UNCOUNTED_LIMIT}`, [id])).rows;

    const rows = [];
    const S = { match: 0, short: 0, over: 0, uncounted: 0, unknown: 0 };
    let diffQty = 0, valCost = 0, valList = 0;

    for (const p of parts) {
      const sys = num(p.stock_qty); const cnt = num(p.counted); const diff = round2(cnt - sys);
      const cat = diff === 0 ? 'match' : (diff < 0 ? 'short' : 'over');
      S[cat] += 1; diffQty += diff;
      const vc = round2(diff * num(p.avg_cost)); const vl = round2(diff * num(p.list_price));
      valCost += vc; valList += vl;
      rows.push({
        kind: 'part', category: cat, product_id: Number(p.product_id), code: p.code, name: p.name || '', syd_code: p.syd_code || '',
        rack: p.racks || p.rack_location || '', rack_scanned: p.racks || '', master_rack: p.rack_location || '',
        system_qty: sys, counted_qty: cnt,
        avail_qty: Math.max(0, sys - num(p.reserved)), diff,
        ...(withValue ? { value_cost: vc, value_list: vl } : {}),
      });
    }
    for (const p of promos) {
      const sys = num(p.stock_qty); const cnt = num(p.counted); const diff = round2(cnt - sys);
      const cat = diff === 0 ? 'match' : (diff < 0 ? 'short' : 'over');
      S[cat] += 1; diffQty += diff;
      const vc = round2(diff * num(p.unit_cost));
      valCost += vc;
      rows.push({
        kind: 'promo', category: cat, promo_item_id: Number(p.promo_item_id), code: p.code, name: p.name || '',
        rack: p.racks || p.rack_location || '', rack_scanned: p.racks || '', master_rack: p.rack_location || '',
        system_qty: sys, counted_qty: cnt, avail_qty: null, diff,
        ...(withValue ? { value_cost: vc, value_list: 0 } : {}),
      });
    }
    for (const p of uncounted) {
      const sys = num(p.stock_qty);
      rows.push({
        kind: 'part', category: 'uncounted', product_id: Number(p.product_id), code: p.code, name: p.name || '', syd_code: p.syd_code || '',
        rack: p.rack_location || '', system_qty: sys, counted_qty: null, avail_qty: null, diff: null,
        ...(withValue ? { value_cost: 0, value_list: 0 } : {}),
      });
    }
    S.uncounted = uncountedTotal;   // 요약 개수는 전체(정확), 위 rows 는 상위 N건만
    for (const u of unknowns) {
      S.unknown += 1;
      rows.push({
        kind: 'unknown', category: 'unknown', code: u.raw_code, name: '(미등록 코드)',
        rack: u.racks || '', system_qty: null, counted_qty: num(u.counted), avail_qty: null, diff: null,
      });
    }

    // 정렬: 차이 큰 문제부터. cat 가중치 → |diff| 내림차순
    const catW = { short: 0, over: 1, unknown: 2, uncounted: 3, match: 4 };
    rows.sort((a, b) => {
      if (catW[a.category] !== catW[b.category]) return catW[a.category] - catW[b.category];
      return Math.abs(num(b.diff)) - Math.abs(num(a.diff));
    });

    const summary = {
      ...S, counted_items: parts.length + promos.length, diff_qty_total: round2(diffQty),
      uncounted_shown: uncounted.length, uncounted_truncated: uncountedTotal > uncounted.length,
      ...(withValue ? { value_cost_impact: round2(valCost), value_list_impact: round2(valList) } : {}),
    };
    return { count: sessRow(sc), can_apply: isDirector(req) && sc.status === 'submitted', summary, rows };
  });

  // ================= 실물로 맞추기 (디렉터) =================
  // 실사되어 차이가 난 항목만 조정. 미실사(uncounted)·미등록(unknown)은 건드리지 않음.
  async function buildAdjustPlan(id) {
    const parts = (await query(
      `SELECT g.product_id, g.counted, p.code, p.name, p.stock_qty
         FROM (SELECT product_id, SUM(counted_qty) AS counted FROM stock_count_lines
                WHERE count_id=$1 AND item_kind='part' AND product_id IS NOT NULL GROUP BY product_id) g
         JOIN products p ON p.id=g.product_id WHERE p.deleted_at IS NULL`, [id])).rows;
    const promos = (await query(
      `SELECT g.promo_item_id, g.counted, pi.code, pi.name, pi.stock_qty
         FROM (SELECT promo_item_id, SUM(counted_qty) AS counted FROM stock_count_lines
                WHERE count_id=$1 AND item_kind='promo' AND promo_item_id IS NOT NULL GROUP BY promo_item_id) g
         JOIN promo_items pi ON pi.id=g.promo_item_id WHERE pi.deleted_at IS NULL`, [id])).rows;
    const plan = [];
    for (const p of parts) {
      const before = num(p.stock_qty); const after = num(p.counted); const delta = round2(after - before);
      if (delta !== 0) plan.push({ kind: 'part', product_id: Number(p.product_id), code: p.code, name: p.name || '', before, after, delta });
    }
    for (const p of promos) {
      const before = num(p.stock_qty); const after = num(p.counted); const delta = round2(after - before);
      if (delta !== 0) plan.push({ kind: 'promo', promo_item_id: Number(p.promo_item_id), code: p.code, name: p.name || '', before, after, delta });
    }
    return plan;
  }

  // 디렉터 검토 목록: 수량 차이(delta≠0) 또는 실사랙≠마스터랙 인 항목.
  // 각 항목에 시스템/실사/차이 + 실사랙(rack_scanned) + 마스터랙(master_rack) 포함.
  async function buildReviewList(id, exec = query) {
    const run = typeof exec === 'function' ? exec : (s, p) => exec.query(s, p);
    const parts = (await run(
      `SELECT g.product_id, g.counted, g.racks, p.code, p.name, p.stock_qty, p.rack_location
         FROM (SELECT product_id, SUM(counted_qty) AS counted,
                      STRING_AGG(DISTINCT NULLIF(rack_scanned,''), ', ') AS racks
                 FROM stock_count_lines
                WHERE count_id=$1 AND item_kind='part' AND product_id IS NOT NULL GROUP BY product_id) g
         JOIN products p ON p.id=g.product_id WHERE p.deleted_at IS NULL`, [id])).rows;
    const promos = (await run(
      `SELECT g.promo_item_id, g.counted, g.racks, pi.code, pi.name, pi.stock_qty, pi.rack_location
         FROM (SELECT promo_item_id, SUM(counted_qty) AS counted,
                      STRING_AGG(DISTINCT NULLIF(rack_scanned,''), ', ') AS racks
                 FROM stock_count_lines
                WHERE count_id=$1 AND item_kind='promo' AND promo_item_id IS NOT NULL GROUP BY promo_item_id) g
         JOIN promo_items pi ON pi.id=g.promo_item_id WHERE pi.deleted_at IS NULL`, [id])).rows;
    const items = [];
    const mk = (kind, p, idKey) => {
      const before = num(p.stock_qty), after = num(p.counted), delta = round2(after - before);
      const scanned = (p.racks || '').trim(), master = (p.rack_location || '').trim();
      const rackDiff = scanned !== '' && scanned !== master;
      if (delta === 0 && !rackDiff) return null;
      const it = { kind, code: p.code, name: p.name || '', system_qty: before, counted_qty: after, delta,
        rack_scanned: scanned, master_rack: master, rack_diff: rackDiff };
      it[idKey] = Number(kind === 'part' ? p.product_id : p.promo_item_id);
      return it;
    };
    for (const p of parts) { const it = mk('part', p, 'product_id'); if (it) items.push(it); }
    for (const p of promos) { const it = mk('promo', p, 'promo_item_id'); if (it) items.push(it); }
    items.sort((a, b) => Math.abs(num(b.delta)) - Math.abs(num(a.delta)));
    return items;
  }

  // 코드별 실사 내역(드릴다운) + SYD 코드
  app.get('/api/stock-counts/:id/code-lines', { preHandler: [authGuard, requirePage('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const q = req.query || {};
    const productId = (q.product_id != null && q.product_id !== '') ? Number(q.product_id) : null;
    const promoId   = (q.promo_item_id != null && q.promo_item_id !== '') ? Number(q.promo_item_id) : null;
    const raw       = (q.raw != null && q.raw !== '') ? String(q.raw) : null;
    const sel = `l.id, l.rack_scanned, l.counted_qty, l.matched_code, l.created_at, u.name AS created_by_name`;
    let lines = [], syd = [];
    if (productId != null) {
      lines = (await query(`SELECT ${sel} FROM stock_count_lines l LEFT JOIN users u ON u.id=l.created_by
                             WHERE l.count_id=$1 AND l.product_id=$2 ORDER BY l.created_at, l.id`, [id, productId])).rows;
      syd = (await query(`SELECT syd_code FROM product_syd_codes WHERE product_id=$1 AND syd_code IS NOT NULL AND TRIM(syd_code) <> '' ORDER BY syd_code`, [productId])).rows.map((r) => r.syd_code);
    } else if (promoId != null) {
      lines = (await query(`SELECT ${sel} FROM stock_count_lines l LEFT JOIN users u ON u.id=l.created_by
                             WHERE l.count_id=$1 AND l.promo_item_id=$2 ORDER BY l.created_at, l.id`, [id, promoId])).rows;
    } else if (raw != null) {
      lines = (await query(`SELECT ${sel} FROM stock_count_lines l LEFT JOIN users u ON u.id=l.created_by
                             WHERE l.count_id=$1 AND l.item_kind='unknown' AND l.raw_code=$2 ORDER BY l.created_at, l.id`, [id, raw])).rows;
    } else {
      return reply.code(400).send({ error: 'no_key' });
    }
    return { ok: true, syd_codes: syd, lines: lines.map((l) => ({
      id: Number(l.id), rack_scanned: l.rack_scanned || '', counted_qty: num(l.counted_qty),
      matched_code: l.matched_code || '', created_at: l.created_at, created_by_name: l.created_by_name || '',
    })) };
  });

  app.post('/api/stock-counts/:id/apply/preview', { preHandler: [authGuard] }, async (req, reply) => {
    if (!isDirector(req)) return reply.code(403).send({ error: 'director_only', note: '디렉터 승인이 필요합니다.' });
    const id = Number(req.params.id);
    const sc = await loadSession(id);
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (normMode(sc.mode) === 'spot') return reply.code(409).send(FULL_ONLY);
    if (sc.status !== 'submitted') return reply.code(409).send({ error: 'not_submitted', note: '제출된 실사만 적용할 수 있습니다.' });
    const items = await buildReviewList(id);
    const plan = await buildAdjustPlan(id);            // 하위호환(레거시 필드 유지)
    return { count_id: id, adjust_count: plan.length, review_count: items.length, items, plan };
  });

  // 디렉터 승인·반영. body.items 가 오면 항목별 결정(반영/보류·코멘트·랙저장)을 적용.
  //   items: [{ kind:'part'|'promo', product_id?/promo_item_id?, apply:bool, save_rack:bool, comment:string }]
  // body.items 가 없으면 레거시(차이 전부 반영).
  app.post('/api/stock-counts/:id/apply', { preHandler: [authGuard] }, async (req, reply) => {
    if (!isDirector(req)) return reply.code(403).send({ error: 'director_only', note: '디렉터 승인이 필요합니다.' });
    const id = Number(req.params.id);
    const uid = req.ctx.perm.userId;
    const body = req.body || {};
    // 모드 확인이 PIN보다 먼저 — 스팟 세션이면 "PIN 틀림"이 아니라 이유를 정확히 돌려준다.
    const scMode = await loadSession(id);
    if (!scMode) return reply.code(404).send({ error: 'not_found' });
    if (normMode(scMode.mode) === 'spot') return reply.code(409).send(FULL_ONLY);
    // 디렉터 PIN 확인 — 반영은 되돌릴 수 없으므로 본인 재인증
    const pin = String(body.pin || '');
    if (!pin) return reply.code(400).send({ error: 'pin_required', note: 'PIN을 입력하세요.' });
    const me = (await query(`SELECT pin_hash FROM users WHERE id=$1 AND deleted_at IS NULL`, [uid])).rows[0];
    if (!me || !verifyPin(pin, me.pin_hash)) return reply.code(403).send({ error: 'bad_pin', note: 'PIN이 올바르지 않습니다.' });
    const hasDecisions = Array.isArray(body.items);
    const keyOf = (kind, pid, promoId) => `${kind}:${kind === 'part' ? pid : promoId}`;
    const decMap = new Map();
    if (hasDecisions) {
      for (const it of body.items) {
        const k = keyOf(it.kind, Number(it.product_id), Number(it.promo_item_id));
        const fin = (it.final_qty != null && isFinite(Number(it.final_qty))) ? Number(it.final_qty) : null;
        decMap.set(k, { apply: !!it.apply, save_rack: !!it.save_rack, comment: String(it.comment || '').trim().slice(0, 500), final: fin });
      }
    }
    const result = await withTx(async (c) => {
      const sc = (await c.query(`SELECT id, code, status, mode FROM stock_counts WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!sc) return { error: 'not_found' };
      // 스팟점검은 기록 전용 — 재고를 바꾸는 경로에 절대 들어오지 못한다(디렉터 결정).
      if (normMode(sc.mode) === 'spot') return { error: 'full_only' };
      if (sc.status !== 'submitted') return { error: 'not_submitted' };
      const review = await buildReviewList(id, c);
      const eventNo = Number((await c.query(`SELECT nextval('stock_event_seq') AS n`)).rows[0].n);
      let applied = 0, rackSaved = 0;
      for (const it of review) {
        const k = keyOf(it.kind, it.product_id, it.promo_item_id);
        // 결정: 명시적 payload 있으면 그대로, 없으면 레거시(차이는 반영, 랙은 저장 안함)
        const dec = hasDecisions ? (decMap.get(k) || { apply: false, save_rack: false, comment: '', final: null })
                                 : { apply: it.delta !== 0, save_rack: false, comment: '', final: null };
        let didApply = false, didRack = false, appliedQty = null;
        if (it.kind === 'part') {
          if (dec.apply) {
            const cur = num((await c.query(`SELECT stock_qty FROM products WHERE id=$1 FOR UPDATE`, [it.product_id])).rows[0].stock_qty);
            const target = round2(dec.final != null && dec.final >= 0 ? dec.final : it.counted_qty);
            if (target < 0) return { error: 'would_go_negative', code: it.code };
            const delta = round2(target - cur);
            if (delta !== 0) {
              await c.query(`UPDATE products SET stock_qty=$1, updated_by=$2 WHERE id=$3`, [target, uid, it.product_id]);
              const forced = dec.final != null && round2(dec.final) !== round2(it.counted_qty);
              const note = `재고실사 ${sc.code} 실물조정` + (forced ? ' (강제조정)' : '') + (dec.comment ? ` · ${dec.comment}` : '');
              await c.query(
                `INSERT INTO stock_movements (product_id, move_type, qty, ref, note, source, moved_at, event_no, created_by)
                 VALUES ($1,'adjust',$2,$3,$4,'count', now(), $5, $6)`,
                [it.product_id, delta, `count:${id}`, note, eventNo, uid]);
              didApply = true; applied += 1; appliedQty = target;
            }
          }
          if (dec.save_rack && it.rack_scanned) {
            await c.query(`UPDATE products SET rack_location=$1, updated_by=$2 WHERE id=$3`, [it.rack_scanned, uid, it.product_id]);
            didRack = true; rackSaved += 1;
          }
        } else {
          if (dec.apply) {
            const cur = num((await c.query(`SELECT stock_qty FROM promo_items WHERE id=$1 FOR UPDATE`, [it.promo_item_id])).rows[0].stock_qty);
            const target = round2(dec.final != null && dec.final >= 0 ? dec.final : it.counted_qty);
            if (target < 0) return { error: 'would_go_negative', code: it.code };
            const delta = round2(target - cur);
            if (delta !== 0) {
              await c.query(`UPDATE promo_items SET stock_qty=$1, updated_by=$2 WHERE id=$3`, [target, uid, it.promo_item_id]);
              didApply = true; applied += 1; appliedQty = target;
            }
          }
          if (dec.save_rack && it.rack_scanned) {
            await c.query(`UPDATE promo_items SET rack_location=$1, updated_by=$2 WHERE id=$3`, [it.rack_scanned, uid, it.promo_item_id]);
            didRack = true; rackSaved += 1;
          }
        }
        // 검토 이력 기록(반영/보류·코멘트·강제조정 수량 모두 감사 저장)
        await c.query(
          `INSERT INTO stock_count_adjustments
             (count_id, item_kind, product_id, promo_item_id, code, system_qty, counted_qty, delta,
              decision, comment, rack_scanned, rack_saved, applied, applied_qty, event_no, reviewed_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [id, it.kind, it.kind === 'part' ? it.product_id : null, it.kind === 'promo' ? it.promo_item_id : null,
           it.code, it.system_qty, it.counted_qty, it.delta,
           didApply ? 'apply' : 'skip', dec.comment || null, it.rack_scanned || null, didRack, didApply, appliedQty, eventNo, uid]);
      }
      await c.query(`UPDATE stock_counts SET status='reconciled', reconciled_at=now(), reconciled_by=$1, adjust_event_no=$2 WHERE id=$3`,
        [uid, eventNo, id]);
      return { ok: true, applied, rack_saved: rackSaved, reviewed: review.length, event_no: eventNo, code: sc.code };
    });
    if (result.error) {
      const codeMap = { not_found: 404, not_submitted: 409, full_only: 409, would_go_negative: 400 };
      if (result.error === 'full_only') return reply.code(409).send(FULL_ONLY);
      return reply.code(codeMap[result.error] || 400).send(result);
    }
    await logEvent({ userId: uid, action: 'update', target: `stock_count:${id}`, detail: { step: 'apply', applied: result.applied, rack_saved: result.rack_saved, event_no: result.event_no } });
    return result;
  });

  // 반영 내역(디렉터 검토 결과·코멘트) 조회
  app.get('/api/stock-counts/:id/adjustments', { preHandler: [authGuard, requirePage('warehouse')] }, async (req) => {
    const id = Number(req.params.id);
    const rows = (await query(
      `SELECT a.*, COALESCE(p.name, pi.name) AS item_name, u.name AS reviewer
         FROM stock_count_adjustments a
         LEFT JOIN products p ON p.id = a.product_id
         LEFT JOIN promo_items pi ON pi.id = a.promo_item_id
         LEFT JOIN users u ON u.id = a.reviewed_by
        WHERE a.count_id = $1 ORDER BY a.id`, [id])).rows;
    return {
      items: rows.map((a) => ({
        code: a.code, name: a.item_name || '', kind: a.item_kind,
        system_qty: num(a.system_qty), counted_qty: num(a.counted_qty), delta: num(a.delta),
        applied_qty: a.applied_qty != null ? num(a.applied_qty) : null,
        decision: a.decision, applied: !!a.applied, comment: a.comment || '',
        rack_scanned: a.rack_scanned || '', rack_saved: !!a.rack_saved,
        reviewer: a.reviewer || '', reviewed_at: a.reviewed_at,
      })),
    };
  });

  // ================= 프로모션 품목 마스터 =================
  app.get('/api/promo-items', { preHandler: [authGuard, requirePage('warehouse')] }, async (req) => {
    const includeInactive = String(req.query.all || '') === '1';
    const rows = (await query(
      `SELECT * FROM promo_items WHERE deleted_at IS NULL ${includeInactive ? '' : 'AND active=TRUE'} ORDER BY code`, [])).rows;
    return {
      items: rows.map((r) => ({
        id: Number(r.id), code: r.code, name: r.name, barcode: r.barcode || '',
        rack_location: r.rack_location || '', stock_qty: num(r.stock_qty), unit_cost: num(r.unit_cost),
        active: !!r.active, note: r.note || '',
      })),
    };
  });

  app.post('/api/promo-items', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const b = req.body || {};
    const code = String(b.code || '').trim().toUpperCase();
    const name = String(b.name || '').trim();
    if (!code || !name) return reply.code(400).send({ error: 'code_and_name_required' });
    const dup = (await query(`SELECT id FROM promo_items WHERE UPPER(code)=$1 AND deleted_at IS NULL`, [code])).rows[0];
    if (dup) return reply.code(409).send({ error: 'duplicate_code' });
    const row = (await query(
      `INSERT INTO promo_items (code, name, barcode, rack_location, stock_qty, unit_cost, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [code, name, String(b.barcode || '').trim() || null, String(b.rack_location || '').trim() || null,
       Number(b.stock_qty) || 0, Number(b.unit_cost) || 0, String(b.note || '').trim() || null, req.ctx.perm.userId])).rows[0];
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `promo_item:${row.id}`, detail: { code } });
    return { id: Number(row.id) };
  });

  app.patch('/api/promo-items/:id', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const sets = []; const args = [];
    const add = (col, val) => { args.push(val); sets.push(`${col}=$${args.length}`); };
    if (b.name != null) add('name', String(b.name).trim());
    if (b.barcode != null) add('barcode', String(b.barcode).trim() || null);
    if (b.rack_location != null) add('rack_location', String(b.rack_location).trim() || null);
    if (b.stock_qty != null) { const q = Number(b.stock_qty); if (!isFinite(q) || q < 0) return reply.code(400).send({ error: 'bad_qty' }); add('stock_qty', q); }
    if (b.unit_cost != null) add('unit_cost', Number(b.unit_cost) || 0);
    if (b.note != null) add('note', String(b.note).trim() || null);
    if (b.active != null) add('active', !!b.active);
    if (!sets.length) return { ok: true };
    args.push(req.ctx.perm.userId); sets.push(`updated_by=$${args.length}`);
    args.push(id);
    const r = (await query(`UPDATE promo_items SET ${sets.join(', ')} WHERE id=$${args.length} AND deleted_at IS NULL RETURNING id`, args)).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `promo_item:${id}`, detail: {} });
    return { ok: true };
  });

  app.delete('/api/promo-items/:id', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const r = (await query(`UPDATE promo_items SET deleted_at=now(), updated_by=$1 WHERE id=$2 AND deleted_at IS NULL RETURNING id`, [req.ctx.perm.userId, id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `promo_item:${id}`, detail: {} });
    return { ok: true };
  });
}
