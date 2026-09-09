// 웹 카달록 회원가입 신청(리드) — 수신 · 팝업 알림 · 누적 이력 (0210)
//
//   고객이 홈페이지에서 회원가입을 누르면 CRM 이 이 주소로 즉시 알린다.
//   ERP 는 상시 켜져 있으므로 팝업으로 사람에게 들이밀고, 영업사원이 전화해서
//   상업정보를 파악한 뒤 고객으로 등록한다. 그 전까지 고객은 가격·재고를 못 본다 —
//   **아무도 모른 채 며칠 지나는 것**이 이 기능이 막으려는 손실이다.
//
//   설계에서 한 판단
//     1) 리드는 **고객이 아니다.** customers 에 행을 만들지 않는다. 상업정보가 하나도 없는
//        고객이 승인 대기함에 쌓이면 그 함이 쓸모없어진다.
//     2) 고객이 입력한 **모든 값**을 원문으로 박제한다. 우리가 모르는 필드를 CRM 이 더해도
//        잃어버리지 않고 팝업에 그대로 보여 준다.
//     3) 알림 대상은 **사람 단위**로 디렉터가 고른다. 디렉터는 설정과 무관하게 항상 받는다
//        (설정을 비워 두면 아무도 못 받는 상태가 되는데, 그건 이 기능이 없는 것과 같다).
//     4) 기록은 지우지 않는다. 상태만 바뀐다(new → assigned → registered → done, 또는 dismissed).
//     5) **담당은 디렉터가 지정한다**(0211). 「먼저 잡는 사람」 방식은 없앴다 —
//        누가 어떤 고객을 맡을지는 디렉터가 정할 일이고, 지정받은 사람은 승인이 날 때까지
//        팝업으로 계속 상기받는다. 등록만 하고 승인을 안 챙기면 고객은 여전히 가격을 못 본다.
import { query } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { getEndpoint, INBOUND_KEY_FALLBACK } from '../integrations.js';
import { writeInboundLog } from '../crmInboundLog.js';
import { mapLead, missingLeadFields, readInboundKey, verifyInboundKey,
         scrubPayload, errBody } from '../crmInbound.js';

export const LEAD_KEY = 'crm_web_lead';

async function safeLog(args) { try { await logEvent(args); } catch (_) { /* ignore */ } }

// 수신 이력 — **이 창구의 기록임을 명시**한다. 연동 관리의 「수신 이력」은 창구별로 갈린다.
//   crm_web_leads 에는 접수된 리드만 남는다(거절은 안 남는다). 401·400 처럼 문 앞에서
//   막힌 건까지 보이려면 이 공용 기록이 필요하다 — 상대와 갈릴 때 근거가 되는 게 이것뿐이다.
async function writeLog(rec) { return writeInboundLog({ endpoint_key: LEAD_KEY, ...rec }); }

// 0210 준비 여부 — 긍정만 영구 캐시, 없을 때만 30초마다 재확인
//   (Railway 는 배포 뒤 사람이 콘솔에서 migrate 를 돌린다. 재시작 없이 인식돼야 한다)
let ready = false; let probe = 0;
async function leadsReady() {
  if (ready) return true;
  if (Date.now() - probe < 30000) return false;
  probe = Date.now();
  try {
    const r = await query(`SELECT to_regclass('public.crm_web_leads') AS t`);
    ready = !!(r.rows[0] && r.rows[0].t);
  } catch (_) { ready = false; }
  return ready;
}

const S = (v) => { const s = v == null ? '' : String(v).trim(); return s || null; };

function leadRow(r) {
  return {
    id: Number(r.id),
    crm_lead_code: r.crm_lead_code || null,
    empresa: r.empresa || null, nombre: r.nombre || null, apellido: r.apellido || null,
    telefono: r.telefono || null, correo: r.correo || null, rfc: r.rfc || null,
    ciudad: r.ciudad || null, estado: r.estado || null, direccion: r.direccion || null,
    mensaje: r.mensaje || null,
    payload: r.payload || {},
    status: r.status, received_at: r.received_at,
    assigned_to: r.assigned_to ? Number(r.assigned_to) : null,
    assigned_to_name: r.assigned_to_name || null, assigned_at: r.assigned_at,
    assigned_by_name: r.assigned_by_name || null,
    registered_at: r.registered_at || null,
    closed_by_name: r.closed_by_name || null, closed_at: r.closed_at,
    close_reason: r.close_reason || null,
    customer_id: r.customer_id ? Number(r.customer_id) : null,
    // 등록된 고객의 승인 상태 — 「등록됨」과 「완결」은 다른 상태다.
    //   담당자 팝업은 **승인까지** 떠 있어야 한다. 등록에서 끝내면 승인은 아무도 안 챙긴다.
    customer_code: r.customer_code || null,
    customer_approval: r.customer_approval || null,
    // 같은 RFC 로 이미 ERP 에 고객이 있는가 — 있으면 새로 만들 게 아니라 그 고객을 손봐야 한다.
    existing_code: r.existing_code || null,
    existing_name: r.existing_name || null,
  };
}

const SELECT_LEAD = `
  SELECT l.*, u.name AS assigned_to_name, ab.name AS assigned_by_name, cu.name AS closed_by_name,
         c.code AS existing_code, c.name AS existing_name,
         lc.code AS customer_code,
         COALESCE(lc.approval_status,'approved') AS customer_approval
    FROM crm_web_leads l
    LEFT JOIN users u  ON u.id = l.assigned_to
    LEFT JOIN users ab ON ab.id = l.assigned_by
    LEFT JOIN users cu ON cu.id = l.closed_by
    LEFT JOIN customers lc ON lc.id = l.customer_id AND lc.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT code, name FROM customers
       WHERE deleted_at IS NULL AND rfc_norm IS NOT NULL AND rfc_norm = l.rfc_norm
       ORDER BY id LIMIT 1) c ON true`;

// 팝업에 뜨는 건 = 아직 안 끝난 건.
//   ⚠ 상태만 믿지 않고 **등록된 고객의 승인 상태도 본다.** 승인 훅이 어떤 이유로 못 돌아도
//     승인된 건이 계속 팝업에 남지 않게 하는 안전장치다(반대로 상태가 done 인데 승인이
//     취소된 경우도 여기서 걸린다).
const OPEN_WHERE = `l.status IN ('new','assigned','registered')
  AND NOT (l.customer_id IS NOT NULL AND COALESCE(lc.approval_status,'approved')='approved')`;

/** 담당으로 지정할 수 있는 사람 — 고객에게 전화하고 등록까지 할 수 있는 역할만. */
async function assignableUsers() {
  try {
    return (await query(
      `SELECT id, name, role FROM users
        WHERE deleted_at IS NULL AND role IN ('sales','ops','marketing','director')
        ORDER BY (role='sales') DESC, name`)).rows
      .map((u) => ({ id: Number(u.id), name: u.name, role: u.role }));
  } catch (_) { return []; }
}

export default async function crmLeadRoutes(app) {
  // ════════════════════════════════════════════════════════════════════
  //  ① 수신 (공개 — 자체 API 키)
  // ════════════════════════════════════════════════════════════════════
  app.post('/api/integrations/crm/customer-lead', async (req, reply) => {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const raw = req.body || {};
    const safe = scrubPayload(raw);           // 이력에 우리 키가 남지 않게
    const { token, where } = readInboundKey(req);

    const base = { remote_ip: ip, auth_in: where, payload: safe };

    const ep = await getEndpoint(LEAD_KEY);
    if (!ep) {
      const body = errBody('ERR_INTERNAL', 'Endpoint de avisos no configurado en el ERP (falta migración 0210).');
      await writeLog({ ...base, auth_ok: false, http_status: 503, result: 'rejected',
        codigo_error: body.codigoError, mensaje: body.mensaje });
      return reply.code(503).send(body);
    }
    // 키를 따로 발급하지 않았으면 **신규고객 등록 수신과 같은 키**를 받아 준다 —
    //   상대에게 창구마다 다른 키를 요구하면 연동이 늦어질 뿐 얻는 게 없다.
    let v = verifyInboundKey(ep, token);
    if (!v.ok && v.reason === 'no_key_configured') {
      const fb = INBOUND_KEY_FALLBACK[LEAD_KEY];
      const regEp = fb ? await getEndpoint(fb) : null;
      if (regEp) v = verifyInboundKey(regEp, token);
    }
    if (!v.ok) {
      const body = errBody('ERR_API_KEY', v.reason === 'no_key_configured'
        ? 'El ERP aún no tiene una API key emitida para esta integración.'
        : 'API key faltante o inválida.');
      await writeLog({ ...base, auth_ok: false, http_status: 401, result: 'rejected',
        codigo_error: body.codigoError, mensaje: body.mensaje });
      return reply.code(401).send(body);
    }
    if (ep.enabled === false) {
      const body = errBody('ERR_INTERNAL', 'La recepción de avisos está deshabilitada temporalmente en el ERP.');
      await writeLog({ ...base, auth_ok: true, http_status: 503, result: 'rejected',
        codigo_error: body.codigoError, mensaje: body.mensaje });
      return reply.code(503).send(body);
    }
    if (!(await leadsReady())) {
      const body = errBody('ERR_INTERNAL', 'El ERP aún no aplicó la migración 0210. Reintentar más tarde.');
      await writeLog({ ...base, auth_ok: true, http_status: 503, result: 'rejected',
        codigo_error: body.codigoError, mensaje: body.mensaje });
      return reply.code(503).send(body);
    }

    const m = mapLead(raw);
    const logBase = { ...base, auth_ok: true, rfc: m.rfc || null, crm_code: m.crmLeadCode || null };
    const miss = missingLeadFields(m);
    if (miss.length) {
      const body = errBody('ERR_REQUIRED_FIELD', `Falta(n) campo(s) obligatorio(s): ${miss.join(', ')}.`);
      await writeLog({ ...logBase, http_status: 400, result: 'rejected',
        codigo_error: body.codigoError, mensaje: body.mensaje });
      return reply.code(400).send(body);
    }

    try {
      // 멱등 — 같은 CRM 코드로 다시 오면 새 알림을 만들지 않고 내용만 갱신한다.
      //   (상대가 재시도하거나 고객이 폼을 두 번 눌러도 팝업이 두 번 뜨면 안 된다)
      if (m.crmLeadCode) {
        const dup = (await query(
          `SELECT id, status FROM crm_web_leads WHERE crm_lead_code=$1`, [m.crmLeadCode])).rows[0];
        if (dup) {
          await query(
            `UPDATE crm_web_leads
                SET empresa=$1, nombre=$2, apellido=$3, telefono=$4, correo=$5, rfc=$6,
                    ciudad=$7, estado=$8, direccion=$9, mensaje=$10, payload=$11::jsonb
              WHERE id=$12`,
            [m.empresa, m.nombre, m.apellido, m.telefono, m.correo, m.rfc,
             m.ciudad, m.estado, m.direccion, m.mensaje, JSON.stringify(safe), dup.id]);
          const body = errBody('0', 'Solicitud ya recibida anteriormente; datos actualizados.',
            { leadId: Number(dup.id) });
          await writeLog({ ...logBase, http_status: 200, result: 'updated',
            erp_code: 'LEAD-' + dup.id, codigo_error: '0', mensaje: body.mensaje });
          return reply.code(200).send(body);
        }
      }

      const row = (await query(
        `INSERT INTO crm_web_leads
           (crm_lead_code, empresa, nombre, apellido, telefono, correo, rfc,
            ciudad, estado, direccion, mensaje, payload, remote_ip, auth_in)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)
         RETURNING id`,
        [m.crmLeadCode, m.empresa, m.nombre, m.apellido, m.telefono, m.correo, m.rfc,
         m.ciudad, m.estado, m.direccion, m.mensaje, JSON.stringify(safe), ip || null, where])).rows[0];

      await safeLog({ userId: null, action: 'create', target: `web_lead:${row.id}`,
        detail: { origin: 'crm_web_lead', rfc: m.rfc, empresa: m.empresa } });

      const body = errBody('0', 'Solicitud recibida, un asesor lo contactará.', { leadId: Number(row.id) });
      await writeLog({ ...logBase, http_status: 200, result: 'created',
        erp_code: 'LEAD-' + row.id, codigo_error: '0', mensaje: body.mensaje });
      return reply.code(200).send(body);
    } catch (e) {
      req.log?.error({ err: e }, 'crm web lead failed');
      const body = errBody('ERR_INTERNAL', 'Error interno del ERP. Reintentar más tarde.');
      await writeLog({ ...logBase, http_status: 500, result: 'rejected',
        codigo_error: body.codigoError, mensaje: String(e.message || '').slice(0, 400) });
      return reply.code(500).send(body);
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  ② 팝업 알림 — 60초 폴링 (전 화면 공통 · refatrix-nav.js)
  // ════════════════════════════════════════════════════════════════════
  //   대상이 아닌 사람에게는 **빈 배열**을 준다(403 이 아니라). 화면마다 오류를 띄울 일이 아니다.
  app.get('/api/portal/web-lead-alert', { preHandler: [authGuard] }, async (req) => {
    const empty = { count: 0, items: [], can_assign: false, assignees: [] };
    if (!(await leadsReady())) return empty;
    const perm = req.ctx.perm;
    try {
      const isDir = perm.role === 'director';
      let where;
      const params = [];
      if (isDir) {
        // 디렉터는 **전부** 본다 — 지정하는 사람이 못 보면 아무 일도 시작되지 않는다.
        where = OPEN_WHERE;
      } else {
        // 직원은 ① 자기에게 지정된 건과 ② (알림 대상으로 뽑혔다면) 아직 아무에게도 안 간 신규 건.
        //   남에게 지정된 건은 보이지 않는다 — 두 사람이 같은 고객에게 전화하는 걸 막는 게 목적이다.
        const target = (await query(
          `SELECT 1 FROM crm_lead_notify_targets WHERE user_id=$1`, [perm.userId])).rows[0];
        params.push(perm.userId);
        where = target
          ? `${OPEN_WHERE} AND (l.assigned_to=$1 OR l.assigned_to IS NULL)`
          : `${OPEN_WHERE} AND l.assigned_to=$1`;
      }
      const rows = (await query(
        `${SELECT_LEAD} WHERE ${where} ORDER BY l.received_at DESC LIMIT 30`, params)).rows;
      let assignees = [];
      if (isDir) assignees = await assignableUsers();
      return { count: rows.length, items: rows.map(leadRow), can_assign: isDir, assignees };
    } catch (_) { return empty; }
  });

  // ════════════════════════════════════════════════════════════════════
  //  ③ 누적 이력 + 처리 (고객 화면의 「웹 가입 신청」 탭)
  // ════════════════════════════════════════════════════════════════════
  const canSee = { preHandler: [authGuard, requirePage('customers')] };
  const dirOnly = { preHandler: [authGuard, requireDirector] };

  app.get('/api/crm-leads', canSee, async (req, reply) => {
    if (!(await leadsReady())) {
      return reply.code(503).send({ error: 'migration_required',
        note: '0210_crm_web_leads 마이그레이션이 필요합니다.' });
    }
    const status = String(req.query?.status || 'open');
    const q = String(req.query?.q || '').trim();
    const limit = Math.min(300, Math.max(1, Number(req.query?.limit) || 100));
    const where = []; const params = [];
    if (status === 'open') where.push(OPEN_WHERE);                    // 아직 안 끝난 건
    else if (status === 'unassigned') where.push(`${OPEN_WHERE} AND l.assigned_to IS NULL`);
    else if (['new', 'assigned', 'registered', 'done', 'dismissed'].includes(status)) {
      params.push(status); where.push(`l.status=$${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(l.empresa ILIKE $${params.length} OR l.nombre ILIKE $${params.length}
                   OR l.correo ILIKE $${params.length} OR l.rfc ILIKE $${params.length}
                   OR l.telefono ILIKE $${params.length} OR l.crm_lead_code ILIKE $${params.length})`);
    }
    params.push(limit);
    const rows = (await query(
      `${SELECT_LEAD} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY l.received_at DESC LIMIT $${params.length}`, params)).rows;
    const sum = (await query(`SELECT status, count(*)::int AS n FROM crm_web_leads GROUP BY 1`)).rows;
    const summary = { new: 0, assigned: 0, registered: 0, done: 0, dismissed: 0 };
    for (const s of sum) if (s.status in summary) summary[s.status] = Number(s.n);
    return { migrated: true, summary, items: rows.map(leadRow) };
  });

  async function loadLead(id) {
    return (await query(`${SELECT_LEAD} WHERE l.id=$1`, [Number(id)])).rows[0] || null;
  }

  /** 담당자 지정 — **디렉터만.** 지정받은 사람 화면에 그 건이 팝업으로 뜨기 시작한다. */
  app.post('/api/crm-leads/:id/assign', dirOnly, async (req, reply) => {
    if (!(await leadsReady())) return reply.code(503).send({ error: 'migration_required' });
    const id = Number(req.params.id);
    const uid = Number(req.body?.user_id || 0);
    if (!uid) {
      return reply.code(400).send({ error: 'user_required', note: '담당할 직원을 고르세요.' });
    }
    const u = (await query(
      `SELECT id, name FROM users WHERE id=$1 AND deleted_at IS NULL`, [uid])).rows[0];
    if (!u) return reply.code(404).send({ error: 'user_not_found' });
    // 이미 고객 등록까지 간 건의 담당을 바꿔도 상태는 되돌리지 않는다 — 진행을 되감으면 안 된다.
    const r = (await query(
      `UPDATE crm_web_leads
          SET assigned_to=$1, assigned_by=$2, assigned_at=now(),
              status = CASE WHEN status='new' THEN 'assigned' ELSE status END
        WHERE id=$3 AND status IN ('new','assigned','registered') RETURNING id`,
      [uid, req.ctx.perm.userId, id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found_or_closed' });
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `web_lead:${id}`,
      detail: { op: 'assign', to: uid } });
    return { ok: true, assigned_to_name: u.name, lead: leadRow(await loadLead(id)) };
  });

  /** 담당 해제 — 다시 미배정으로. 지정을 잘못했을 때. */
  app.post('/api/crm-leads/:id/unassign', dirOnly, async (req, reply) => {
    if (!(await leadsReady())) return reply.code(503).send({ error: 'migration_required' });
    const id = Number(req.params.id);
    const r = (await query(
      `UPDATE crm_web_leads SET assigned_to=NULL, assigned_by=NULL, assigned_at=NULL,
              status = CASE WHEN status='assigned' THEN 'new' ELSE status END
        WHERE id=$1 AND status IN ('new','assigned') RETURNING id`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found_or_closed' });
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `web_lead:${id}`, detail: { op: 'unassign' } });
    return { ok: true, lead: leadRow(await loadLead(id)) };
  });

  /** 지정 가능한 직원 목록(디렉터 화면의 드롭다운). */
  app.get('/api/crm-leads/assignees', dirOnly, async () => ({ items: await assignableUsers() }));

  /** 「보류 · 대상 아님」 — 기록은 남기고 목록에서 닫는다. */
  app.post('/api/crm-leads/:id/dismiss', canSee, async (req, reply) => {
    if (!(await leadsReady())) return reply.code(503).send({ error: 'migration_required' });
    const id = Number(req.params.id);
    const reason = S(req.body?.reason);
    if (!reason) {
      return reply.code(400).send({ error: 'reason_required',
        note: '왜 대상이 아닌지 한 줄 적어 주세요 — 나중에 같은 고객이 다시 왔을 때 판단 근거가 됩니다.' });
    }
    const r = (await query(
      `UPDATE crm_web_leads SET status='dismissed', close_reason=$1, closed_by=$2, closed_at=now()
        WHERE id=$3 AND status IN ('new','assigned','registered') RETURNING id`,
      [reason.slice(0, 500), req.ctx.perm.userId, id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found_or_closed' });
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `web_lead:${id}`,
      detail: { op: 'dismiss', reason } });
    return { ok: true, lead: leadRow(await loadLead(id)) };
  });

  /** 「이미 등록했음」 — 이 경로를 안 타고 따로 등록했을 때의 예외 처리.
   *   ⚠ 여기서 끝내지 않는다. **디렉터 승인이 나야 완결(done)** 이다 —
   *     등록에서 끊으면 담당자는 손을 떼고 승인은 아무도 안 챙긴다. 그동안 고객은 가격을 못 본다. */
  app.post('/api/crm-leads/:id/registered', canSee, async (req, reply) => {
    if (!(await leadsReady())) return reply.code(503).send({ error: 'migration_required' });
    const id = Number(req.params.id);
    const cid = req.body?.customer_id ? Number(req.body.customer_id) : null;
    const r = (await query(
      `UPDATE crm_web_leads SET status='registered', customer_id=COALESCE($1, customer_id),
              registered_at=now()
        WHERE id=$2 AND status IN ('new','assigned') RETURNING id`, [cid, id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found_or_closed' });
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `web_lead:${id}`,
      detail: { op: 'registered', customer_id: cid } });
    return { ok: true, lead: leadRow(await loadLead(id)) };
  });

  /** 되돌리기(디렉터) — 잘못 닫은 건을 다시 목록에 올린다. 기록은 남는다. */
  app.post('/api/crm-leads/:id/reopen', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    if (!(await leadsReady())) return reply.code(503).send({ error: 'migration_required' });
    const id = Number(req.params.id);
    const r = (await query(
      `UPDATE crm_web_leads SET status='new', assigned_to=NULL, assigned_by=NULL, assigned_at=NULL,
              closed_by=NULL, closed_at=NULL, close_reason=NULL
        WHERE id=$1 RETURNING id`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `web_lead:${id}`, detail: { op: 'reopen' } });
    return { ok: true, lead: leadRow(await loadLead(id)) };
  });

  // ════════════════════════════════════════════════════════════════════
  //  ④ 알림 대상 설정 (디렉터 전용 — 연동 관리 화면)
  // ════════════════════════════════════════════════════════════════════
  app.get('/api/crm-leads/notify-targets', dirOnly, async () => {
    const users = (await query(
      `SELECT id, name, role, login_id FROM users
        WHERE deleted_at IS NULL AND role <> 'viewer'
        ORDER BY (role='director') DESC, name`)).rows;
    let picked = [];
    if (await leadsReady()) {
      try { picked = (await query(`SELECT user_id FROM crm_lead_notify_targets`)).rows.map((r) => Number(r.user_id)); }
      catch (_) { picked = []; }
    }
    return {
      migrated: await leadsReady(),
      // 디렉터는 설정과 무관하게 항상 받는다 — 화면에서 그 사실을 보여 주기 위해 표시해 둔다.
      items: users.map((u) => ({ id: Number(u.id), name: u.name, role: u.role, login_id: u.login_id || null,
        selected: picked.includes(Number(u.id)), always: u.role === 'director' })),
    };
  });

  app.put('/api/crm-leads/notify-targets', dirOnly, async (req, reply) => {
    if (!(await leadsReady())) {
      return reply.code(503).send({ error: 'migration_required',
        note: '0210_crm_web_leads 마이그레이션이 필요합니다.' });
    }
    const ids = Array.isArray(req.body?.user_ids)
      ? [...new Set(req.body.user_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0))] : [];
    // 존재하는 사용자만 남긴다(삭제된 사용자를 넣어 두면 조용히 아무도 못 받는다).
    const valid = ids.length
      ? (await query(`SELECT id FROM users WHERE deleted_at IS NULL AND id = ANY($1::bigint[])`, [ids]))
        .rows.map((r) => Number(r.id))
      : [];
    await query(`DELETE FROM crm_lead_notify_targets`);
    for (const uid of valid) {
      await query(`INSERT INTO crm_lead_notify_targets (user_id, added_by) VALUES ($1,$2)
                   ON CONFLICT (user_id) DO NOTHING`, [uid, req.ctx.perm.userId]);
    }
    await safeLog({ userId: req.ctx.perm.userId, action: 'permission_change', target: 'crm_lead_notify',
      detail: { user_ids: valid } });
    return { ok: true, count: valid.length,
      note: valid.length ? null : '아무도 선택하지 않았습니다 — 디렉터에게만 팝업이 뜹니다.' };
  });
}
