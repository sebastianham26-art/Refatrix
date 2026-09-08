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
//     4) 기록은 지우지 않는다. 상태만 바뀐다(new → claimed → done, 또는 dismissed).
import { query } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { getEndpoint } from '../integrations.js';
import { mapLead, missingLeadFields, readInboundKey, verifyInboundKey,
         scrubPayload, errBody } from '../crmInbound.js';
import { INBOUND_KEY } from './crmInboundRoutes.js';

export const LEAD_KEY = 'crm_web_lead';

async function safeLog(args) { try { await logEvent(args); } catch (_) { /* ignore */ } }

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
    claimed_by: r.claimed_by ? Number(r.claimed_by) : null,
    claimed_by_name: r.claimed_by_name || null, claimed_at: r.claimed_at,
    closed_by_name: r.closed_by_name || null, closed_at: r.closed_at,
    close_reason: r.close_reason || null,
    customer_id: r.customer_id ? Number(r.customer_id) : null,
    // 같은 RFC 로 이미 ERP 에 고객이 있는가 — 있으면 새로 만들 게 아니라 그 고객을 손봐야 한다.
    existing_code: r.existing_code || null,
    existing_name: r.existing_name || null,
  };
}

const SELECT_LEAD = `
  SELECT l.*, u.name AS claimed_by_name, cu.name AS closed_by_name,
         c.code AS existing_code, c.name AS existing_name
    FROM crm_web_leads l
    LEFT JOIN users u  ON u.id = l.claimed_by
    LEFT JOIN users cu ON cu.id = l.closed_by
    LEFT JOIN LATERAL (
      SELECT code, name FROM customers
       WHERE deleted_at IS NULL AND rfc_norm IS NOT NULL AND rfc_norm = l.rfc_norm
       ORDER BY id LIMIT 1) c ON true`;

export default async function crmLeadRoutes(app) {
  // ════════════════════════════════════════════════════════════════════
  //  ① 수신 (공개 — 자체 API 키)
  // ════════════════════════════════════════════════════════════════════
  app.post('/api/integrations/crm/customer-lead', async (req, reply) => {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const raw = req.body || {};
    const safe = scrubPayload(raw);           // 이력에 우리 키가 남지 않게
    const { token, where } = readInboundKey(req);

    const ep = await getEndpoint(LEAD_KEY);
    if (!ep) {
      return reply.code(503).send(errBody('ERR_INTERNAL',
        'Endpoint de avisos no configurado en el ERP (falta migración 0210).'));
    }
    // 키를 따로 발급하지 않았으면 **신규고객 등록 수신과 같은 키**를 받아 준다 —
    //   상대에게 창구마다 다른 키를 요구하면 연동이 늦어질 뿐 얻는 게 없다.
    let v = verifyInboundKey(ep, token);
    if (!v.ok && v.reason === 'no_key_configured') {
      const regEp = await getEndpoint(INBOUND_KEY);
      if (regEp) v = verifyInboundKey(regEp, token);
    }
    if (!v.ok) {
      return reply.code(401).send(errBody('ERR_API_KEY', v.reason === 'no_key_configured'
        ? 'El ERP aún no tiene una API key emitida para esta integración.'
        : 'API key faltante o inválida.'));
    }
    if (ep.enabled === false) {
      return reply.code(503).send(errBody('ERR_INTERNAL',
        'La recepción de avisos está deshabilitada temporalmente en el ERP.'));
    }
    if (!(await leadsReady())) {
      return reply.code(503).send(errBody('ERR_INTERNAL',
        'El ERP aún no aplicó la migración 0210. Reintentar más tarde.'));
    }

    const m = mapLead(raw);
    const miss = missingLeadFields(m);
    if (miss.length) {
      return reply.code(400).send(errBody('ERR_REQUIRED_FIELD',
        `Falta(n) campo(s) obligatorio(s): ${miss.join(', ')}.`));
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
          return reply.code(200).send(errBody('0',
            'Solicitud ya recibida anteriormente; datos actualizados.', { leadId: Number(dup.id) }));
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

      return reply.code(200).send(errBody('0',
        'Solicitud recibida, un asesor lo contactará.', { leadId: Number(row.id) }));
    } catch (e) {
      req.log?.error({ err: e }, 'crm web lead failed');
      return reply.code(500).send(errBody('ERR_INTERNAL', 'Error interno del ERP. Reintentar más tarde.'));
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  ② 팝업 알림 — 60초 폴링 (전 화면 공통 · refatrix-nav.js)
  // ════════════════════════════════════════════════════════════════════
  //   대상이 아닌 사람에게는 **빈 배열**을 준다(403 이 아니라). 화면마다 오류를 띄울 일이 아니다.
  app.get('/api/portal/web-lead-alert', { preHandler: [authGuard] }, async (req) => {
    const empty = { count: 0, items: [] };
    if (!(await leadsReady())) return empty;
    const perm = req.ctx.perm;
    try {
      if (perm.role !== 'director') {
        const t = (await query(
          `SELECT 1 FROM crm_lead_notify_targets WHERE user_id=$1`, [perm.userId])).rows[0];
        if (!t) return empty;
      }
      const rows = (await query(
        `${SELECT_LEAD} WHERE l.status IN ('new','claimed')
          ORDER BY l.received_at DESC LIMIT 30`)).rows;
      return { count: rows.length, items: rows.map(leadRow) };
    } catch (_) { return empty; }
  });

  // ════════════════════════════════════════════════════════════════════
  //  ③ 누적 이력 + 처리 (고객 화면의 「웹 가입 신청」 탭)
  // ════════════════════════════════════════════════════════════════════
  const canSee = { preHandler: [authGuard, requirePage('customers')] };

  app.get('/api/crm-leads', canSee, async (req, reply) => {
    if (!(await leadsReady())) {
      return reply.code(503).send({ error: 'migration_required',
        note: '0210_crm_web_leads 마이그레이션이 필요합니다.' });
    }
    const status = String(req.query?.status || 'open');
    const q = String(req.query?.q || '').trim();
    const limit = Math.min(300, Math.max(1, Number(req.query?.limit) || 100));
    const where = []; const params = [];
    if (status === 'open') where.push(`l.status IN ('new','claimed')`);
    else if (['new', 'claimed', 'done', 'dismissed'].includes(status)) {
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
    const summary = { new: 0, claimed: 0, done: 0, dismissed: 0 };
    for (const s of sum) if (s.status in summary) summary[s.status] = Number(s.n);
    return { migrated: true, summary, items: rows.map(leadRow) };
  });

  async function loadLead(id) {
    return (await query(`${SELECT_LEAD} WHERE l.id=$1`, [Number(id)])).rows[0] || null;
  }

  /** 「내가 맡겠습니다」 — 먼저 누른 사람이 담당이 된다. */
  app.post('/api/crm-leads/:id/claim', canSee, async (req, reply) => {
    if (!(await leadsReady())) return reply.code(503).send({ error: 'migration_required' });
    const id = Number(req.params.id);
    const perm = req.ctx.perm;
    // 이미 다른 사람이 잡았으면 뺏지 않는다 — 두 사람이 같은 고객에게 전화하는 걸 막는 게 목적이다.
    const r = (await query(
      `UPDATE crm_web_leads SET status='claimed', claimed_by=$1, claimed_at=now()
        WHERE id=$2 AND status='new' RETURNING id`, [perm.userId, id])).rows[0];
    if (!r) {
      const cur = await loadLead(id);
      if (!cur) return reply.code(404).send({ error: 'not_found' });
      if (String(cur.claimed_by) === String(perm.userId)) return { ok: true, already_mine: true, lead: leadRow(cur) };
      return reply.code(409).send({ error: 'already_claimed', note: (cur.claimed_by_name || '다른 사용자') + ' 님이 이미 맡았습니다.',
        lead: leadRow(cur) });
    }
    await safeLog({ userId: perm.userId, action: 'update', target: `web_lead:${id}`, detail: { op: 'claim' } });
    return { ok: true, lead: leadRow(await loadLead(id)) };
  });

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
        WHERE id=$3 AND status IN ('new','claimed') RETURNING id`,
      [reason.slice(0, 500), req.ctx.perm.userId, id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found_or_closed' });
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `web_lead:${id}`,
      detail: { op: 'dismiss', reason } });
    return { ok: true, lead: leadRow(await loadLead(id)) };
  });

  /** 「고객 등록 완료」 — 고객으로 옮겨졌음을 표시(고객 id 를 주면 연결한다). */
  app.post('/api/crm-leads/:id/done', canSee, async (req, reply) => {
    if (!(await leadsReady())) return reply.code(503).send({ error: 'migration_required' });
    const id = Number(req.params.id);
    const cid = req.body?.customer_id ? Number(req.body.customer_id) : null;
    const r = (await query(
      `UPDATE crm_web_leads SET status='done', customer_id=COALESCE($1, customer_id),
              closed_by=$2, closed_at=now()
        WHERE id=$3 AND status IN ('new','claimed') RETURNING id`,
      [cid, req.ctx.perm.userId, id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found_or_closed' });
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `web_lead:${id}`,
      detail: { op: 'done', customer_id: cid } });
    return { ok: true, lead: leadRow(await loadLead(id)) };
  });

  /** 되돌리기(디렉터) — 잘못 닫은 건을 다시 목록에 올린다. 기록은 남는다. */
  app.post('/api/crm-leads/:id/reopen', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    if (!(await leadsReady())) return reply.code(503).send({ error: 'migration_required' });
    const id = Number(req.params.id);
    const r = (await query(
      `UPDATE crm_web_leads SET status='new', claimed_by=NULL, claimed_at=NULL,
              closed_by=NULL, closed_at=NULL, close_reason=NULL
        WHERE id=$1 RETURNING id`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `web_lead:${id}`, detail: { op: 'reopen' } });
    return { ok: true, lead: leadRow(await loadLead(id)) };
  });

  // ════════════════════════════════════════════════════════════════════
  //  ④ 알림 대상 설정 (디렉터 전용 — 연동 관리 화면)
  // ════════════════════════════════════════════════════════════════════
  const dirOnly = { preHandler: [authGuard, requireDirector] };

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
