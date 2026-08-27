// build 20260827rfc — 고객 등록 디렉터 승인 + **RFC 선점**(0188) + 기준품목 할인율 제안 (0185)
//   0188: 선점 조건이 CONSTANCIA → RFC 로 바뀌었다. CONSTANCIA 번호·PDF 는 선택 증빙.
import { query, withTx } from '../db.js';
import { CROSS_TEAM_PAGE_KEY } from '../permLoader.js';
import { authGuard, requirePage, requirePageEdit, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { visibleTeamIds, canViewTeam, canEditTeam, canRequestCrossTeam } from '../teams.js';
import { buildHeaderIndex, parseCustRow, buildCustPreview, CUST_TEMPLATE_HEADERS } from '../customerImport.js';
import { mxTodayStr } from '../workingHours.js';
import { reorderMetrics, medianWorkingGap } from '../salesCycle.js';
import { assembleVisitHistory } from '../customerVisits.js';
import { stageLabel, stripStageLabel } from '../stageLabel.js';
import { normalizeClaimKey, computeBaselineDiscount, validateChosenDiscount,
         discountGap, MAX_DISCOUNT_PCT, validateRfc, RFC_ERROR_NOTE } from '../customerClaim.js';

const VISIT_TZ = 'America/Mexico_City';   // 방문 시각 표시 기준(현지)
const VISIT_HIST_LIMIT = 300;             // 상담·방문 이력 1회 조회 상한(방문·미팅 각각)

// 0185 · 기준품목 — 고객이 경쟁사(SYD)에서 사는 단가를 물어보는 대표 SKU.
//   Railway 환경변수 SYD_BASE_CODE 로 바꿀 수 있다(코드 배포 없이 기준 교체).
const SYD_BASE_CODE = String(process.env.SYD_BASE_CODE || '1516049').trim();

function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
async function safeLog(args) { try { await logEvent(args); } catch (_) { /* ignore */ } }

// 0185 · 등록 승인 상태. 컬럼 추가 전(마이그레이션 미적용) DB 에서도 죽지 않도록
//   읽기는 전부 COALESCE 로 감싸고, 쓰기는 아래 regColumnsReady() 가 true 일 때만 한다.
let _regReady = null, _regCheckedAt = 0;
async function regColumnsReady() {
  const now = Date.now();
  if (_regReady !== null && now - _regCheckedAt < 60000) return _regReady;
  try {
    const r = (await query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name='customers' AND column_name IN ('approval_status','constancia_no','suggested_discount')`)).rows[0];
    _regReady = Number(r.n) >= 3;
  } catch (_) { _regReady = false; }
  _regCheckedAt = now;
  return _regReady;
}

// 0188 · RFC 선점 예외 컬럼(rfc_claim_exempt) + 유니크 인덱스 적용 여부.
//   미적용이어도 등록은 막지 않는다 — 애플리케이션 사전조회로 선점을 판정하고,
//   DB 유니크(동시성 최종 방어선)만 없는 상태로 동작한다.
let _rfcReady = null, _rfcCheckedAt = 0;
async function rfcClaimReady() {
  const now = Date.now();
  if (_rfcReady !== null && now - _rfcCheckedAt < 60000) return _rfcReady;
  try {
    const r = (await query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name='customers' AND column_name='rfc_claim_exempt'`)).rows[0];
    _rfcReady = Number(r.n) >= 1;
  } catch (_) { _rfcReady = false; }
  _rfcCheckedAt = now;
  return _rfcReady;
}

export default async function customerRoutes(app) {
  // 팀 목록(고객 배정·필터용 = 영업팀만)
  app.get('/api/teams', { preHandler: [authGuard, requirePage('customers')] }, async () => {
    const rows = (await query(`SELECT id, name, sort_order FROM sales_teams WHERE deleted_at IS NULL AND is_sales=true ORDER BY sort_order, id`)).rows;
    return { items: rows.map((t) => ({ id: t.id, name: t.name })) };
  });

  // 소속 배정용 전체 팀(director 포함) — 팀 권한 관리 화면
  app.get('/api/team-admin/teams', { preHandler: [authGuard, requireDirector] }, async () => {
    const rows = (await query(
      `SELECT t.id, t.name, t.sort_order, t.is_sales,
              (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id AND u.deleted_at IS NULL)     AS member_count,
              (SELECT COUNT(*) FROM customers c WHERE c.team_id = t.id AND c.deleted_at IS NULL) AS customer_count
         FROM sales_teams t
        WHERE t.deleted_at IS NULL
        ORDER BY t.sort_order, t.id`)).rows;
    return {
      items: rows.map((t) => ({
        id: Number(t.id),
        name: t.name,
        is_sales: t.is_sales,
        sort_order: Number(t.sort_order),
        member_count: Number(t.member_count),
        customer_count: Number(t.customer_count),
      })),
    };
  });

  // 팀 생성(디렉터) — 자동 추가. name UNIQUE 이므로 동명 소프트삭제 팀은 되살림.
  app.post('/api/team-admin/teams', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const name = String(req.body?.name || '').trim();
    const isSales = req.body?.is_sales === false ? false : true;
    const sortOrder = Number.isFinite(Number(req.body?.sort_order)) ? Number(req.body.sort_order) : 0;
    if (!name) return reply.code(400).send({ error: 'name_required' });
    const dup = (await query(`SELECT id, deleted_at FROM sales_teams WHERE name = $1`, [name])).rows[0];
    if (dup && dup.deleted_at == null) return reply.code(409).send({ error: 'name_taken' });
    let row;
    if (dup && dup.deleted_at != null) {
      // 과거 소프트삭제된 동명 팀 재활성화(이름 UNIQUE 충돌 회피)
      row = (await query(
        `UPDATE sales_teams SET deleted_at = NULL, is_sales = $2, sort_order = $3 WHERE id = $1
         RETURNING id, name, is_sales, sort_order`, [dup.id, isSales, sortOrder])).rows[0];
    } else {
      row = (await query(
        `INSERT INTO sales_teams (name, sort_order, is_sales) VALUES ($1, $2, $3)
         RETURNING id, name, is_sales, sort_order`, [name, sortOrder, isSales])).rows[0];
    }
    await safeLog({ userId: req.ctx.perm.userId, action: 'create', target: `team:${row.id}`, detail: { name, is_sales: isSales } });
    return { ok: true, team: { id: Number(row.id), name: row.name, is_sales: row.is_sales, sort_order: Number(row.sort_order) } };
  });

  // 팀 개명·유형·정렬 변경(디렉터). id 불변이라 기존 연결 유지.
  app.patch('/api/team-admin/teams/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const cur = (await query(`SELECT id, name, is_sales, sort_order FROM sales_teams WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {};
    const name = b.name != null ? String(b.name).trim() : cur.name;
    if (!name) return reply.code(400).send({ error: 'name_required' });
    const isSales = b.is_sales != null ? (b.is_sales === false ? false : true) : cur.is_sales;
    const sortOrder = (b.sort_order != null && Number.isFinite(Number(b.sort_order))) ? Number(b.sort_order) : Number(cur.sort_order);
    if (name !== cur.name) {
      const dup = (await query(`SELECT id FROM sales_teams WHERE name = $1 AND id <> $2`, [name, id])).rows[0];
      if (dup) return reply.code(409).send({ error: 'name_taken' });
    }
    const row = (await query(
      `UPDATE sales_teams SET name = $1, is_sales = $2, sort_order = $3 WHERE id = $4
       RETURNING id, name, is_sales, sort_order`, [name, isSales, sortOrder, id])).rows[0];
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `team:${id}`, detail: { name, is_sales: isSales, sort_order: sortOrder } });
    return { ok: true, team: { id: Number(row.id), name: row.name, is_sales: row.is_sales, sort_order: Number(row.sort_order) } };
  });

  // 팀 삭제(소프트, 디렉터) — 소속 유저·고객 있으면 차단(고아 방지).
  app.delete('/api/team-admin/teams/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const cur = (await query(`SELECT id FROM sales_teams WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    const mem = Number((await query(`SELECT COUNT(*) AS n FROM users WHERE team_id = $1 AND deleted_at IS NULL`, [id])).rows[0].n);
    const cus = Number((await query(`SELECT COUNT(*) AS n FROM customers WHERE team_id = $1 AND deleted_at IS NULL`, [id])).rows[0].n);
    if (mem > 0 || cus > 0) return reply.code(409).send({ error: 'team_in_use', member_count: mem, customer_count: cus });
    await query(`UPDATE sales_teams SET deleted_at = now() WHERE id = $1`, [id]);
    // 이 팀을 가리키던 상대팀 열람권도 정리(팀이 비었을 때만 이 지점 도달).
    await query(`DELETE FROM user_team_access WHERE team_id = $1`, [id]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'delete', target: `team:${id}`, detail: {} });
    return { ok: true };
  });

  async function computeNextCode() {
    // ⚠ 삭제된 고객(soft delete)의 코드도 세어야 한다.
    //   customers.code 에는 유니크 제약이 걸려 있고 소프트삭제 행은 테이블에 그대로 남으므로,
    //   deleted_at IS NULL 만 보면 이미 쓰인 번호를 다시 뽑아 INSERT 가 계속 실패한다.
    //   (0185 등록 반려 직후 같은 고객을 재등록하면 code_generation_failed 로 드러남 —
    //    디렉터가 고객을 삭제한 뒤에도 같은 증상이 났을 잠재 버그였다)
    const rows = (await query(`SELECT code FROM customers`)).rows;
    const used = new Set(); let maxn = 0;
    for (const r of rows) { const m = String(r.code || '').match(/^c-?(\d+)$/i); if (m) { const n = parseInt(m[1], 10); used.add(n); if (n > maxn) maxn = n; } }
    let next = maxn + 1; while (used.has(next)) next++;
    return 'C-' + String(next).padStart(4, '0');
  }

  // 다음 고객코드 자동생성(미리보기). 대소문자 무관, 빈 번호 충돌 회피.
  app.get('/api/customers/next-code', { preHandler: [authGuard, requirePage('customers')] }, async () => {
    return { code: await computeNextCode() };
  });

  // Constancia(세무등록) 미입력 고객 알림 — 이름이 Maria인 사용자에게만 nag.
  app.get('/api/customers/missing-constancia', { preHandler: [authGuard] }, async (req) => {
    const isMaria = String(req.ctx.perm.name || '').trim().toLowerCase().startsWith('maria');
    const rows = (await query(
      `SELECT id, code, name FROM customers
        WHERE deleted_at IS NULL AND (constancia_fiscal IS NULL OR btrim(constancia_fiscal) = '')
        ORDER BY created_at DESC, id DESC`)).rows;
    const items = rows.map((r) => ({ id: Number(r.id), code: r.code, name: r.name }));
    return { is_target: isMaria, nag: isMaria && items.length > 0, count: items.length, items: isMaria ? items : [] };
  });

  // 업로드 양식 헤더(프런트가 빈 xlsx 양식 생성에 사용)
  app.get('/api/customers/template', { preHandler: [authGuard, requirePage('customers')] }, async () => {
    return { headers: CUST_TEMPLATE_HEADERS };
  });

  async function resolveRefs() {
    const teams = (await query(`SELECT id, name FROM sales_teams WHERE deleted_at IS NULL AND is_sales=true`)).rows;
    const owners = (await query(`SELECT id, name FROM users WHERE deleted_at IS NULL AND role IN ('sales','director')`)).rows;
    const stages = (await query(`SELECT id, name FROM stages WHERE deleted_at IS NULL`)).rows;
    const existing = (await query(
      `SELECT c.code, c.name, c.rfc, c.customer_type, c.contact, c.phone, c.discount, c.credit_days, c.memo, c.team_id, t.name AS team_name
         FROM customers c LEFT JOIN sales_teams t ON t.id=c.team_id WHERE c.deleted_at IS NULL`)).rows;
    const teamByName = {}; for (const t of teams) teamByName[t.name.toLowerCase()] = t.id;
    const ownerByName = {}; for (const o of owners) ownerByName[o.name.toLowerCase()] = o.id;
    const stageByName = {}; for (const s of stages) stageByName[stripStageLabel(s.name).toLowerCase()] = s.id;
    const existingByCode = new Set(existing.map((r) => String(r.code).toLowerCase()));
    const existingByCodeData = {}; for (const r of existing) existingByCodeData[String(r.code).toLowerCase()] = r;
    return { teamByName, ownerByName, stageByName, existingByCode, existingByCodeData };
  }

  // 엑셀 업로드 미리보기 — body: { rows: [[...]] } (첫 행 헤더)
  app.post('/api/customers/import/preview', { preHandler: [authGuard, requirePageEdit('customers')] }, async (req, reply) => {
    const all = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!all.length) return reply.code(400).send({ error: 'no_rows' });
    const idx = buildHeaderIndex(all[0]);
    if (idx.name == null) return reply.code(400).send({ error: 'missing_name_column' });
    const parsed = all.slice(1).map((r) => parseCustRow(r, idx)).filter(Boolean);
    const resolve = await resolveRefs();
    const preview = buildCustPreview(parsed, resolve);
    return { ...preview, total: parsed.length };
  });

  // 커밋 — 신규는 코드 자동생성, 기존(코드 일치)은 갱신. 팀 편집권한 확인.
  app.post('/api/customers/import/commit', { preHandler: [authGuard, requirePageEdit('customers')] }, async (req, reply) => {
    const all = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!all.length) return reply.code(400).send({ error: 'no_rows' });
    const idx = buildHeaderIndex(all[0]);
    const parsed = all.slice(1).map((r) => parseCustRow(r, idx)).filter(Boolean);
    const resolve = await resolveRefs();
    const userId = req.ctx.perm.userId;
    // 0185 · 엑셀 일괄 등록은 RFC 선점·승인 흐름을 우회하는 경로다.
    //   신규 고객 생성은 디렉터만 허용하고, 그 외 사용자는 기존 고객 갱신만 가능하다.
    const isDir = req.ctx.perm.role === 'director';
    let created = 0, updated = 0, skipped = 0, blockedNew = 0;
    for (const p of parsed) {
      if (!p.name || !p.team) { skipped++; continue; }
      const teamId = resolve.teamByName[p.team.toLowerCase()];
      if (!teamId || !canEditTeam(req.ctx.perm, teamId)) { skipped++; continue; }
      const ownerId = p.owner ? (resolve.ownerByName[p.owner.toLowerCase()] || null) : null;
      const stageId = p.stage ? (resolve.stageByName[stripStageLabel(p.stage).toLowerCase()] || null) : null;
      const isUpdate = p.code && resolve.existingByCode.has(p.code.toLowerCase());
      if (isUpdate) {
        // 기본할인·외상일은 엑셀 일괄수정에서 제외 — 반드시 고객 폼(수정이유·제공조건 + 디렉터 승인)으로만 변경
        await query(
          `UPDATE customers SET name=$1, rfc=$2, contact=$3, phone=$4,
             team_id=$5, stage_id=COALESCE($6,stage_id), owner_id=COALESCE($7,owner_id),
             customer_type=COALESCE($8,customer_type), memo=COALESCE($9,memo), updated_by=$10
           WHERE lower(code)=lower($11) AND deleted_at IS NULL`,
          [p.name, p.rfc, p.contact, p.phone, teamId, stageId, ownerId, p.customer_type, p.memo, userId, p.code]);
        updated++;
      } else if (!isDir) {
        blockedNew++;                       // 신규 고객 생성은 디렉터 전용(승인·RFC 선점 우회 방지)
      } else {
        let code = p.code, ok = false;
        for (let attempt = 0; attempt < 5 && !ok; attempt++) {
          if (!code || attempt > 0) code = await computeNextCode();
          try {
            const ins = (await query(
              `INSERT INTO customers (code, name, rfc, contact, phone, discount, credit_days, team_id, stage_id, owner_id, customer_type, memo, stage_since, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $9::bigint IS NOT NULL THEN CURRENT_DATE END, $13) RETURNING id`,
              [code, p.name, p.rfc, p.contact, p.phone, p.discount, p.credit_days, teamId, stageId, ownerId, p.customer_type, p.memo, userId])).rows[0];
            ok = true; resolve.existingByCode.add(String(code).toLowerCase());
            // 신규 고객 초기 할인/외상일 이력(0이 아니면)
            const initT = [];
            if ((Number(p.discount) || 0) !== 0) initT.push({ field: 'discount', old: null, nv: Number(p.discount) || 0 });
            if ((Number(p.credit_days) || 0) !== 0) initT.push({ field: 'credit_days', old: null, nv: Number(p.credit_days) || 0 });
            if (initT.length) { try { await logTermsHistory(ins.id, initT, { reason: '엑셀 일괄 등록 초기값', conditions: null, changedBy: userId, approvedBy: null }); } catch (_) {} }
          } catch (e) { if (!String(e.message || '').match(/unique|duplicate/)) throw e; }
        }
        if (ok) created++; else skipped++;
      }
    }
    await safeLog({ userId, action: 'create', target: 'customer_import', detail: { created, updated, skipped, blockedNew } });
    return { ok: true, created, updated, skipped, blocked_new: blockedNew,
      blocked_note: blockedNew ? '신규 고객 생성은 디렉터만 가능합니다(RFC 선점·승인 흐름). 고객 등록 화면에서 등록하세요.' : null };
  });

  // 고객 단계 목록
  app.get('/api/stages', { preHandler: [authGuard, requirePage('customers')] }, async () => {
    const rows = (await query(`SELECT id, name, sort_order FROM stages WHERE deleted_at IS NULL ORDER BY sort_order, id`)).rows;
    return { items: rows.map((s) => ({ id: s.id, name: stageLabel(s.name) })) };
  });

  // 영업 담당(사용자) 목록 — 고객 배정용
  app.get('/api/sales-users', { preHandler: [authGuard, requirePage('customers')] }, async (req) => {
    const vis = visibleTeamIds(req.ctx.perm);
    let where = `deleted_at IS NULL AND role IN ('sales','director')`;
    const params = [];
    if (vis !== null) {
      if (!vis.length) return { items: [] };
      params.push(vis); where += ` AND (team_id = ANY($1) OR team_id IS NULL)`;
    }
    const rows = (await query(`SELECT id, name, team_id FROM users WHERE ${where} ORDER BY name`, params)).rows;
    return { items: rows.map((u) => ({ id: u.id, name: u.name, team_id: u.team_id })) };
  });

  // 고객 목록: 팀 가시성 적용 + 검색 + 미수/연체 요약
  app.get('/api/customers', { preHandler: [authGuard, requirePage('customers')] }, async (req) => {
    const { perm } = req.ctx;
    const vis = visibleTeamIds(perm);
    const q = String(req.query.q || '').trim();
    const teamFilter = req.query.team_id ? Number(req.query.team_id) : null;
    const conds = ['c.deleted_at IS NULL']; const params = [];
    if (vis !== null) {
      if (!vis.length) return { items: [] };
      params.push(vis); conds.push(`c.team_id = ANY($${params.length})`);
    }
    if (teamFilter) {
      if (vis !== null && !vis.includes(teamFilter)) return { items: [] };
      params.push(teamFilter); conds.push(`c.team_id = $${params.length}`);
    }
    if (q) { params.push(`%${q}%`); conds.push(`(c.name ILIKE $${params.length} OR c.code ILIKE $${params.length} OR c.rfc ILIKE $${params.length})`); }
    // 0185 · 승인 대기 고객도 목록에는 보인다(등록자가 자기 건 상태를 봐야 하므로).
    //   실제 사용 차단은 견적·매출 생성 시점에서 한다.
    const regOn = await regColumnsReady();
    const apprExpr = regOn ? `COALESCE(c.approval_status,'approved')` : `'approved'`;
    const rows = (await query(
      `SELECT c.id, c.code, c.name, c.rfc, c.contact, c.phone, c.buyer_name, c.buyer_phone, c.discount, c.credit_days, c.customer_type, c.branch_count,
              c.ship_address, ${apprExpr} AS approval_status,
              ${regOn ? 'c.constancia_no' : 'NULL::text'} AS constancia_no,
              c.team_id, t.name AS team_name, c.stage_id, s.name AS stage_name,
              c.owner_id, u.name AS owner_name,
              COALESCE(ar.outstanding,0) AS outstanding,
              COALESCE(ar.overdue,0) AS overdue,
              COALESCE(ar.sales_total,0) AS sales_total,
              COALESCE(dc.doc_count,0) AS doc_count,
              COALESCE(lq.live_quote_mxn,0) AS live_quote_mxn,
              COALESCE(iq.total_qty,0) AS total_qty,
              iq.order_dates AS order_dates,
              iq.first_deal_date AS first_deal_date,
              iq.last_deal_date AS last_deal_date,
              iq.first_qty AS first_qty,
              (CURRENT_DATE - COALESCE(ar.last_sale_date, c.created_at::date)) AS days_no_sales,
              (CURRENT_DATE - COALESCE(ar.last_sale_date, c.created_at::date)) AS no_sale_days,
              (EXISTS (SELECT 1 FROM customer_change_requests rr WHERE rr.customer_id=c.id AND rr.status='pending')) AS has_pending
         FROM customers c
         LEFT JOIN sales_teams t ON t.id=c.team_id
         LEFT JOIN stages s ON s.id=c.stage_id
         LEFT JOIN users u ON u.id=c.owner_id
         LEFT JOIN (
           SELECT i.customer_id,
                  SUM(i.total_mxn - COALESCE(p.paid,0)) AS outstanding,
                  SUM(CASE WHEN i.due_date < CURRENT_DATE THEN (i.total_mxn - COALESCE(p.paid,0)) ELSE 0 END) AS overdue,
                  SUM(i.total_mxn) AS sales_total,
                  MAX(i.inv_date) AS last_sale_date
             FROM sales_invoices i
             LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) p
                    ON p.invoice_id=i.id
            WHERE i.status='posted'
            GROUP BY i.customer_id
         ) ar ON ar.customer_id=c.id
         LEFT JOIN (
           SELECT customer_id, COUNT(*) AS doc_count
             FROM customer_documents
            WHERE deleted_at IS NULL
            GROUP BY customer_id
         ) dc ON dc.customer_id=c.id
         LEFT JOIN (
           SELECT customer_id, SUM(total_mxn) AS live_quote_mxn
             FROM quotes
            WHERE status IN ('draft','confirmed','expired')   -- 저장된 미전환 견적(주문) = 견적/수주 단계 금액 (전환·취소·삭제·가격표 제외, 24h 만료도 포함)
              AND deleted_at IS NULL
            GROUP BY customer_id
         ) lq ON lq.customer_id=c.id
         LEFT JOIN (
           SELECT customer_id,
                  SUM(day_qty) AS total_qty,
                  COUNT(*) AS order_dates,
                  to_char(MIN(inv_date),'YYYY-MM-DD') AS first_deal_date,
                  to_char(MAX(inv_date),'YYYY-MM-DD') AS last_deal_date,
                  (ARRAY_AGG(day_qty ORDER BY inv_date))[1] AS first_qty
             FROM (SELECT si.customer_id, si.inv_date, SUM(sil.qty) AS day_qty
                     FROM sales_invoices si JOIN sales_invoice_lines sil ON sil.invoice_id=si.id
                    WHERE si.status='posted' GROUP BY si.customer_id, si.inv_date) pd
            GROUP BY customer_id
         ) iq ON iq.customer_id=c.id
        WHERE ${conds.join(' AND ')}
        ORDER BY c.name LIMIT 300`, params)).rows;
    // 재주문(구매주기) 지표 — 첫 주문 제외, 영업일 기준(파이프라인/그래프/상세 공통 계산)
    const mxToday = mxTodayStr(new Date());
    for (const c of rows) {
      c._rc = reorderMetrics({ total_qty: c.total_qty, order_dates: c.order_dates, first_qty: c.first_qty,
        first_date: c.first_deal_date, last_date: c.last_deal_date }, mxToday);
    }
    return { items: rows.map((c) => ({
      id: c.id, code: c.code, name: c.name, rfc: c.rfc, contact: c.contact, phone: c.phone,
      buyer_name: c.buyer_name || null, buyer_phone: c.buyer_phone || null,
      discount: Number(c.discount), credit_days: c.credit_days, customer_type: c.customer_type,
      branch_count: c.branch_count == null ? null : Number(c.branch_count),
      ship_address: c.ship_address || null,
      approval_status: c.approval_status, constancia_no: c.constancia_no || null,
      team_id: c.team_id, team_name: c.team_name, stage_id: c.stage_id, stage_name: stageLabel(c.stage_name),
      owner_id: c.owner_id, owner_name: c.owner_name,
      outstanding: r2(c.outstanding), overdue: r2(c.overdue),
      sales_total: r2(c.sales_total), doc_count: Number(c.doc_count),
      live_quote_mxn: r2(c.live_quote_mxn),
      total_qty: Number(c.total_qty) || 0,
      orders: c._rc.orders,
      first_deal_date: c.first_deal_date || null,
      last_deal_date: c.last_deal_date || null,
      reorder_velocity: c._rc.reorder_velocity,  // ② 그래프 우측축
      reorder_cycle: c._rc.reorder_cycle,        // ③ (참고)
      reorder_qty: c._rc.reorder_qty,            // ③ (참고)
      days_no_sales: c.days_no_sales == null ? null : Number(c.days_no_sales),
      no_sale_days: c.no_sale_days == null ? null : Number(c.no_sale_days),
      pending_change: !!c.has_pending,
    })) };
  });

  // 고객 상세 + 미수/연체 인보이스
  app.get('/api/customers/:id', { preHandler: [authGuard, requirePage('customers')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const c = (await query(
      `SELECT c.*, t.name AS team_name, s.name AS stage_name, u.name AS owner_name,
              to_char(c.stage_since,'YYYY-MM-DD') AS stage_since_str
         FROM customers c
         LEFT JOIN sales_teams t ON t.id=c.team_id
         LEFT JOIN stages s ON s.id=c.stage_id
         LEFT JOIN users u ON u.id=c.owner_id
        WHERE c.id=$1 AND c.deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canViewTeam(req.ctx.perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    // 연초~현재 누적 매출실적(올해, posted 인보이스 합계)
    const ytd = (await query(
      `SELECT COALESCE(SUM(total_mxn),0) AS actual
         FROM sales_invoices
        WHERE customer_id=$1 AND status='posted'
          AND inv_date >= date_trunc('year', CURRENT_DATE)`, [id])).rows[0];
    // 올해 매출목표(고객 월 목표 합) — 매출 목표 메뉴에서 설정되면 채워짐
    const tgt = (await query(
      `SELECT COALESCE(SUM(amount),0) AS yt FROM target_customer_months
        WHERE customer_id=$1 AND ym LIKE to_char(CURRENT_DATE,'YYYY') || '-%'`, [id])).rows[0];
    const yearTarget = Number(tgt.yt) > 0 ? r2(tgt.yt) : null;
    const invs = (await query(
      `SELECT i.id, to_char(i.inv_date,'YYYY-MM-DD') AS inv_date, to_char(i.due_date,'YYYY-MM-DD') AS due_date,
              i.total_mxn, COALESCE(p.paid,0) AS paid, (i.total_mxn - COALESCE(p.paid,0)) AS outstanding,
              (i.due_date < CURRENT_DATE AND (i.total_mxn - COALESCE(p.paid,0)) > 0) AS overdue
         FROM sales_invoices i
         LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) p ON p.invoice_id=i.id
        WHERE i.customer_id=$1 AND i.status='posted'
        ORDER BY i.inv_date DESC LIMIT 100`, [id])).rows;
    // 재주문(구매주기) 지표 — 주문일(중복 제거)별 수량 목록에서 ②재주문속도/③주기·수량/④중앙값 산출
    const orderDays = (await query(
      `SELECT to_char(si.inv_date,'YYYY-MM-DD') AS d, SUM(sil.qty) AS day_qty
         FROM sales_invoices si JOIN sales_invoice_lines sil ON sil.invoice_id=si.id
        WHERE si.customer_id=$1 AND si.status='posted'
        GROUP BY si.inv_date ORDER BY si.inv_date`, [id])).rows;
    const rcToday = mxTodayStr(new Date());
    const rcTotal = orderDays.reduce((s, r) => s + (Number(r.day_qty) || 0), 0);
    const rcFirst = orderDays.length ? orderDays[0].d : null;
    const rcLast = orderDays.length ? orderDays[orderDays.length - 1].d : null;
    const rcFirstQty = orderDays.length ? (Number(orderDays[0].day_qty) || 0) : 0;
    const rc = reorderMetrics({ total_qty: rcTotal, order_dates: orderDays.length, first_qty: rcFirstQty,
      first_date: rcFirst, last_date: rcLast }, rcToday);
    const reorderSummary = {
      orders: orderDays.length, total_qty: rcTotal, first_qty: rcFirstQty,
      first_date: rcFirst, last_date: rcLast,
      reorder_velocity: rc.reorder_velocity,      // ② 개/영업일
      reorder_cycle: rc.reorder_cycle,            // ③ 영업일/회
      reorder_qty: rc.reorder_qty,                // ③ 개/회
      median_cycle: medianWorkingGap(orderDays.map((r) => r.d)),  // ④ 영업일
    };
    // 중요 아이템 — 누적 구매 SKU 중 파레토(누적 80%) ∪ 반복주문(2회 이상) + 적용차량정보
    const skuRows = (await query(
      `SELECT p.id AS product_id, p.code, p.name,
              SUM(sil.qty) AS total_qty,
              COUNT(DISTINCT sil.invoice_id) AS order_count,
              to_char(MAX(si.inv_date),'YYYY-MM-DD') AS last_date
         FROM sales_invoice_lines sil
         JOIN sales_invoices si ON si.id=sil.invoice_id
         JOIN products p ON p.id=sil.product_id
        WHERE si.customer_id=$1 AND si.status='posted'
        GROUP BY p.id, p.code, p.name
        ORDER BY SUM(sil.qty) DESC, p.code`, [id])).rows;
    const grandQty = skuRows.reduce((s, r) => s + (Number(r.total_qty) || 0), 0);
    let cum = 0;
    const skuMarked = skuRows.map((r) => {
      const qty = Number(r.total_qty) || 0;
      const before = cum; cum += qty;
      // 파레토: 내림차순 누적이 80%에 도달하기 전(경계를 넘기는 항목 포함) = 핵심 소수
      const isPareto = grandQty > 0 ? (before < 0.8 * grandQty) : false;
      const isRepeat = (Number(r.order_count) || 0) >= 2; // 서로 다른 인보이스 2건 이상 = 반복주문
      return { product_id: r.product_id, code: r.code, name: r.name, total_qty: qty,
        order_count: Number(r.order_count) || 0, last_date: r.last_date || null,
        is_pareto: isPareto, is_repeat: isRepeat };
    });
    const importantRaw = skuMarked.filter((r) => r.is_pareto || r.is_repeat);
    const appMap = {};
    if (importantRaw.length) {
      const ids = importantRaw.map((r) => r.product_id);
      const apps = (await query(
        `SELECT product_id, app_text FROM product_applications WHERE product_id = ANY($1) ORDER BY product_id, id`, [ids])).rows;
      for (const a of apps) { (appMap[a.product_id] ||= []).push(a.app_text); }
    }
    const importantSkus = importantRaw.map((r) => ({
      code: r.code, name: r.name, total_qty: r.total_qty, order_count: r.order_count,
      last_date: r.last_date, is_pareto: r.is_pareto, is_repeat: r.is_repeat,
      applications: appMap[r.product_id] || [],
    }));
    return {
      customer: {
        id: c.id, code: c.code, name: c.name, rfc: c.rfc, contact: c.contact, phone: c.phone,
        buyer_name: c.buyer_name || null, buyer_phone: c.buyer_phone || null,
        discount: Number(c.discount), credit_days: c.credit_days, memo: c.memo, customer_type: c.customer_type,
        constancia_fiscal: c.constancia_fiscal || null,
        // 0185 · 등록 승인 + 선점 + 기준품목 근거 (마이그레이션 전 DB 에서는 undefined → 화면이 알아서 숨김)
        approval_status: c.approval_status || 'approved',
        constancia_no: c.constancia_no || null,
        // 0188 · RFC 가 선점 키. exempt = 마이그레이션 시점에 이미 RFC 가 중복이던 레거시 행.
        rfc_claim_exempt: c.rfc_claim_exempt === true,
        rejected_reason: c.rejected_reason || null,
        syd_ref_code: c.syd_ref_code || null,
        syd_ref_buy_price: c.syd_ref_buy_price == null ? null : Number(c.syd_ref_buy_price),
        syd_ref_list_price: c.syd_ref_list_price == null ? null : Number(c.syd_ref_list_price),
        syd_ref_discount: c.syd_ref_discount == null ? null : Number(c.syd_ref_discount),
        ctr_ref_code: c.ctr_ref_code || null,
        ctr_ref_list_price: c.ctr_ref_list_price == null ? null : Number(c.ctr_ref_list_price),
        suggested_discount: c.suggested_discount == null ? null : Number(c.suggested_discount),
        ship_address: c.ship_address || null,
        branch_count: c.branch_count == null ? null : Number(c.branch_count),
        team_id: c.team_id, team_name: c.team_name, stage_id: c.stage_id, stage_name: stageLabel(c.stage_name),
        owner_id: c.owner_id, owner_name: c.owner_name, stage_since: c.stage_since_str,
      },
      invoices: invs.map((i) => ({ ...i, total_mxn: r2(i.total_mxn), paid: r2(i.paid), outstanding: r2(i.outstanding) })),
      important_skus: importantSkus,
      reorder_summary: reorderSummary,
      sku_stats: { distinct: skuRows.length, total_qty: grandQty, important: importantSkus.length },
      summary: {
        ytd_actual: r2(ytd.actual),     // 연초~현재 누적 매출실적
        year_target: yearTarget,        // 올해 고객 월 목표 합(매출 목표 메뉴에서 설정)
        year: new Date().getUTCFullYear(),
      },
    };
  });

  // ===== 기본할인(%)·외상일 변경 통제 헬퍼 =====
  // 숫자 정규화: 빈값/무효 → 현재값 유지(applyCustomerUpdate 의 keepNum 과 동일 의미)
  function termsNum(v, cur) {
    if (v === undefined || v === '' || v === null) return Number(cur) || 0;
    const n = Number(v); return Number.isFinite(n) ? n : (Number(cur) || 0);
  }
  // 요청 본문 b 를 현재값 c 와 비교해 할인/외상일 실변경 목록 반환
  function detectTermsChanges(c, b) {
    const out = [];
    const nd = termsNum(b.discount, c.discount);
    const nc = termsNum(b.credit_days, c.credit_days);
    if (nd !== (Number(c.discount) || 0)) out.push({ field: 'discount', old: Number(c.discount) || 0, nv: nd });
    if (nc !== (Number(c.credit_days) || 0)) out.push({ field: 'credit_days', old: Number(c.credit_days) || 0, nv: nc });
    return out;
  }
  // 변경이력 기록(변경 필드당 1행, 같은 이유·조건 공유)
  async function logTermsHistory(customerId, changes, { reason, conditions, changedBy, approvedBy }) {
    for (const ch of changes) {
      await query(
        `INSERT INTO customer_terms_history (customer_id, field, old_value, new_value, reason, conditions, changed_by, approved_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [customerId, ch.field, ch.old, ch.nv, reason || null, conditions || null, changedBy || null, approvedBy || null]);
    }
  }

  // 기본할인·외상일 변경이력 — 고객을 볼 수 있으면 열람 가능
  app.get('/api/customers/:id/terms-history', { preHandler: [authGuard, requirePage('customers')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const c = (await query(`SELECT team_id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canViewTeam(req.ctx.perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    const rows = (await query(
      `SELECT h.id, h.field, h.old_value, h.new_value, h.reason, h.conditions,
              to_char(h.changed_at,'YYYY-MM-DD HH24:MI') AS changed_at,
              cb.name AS changed_by_name, ab.name AS approved_by_name
         FROM customer_terms_history h
         LEFT JOIN users cb ON cb.id=h.changed_by
         LEFT JOIN users ab ON ab.id=h.approved_by
        WHERE h.customer_id=$1
        ORDER BY h.changed_at DESC, h.id DESC LIMIT 200`, [id])).rows;
    return { items: rows.map((r) => ({
      id: Number(r.id), field: r.field,
      old_value: r.old_value == null ? null : Number(r.old_value),
      new_value: r.new_value == null ? null : Number(r.new_value),
      reason: r.reason, conditions: r.conditions, changed_at: r.changed_at,
      changed_by_name: r.changed_by_name, approved_by_name: r.approved_by_name,
    })) };
  });

  // 상담·방문 이력 — 현장방문 + 수기 미팅 통합, 최신순.
  //   열람 범위(디렉터 확정 2026-08-19): **디렉터는 전체 · 그 외는 본인이 기록한 것만**.
  //   영업활동(pipeline) 화면의 ownerCond 와 동일한 규칙 — 고객 화면을 통해 남의 상담
  //   내용이 새어나가지 않게 한다. 팀 가시성(canViewTeam)은 그 위에 추가로 건다.
  //   방문 목적 컬럼이 없으므로 카테고리는 visitTags 가 텍스트에서 자동 추출한다.
  app.get('/api/customers/:id/visits', { preHandler: [authGuard, requirePage('customers')] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad_id' });
    const c = (await query(`SELECT team_id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canViewTeam(perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });

    const isDir = perm.role === 'director';
    const ownerId = isDir ? null : Number(perm.userId);

    const vParams = [id, VISIT_TZ, VISIT_HIST_LIMIT];
    let vOwner = '';
    if (!isDir) { vParams.push(ownerId); vOwner = ` AND v.created_by = $${vParams.length}`; }
    const visits = (await query(
      `SELECT v.id,
              to_char(v.visit_date,'YYYY-MM-DD') AS visit_date,
              to_char(v.visited_at AT TIME ZONE $2,'HH24:MI') AS visit_time,
              v.met_person, v.talk_note, v.insight_note, u.name AS by_name
         FROM sales_visits v
         LEFT JOIN users u ON u.id = v.created_by
        WHERE v.customer_id = $1 AND v.deleted_at IS NULL${vOwner}
        ORDER BY v.visit_date DESC, v.visited_at DESC, v.id DESC
        LIMIT $3`, vParams)).rows;

    const vids = visits.map((v) => Number(v.id));
    let pendings = []; let recordings = [];
    if (vids.length) {
      pendings = (await query(
        `SELECT id, visit_id, content, due_date, done FROM sales_visit_pendings
          WHERE visit_id = ANY($1) ORDER BY done ASC, (due_date IS NULL) ASC, due_date ASC, id ASC`,
        [vids])).rows;
      try {
        recordings = (await query(
          `SELECT id, visit_id, status, summary_json FROM sales_visit_recordings
            WHERE visit_id = ANY($1) ORDER BY id ASC`, [vids])).rows;
      } catch (_) { recordings = []; }   // 0165 이전 DB 호환
    }

    // 수기 미팅(자동 생성된 '[현장방문]' 미팅은 방문 줄과 중복되므로 제외)
    const mParams = [id, VISIT_HIST_LIMIT];
    let mOwner = '';
    if (!isDir) { mParams.push(ownerId); mOwner = ` AND m.created_by = $${mParams.length}`; }
    const meetings = (await query(
      `SELECT m.id, to_char(m.meeting_date,'YYYY-MM-DD') AS meeting_date, m.note,
              u.name AS by_name, sb.name AS stage_before_name, sa.name AS stage_after_name
         FROM customer_meetings m
         LEFT JOIN users  u  ON u.id  = m.created_by
         LEFT JOIN stages sb ON sb.id = m.stage_before
         LEFT JOIN stages sa ON sa.id = m.stage_after
        WHERE m.customer_id = $1 AND COALESCE(m.note,'') NOT LIKE '[현장방문]%'${mOwner}
        ORDER BY m.meeting_date DESC, m.id DESC
        LIMIT $2`, mParams)).rows;

    // 상한에 걸렸으면 총계·최초방문일이 '담긴 범위' 기준임을 화면에 알린다.
    const truncated = visits.length >= VISIT_HIST_LIMIT || meetings.length >= VISIT_HIST_LIMIT;
    const mxToday = mxTodayStr(new Date());
    return { mx_today: mxToday, limit: VISIT_HIST_LIMIT, scope: isDir ? 'all' : 'own',
      ...assembleVisitHistory({ visits, meetings, pendings, recordings, mxToday, truncated }) };
  });

  // =====================================================================
  // 0185 · 고객 선점(claim) 조회  (0188 — 선점 키는 RFC)
  //
  //   100% 커미션 영업사원은 서로의 존재를 모른다. 그래서 "이미 남이 잡은 고객인가"
  //   만 확인할 수 있어야 하고, 그 이상(매출·상담·연락처·팀·금액)은 절대 보이면 안 된다.
  //   → 반환 필드는 **상호 · RFC · 담당 영업사원 이름 · 등록일 · 승인상태** 뿐이다.
  //   팀 스코프를 타지 않는 유일한 고객 조회 경로이므로 SELECT 목록을 함부로 늘리지 말 것.
  // =====================================================================
  app.get('/api/customers/claim-check', { preHandler: [authGuard, requirePage('customers')] }, async (req) => {
    const regOn = await regColumnsReady();
    const name = String(req.query.name || req.query.q || '').trim();
    const rfcN = normalizeClaimKey(req.query.rfc);
    const conN = normalizeClaimKey(req.query.constancia);
    if (!name && !rfcN && !conN) return { items: [], note: 'empty_query' };
    if (name && name.length < 2 && !rfcN && !conN) return { items: [], note: 'min_2_chars' };

    const where = [], params = [];
    if (name && name.length >= 2) { params.push(`%${name}%`); where.push(`c.name ILIKE $${params.length}`); }
    if (rfcN) {
      params.push(rfcN);
      where.push(regOn ? `c.rfc_norm = $${params.length}`
                       : `upper(regexp_replace(coalesce(c.rfc,''),'[^A-Za-z0-9]','','g')) = $${params.length}`);
    }
    if (conN && regOn) { params.push(conN); where.push(`c.constancia_no_norm = $${params.length}`); }

    const statusExpr = regOn ? `COALESCE(c.approval_status,'approved')` : `'approved'`;
    const rows = (await query(
      `SELECT c.name, c.rfc, u.name AS owner_name,
              to_char(c.created_at,'YYYY-MM-DD') AS registered_at,
              ${statusExpr} AS approval_status,
              ${regOn ? 'c.constancia_no_norm' : 'NULL::text'} AS con_norm,
              ${regOn ? 'c.rfc_norm' : `upper(regexp_replace(coalesce(c.rfc,''),'[^A-Za-z0-9]','','g'))`} AS rfc_n
         FROM customers c
         LEFT JOIN users u ON u.id=c.owner_id
        WHERE c.deleted_at IS NULL AND ${statusExpr} <> 'rejected' AND (${where.join(' OR ')})
        ORDER BY c.created_at LIMIT 30`, params)).rows;

    return {
      items: rows.map((r) => ({
        name: r.name, rfc: r.rfc || null,
        owner_name: r.owner_name || '(담당자 미지정)',
        registered_at: r.registered_at,
        approval_status: r.approval_status,
        // 어떤 키로 걸렸는지 — 화면에서 "이 RFC 는 이미 선점됨" 을 정확히 안내하기 위함
        matched_constancia: !!(conN && r.con_norm && r.con_norm === conN),
        matched_rfc: !!(rfcN && r.rfc_n && r.rfc_n === rfcN),
      })),
      // 이 둘 중 하나라도 true 면 등록이 차단된다 (0188 · 주 판정은 RFC)
      blocked_constancia: rows.some((r) => conN && r.con_norm && r.con_norm === conN),
      blocked_rfc: rows.some((r) => rfcN && r.rfc_n && r.rfc_n === rfcN),
      migration_required: !regOn,
      // 0188 마이그레이션 전이면 DB 유니크가 없어 동시 등록 극단 케이스가 뚫릴 수 있다.
      rfc_db_lock: await rfcClaimReady(),
    };
  });

  // =====================================================================
  // 0185 · 기준품목(SYD) 구매단가 → 할인율 산출 + 제안
  //
  //   ① 고객이 SYD 1516049 를 얼마에 사는지 입력  → SYD List Price 대비 할인율
  //   ② 그 구매가보다 5% 싸게 주는 목표가         → 구매단가 × 0.95
  //   ③ 목표가를 만드는 CTR 정가 대비 할인율      → **제안 할인율**
  //   CTR 정가는 1516049 에 매칭된 실제 CTR 제품의 List Price 를 쓴다(상수 마크업 아님).
  //
  //   권한: 고객을 등록할 수 있는 사람(requirePageEdit('customers')).
  //         할인율을 정하려면 정가를 봐야 하므로 sale_price 필드권한과 별도로 연다.
  // =====================================================================
  app.get('/api/customers/price-baseline', { preHandler: [authGuard, requirePageEdit('customers')] }, async (req) => {
    const code = String(req.query.code || SYD_BASE_CODE).trim();
    const buy = req.query.buy;
    const out = { base_code: code, found: false, ctr_code: null, product_name: null,
      syd_list_price: null, ctr_list_price: null, calc: null };
    if (!code) return out;
    const esc = code.replace(/([%_\\])/g, '\\$1');
    // 매칭: product_syd_codes 정확일치 우선 → products.scode 부분일치 폴백 (syd-baseline 과 동일 규칙)
    let row = (await query(
      `SELECT p.code, p.name, p.list_price_syd, p.list_price
         FROM product_syd_codes sc
         JOIN products p ON p.id = sc.product_id AND p.deleted_at IS NULL
        WHERE sc.syd_code = $1
        ORDER BY p.code LIMIT 1`, [code])).rows[0];
    if (!row) {
      row = (await query(
        `SELECT code, name, list_price_syd, list_price
           FROM products
          WHERE deleted_at IS NULL AND scode ILIKE $1
          ORDER BY code LIMIT 1`, ['%' + esc + '%'])).rows[0];
    }
    if (!row) return out;
    out.found = true;
    out.ctr_code = row.code;
    out.product_name = row.name;
    out.syd_list_price = row.list_price_syd != null ? Number(row.list_price_syd) : null;
    out.ctr_list_price = row.list_price != null ? Number(row.list_price) : null;
    if (buy != null && buy !== '') {
      out.calc = computeBaselineDiscount({
        buy_price: buy, syd_list_price: out.syd_list_price, ctr_list_price: out.ctr_list_price });
    }
    return out;
  });

  // =====================================================================
  // 고객 등록 (0185 → 0188 개정)
  //   · **RFC 입력이 곧 선점**이다(0188). 형식 검증을 통과한 RFC 하나면 등록된다.
  //   · CONSTANCIA 번호·PDF 는 선택 — 넣으면 그 번호도 함께 잠긴다(0185 유니크 유지).
  //   · 같은 RFC(정규화) 또는 같은 CONSTANCIA 가 이미 있으면 **등록 차단**(선점 안내).
  //   · 기준품목 구매단가 → 산출/제안 할인율을 스냅샷으로 박제.
  //   · 디렉터가 아니면 approval_status='pending' — 승인 전에는 견적·매출에 못 쓴다.
  // =====================================================================
  app.post('/api/customers', { preHandler: [authGuard, requirePageEdit('customers')] }, async (req, reply) => {
    const b = req.body || {};
    const perm = req.ctx.perm;
    if (!(await regColumnsReady())) {
      return reply.code(503).send({ error: 'migration_required',
        note: '고객 등록 고도화(0185) 마이그레이션이 아직 적용되지 않았습니다. 디렉터에게 문의하세요.' });
    }
    if (!b.name) return reply.code(400).send({ error: 'missing_fields' });
    const teamId = b.team_id ? Number(b.team_id) : (perm.teamId || null);
    if (!teamId) return reply.code(400).send({ error: 'team_required' });
    if (!canEditTeam(perm, teamId)) return reply.code(403).send({ error: 'forbidden_team' });

    // ── ① RFC 필수 = 선점 조건 (0188) ─────────────────────────────────
    //   "아무 문자열이나 넣고 선점" 이 되면 선점 장치 자체가 무의미해지므로
    //   멕시코 RFC 형식(법인 12 / 개인 13)을 실제로 검사한다.
    const rfcChk = validateRfc(b.rfc);
    if (!rfcChk.ok) {
      return reply.code(400).send({ error: rfcChk.error, note: RFC_ERROR_NOTE[rfcChk.error] });
    }
    const rfcClean = rfcChk.value;                 // 대문자·구분자 제거본을 저장한다(표기 흔들림 제거)
    const rfcNorm = normalizeClaimKey(rfcClean);

    // ── ② CONSTANCIA 번호 + 스캔본 (선택) ─────────────────────────────
    //   넣으면 그 번호도 0185 유니크로 함께 잠긴다. 안 넣어도 등록·선점은 된다.
    const conNo = String(b.constancia_no || '').trim();
    const conNorm = normalizeClaimKey(conNo);
    const doc = b.constancia_file || null;
    const docName = String(doc?.file_name || '').trim();
    const docMime = String(doc?.mime_type || '').trim();
    const docB64 = String(doc?.data_base64 || '');
    const hasDoc = !!(docName || docMime || docB64);
    let docBuf = null;
    if (hasDoc) {
      if (!docName || !docMime || !docB64) {
        return reply.code(400).send({ error: 'constancia_file_incomplete',
          note: 'CONSTANCIA 첨부가 불완전합니다. 파일을 다시 선택하세요.' });
      }
      if (!ALLOWED_DOC_MIME.includes(docMime)) {
        return reply.code(400).send({ error: 'unsupported_type', note: 'PDF·JPEG·PNG·WEBP만 첨부할 수 있습니다.' });
      }
      try { docBuf = Buffer.from(docB64, 'base64'); } catch (_) { return reply.code(400).send({ error: 'bad_base64' }); }
      if (!docBuf.length) return reply.code(400).send({ error: 'empty_file' });
      if (docBuf.length > MAX_DOC_BYTES) {
        return reply.code(400).send({ error: 'too_large', note: '파일은 5MB 이하만 가능합니다.' });
      }
    }

    // ── ③ 선점 검사 (RFC · CONSTANCIA) ────────────────────────────────
    //   유니크 인덱스가 최종 방어선이지만, 사용자에게는 "누가 선점했는지" 를 알려줘야 하므로
    //   저장 전에 먼저 조회한다. 동시성 충돌은 아래 INSERT 의 unique 에러로 다시 잡힌다.
    //   ⚠ rfc_claim_exempt(레거시 중복) 행도 여기서는 그대로 걸린다 —
    //     인덱스에서만 빠질 뿐, 남의 고객을 새로 등록해 가져가는 건 막아야 하기 때문.
    const dup = (await query(
      `SELECT c.name, u.name AS owner_name, to_char(c.created_at,'YYYY-MM-DD') AS registered_at,
              c.constancia_no_norm, c.rfc_norm
         FROM customers c LEFT JOIN users u ON u.id=c.owner_id
        WHERE c.deleted_at IS NULL AND COALESCE(c.approval_status,'approved') <> 'rejected'
          AND (c.rfc_norm = $1 OR ($2::text IS NOT NULL AND c.constancia_no_norm = $2))
        ORDER BY c.created_at LIMIT 1`, [rfcNorm, conNorm])).rows[0];
    if (dup) {
      const byRfc = dup.rfc_norm === rfcNorm;
      return reply.code(409).send({
        error: byRfc ? 'rfc_taken' : 'constancia_taken',
        note: `이미 등록된 고객입니다 — ${dup.name} · 담당 ${dup.owner_name || '(미지정)'} · 등록일 ${dup.registered_at}. `
            + '같은 고객이 맞다면 디렉터에게 문의하세요.',
        claimed_by: dup.owner_name || null, claimed_at: dup.registered_at, claimed_name: dup.name,
      });
    }

    // ── ④ 기준품목 단가 → 할인율 근거 스냅샷 ──────────────────────────
    const baseCode = String(b.syd_ref_code || SYD_BASE_CODE).trim();
    const buyPrice = (b.syd_ref_buy_price == null || b.syd_ref_buy_price === '') ? null : Number(b.syd_ref_buy_price);
    if (buyPrice == null || !Number.isFinite(buyPrice) || buyPrice <= 0) {
      return reply.code(400).send({ error: 'syd_ref_price_required',
        note: `기준품목 ${baseCode} 의 고객 구매단가를 입력해야 합니다.` });
    }
    const base = (await query(
      `SELECT p.code, p.list_price_syd, p.list_price
         FROM product_syd_codes sc JOIN products p ON p.id=sc.product_id AND p.deleted_at IS NULL
        WHERE sc.syd_code=$1 ORDER BY p.code LIMIT 1`, [baseCode])).rows[0]
      || (await query(
      `SELECT code, list_price_syd, list_price FROM products
        WHERE deleted_at IS NULL AND scode ILIKE $1 ORDER BY code LIMIT 1`,
        ['%' + baseCode.replace(/([%_\\])/g, '\\$1') + '%'])).rows[0] || null;
    const sydLP = base?.list_price_syd != null ? Number(base.list_price_syd) : null;
    const ctrLP = base?.list_price != null ? Number(base.list_price) : null;
    const calc = computeBaselineDiscount({ buy_price: buyPrice, syd_list_price: sydLP, ctr_list_price: ctrLP });

    // ── ⑤ 등록자가 정한 할인율 ────────────────────────────────────────
    const chosen = validateChosenDiscount(b.discount);
    if (!chosen.ok) {
      return reply.code(400).send({ error: chosen.error,
        note: `기본 할인율을 0~${MAX_DISCOUNT_PCT}% 범위로 입력하세요(제안값: ${calc.suggested_discount ?? '—'}%).` });
    }

    const isDir = perm.role === 'director';
    const status = isDir ? 'approved' : 'pending';

    // 코드 충돌 시 재시도(동시 생성 대비)
    let row, dupKey = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = await computeNextCode();
      try {
        row = (await query(
          `INSERT INTO customers (code, name, rfc, contact, phone, discount, credit_days, team_id, stage_id, owner_id,
                                  customer_type, memo, branch_count, ship_address, buyer_name, buyer_phone,
                                  constancia_fiscal, constancia_no,
                                  syd_ref_code, syd_ref_buy_price, syd_ref_list_price, syd_ref_discount,
                                  ctr_ref_code, ctr_ref_list_price, suggested_discount,
                                  approval_status, submitted_at, approved_by, approved_at,
                                  stage_since, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                   $11,$12,$13,$14,$15,$16,
                   $17,$18,
                   $19,$20,$21,$22,
                   $23,$24,$25,
                   $26, now(), $27, $28,
                   CASE WHEN $9::bigint IS NOT NULL THEN CURRENT_DATE END, $29)
           RETURNING id, code`,
          [code, b.name, rfcClean, b.contact || null, b.phone || null, chosen.value,
           Number(b.credit_days) || 0, teamId, b.stage_id || null,
           // 담당자 미지정이면 등록한 본인이 담당 = 선점자. 커미션 귀속의 근거가 된다.
           b.owner_id || perm.userId || null,
           b.customer_type || null, b.memo || null,
           (b.branch_count === '' || b.branch_count == null) ? null : Number(b.branch_count),
           (b.ship_address == null || String(b.ship_address).trim() === '') ? null : String(b.ship_address).trim(),
           (b.buyer_name == null || String(b.buyer_name).trim() === '') ? null : String(b.buyer_name).trim(),
           (b.buyer_phone == null || String(b.buyer_phone).trim() === '') ? null : String(b.buyer_phone).trim(),
           b.constancia_fiscal || null, conNo || null,
           baseCode, buyPrice, sydLP, calc.syd_discount,
           base?.code || null, ctrLP, calc.suggested_discount,
           status, isDir ? perm.userId : null, isDir ? new Date() : null,
           perm.userId])).rows[0];
        break;
      } catch (e) {
        const msg = String(e.message || '');
        if (msg.includes('uq_customers_rfc_claim')) { dupKey = 'rfc_taken'; break; }
        if (msg.includes('uq_customers_constancia_no')) { dupKey = 'constancia_taken'; break; }
        if (!msg.includes('unique') && !msg.includes('duplicate')) throw e;
      }
    }
    if (dupKey) {
      return reply.code(409).send({ error: dupKey,
        note: dupKey === 'rfc_taken'
          ? '방금 다른 영업사원이 같은 RFC 로 먼저 등록했습니다.'
          : '방금 다른 영업사원이 같은 CONSTANCIA 로 먼저 등록했습니다.' });
    }
    if (!row) return reply.code(409).send({ error: 'code_generation_failed' });

    // ── ⑥ CONSTANCIA 스캔본 저장 (첨부된 경우에만) ────────────────────
    //   0188 이후 증빙은 선택이다. 저장에 실패해도 **선점(RFC)은 이미 유효**하므로
    //   등록을 되돌리지 않는다 — 되돌리면 그 사이 남이 같은 RFC 를 가져갈 수 있다.
    //   대신 경고를 실어 보내 "증빙만 다시 올리세요" 로 유도한다.
    let docWarning = null;
    if (docBuf) {
      try {
        await query(
          `INSERT INTO customer_documents (customer_id, doc_type, file_name, mime_type, byte_size, content, uploaded_by)
           VALUES ($1,'constancia',$2,$3,$4,$5,$6)`,
          [row.id, docName, docMime, docBuf.length, docBuf, perm.userId]);
      } catch (e) {
        docWarning = 'constancia_save_failed';
      }
    }

    // ── ⑦ 이력 ───────────────────────────────────────────────────────
    const snapshot = {
      syd_ref_code: baseCode, syd_ref_buy_price: buyPrice, syd_ref_list_price: sydLP,
      syd_ref_discount: calc.syd_discount, ctr_ref_code: base?.code || null, ctr_ref_list_price: ctrLP,
      suggested_discount: calc.suggested_discount, chosen_discount: chosen.value,
      gap: discountGap(chosen.value, calc.suggested_discount), calc_note: calc.note || null,
    };
    try {
      await query(
        `INSERT INTO customer_registration_events (customer_id, action, reason, snapshot, acted_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [row.id, isDir ? 'approve' : 'submit', b.memo || null, JSON.stringify(snapshot), perm.userId]);
    } catch (_) { /* 이력 실패가 등록을 막지 않음 */ }

    // 초기 할인/외상일이 0이 아니면 기존 변경이력에도 남김(승인자는 디렉터 등록일 때만)
    const initTerms = [];
    if (chosen.value !== 0) initTerms.push({ field: 'discount', old: null, nv: chosen.value });
    if ((Number(b.credit_days) || 0) !== 0) initTerms.push({ field: 'credit_days', old: null, nv: Number(b.credit_days) || 0 });
    if (initTerms.length) {
      try {
        await logTermsHistory(row.id, initTerms, {
          reason: '신규 등록 초기값 (기준품목 ' + baseCode + ' 구매단가 ' + buyPrice + ' → 제안 ' + (calc.suggested_discount ?? '—') + '%)',
          conditions: null, changedBy: perm.userId, approvedBy: isDir ? perm.userId : null });
      } catch (_) { /* 이력 실패가 등록을 막지 않음 */ }
    }
    await safeLog({ userId: perm.userId, action: 'create', target: `customer:${row.id}`, detail: { approval_status: status } });
    return { ok: true, id: row.id, code: row.code, approval_status: status,
      pending_approval: status === 'pending', calc, suggested_discount: calc.suggested_discount,
      claimed_by: 'rfc', rfc: rfcClean, constancia_no: conNo || null, constancia_doc: !!docBuf && !docWarning,
      warning: docWarning,
      warning_note: docWarning
        ? 'RFC 로 선점·등록은 완료됐지만 CONSTANCIA 스캔본 저장에 실패했습니다. 고객 상세의 증빙서류에서 다시 올려 주세요.'
        : null };
  });

  // =====================================================================
  // 0185 · 고객 등록 승인 (디렉터)
  // =====================================================================
  app.get('/api/customer-registrations', { preHandler: [authGuard, requireDirector] }, async (req) => {
    if (!(await regColumnsReady())) return { items: [], migration_required: true };
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const rows = (await query(
      `SELECT c.id, c.code, c.name, c.rfc, c.constancia_no, c.discount, c.credit_days,
              c.suggested_discount, c.syd_ref_code, c.syd_ref_buy_price, c.syd_ref_list_price,
              c.syd_ref_discount, c.ctr_ref_code, c.ctr_ref_list_price, c.customer_type, c.memo,
              to_char(c.created_at,'YYYY-MM-DD') AS registered_at,
              t.name AS team_name, u.name AS owner_name, cu.name AS created_by_name,
              COALESCE(c.approval_status,'approved') AS approval_status,
              (SELECT count(*) FROM customer_documents d
                WHERE d.customer_id=c.id AND d.deleted_at IS NULL AND d.doc_type='constancia') AS constancia_docs
         FROM customers c
         LEFT JOIN sales_teams t ON t.id=c.team_id
         LEFT JOIN users u ON u.id=c.owner_id
         LEFT JOIN users cu ON cu.id=c.created_by
        WHERE c.deleted_at IS NULL AND COALESCE(c.approval_status,'approved')=$1
        ORDER BY c.created_at DESC LIMIT 200`, [status])).rows;
    return {
      items: rows.map((r) => ({
        id: Number(r.id), code: r.code, name: r.name, rfc: r.rfc || null,
        constancia_no: r.constancia_no || null, constancia_docs: Number(r.constancia_docs),
        discount: r.discount == null ? null : Number(r.discount),
        credit_days: r.credit_days == null ? null : Number(r.credit_days),
        suggested_discount: r.suggested_discount == null ? null : Number(r.suggested_discount),
        discount_gap: discountGap(r.discount, r.suggested_discount),
        syd_ref_code: r.syd_ref_code, ctr_ref_code: r.ctr_ref_code,
        syd_ref_buy_price: r.syd_ref_buy_price == null ? null : Number(r.syd_ref_buy_price),
        syd_ref_list_price: r.syd_ref_list_price == null ? null : Number(r.syd_ref_list_price),
        syd_ref_discount: r.syd_ref_discount == null ? null : Number(r.syd_ref_discount),
        ctr_ref_list_price: r.ctr_ref_list_price == null ? null : Number(r.ctr_ref_list_price),
        customer_type: r.customer_type, memo: r.memo,
        team_name: r.team_name, owner_name: r.owner_name, created_by_name: r.created_by_name,
        registered_at: r.registered_at, approval_status: r.approval_status,
      })),
    };
  });

  // 승인: 할인율을 디렉터가 조정해서 승인할 수도 있다(body.discount).
  app.post('/api/customer-registrations/:id/approve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const perm = req.ctx.perm;
    const c = (await query(
      `SELECT * FROM customers WHERE id=$1 AND deleted_at IS NULL AND COALESCE(approval_status,'approved')='pending'`,
      [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    // 0188 · CONSTANCIA 는 선택 증빙이 되었으므로 **승인을 막지 않는다**.
    //   대신 증빙 유무를 응답에 실어 승인 화면이 "증빙 없이 승인함" 을 남길 수 있게 한다.
    const docs = (await query(
      `SELECT count(*)::int AS n FROM customer_documents
        WHERE customer_id=$1 AND deleted_at IS NULL AND doc_type='constancia'`, [id])).rows[0];
    const hadDoc = Number(docs.n) > 0;
    let discount = c.discount == null ? 0 : Number(c.discount);
    if (req.body && req.body.discount != null && req.body.discount !== '') {
      const v = validateChosenDiscount(req.body.discount);
      if (!v.ok) return reply.code(400).send({ error: v.error });
      discount = v.value;
    }
    await query(
      `UPDATE customers SET approval_status='approved', approved_by=$1, approved_at=now(),
              rejected_reason=NULL, discount=$2, updated_by=$1 WHERE id=$3`,
      [perm.userId, discount, id]);
    try {
      await query(
        `INSERT INTO customer_registration_events (customer_id, action, reason, snapshot, acted_by)
         VALUES ($1,'approve',$2,$3,$4)`,
        [id, (req.body && req.body.reason) ? String(req.body.reason) : null,
         JSON.stringify({ approved_discount: discount, requested_discount: c.discount == null ? null : Number(c.discount),
           suggested_discount: c.suggested_discount == null ? null : Number(c.suggested_discount),
           constancia_doc: hadDoc }), perm.userId]);
    } catch (_) { /* ignore */ }
    // 디렉터가 할인율을 바꿔 승인했으면 변경이력에 남긴다
    if (Number(c.discount || 0) !== discount) {
      try {
        await logTermsHistory(id, [{ field: 'discount', old: Number(c.discount || 0), nv: discount }], {
          reason: '등록 승인 시 디렉터 조정', conditions: null, changedBy: c.created_by, approvedBy: perm.userId });
      } catch (_) { /* ignore */ }
    }
    await safeLog({ userId: perm.userId, action: 'approve_registration', target: `customer:${id}`, detail: { constancia_doc: hadDoc } });
    return { ok: true, id, discount, constancia_doc: hadDoc,
      warning: hadDoc ? null : 'constancia_missing',
      warning_note: hadDoc ? null : 'CONSTANCIA 스캔본 없이 승인했습니다(0188 이후 선택 항목).' };
  });

  // 반려: 선점을 풀어준다 — rejected 는 RFC·CONSTANCIA 두 유니크 인덱스 모두에서 빠진다 + 소프트 삭제.
  app.post('/api/customer-registrations/:id/reject', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const perm = req.ctx.perm;
    const reason = (req.body && req.body.reason) ? String(req.body.reason).trim() : '';
    if (!reason) return reply.code(400).send({ error: 'reason_required', note: '반려 사유를 입력하세요.' });
    const c = (await query(
      `SELECT id FROM customers WHERE id=$1 AND deleted_at IS NULL AND COALESCE(approval_status,'approved')='pending'`,
      [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    await query(
      `UPDATE customers SET approval_status='rejected', rejected_reason=$1, approved_by=$2, approved_at=now(),
              deleted_at=now(), updated_by=$2 WHERE id=$3`, [reason, perm.userId, id]);
    try {
      await query(
        `INSERT INTO customer_registration_events (customer_id, action, reason, snapshot, acted_by)
         VALUES ($1,'reject',$2,NULL,$3)`, [id, reason, perm.userId]);
    } catch (_) { /* ignore */ }
    await safeLog({ userId: perm.userId, action: 'reject_registration', target: `customer:${id}` });
    return { ok: true, id };
  });

  // 고객 수정
  // ===== 타팀 고객 수정요청(디렉터 승인 전제) =====
  //  배경: 영업이 다른 팀 고객을 "본인 담당으로 이관" 하려면 그 고객을 수정해야 하는데,
  //        고객 목록·상세는 팀 스코프라 아예 접근이 막혀 있었다(403 forbidden_team).
  //  방침: 열람 범위는 넓히지 않는다. 대신 디렉터가 켜 준 「타팀 수정요청」 권한이 있는 사용자에게만
  //        ① 상호/코드/RFC 로 고객을 "찾고"(최소 신원정보만),
  //        ② 그 고객의 "수정 요청 폼에 필요한 기본 항목"만 읽고,
  //        ③ PATCH 로 수정 요청을 넣는 경로를 연다. 실제 반영은 디렉터 승인 시에만.
  //  ⚠ 매출·미수·인보이스·증빙서류·방문이력 등 민감 데이터는 이 경로로 절대 나가지 않는다.

  // 고객 찾기(타팀 포함) — 수정요청용 최소 신원정보만 반환
  app.get('/api/customers/lookup', { preHandler: [authGuard, requirePageEdit('customers')] }, async (req, reply) => {
    const perm = req.ctx.perm;
    if (perm.role !== 'director' && !canRequestCrossTeam(perm)) {
      return reply.code(403).send({ error: 'cross_team_request_denied' });
    }
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return { items: [], note: 'min_2_chars' };
    const vis = visibleTeamIds(perm);
    const rows = (await query(
      `SELECT c.id, c.code, c.name, c.rfc, c.team_id, t.name AS team_name, c.owner_id, u.name AS owner_name,
              (EXISTS (SELECT 1 FROM customer_change_requests r WHERE r.customer_id=c.id AND r.status='pending')) AS has_pending
         FROM customers c
         LEFT JOIN sales_teams t ON t.id=c.team_id
         LEFT JOIN users u ON u.id=c.owner_id
        WHERE c.deleted_at IS NULL
          AND (c.name ILIKE $1 OR c.code ILIKE $1 OR c.rfc ILIKE $1)
        ORDER BY c.name LIMIT 30`, [`%${q}%`])).rows;
    return {
      items: rows.map((c) => ({
        id: Number(c.id), code: c.code, name: c.name, rfc: c.rfc,
        team_id: c.team_id == null ? null : Number(c.team_id), team_name: c.team_name,
        owner_id: c.owner_id == null ? null : Number(c.owner_id), owner_name: c.owner_name,
        // in_scope=true 면 원래 내 팀 고객(목록에서 그냥 열면 됨), false 면 타팀 → 수정요청 대상
        in_scope: vis === null ? true : (c.team_id != null && vis.includes(Number(c.team_id))),
        pending_change: !!c.has_pending,
      })),
    };
  });

  // 수정요청 폼용 기본 항목만 조회(타팀 고객 허용) — 금액·이력·서류는 포함하지 않는다
  app.get('/api/customers/:id/edit-basic', { preHandler: [authGuard, requirePageEdit('customers')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const perm = req.ctx.perm;
    const c = (await query(
      `SELECT c.id, c.code, c.name, c.rfc, c.contact, c.phone, c.buyer_name, c.buyer_phone,
              c.discount, c.credit_days, c.branch_count, c.customer_type, c.memo, c.constancia_fiscal,
              c.ship_address, c.team_id, c.stage_id, c.owner_id,
              t.name AS team_name, s.name AS stage_name, u.name AS owner_name
         FROM customers c
         LEFT JOIN sales_teams t ON t.id=c.team_id
         LEFT JOIN stages s ON s.id=c.stage_id
         LEFT JOIN users u ON u.id=c.owner_id
        WHERE c.id=$1 AND c.deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    const inScope = canViewTeam(perm, c.team_id);        // 볼 수 있나 (금액 등 노출 판단)
    const canEdit = canEditTeam(perm, c.team_id);        // 바로 고칠 수 있나 (승인 없이)
    if (!inScope && !canRequestCrossTeam(perm)) return reply.code(403).send({ error: 'forbidden_team' });
    const pend = (await query(
      `SELECT r.id, r.requested_by, u.name AS requested_by_name, r.created_at
         FROM customer_change_requests r LEFT JOIN users u ON u.id=r.requested_by
        WHERE r.customer_id=$1 AND r.status='pending' LIMIT 1`, [id])).rows[0] || null;
    return {
      item: {
        id: Number(c.id), code: c.code, name: c.name, rfc: c.rfc, contact: c.contact, phone: c.phone,
        buyer_name: c.buyer_name, buyer_phone: c.buyer_phone,
        discount: c.discount == null ? 0 : Number(c.discount),
        credit_days: c.credit_days == null ? 0 : Number(c.credit_days),
        branch_count: c.branch_count == null ? null : Number(c.branch_count),
        customer_type: c.customer_type, memo: c.memo, constancia_fiscal: c.constancia_fiscal,
        // 배송지는 타팀 요청 화면에서 수정 대상이 아니다(즉시 저장 경로라 승인 우회가 되므로).
        ship_address: inScope ? (c.ship_address || null) : null,
        team_id: c.team_id == null ? null : Number(c.team_id), team_name: c.team_name,
        stage_id: c.stage_id == null ? null : Number(c.stage_id), stage_name: stageLabel(c.stage_name),
        owner_id: c.owner_id == null ? null : Number(c.owner_id), owner_name: c.owner_name,
      },
      in_scope: inScope,
      // ⚠ cross_team 은 "볼 수 있나"가 아니라 "바로 고칠 수 있나" 기준이다.
      //   상대팀 열람만 부여받은 사용자는 고객이 목록에 보여서 일반 수정 화면으로 들어오는데,
      //   그때도 배송지 즉시저장은 막히고 저장은 승인 대기로 가야 하므로 PATCH 와 같은 기준을 쓴다.
      cross_team: !canEdit,
      pending: pend ? { id: Number(pend.id), requested_by_name: pend.requested_by_name, created_at: pend.created_at } : null,
    };
  });

  // 고객 수정에 적용할 필드를 customers에 반영(헬퍼) — 승인 시 재사용
  async function applyCustomerUpdate(id, c, b, userId) {
    // 빈문자열/무효값이 숫자·FK 컬럼(owner_id, stage_id, team_id, credit_days 등)에 들어가
    // "invalid input syntax for type bigint" 류 오류로 승인이 실패하던 문제 방지.
    // (요청 생성 시엔 proposed JSON 저장만 하므로 통과, 실제 검증은 승인 UPDATE 시점에 발생)
    // 필수/NOT NULL 숫자(team_id·stage_id·discount·credit_days): 빈값·무효 → 현재값 유지.
    const keepNum = (v, cur) => {
      if (v === undefined || v === '' || v === null) return cur;
      const n = Number(v); return Number.isFinite(n) ? n : cur;
    };
    // nullable FK/숫자(owner_id·branch_count): 빈값 → null(명시적 비움 허용), 무효 → 현재값.
    const nullNum = (v, cur) => {
      if (v === undefined) return cur;
      if (v === '' || v === null) return null;
      const n = Number(v); return Number.isFinite(n) ? n : cur;
    };
    const teamId = keepNum(b.team_id, c.team_id);
    const stageId = keepNum(b.stage_id, c.stage_id);
    const stageChanged = Number(stageId) !== Number(c.stage_id);
    // 0188 · RFC 가 선점 키다.
    //   ① 빈값으로 지우는 것은 막는다 — 지우면 선점이 풀려 남이 같은 고객을 다시 등록할 수 있다.
    //   ② 값이 바뀌면 형식 검증 + 선점 충돌 검사를 거친다(디렉터 즉시반영·승인 반영 양쪽 공통).
    //   원래 RFC 가 비어 있던 레거시 고객은 여기서 처음 채우는 것이므로 검증만 통과하면 된다.
    let rfcVal = (b.rfc !== undefined && String(b.rfc).trim() !== '') ? String(b.rfc).trim() : (c.rfc || null);
    if (rfcVal && normalizeClaimKey(rfcVal) !== normalizeClaimKey(c.rfc)) {
      const chk = validateRfc(rfcVal);
      if (!chk.ok) { const e = new Error(chk.error); e.claimError = chk.error; throw e; }
      rfcVal = chk.value;
      const clash = (await query(
        `SELECT c2.name, u.name AS owner_name, to_char(c2.created_at,'YYYY-MM-DD') AS registered_at
           FROM customers c2 LEFT JOIN users u ON u.id=c2.owner_id
          WHERE c2.id <> $2 AND c2.deleted_at IS NULL
            AND COALESCE(c2.approval_status,'approved') <> 'rejected'
            AND c2.rfc_norm = $1
          ORDER BY c2.created_at LIMIT 1`, [normalizeClaimKey(rfcVal), id])).rows[0];
      if (clash) {
        const e = new Error('rfc_taken'); e.claimError = 'rfc_taken';
        e.claimNote = `이미 등록된 RFC 입니다 — ${clash.name} · 담당 ${clash.owner_name || '(미지정)'} · 등록일 ${clash.registered_at}.`;
        throw e;
      }
    }
    // 0185 · CONSTANCIA 번호는 마이그레이션이 적용된 DB 에서만 건드린다
    //   (컬럼이 없는 반쪽 배포 상태에서도 기존 고객 수정이 죽지 않게).
    //   0188 이후 선점 키가 아니므로 **빈값으로 지우는 것도 허용**한다.
    const conOn = await regColumnsReady();
    const params = [b.name || c.name, rfcVal, b.contact !== undefined ? b.contact : c.contact,
      b.phone !== undefined ? b.phone : c.phone, keepNum(b.discount, c.discount),
      keepNum(b.credit_days, c.credit_days), teamId,
      stageId, nullNum(b.owner_id, c.owner_id),
      b.customer_type !== undefined ? b.customer_type : c.customer_type,
      b.memo !== undefined ? b.memo : c.memo, stageChanged, userId, id,
      b.constancia_fiscal !== undefined ? b.constancia_fiscal : c.constancia_fiscal,
      nullNum(b.branch_count, c.branch_count),
      b.buyer_name !== undefined ? b.buyer_name : c.buyer_name,
      b.buyer_phone !== undefined ? b.buyer_phone : c.buyer_phone];
    if (conOn) {
      params.push(b.constancia_no === undefined
        ? (c.constancia_no || null)
        : (String(b.constancia_no).trim() || null));
    }
    await query(
      `UPDATE customers SET name=$1, rfc=$2, contact=$3, phone=$4, discount=$5, credit_days=$6,
         team_id=$7, stage_id=$8, owner_id=$9, customer_type=$10, memo=$11, constancia_fiscal=$15, branch_count=$16,
         buyer_name=$17, buyer_phone=$18${conOn ? ', constancia_no=$19' : ''},
         stage_since=CASE WHEN $12 THEN CURRENT_DATE ELSE stage_since END, updated_by=$13 WHERE id=$14`,
      params);
  }

  app.patch('/api/customers/:id', { preHandler: [authGuard, requirePageEdit('customers')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const perm = req.ctx.perm;
    const c = (await query(`SELECT * FROM customers WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    // 타팀 고객: cross_team_request 권한이 있으면 "수정 요청"만 허용(즉시 반영 경로로는 절대 못 감).
    const crossTeam = !canEditTeam(perm, c.team_id);
    if (crossTeam && !canRequestCrossTeam(perm)) return reply.code(403).send({ error: 'forbidden_team' });
    const b = req.body || {};
    // 팀 이동 권한 체크(디렉터/양팀 편집권).
    //   타팀 수정요청은 "이관 요청" 그 자체이므로 목적지 팀 편집권을 요구하지 않는다
    //   — 어차피 제안일 뿐이고 디렉터 승인에서 최종 판단한다.
    if (!crossTeam && b.team_id != null && Number(b.team_id) !== c.team_id) {
      if (!canEditTeam(perm, Number(b.team_id))) return reply.code(403).send({ error: 'forbidden_team_move' });
    }
    // 기본할인(%)·외상일 변경은 수정이유 + 제공 조건 작성이 필수(디렉터 포함)
    const termsChanges = detectTermsChanges(c, b);
    const termsReason = String(b.terms_reason || b.reason || '').trim();
    const termsConditions = String(b.terms_conditions || '').trim();
    if (termsChanges.length && (!termsReason || !termsConditions)) {
      return reply.code(400).send({ error: 'terms_reason_required',
        note: '기본할인(%)·외상일을 변경할 때는 수정이유와 제공 조건을 반드시 입력해야 합니다.' });
    }
    // 디렉터: 즉시 반영(+이력 기록) / 그 외: 디렉터 승인 대기로 보관
    // (crossTeam 은 디렉터에게 항상 false — 방어적으로 한 번 더 명시)
    if (perm.role === 'director' && !crossTeam) {
      try {
        await applyCustomerUpdate(id, c, b, perm.userId);
      } catch (e) {
        if (e.claimError) {
          return reply.code(e.claimError === 'rfc_taken' ? 409 : 400)
            .send({ error: e.claimError, note: e.claimNote || RFC_ERROR_NOTE[e.claimError] || null });
        }
        throw e;
      }
      if (termsChanges.length) {
        await logTermsHistory(id, termsChanges, { reason: termsReason, conditions: termsConditions, changedBy: perm.userId, approvedBy: perm.userId });
      }
      await safeLog({ userId: perm.userId, action: 'update', target: `customer:${id}` });
      return { ok: true };
    }
    // 같은 고객에 이미 대기중인 요청이 있으면 갱신(최신으로 덮어씀)
    // ⚠ 여기에 빠진 필드는 승인해도 절대 반영되지 않는다(diff에도 안 뜸).
    //    승인 화면 LABELS / applyCustomerUpdate 와 항상 같은 집합을 유지할 것.
    //    2026-08-18: buyer_name·buyer_phone(구매결정권자 WhatsApp)·branch_count 누락 수정.
    const proposed = {
      name: b.name, rfc: b.rfc, contact: b.contact, phone: b.phone,
      buyer_name: b.buyer_name, buyer_phone: b.buyer_phone,
      discount: b.discount, credit_days: b.credit_days, branch_count: b.branch_count,
      team_id: b.team_id, stage_id: b.stage_id, owner_id: b.owner_id,
      customer_type: b.customer_type, memo: b.memo, constancia_fiscal: b.constancia_fiscal,
      constancia_no: b.constancia_no,
    };
    const existing = (await query(`SELECT id FROM customer_change_requests WHERE customer_id=$1 AND status='pending'`, [id])).rows[0];
    if (existing) {
      await query(`UPDATE customer_change_requests SET proposed=$1, requested_by=$2, reason=$3, conditions=$4, created_at=now() WHERE id=$5`,
        [JSON.stringify(proposed), perm.userId, termsReason || null, termsConditions || null, existing.id]);
    } else {
      await query(`INSERT INTO customer_change_requests (customer_id, proposed, requested_by, reason, conditions) VALUES ($1,$2,$3,$4,$5)`,
        [id, JSON.stringify(proposed), perm.userId, termsReason || null, termsConditions || null]);
    }
    await safeLog({ userId: perm.userId, action: 'change_request', target: `customer:${id}`, detail: { cross_team: crossTeam } });
    return { ok: true, pending: true, cross_team: crossTeam };
  });

  // 배송지(ship_address) 즉시 저장 — 승인 플로우 없이 언제든 입력/수정 가능.
  //   포장 라벨(etiqueta)·패킹리스트 출력에 쓰이는 운영 정보라 지연 없이 반영한다.
  //   편집 권한(requirePageEdit) + 팀 편집권만 확인. 빈값 저장 = 배송지 비우기.
  app.patch('/api/customers/:id/ship-address', { preHandler: [authGuard, requirePageEdit('customers')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const perm = req.ctx.perm;
    const c = (await query(`SELECT id, team_id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canEditTeam(perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    const raw = (req.body || {}).ship_address;
    const val = (raw == null || String(raw).trim() === '') ? null : String(raw).trim();
    await query(`UPDATE customers SET ship_address=$1, updated_by=$2 WHERE id=$3`, [val, perm.userId, id]);
    await safeLog({ userId: perm.userId, action: 'update', target: `customer:${id}`, detail: { field: 'ship_address' } });
    return { ok: true, ship_address: val };
  });

  // 단계별 고객수 요약(팀별 + 합계) — 견적30/협상40/수주50/거래중60
  app.get('/api/customers/stage-summary', { preHandler: [authGuard, requirePage('customers')] }, async (req) => {
    const { perm } = req.ctx;
    const vis = visibleTeamIds(perm);
    const conds = ['c.deleted_at IS NULL']; const params = [];
    if (vis !== null) {
      if (!vis.length) return { teams: [], total: { total: 0, unset: 0, latent: 0, contact: 0, quote: 0, nego: 0, won: 0, active: 0 } };
      params.push(vis); conds.push(`c.team_id = ANY($${params.length})`);
    }
    const rows = (await query(
      `SELECT c.team_id, t.name AS team_name, t.sort_order AS team_sort,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE s.sort_order IS NULL OR s.sort_order=0)::int AS unset,
              COUNT(*) FILTER (WHERE s.sort_order=10)::int AS latent,
              COUNT(*) FILTER (WHERE s.sort_order=20)::int AS contact,
              COUNT(*) FILTER (WHERE s.sort_order=30)::int AS quote,
              COUNT(*) FILTER (WHERE s.sort_order=40)::int AS nego,
              COUNT(*) FILTER (WHERE s.sort_order=50)::int AS won,
              COUNT(*) FILTER (WHERE s.sort_order=60)::int AS active
         FROM customers c
         LEFT JOIN sales_teams t ON t.id=c.team_id
         LEFT JOIN stages s ON s.id=c.stage_id
        WHERE ${conds.join(' AND ')}
        GROUP BY c.team_id, t.name, t.sort_order
        ORDER BY t.sort_order NULLS LAST, t.name`, params)).rows;
    const teams = rows.map((r) => ({
      team_id: r.team_id, team_name: r.team_name || '(미지정)',
      total: Number(r.total), unset: Number(r.unset), latent: Number(r.latent), contact: Number(r.contact),
      quote: Number(r.quote), nego: Number(r.nego), won: Number(r.won), active: Number(r.active),
    }));
    const total = teams.reduce((a, t) => ({
      total: a.total + t.total, unset: a.unset + t.unset, latent: a.latent + t.latent, contact: a.contact + t.contact,
      quote: a.quote + t.quote, nego: a.nego + t.nego, won: a.won + t.won, active: a.active + t.active,
    }), { total: 0, unset: 0, latent: 0, contact: 0, quote: 0, nego: 0, won: 0, active: 0 });
    return { teams, total };
  });

  // 고객 수정 승인 대기 목록(디렉터)
  app.get('/api/customer-change-requests', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const cid = req.query.customer_id ? Number(req.query.customer_id) : null;
    const rows = (await query(
      `SELECT r.id, r.customer_id, r.proposed, r.status, r.reason, r.conditions, r.created_at,
              c.code AS customer_code, c.name AS customer_name,
              c.name AS cur_name, c.rfc AS cur_rfc, c.contact AS cur_contact, c.phone AS cur_phone,
              c.buyer_name AS cur_buyer_name, c.buyer_phone AS cur_buyer_phone,
              c.discount AS cur_discount, c.credit_days AS cur_credit_days, c.branch_count AS cur_branch_count,
              c.team_id AS cur_team_id, c.stage_id AS cur_stage_id, c.owner_id AS cur_owner_id,
              c.customer_type AS cur_customer_type, c.memo AS cur_memo, c.constancia_fiscal AS cur_constancia_fiscal,
              c.constancia_no AS cur_constancia_no,
              u.name AS requested_by_name, u.team_id AS requester_team_id, rt.name AS requester_team_name,
              ct.name AS cur_team_name
         FROM customer_change_requests r
         JOIN customers c ON c.id=r.customer_id
         LEFT JOIN users u ON u.id=r.requested_by
         LEFT JOIN sales_teams rt ON rt.id=u.team_id
         LEFT JOIN sales_teams ct ON ct.id=c.team_id
        WHERE r.status=$1 AND ($2::bigint IS NULL OR r.customer_id=$2) ORDER BY r.created_at DESC`, [status, cid])).rows;

    // 팀/단계/담당자 id → 이름 매핑(현재값·제안값 모두 모아서 한 번에 조회)
    const teamIds = new Set(), stageIds = new Set(), ownerIds = new Set();
    for (const r of rows) {
      const p = r.proposed || {};
      [r.cur_team_id, p.team_id].forEach((v) => { if (v != null && v !== '') teamIds.add(Number(v)); });
      [r.cur_stage_id, p.stage_id].forEach((v) => { if (v != null && v !== '') stageIds.add(Number(v)); });
      [r.cur_owner_id, p.owner_id].forEach((v) => { if (v != null && v !== '') ownerIds.add(Number(v)); });
    }
    const nameMap = async (table, ids) => {
      if (!ids.size) return {};
      const rs = (await query(`SELECT id, name FROM ${table} WHERE id = ANY($1)`, [[...ids]])).rows;
      const m = {}; rs.forEach((x) => { m[Number(x.id)] = x.name; }); return m;
    };
    const teamNames = await nameMap('sales_teams', teamIds);
    const stageNames = await nameMap('stages', stageIds);
    const ownerNames = await nameMap('users', ownerIds);

    const LABELS = { name: '고객명', rfc: 'RFC(선점 키)', contact: '이메일 주소', phone: '전화', buyer_name: '구매결정권자', buyer_phone: '구매결정권자 전화(WhatsApp)', discount: '기본할인', credit_days: '외상일', branch_count: '지점 수', team_id: '영업팀', stage_id: '영업단계', owner_id: '담당자', customer_type: '고객유형', memo: '메모', constancia_fiscal: '세무등록(Constancia)', constancia_no: 'CONSTANCIA 번호' };
    const NUMERIC = new Set(['discount', 'credit_days', 'branch_count', 'team_id', 'stage_id', 'owner_id']);
    const isEmpty = (v) => v == null || v === '';
    const disp = (field, val) => {
      if (isEmpty(val)) return '(미지정)';
      if (field === 'team_id') return teamNames[Number(val)] || `팀 #${val}`;
      if (field === 'stage_id') return stageLabel(stageNames[Number(val)]) || `단계 #${val}`;
      if (field === 'owner_id') return ownerNames[Number(val)] || `사용자 #${val}`;
      if (field === 'discount') return `${val}%`;
      if (field === 'credit_days') return `${val}일`;
      return String(val);
    };

    const items = rows.map((r) => {
      const p = r.proposed || {};
      const cur = {
        name: r.cur_name, rfc: r.cur_rfc, contact: r.cur_contact, phone: r.cur_phone,
        buyer_name: r.cur_buyer_name, buyer_phone: r.cur_buyer_phone,
        discount: r.cur_discount, credit_days: r.cur_credit_days, branch_count: r.cur_branch_count,
        team_id: r.cur_team_id, stage_id: r.cur_stage_id, owner_id: r.cur_owner_id,
        customer_type: r.cur_customer_type, memo: r.cur_memo, constancia_fiscal: r.cur_constancia_fiscal,
        constancia_no: r.cur_constancia_no,
      };
      const changes = [];
      for (const f of Object.keys(LABELS)) {
        if (!(f in p)) continue;                       // 요청에 포함된 필드만
        const pv = p[f]; const cv = cur[f];
        let same;
        if (NUMERIC.has(f)) {
          if (isEmpty(cv) && isEmpty(pv)) same = true;
          else if (isEmpty(cv) || isEmpty(pv)) same = false;
          else same = Number(cv) === Number(pv);
        } else { same = String(cv == null ? '' : cv) === String(pv == null ? '' : pv); }
        if (same) continue;                            // 실제로 바뀐 것만
        changes.push({ field: f, label: LABELS[f], from: disp(f, cv), to: disp(f, pv) });
      }
      return {
        id: r.id, customer_id: r.customer_id, customer_code: r.customer_code, customer_name: r.customer_name,
        proposed: r.proposed, status: r.status, reason: r.reason, conditions: r.conditions,
        requested_by_name: r.requested_by_name, created_at: r.created_at, changes,
        // 요청자 소속팀 ≠ 고객 소속팀 → 「타팀 요청」. 디렉터가 승인 화면에서 바로 알아볼 수 있게 표시.
        requester_team_name: r.requester_team_name || null,
        customer_team_name: r.cur_team_name || null,
        cross_team: r.requester_team_id != null && r.cur_team_id != null
          && Number(r.requester_team_id) !== Number(r.cur_team_id),
      };
    });
    return { items };
  });

  // 승인 → customers에 반영(디렉터)
  app.post('/api/customer-change-requests/:id/approve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const r = (await query(`SELECT * FROM customer_change_requests WHERE id=$1 AND status='pending'`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    const c = (await query(`SELECT * FROM customers WHERE id=$1 AND deleted_at IS NULL`, [r.customer_id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'customer_gone' });
    // 승인 전 현재값 기준으로 할인/외상일 실변경 산출 → 반영 후 이력 기록
    const approvedTerms = detectTermsChanges(c, r.proposed || {});
    try {
      await applyCustomerUpdate(r.customer_id, c, r.proposed, req.ctx.perm.userId);
    } catch (e) {
      // 0188 · 요청이 올라온 뒤 그 RFC 를 다른 고객이 선점했거나 형식이 잘못된 경우.
      //   요청은 pending 그대로 두고 디렉터에게 이유를 알린다(반려/수정 판단은 사람이).
      if (e.claimError) {
        return reply.code(e.claimError === 'rfc_taken' ? 409 : 400)
          .send({ error: e.claimError, note: e.claimNote || RFC_ERROR_NOTE[e.claimError] || null });
      }
      throw e;
    }
    if (approvedTerms.length) {
      await logTermsHistory(r.customer_id, approvedTerms, {
        reason: r.reason, conditions: r.conditions,
        changedBy: r.requested_by, approvedBy: req.ctx.perm.userId,
      });
    }
    await query(`UPDATE customer_change_requests SET status='approved', decided_by=$1, decided_at=now() WHERE id=$2`, [req.ctx.perm.userId, id]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'approve_change', target: `customer:${r.customer_id}` });
    return { ok: true };
  });

  // 반려(디렉터)
  app.post('/api/customer-change-requests/:id/reject', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const r = (await query(`SELECT id FROM customer_change_requests WHERE id=$1 AND status='pending'`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await query(`UPDATE customer_change_requests SET status='rejected', decided_by=$1, decided_at=now(), reject_reason=$2 WHERE id=$3`,
      [req.ctx.perm.userId, (req.body && req.body.reason) ? String(req.body.reason) : null, id]);
    return { ok: true };
  });

  // 고객 삭제(디렉터)
  app.delete('/api/customers/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const c = (await query(`SELECT id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    await query(`UPDATE customers SET deleted_at=now(), updated_by=$1 WHERE id=$2`, [req.ctx.perm.userId, id]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'delete', target: `customer:${id}` });
    return { ok: true };
  });

  // ===== 디렉터: 팀 배정 · 상대팀 열람 권한 =====
  // 사용자 목록(팀·권한 보기용)
  app.get('/api/team-admin/users', { preHandler: [authGuard, requireDirector] }, async () => {
    const users = (await query(
      `SELECT u.id, u.name, u.role, u.team_id, t.name AS team_name
         FROM users u LEFT JOIN sales_teams t ON t.id=u.team_id
        WHERE u.deleted_at IS NULL ORDER BY u.name`)).rows;
    // 타팀 수정요청 권한 — 스키마 변경 없이 user_page_access 의 행 유무로 판단
    const crossOn = new Set((await query(
      `SELECT user_id FROM user_page_access WHERE page_key=$1`, [CROSS_TEAM_PAGE_KEY]
    )).rows.map((r) => String(r.user_id)));
    const grants = (await query(
      `SELECT a.user_id, a.team_id, a.can_edit, t.name AS team_name
         FROM user_team_access a JOIN sales_teams t ON t.id=a.team_id`)).rows;
    const grantsByUser = {};
    // ★ BIGINT는 pg가 문자열로 반환 → Number로 정규화(프런트 === 비교가 어긋나 저장값이 '미지정'으로 보이던 원인)
    for (const g of grants) (grantsByUser[String(g.user_id)] ||= []).push({ team_id: Number(g.team_id), team_name: g.team_name, can_edit: g.can_edit });
    return {
      items: users.map((u) => ({
        id: Number(u.id), name: u.name, role: u.role,
        team_id: u.team_id == null ? null : Number(u.team_id),
        team_name: u.team_name,
        cross_team_request: crossOn.has(String(u.id)),
        grants: grantsByUser[String(u.id)] || [],
      })),
    };
  });

  // 타팀 고객 수정요청 허용/차단(디렉터)
  //   ⚠ 이 스위치는 "열람 권한"이 아니다. 켜도 고객 목록·매출·미수는 종전대로 자기 팀만 보인다.
  //      켜진 사용자는 타팀 고객을 상호/코드로 찾아 「수정 요청」만 넣을 수 있고, 반영은 디렉터 승인 시.
  app.patch('/api/team-admin/users/:id/cross-team-request', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const on = req.body?.enabled === true;
    // 스키마 변경 없이 기존 권한 테이블에 행을 넣고/빼는 것으로 끝낸다(마이그레이션 불필요).
    const usr = (await query(`SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!usr) return reply.code(404).send({ error: 'user_not_found' });
    if (on) {
      await query(
        `INSERT INTO user_page_access (user_id, page_key, device_req, access)
         VALUES ($1,$2,'anywhere','edit')
         ON CONFLICT (user_id, page_key) DO UPDATE SET access='edit'`, [id, CROSS_TEAM_PAGE_KEY]);
    } else {
      await query(`DELETE FROM user_page_access WHERE user_id=$1 AND page_key=$2`, [id, CROSS_TEAM_PAGE_KEY]);
    }
    await safeLog({ userId: req.ctx.perm.userId, action: 'permission_change',
      target: `user_cross_team_request:${id}`, detail: { enabled: on } });
    return { ok: true, enabled: on };
  });

  // 사용자 소속팀 지정(디렉터)
  app.patch('/api/team-admin/users/:id/team', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const teamId = req.body?.team_id != null ? Number(req.body.team_id) : null;
    // 존재하지 않는 팀/사용자면 FK 500 대신 명확한 오류 반환(프런트가 사유를 표시하고 원복)
    let teamName = null;
    if (teamId != null) {
      const t = (await query(`SELECT id, name FROM sales_teams WHERE id=$1 AND deleted_at IS NULL`, [teamId])).rows[0];
      if (!t) return reply.code(400).send({ error: 'team_not_found' });
      teamName = t.name;
    }
    const up = await query(`UPDATE users SET team_id=$1, updated_by=$2 WHERE id=$3 AND deleted_at IS NULL`, [teamId, req.ctx.perm.userId, id]);
    if (up.rowCount === 0) return reply.code(404).send({ error: 'user_not_found' });
    await safeLog({ userId: req.ctx.perm.userId, action: 'permission_change', target: `user_team:${id}`, detail: { team_id: teamId } });
    return { ok: true, team_id: teamId, team_name: teamName };
  });

  // 상대팀 열람 권한 부여/회수(디렉터)
  app.post('/api/team-admin/users/:id/grant', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const teamId = Number(req.body?.team_id);
    const canEdit = !!req.body?.can_edit;
    if (!teamId) return reply.code(400).send({ error: 'team_required' });
    const t = (await query(`SELECT id FROM sales_teams WHERE id=$1 AND deleted_at IS NULL`, [teamId])).rows[0];
    if (!t) return reply.code(400).send({ error: 'team_not_found' });
    const usr = (await query(`SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!usr) return reply.code(404).send({ error: 'user_not_found' });
    await query(
      `INSERT INTO user_team_access (user_id, team_id, can_edit, created_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, team_id) DO UPDATE SET can_edit=$3`, [id, teamId, canEdit, req.ctx.perm.userId]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'permission_change', target: `user_team_grant:${id}`, detail: { team_id: teamId, can_edit: canEdit } });
    return { ok: true };
  });

  app.delete('/api/team-admin/users/:id/grant/:teamId', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const id = Number(req.params.id), teamId = Number(req.params.teamId);
    await query(`DELETE FROM user_team_access WHERE user_id=$1 AND team_id=$2`, [id, teamId]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'permission_change', target: `user_team_revoke:${id}`, detail: { team_id: teamId } });
    return { ok: true };
  });

  // ===== 고객 증빙서류 (PDF·JPEG 등) — DB 저장 =====
  const ALLOWED_DOC_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
  const MAX_DOC_BYTES = 5 * 1024 * 1024; // 5MB

  // 목록 (본문 제외)
  app.get('/api/customers/:id/documents', { preHandler: [authGuard, requirePage('customers')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const c = (await query(`SELECT team_id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canViewTeam(req.ctx.perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    const rows = (await query(
      `SELECT d.id, d.doc_type, d.file_name, d.mime_type, d.byte_size, to_char(d.uploaded_at,'YYYY-MM-DD') AS uploaded_at, u.name AS uploaded_by_name
         FROM customer_documents d LEFT JOIN users u ON u.id=d.uploaded_by
        WHERE d.customer_id=$1 AND d.deleted_at IS NULL ORDER BY d.uploaded_at DESC, d.id DESC`, [id])).rows;
    return { items: rows.map((r) => ({ ...r, byte_size: Number(r.byte_size) })) };
  });

  // 업로드: { doc_type?, file_name, mime_type, data_base64 }
  app.post('/api/customers/:id/documents', { preHandler: [authGuard, requirePageEdit('customers')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const c = (await query(`SELECT team_id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canEditTeam(req.ctx.perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    const b = req.body || {};
    const fileName = String(b.file_name || '').trim();
    const mime = String(b.mime_type || '').trim();
    const b64 = String(b.data_base64 || '');
    if (!fileName || !mime || !b64) return reply.code(400).send({ error: 'missing_fields' });
    if (!ALLOWED_DOC_MIME.includes(mime)) return reply.code(400).send({ error: 'unsupported_type', note: 'PDF·JPEG·PNG·WEBP만 업로드할 수 있습니다.' });
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch (e) { return reply.code(400).send({ error: 'bad_base64' }); }
    if (!buf.length) return reply.code(400).send({ error: 'empty_file' });
    if (buf.length > MAX_DOC_BYTES) return reply.code(400).send({ error: 'too_large', note: '파일은 5MB 이하만 가능합니다.' });
    const row = (await query(
      `INSERT INTO customer_documents (customer_id, doc_type, file_name, mime_type, byte_size, content, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [id, b.doc_type || null, fileName, mime, buf.length, buf, req.ctx.perm.userId])).rows[0];
    await safeLog({ userId: req.ctx.perm.userId, action: 'create', target: `customer_doc:${row.id}`, detail: { customer_id: id, file_name: fileName } });
    return { ok: true, id: row.id };
  });

  // 다운로드(본문) — 바이너리 반환
  app.get('/api/customers/:id/documents/:docId', { preHandler: [authGuard, requirePage('customers')] }, async (req, reply) => {
    const id = Number(req.params.id), docId = Number(req.params.docId);
    const c = (await query(`SELECT team_id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canViewTeam(req.ctx.perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    const d = (await query(`SELECT file_name, mime_type, content FROM customer_documents WHERE id=$1 AND customer_id=$2 AND deleted_at IS NULL`, [docId, id])).rows[0];
    if (!d) return reply.code(404).send({ error: 'not_found' });
    reply.header('Content-Type', d.mime_type);
    reply.header('Content-Disposition', `inline; filename="${encodeURIComponent(d.file_name)}"`);
    return reply.send(d.content);
  });

  // 삭제(soft)
  app.delete('/api/customers/:id/documents/:docId', { preHandler: [authGuard, requirePageEdit('customers')] }, async (req, reply) => {
    const id = Number(req.params.id), docId = Number(req.params.docId);
    const c = (await query(`SELECT team_id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canEditTeam(req.ctx.perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    const r = (await query(`UPDATE customer_documents SET deleted_at=now() WHERE id=$1 AND customer_id=$2 AND deleted_at IS NULL RETURNING id`, [docId, id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await safeLog({ userId: req.ctx.perm.userId, action: 'delete', target: `customer_doc:${docId}` });
    return { ok: true };
  });
}
