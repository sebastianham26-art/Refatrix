// CRM → ERP 수신 (0208)
//
//   웹카달록에서 고객이 스스로 등록하면 CRM 이 이 주소로 쏜다. 우리는 그걸 받아
//   **승인 대기 고객**으로 만든다(코드 P-####). 최종 판단은 언제나 ERP 의 디렉터가 한다.
//
//   설계 원칙
//     1) 읽기는 관대하게, 저장은 엄격하게. 필드 이름이 계약서와 달라도 알아본다
//        (첫 호출부터 crmCustomerCode 가 아니라 customerCode 로 왔다).
//     2) 필수는 5개(rfc·nombre·apellido·telefono·correo)뿐. 나머지가 없다고 막지 않는다 —
//        막으면 고객이 카달록에서 등록을 못 끝내고, 그 손해가 훨씬 크다.
//     3) 멱등. 같은 RFC 를 두 번 보내도 고객이 둘이 되지 않는다(있으면 갱신하고 기존 코드를 준다).
//     4) 무슨 일이 있어도 500 을 조용히 내지 않는다 — 수신 1건마다 crm_inbound_log 에
//        원문·판정·응답을 남긴다. 상대와 싸울 때 근거가 되는 건 이 기록뿐이다.
import crypto from 'node:crypto';
import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { getEndpoint, invalidateEndpointCache, envTokenColsReady } from '../integrations.js';
import { writeInboundLog, inboundLogReady } from '../crmInboundLog.js';
import { mapInbound, missingRequired, readInboundKey, verifyInboundKey, scrubPayload,
         errBody } from '../crmInbound.js';
import { validateRfcOptional, normalizeClaimKey, computeBaselineDiscount,
         MAX_DISCOUNT_PCT } from '../customerClaim.js';
import { computeNextCode } from '../customerCode.js';

export const INBOUND_KEY = 'crm_customer_registration';
const SYD_BASE_CODE = String(process.env.SYD_BASE_CODE || '1516049').trim();

const ESTATUS = { pending: 'pendiente', approved: 'aprobado', rejected: 'rechazado' };

// 상대(CRM)가 읽는 건 스페인어 mensaje 뿐이다 — 사유를 구체적으로 준다.
const RFC_ES = {
  rfc_invalid: 'El RFC no cumple el formato: persona moral 12 caracteres (3 letras + AAMMDD + 3) o física 13 (4 letras + AAMMDD + 3).',
  rfc_invalid_date: 'Los 6 dígitos centrales del RFC (AAMMDD) no forman una fecha válida.',
  rfc_generic: 'No se acepta un RFC genérico (XAXX010101000 · XEXX010101000): se requiere el RFC propio del cliente.',
  rfc_required: 'El RFC es obligatorio.',
};

async function safeLog(args) { try { await logEvent(args); } catch (_) { /* ignore */ } }

// 0206(crm_customer_code·crm_registered_at) 준비 여부 — 없어도 수신은 되어야 한다.
let crmCols = false; let crmColsProbe = 0;
async function crmOriginColsReady() {
  if (crmCols) return true;
  if (Date.now() - crmColsProbe < 30000) return false;
  crmColsProbe = Date.now();
  try {
    const r = await query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='customers' AND column_name='crm_customer_code' LIMIT 1`);
    crmCols = r.rows.length > 0;
  } catch (_) { crmCols = false; }
  return crmCols;
}

// 이 창구의 기록임을 매번 명시한다 — 창구가 나뉘어 있으면 기록도 나뉘어야 한다.
async function writeLog(rec) { return writeInboundLog({ endpoint_key: INBOUND_KEY, ...rec }); }

/** 담당 영업 찾기 — CRM 의 vendedorCorreo 를 ERP login_id·이름과 대조한다. */
async function findAsesor(m) {
  const mail = String(m.vendedorCorreo || '').trim();
  if (mail) {
    const local = mail.split('@')[0];
    const u = (await query(
      `SELECT id, name, team_id FROM users
        WHERE deleted_at IS NULL AND role IN ('sales','ops','director','marketing')
          AND (lower(login_id)=lower($1) OR lower(login_id)=lower($2))
        ORDER BY id LIMIT 1`, [mail, local])).rows[0];
    if (u) return { ...u, matched_by: 'correo' };
  }
  const nom = String(m.vendedorNombre || '').trim();
  if (nom) {
    const u = (await query(
      `SELECT id, name, team_id FROM users
        WHERE deleted_at IS NULL AND role IN ('sales','ops','director','marketing')
          AND lower(name)=lower($1) ORDER BY id LIMIT 1`, [nom])).rows[0];
    if (u) return { ...u, matched_by: 'nombre' };
  }
  return null;
}

/** 기준품목 단가가 왔으면 할인 제안 근거를 만들어 둔다(안 와도 등록은 진행). */
async function baselineFrom(m) {
  const buy = m.sydRefBuyPrice;
  if (buy == null || !Number.isFinite(buy) || buy <= 0) return null;
  const baseCode = String(m.sydRefCode || SYD_BASE_CODE).trim();
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
  const calc = computeBaselineDiscount({ buy_price: buy, syd_list_price: sydLP, ctr_list_price: ctrLP });
  return { baseCode, buy, sydLP, ctrLP, ctrCode: base?.code || null, calc };
}

export default async function crmInboundRoutes(app) {
  // ════════════════════════════════════════════════════════════════════
  //  수신 엔드포인트 (공개 — 자체 API 키로 인증한다)
  // ════════════════════════════════════════════════════════════════════
  app.post('/api/integrations/crm/customer-registration', async (req, reply) => {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const raw = req.body || {};
    const safe = scrubPayload(raw);        // 이력에는 키를 지운 본문만 남긴다
    const { token, where } = readInboundKey(req);

    // ── ① 인증 ────────────────────────────────────────────────────────
    const ep = await getEndpoint(INBOUND_KEY);
    if (!ep) {
      const body = errBody('ERR_INTERNAL', 'Endpoint de recepción no configurado en el ERP (falta migración 0208).');
      await writeLog({ remote_ip: ip, auth_in: where, auth_ok: false, http_status: 503,
        codigo_error: body.codigoError, mensaje: body.mensaje, payload: safe, result: 'rejected' });
      return reply.code(503).send(body);
    }
    const v = verifyInboundKey(ep, token);
    if (!v.ok) {
      const body = errBody('ERR_API_KEY', v.reason === 'no_key_configured'
        ? 'El ERP aún no tiene una API key emitida para esta integración.'
        : 'API key faltante o inválida.');
      await writeLog({ remote_ip: ip, auth_in: where, auth_ok: false, http_status: 401,
        rfc: String(raw.rfc || raw.RFC || '') || null,
        codigo_error: body.codigoError, mensaje: body.mensaje, payload: safe, result: 'rejected' });
      return reply.code(401).send(body);
    }
    if (ep.enabled === false) {
      const body = errBody('ERR_INTERNAL', 'La recepción de altas está deshabilitada temporalmente en el ERP.');
      await writeLog({ remote_ip: ip, auth_in: where, auth_ok: true, http_status: 503,
        codigo_error: body.codigoError, mensaje: body.mensaje, payload: safe, result: 'rejected' });
      return reply.code(503).send(body);
    }

    // ── ② 읽기 + 필수 검사 ────────────────────────────────────────────
    const m = mapInbound(raw);
    const base = { remote_ip: ip, auth_in: where, auth_ok: true, payload: safe,
      rfc: m.rfc || null, crm_code: m.crmCode || null };

    const miss = missingRequired(m);
    if (miss.length) {
      const body = errBody('ERR_REQUIRED_FIELD', `Falta(n) campo(s) obligatorio(s): ${miss.join(', ')}.`);
      await writeLog({ ...base, http_status: 400, result: 'rejected',
        codigo_error: body.codigoError, mensaje: body.mensaje });
      return reply.code(400).send(body);
    }

    const rfcChk = validateRfcOptional(m.rfc);
    if (!rfcChk.ok || !rfcChk.value) {
      const body = errBody('ERR_RFC_INVALID', RFC_ES[rfcChk.error] || RFC_ES.rfc_invalid);
      await writeLog({ ...base, http_status: 400, result: 'rejected',
        codigo_error: body.codigoError, mensaje: body.mensaje });
      return reply.code(400).send(body);
    }
    const rfc = rfcChk.value;
    const rfcNorm = normalizeClaimKey(rfc);

    try {
      // ── ③ 이미 있는 RFC 인가 (멱등) ────────────────────────────────
      //   같은 고객을 두 번 만들지 않는다. 있으면 **비어 있는 연락처만** 채운다 —
      //   디렉터가 손본 값을 카달록 입력으로 덮어쓰면 안 된다.
      const crmCols = await crmOriginColsReady();
      const exist = (await query(
        `SELECT id, code, name, contact, phone, ship_address,
                ${crmCols ? 'crm_customer_code' : 'NULL::text AS crm_customer_code'},
                COALESCE(approval_status,'approved') AS approval_status
           FROM customers
          WHERE deleted_at IS NULL AND rfc_norm = $1
            AND COALESCE(approval_status,'approved') <> 'rejected'
          ORDER BY id LIMIT 1`, [rfcNorm])).rows[0];

      if (exist) {
        const sets = []; const params = [];
        const setIfEmpty = (col, val) => {
          if (val == null || String(val).trim() === '') return;
          if (exist[col] != null && String(exist[col]).trim() !== '') return;
          params.push(String(val).trim()); sets.push(`${col}=$${params.length}`);
        };
        setIfEmpty('contact', m.correo);
        setIfEmpty('phone', m.telefono);
        setIfEmpty('ship_address', [m.direccion, m.ciudad, m.estado].filter(Boolean).join(', '));
        if (crmCols) setIfEmpty('crm_customer_code', m.crmCode);
        if (sets.length) {
          params.push(exist.id);
          try { await query(`UPDATE customers SET ${sets.join(', ')} WHERE id=$${params.length}`, params); }
          catch (_) { /* crm_customer_code 컬럼이 아직 없을 수 있다(0206 미적용) */ }
        }
        const body = errBody('0', 'Cliente ya existía en el ERP, datos de contacto actualizados.', {
          erpCustomerCode: exist.code,
          estatus: ESTATUS[exist.approval_status] || 'aprobado',
        });
        await writeLog({ ...base, customer_id: Number(exist.id), erp_code: exist.code,
          result: 'updated', http_status: 200, codigo_error: '0', mensaje: body.mensaje });
        return reply.code(200).send(body);
      }

      // ── ④ 신규 — P-#### 로 채번해 승인 대기함에 넣는다 ──────────────
      const asesor = await findAsesor(m);
      const bl = await baselineFrom(m);
      const disc = (m.discountPercent != null && Number.isFinite(m.discountPercent)
        && m.discountPercent >= 0 && m.discountPercent <= MAX_DISCOUNT_PCT) ? m.discountPercent : 0;
      const days = (m.paymentDays != null && Number.isFinite(m.paymentDays) && m.paymentDays >= 0)
        ? Math.round(m.paymentDays) : 0;
      const nombre = [m.nombre, m.apellido].filter(Boolean).join(' ').trim();
      const addr = [m.direccion, m.ciudad, m.estado].filter(Boolean).join(', ') || null;

      let row = null; let dupRace = false;
      let conNo = m.constanciaNo || null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = await computeNextCode('P');
        try {
          row = (await query(
            `INSERT INTO customers
               (code, name, rfc, contact, phone, discount, credit_days, team_id, owner_id,
                customer_type, memo, ship_address, constancia_no,
                syd_ref_code, syd_ref_buy_price, syd_ref_list_price, syd_ref_discount,
                ctr_ref_code, ctr_ref_list_price, suggested_discount,
                approval_status, submitted_at, rfc_claimed_at
                ${crmCols ? ', crm_customer_code, crm_registered_at' : ''})
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
                     $10,$11,$12,$13,
                     $14,$15,$16,$17,
                     $18,$19,$20,
                     'pending', now(), now()
                     ${crmCols ? ', $21, now()' : ''})
             RETURNING id, code`,
            [code, nombre, rfc, m.correo || null, m.telefono || null, disc, days,
             asesor?.team_id || null, asesor?.id || null,
             m.tipo || null,
             ['CRM 웹카달록 등록', m.nombreComercial ? `상호명: ${m.nombreComercial}` : null,
              m.crmCode ? `CRM 코드: ${m.crmCode}` : null, m.memo].filter(Boolean).join(' · '),
             addr, conNo,
             bl?.baseCode || null, bl?.buy ?? null, bl?.sydLP ?? null, bl?.calc?.syd_discount ?? null,
             bl?.ctrCode || null, bl?.ctrLP ?? null, bl?.calc?.suggested_discount ?? null,
             ...(crmCols ? [m.crmCode || null] : [])])).rows[0];
          break;
        } catch (e) {
          const msg = String(e.message || '');
          if (msg.includes('uq_customers_rfc_claim')) { dupRace = true; break; }
          if (msg.includes('uq_customers_constancia_no')) {
            // CONSTANCIA 중복은 등록 자체를 막을 이유가 못 된다 → 번호를 비우고 다시.
            conNo = null; continue;
          }
          if (!msg.includes('unique') && !msg.includes('duplicate')) throw e;
        }
      }

      if (dupRace) {
        // 방금 사이에 같은 RFC 가 들어왔다 → 멱등 경로로 되돌아간다.
        const again = (await query(
          `SELECT id, code, COALESCE(approval_status,'approved') AS approval_status FROM customers
            WHERE deleted_at IS NULL AND rfc_norm = $1
              AND COALESCE(approval_status,'approved') <> 'rejected'
            ORDER BY id LIMIT 1`, [rfcNorm])).rows[0];
        const body = errBody('0', 'Cliente ya existía en el ERP.', {
          erpCustomerCode: again?.code || null, estatus: ESTATUS[again?.approval_status] || 'pendiente' });
        await writeLog({ ...base, customer_id: again ? Number(again.id) : null, erp_code: again?.code || null,
          result: 'updated', http_status: 200, codigo_error: '0', mensaje: body.mensaje });
        return reply.code(200).send(body);
      }
      if (!row) {
        const body = errBody('ERR_INTERNAL', 'No fue posible asignar un código de cliente. Reintentar.');
        await writeLog({ ...base, result: 'rejected', http_status: 500,
          codigo_error: body.codigoError, mensaje: body.mensaje });
        return reply.code(500).send(body);
      }

      // 승인 화면이 「무엇이 왔는지」 를 그대로 볼 수 있게 원문을 박제한다.
      try {
        await query(
          `INSERT INTO customer_registration_events (customer_id, action, reason, snapshot, acted_by)
           VALUES ($1,'submit',$2,$3,NULL)`,
          [row.id, 'CRM(웹카달록) 등록 요청', JSON.stringify({
            origin: 'crm', crm_customer_code: m.crmCode, crm_customer_id: m.crmId,
            estatus_crm: m.estatusCrm, transaction_user: m.transactionUser,
            solicitado_en: m.solicitadoEn,
            asesor: asesor ? { id: Number(asesor.id), name: asesor.name, matched_by: asesor.matched_by }
                           : { matched_by: null, vendedor_correo: m.vendedorCorreo || null },
            requested: { discountPercent: m.discountPercent, paymentDays: m.paymentDays,
                         descuentoSyd: m.descuentoSyd, sydRefBuyPrice: m.sydRefBuyPrice,
                         sydRefCode: m.sydRefCode },
            suggested_discount: bl?.calc?.suggested_discount ?? null,
            calc_note: bl?.calc?.note ?? null,
            raw: safe,
          })]);
      } catch (_) { /* 이력 실패가 등록을 되돌리지 않는다 */ }

      await safeLog({ userId: null, action: 'create', target: `customer:${row.id}`,
        detail: { origin: 'crm', crm_customer_code: m.crmCode || null, rfc } });

      const body = errBody('0', 'Cliente recibido, pendiente de aprobación del director.', {
        erpCustomerCode: row.code, estatus: 'pendiente',
        asesor: asesor ? asesor.name : null,
      });
      await writeLog({ ...base, customer_id: Number(row.id), erp_code: row.code,
        result: 'created', http_status: 200, codigo_error: '0', mensaje: body.mensaje });
      return reply.code(200).send(body);
    } catch (e) {
      const body = errBody('ERR_INTERNAL', 'Error interno del ERP. Reintentar más tarde.');
      req.log?.error({ err: e }, 'crm inbound customer-registration failed');
      await writeLog({ ...base, result: 'rejected', http_status: 500,
        codigo_error: body.codigoError, mensaje: String(e.message || '').slice(0, 400) });
      return reply.code(500).send(body);
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  관리자 — 수신 이력 · 키 발급
  // ════════════════════════════════════════════════════════════════════
  const guard = { preHandler: [authGuard, requireDirector] };

  app.get('/api/crm-inbound/history', guard, async (req) => {
    if (!(await inboundLogReady())) return { migrated: false, items: [], summary: {} };
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 50));
    const result = String(req.query?.result || '').trim();
    // ⚠ 창구(endpoint)로 반드시 가른다. 예전에는 이 필터가 없어서 연동 관리의
    //   **두 수신 연동이 같은 목록**을 보여 줬다(신규고객 등록 이력이 웹 가입 신청에도 떴다).
    //   지정이 없으면 예전 그대로 전부 — 옛 화면이 갑자기 빈 목록이 되면 안 되니까.
    const endpoint = String(req.query?.endpoint || '').trim();
    const params = []; const where = [];
    if (endpoint) {
      params.push(endpoint);
      where.push(`COALESCE(l.endpoint_key,'crm_customer_registration')=$${params.length}`);
    }
    if (['created', 'updated', 'rejected'].includes(result)) { params.push(result); where.push(`l.result=$${params.length}`); }
    params.push(limit);
    const rows = (await query(
      `SELECT l.*, c.name AS customer_name
         FROM crm_inbound_log l LEFT JOIN customers c ON c.id=l.customer_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY l.id DESC LIMIT $${params.length}`, params)).rows;
    const sum = (await query(
      `SELECT result, count(*)::int AS n FROM crm_inbound_log
        ${endpoint ? `WHERE COALESCE(endpoint_key,'crm_customer_registration')=$1` : ''}
        GROUP BY 1`, endpoint ? [endpoint] : [])).rows;
    const summary = { created: 0, updated: 0, rejected: 0 };
    for (const s of sum) if (s.result in summary) summary[s.result] = Number(s.n);
    return {
      migrated: true, summary,
      items: rows.map((r) => ({
        id: Number(r.id), created_at: r.created_at, remote_ip: r.remote_ip,
        endpoint_key: r.endpoint_key || 'crm_customer_registration',
        auth_in: r.auth_in, auth_ok: !!r.auth_ok,
        rfc: r.rfc, crm_code: r.crm_code, erp_code: r.erp_code,
        customer_id: r.customer_id ? Number(r.customer_id) : null, customer_name: r.customer_name || null,
        result: r.result, http_status: r.http_status, codigo_error: r.codigo_error,
        mensaje: r.mensaje, payload: r.payload || {},
      })),
    };
  });

  /**
   * 수신 API 키 발급 — **서버가 만든다**. 사람이 지어내거나 채팅으로 주고받지 않는다.
   *   응답에 딱 한 번 평문으로 실려 나가고, 그 뒤로는 어디서도 다시 볼 수 없다
   *   (분실하면 다시 발급 → 상대에게 새 키를 준다).
   */
  app.post('/api/integrations/:key/inbound-key', guard, async (req, reply) => {
    const key = String(req.params.key || '');
    const ep = await getEndpoint(key);
    if (!ep) return reply.code(404).send({ error: 'not_found' });
    const env = ['test', 'prod'].includes(String(req.body?.env)) ? String(req.body.env) : (ep.env || 'prod');
    const token = 'rfx_' + env + '_' + crypto.randomBytes(24).toString('hex');
    const col = env === 'prod' ? 'auth_token_prod' : 'auth_token_test';
    if (!(await envTokenColsReady())) {
      return reply.code(503).send({ error: 'migration_required',
        note: '0202_integration_env_tokens 마이그레이션이 필요합니다.' });
    }
    await query(`UPDATE integration_endpoints SET ${col}=$1, updated_by=$2, updated_at=now() WHERE key=$3`,
      [token, req.ctx.perm.userId || null, key]);
    try {
      await query(
        `INSERT INTO integration_endpoint_changes (endpoint_id, changed_by, changes)
         SELECT id, $2, $3::jsonb FROM integration_endpoints WHERE key=$1`,
        [key, req.ctx.perm.userId || null,
         JSON.stringify({ [col]: { old: '(설정됨)', new: '(새로 발급됨)' } })]);
    } catch (_) { /* 이력 실패가 발급을 되돌리지 않는다 */ }
    invalidateEndpointCache(key);
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `integration:${key}`,
      detail: { inbound_key_issued: env } });
    return { ok: true, env, token,
      note: '이 키는 지금 한 번만 보입니다. CRM 개발자에게 안전한 경로로 전달하세요.' };
  });
}
