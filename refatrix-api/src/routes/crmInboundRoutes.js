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
import { getEndpoint, invalidateEndpointCache, envTokenColsReady, maskSecret, activeToken,
         INBOUND_KEY_FALLBACK } from '../integrations.js';
import { writeInboundLog, inboundLogReady } from '../crmInboundLog.js';
import { mapInbound, missingRequired, readInboundKey, verifyInboundKey, scrubPayload,
         errBody, keyFailNote, keyFailMensaje, isOpenSignup, normalizeOrigin } from '../crmInbound.js';
import { enqueueCustomerSync } from '../crmSync.js';
import { validateRfcOptional, normalizeClaimKey, computeBaselineDiscount,
         MAX_DISCOUNT_PCT } from '../customerClaim.js';
import { computeNextCode } from '../customerCode.js';

export const INBOUND_KEY = 'crm_customer_registration';
const SYD_BASE_CODE = String(process.env.SYD_BASE_CODE || '1516049').trim();

// ── 0278 · 광고 유입(GOOGLE · FACEBOOK) 자동 가입 규칙 ────────────────────
//
//   디렉터 지시(2026-10-16):
//     "CUS_Origin 이 GOOGLE · FACEBOOK 이면 보내오는 것만 데이타를 받고, ERP 가 꼭
//      필요하다고 규정한 항목이 없어도 회원가입을 받아줘. 고객팀을 07_Pagina 로
//      정의하고 할인률을 10% 로 정해서 가입을 진행" · "RFC 가 없을 수 있어 …
//      고객구분을 MECANICO 로 저장"
//
//   ★ 이 네 값이 **규칙의 전부**다. 흐트리지 않게 한 고에 모아 둔다 —
//     나중에 할인율이나 팀을 바꿀 때 고칠 곣이 여기 하나여야 한다.
const WEB_TEAM_NAME = '07_Pagina';        // 0278 마이그레이션이 시드한다
const WEB_DISCOUNT = 10;                   // %
const WEB_CUSTOMER_TYPE = 'MECANICO';      // 고객구분(customers.customer_type)
// 20261022 · 디렉터 지시: "사후승인도 필요없고 … 그냥 회원가입이 자동으로 되도록".
//   CUS_Origin 자동 가입은 등록과 동시에 **확인 완료(ratified)** 로 닫는다 — 사후승인 목록에 안 쌓인다.
//   다시 사후승인을 받게 하려면 이 값을 false 로 바꾸면 된다(나머지 규칙은 그대로).
const WEB_AUTO_RATIFY = true;
const WEB_RATIFY_NOTE = '자동 가입 (CRM 웹 · CUS_Origin) — 사후승인 생략 · 디렉터 지시 2026-10-22/23';

// 0267(ratified_*) 준비 여부. 없으면 예전처럼 사후승인 대기로 남는다(가입은 그대로 된다).
let ratifyCols = false; let ratifyColsProbe = 0;
async function ratifyColsReady() {
  if (ratifyCols) return true;
  if (Date.now() - ratifyColsProbe < 30000) return false;
  ratifyColsProbe = Date.now();
  try {
    const r = await query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name='customers' AND column_name IN ('ratified_at','ratified_note')`);
    ratifyCols = Number(r.rows[0]?.n) === 2;
  } catch (_) { ratifyCols = false; }
  return ratifyCols;
}

// 0278(crm_origin) 준비 여부 — 마이그레이션 전에도 수신은 되어야 한다.
//   ⚠ 긍정만 캐싱하고 30초 뒤 다시 본다(배포 직후 migrate 가 늦어도 반영되게).
let originCol = false; let originColProbe = 0;
async function originColReady() {
  if (originCol) return true;
  if (Date.now() - originColProbe < 30000) return false;
  originColProbe = Date.now();
  try {
    const r = await query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='customers' AND column_name='crm_origin' LIMIT 1`);
    originCol = r.rows.length > 0;
  } catch (_) { originCol = false; }
  return originCol;
}

/** 광고 유입 고객이 들어갈 팀. 없으면 null — 팀이 없다고 가입을 막지는 않는다. */
async function webTeamId() {
  try {
    const r = (await query(
      `SELECT id FROM sales_teams WHERE name=$1 AND deleted_at IS NULL LIMIT 1`, [WEB_TEAM_NAME])).rows[0];
    return r ? Number(r.id) : null;
  } catch (_) { return null; }
}

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


/**
 * CRM 수신 본문 → 고객 등록(또는 기존 고객 갱신). 인증이 끝난 뒤에 부른다.
 *   · 신규고객 등록 창구(customer-registration)가 그대로 쓴다.
 *   · 웹 가입 신청 창구(customer-lead)는 **CUS_Origin 이 있을 때만** 이걸 부른다(20261022·23).
 *   기록은 언제나 신규고객 등록 창구(crm_customer_registration)의 수신 이력에 남는다 —
 *   고객이 생긴 곳이 거기이기 때문이다. 부른 쪽은 자기 이력에 「넘김」만 남긴다.
 */
export async function registerInbound({ raw, safe, ip, where, reply, log, app, via = null }) {
  // ── ② 읽기 + 필수 검사 ────────────────────────────────────────────
  const m = mapInbound(raw);
  const base = { remote_ip: ip, auth_in: where, auth_ok: true, payload: safe,
    rfc: m.rfc || null, crm_code: m.crmCode || null };

  // ── 0278 · 광고 유입이면 **ERP 의 필수 규정을 적용하지 않는다** ──────
  //   디렉터 지시: "보내오는 것만 데이타를 받고, ERP에서 꼭 필요하다고 규정한 항목이
  //   없어도 회원가입을 받아줘." 광고를 보고 바로 가입하는 사람에게 RFC·성까지 요구하면
  //   거기서 끝난다 — 그 사람을 잃는 것이 불완전한 고객 한 줄보다 비싸다.
  //   20261022 · 판정은 isOpenSignup 한 곳(= CUS_Origin 이 GOOGLE·FACEBOOK).
  const openOrigin = isOpenSignup(m);

  if (!openOrigin) {
    const miss = missingRequired(m);
    if (miss.length) {
      const body = errBody('ERR_REQUIRED_FIELD', `Falta(n) campo(s) obligatorio(s): ${miss.join(', ')}.`);
      await writeLog({ ...base, http_status: 400, result: 'rejected',
        codigo_error: body.codigoError, mensaje: body.mensaje });
      return reply.code(400).send(body);
    }
  }

  // RFC: 일반 경로는 **필수**, 광고 유입은 **선택**.
  //   ⚠ 광고 유입이라도 **넣어 보냈으면 형식은 그대로 엄격히 본다.** 형식이 깨진 RFC 를
  //     받아 두면 나중에 팩투라가 막히고, 그때는 어디서 들어온 값인지 아무도 모른다.
  let rfcChk = validateRfcOptional(m.rfc);
  // 20261023 · 자동 가입은 **형식이 깨진 RFC 때문에 가입을 잃지 않는다.** 깨진 값은 저장하지 않고
  //   (팩투라가 막히니까) RFC 없이 가입시킨 뒤 메모·이력에 원문을 남긴다. 일반 경로는 그대로 400.
  let rfcDropped = null;
  if (openOrigin && !rfcChk.ok) { rfcDropped = String(m.rfc || '').trim() || null; rfcChk = { ok: true, value: null }; }
  if (!rfcChk.ok || (!openOrigin && !rfcChk.value)) {
    const body = errBody('ERR_RFC_INVALID', RFC_ES[rfcChk.error] || RFC_ES.rfc_invalid);
    await writeLog({ ...base, http_status: 400, result: 'rejected',
      codigo_error: body.codigoError, mensaje: body.mensaje });
    return reply.code(400).send(body);
  }
  const rfc = rfcChk.value || null;              // 광고 유입은 null 일 수 있다
  const rfcNorm = rfc ? normalizeClaimKey(rfc) : null;

  try {
    // ── ③ 이미 있는 RFC 인가 (멱등) ────────────────────────────────
    //   같은 고객을 두 번 만들지 않는다. 있으면 **비어 있는 연락처만** 채운다 —
    //   디렉터가 손본 값을 카달록 입력으로 덮어쓰면 안 된다.
    const crmCols = await crmOriginColsReady();
    // 0278 · RFC 가 없을 수 있게 되면서 **멱등 축이 하나로는 부족**해졌다.
    //   순서: RFC → CRM 코드 → 이메일. 앞의 것이 있으면 그것만 본다(뒤로 갈수록 약한 키다).
    //     · RFC      — 법적 식별자. 가장 강하다.
    //     · CRM 코드 — uq_customers_crm_code 유니크가 이미 지키고 있다.
    //     · 이메일   — 디렉터·영업이 나중에 고치는 값이라 가장 약하다. 그래도 없는 것보다는
    //                  낫다(없으면 같은 사람이 두 번 누를 때마다 고객이 새로 생긴다).
    const dupBy = rfcNorm ? 'rfc' : (crmCols && m.crmCode ? 'crm_code' : (m.correo ? 'correo' : null));
    const DUP_WHERE = {
      rfc: 'c.rfc_norm = $1',
      crm_code: 'c.crm_customer_code = $1',
      correo: 'lower(btrim(c.contact)) = lower(btrim($1))',
    };
    const dupVal = dupBy === 'rfc' ? rfcNorm : (dupBy === 'crm_code' ? m.crmCode : m.correo);
    const exist = !dupBy ? null : (await query(
      `SELECT c.id, c.code, c.name, c.contact, c.phone, c.ship_address,
              ${crmCols ? 'c.crm_customer_code' : 'NULL::text AS crm_customer_code'},
              COALESCE(c.approval_status,'approved') AS approval_status
         FROM customers c
        WHERE c.deleted_at IS NULL AND ${DUP_WHERE[dupBy]}
          AND COALESCE(c.approval_status,'approved') <> 'rejected'
        ORDER BY c.id LIMIT 1`, [dupVal])).rows[0];

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

    // ── ④ 신규 — P-#### 로 채번해 등록한다 ──────────────────────────
    const asesor = await findAsesor(m);
    const bl = await baselineFrom(m);
    const sentDisc = (m.discountPercent != null && Number.isFinite(m.discountPercent)
      && m.discountPercent >= 0 && m.discountPercent <= MAX_DISCOUNT_PCT) ? m.discountPercent : 0;
    // 0278 · 광고 유입은 **우리가 정한 10%** 다. CRM 이 보낸 값이 있어도 따르지 않는다
    //   (디렉터 지시: "할인률을 10%로 정해서"). 보내온 값은 아래 이력 스냅샷에 남긴다.
    const disc = openOrigin ? WEB_DISCOUNT : sentDisc;
    // 20261022 · 자동 가입은 **외상 없음(현금)** 이다. 서류 관문을 껐으므로(doc_gate=false)
    //   CRM 이 paymentDays 를 실어 보내면 그대로 실효 외상이 된다 — 서류 없이 외상이 열리면 안 된다.
    //   외상을 주려면 고객 상세에서 디렉터가 정한다.
    const days = openOrigin ? 0
      : ((m.paymentDays != null && Number.isFinite(m.paymentDays) && m.paymentDays >= 0)
        ? Math.round(m.paymentDays) : 0);
    // 이름이 하나도 없을 수 있다(광고 유입). customers.name 은 NOT NULL 이므로
    //   **빈 문자열로 두지 않고** 남은 단서로 채운다 — 목록에서 사람이 알아볼 수 있어야 한다.
    const nombre = [m.nombre, m.apellido].filter(Boolean).join(' ').trim()
      || String(m.nombreComercial || '').trim()
      || String(m.correo || '').trim()
      || String(m.telefono || '').trim()
      || (m.crmCode ? `CRM ${m.crmCode}` : '')
      || '(이름 미기재 · 웹 가입)';
    const addr = [m.direccion, m.ciudad, m.estado].filter(Boolean).join(', ') || null;
    // 0278 · 팀·고객구분. 팀이 없으면(마이그레이션 전) null 로 두고 가입은 진행한다 —
    //   팀 하나 때문에 고객을 잃지 않는다. 화면에서 나중에 지정할 수 있다.
    const originCols = await originColReady();
    const teamId = openOrigin ? (await webTeamId()) : (asesor?.team_id || null);
    const custType = openOrigin ? WEB_CUSTOMER_TYPE : (m.tipo || null);

    const autoRatify = openOrigin && WEB_AUTO_RATIFY && (await ratifyColsReady());

    let row = null; let dupRace = false;
    let conNo = m.constanciaNo || null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = await computeNextCode('P');
      // 0278 · 컬럼이 조건부로 늘어나면서 $번호를 손으로 세는 것이 위험해졌다.
      //   (crm_customer_code · crm_origin 이 각각 마이그레이션 적용 여부에 따라 붙는다)
      //   그래서 이름과 값을 **짝으로** 모아 번호를 기계가 붙이게 한다.
      const cols = []; const vals = []; const params = [];
      const add = (col, v) => { params.push(v); cols.push(col); vals.push('$' + params.length); };
      const raw = (col, expr) => { cols.push(col); vals.push(expr); };
      add('code', code);
      add('name', nombre);
      add('rfc', rfc);
      add('contact', m.correo || null);
      add('phone', m.telefono || null);
      add('discount', disc);
      add('credit_days', days);
      add('team_id', teamId);
      add('owner_id', asesor?.id || null);
      add('customer_type', custType);
      add('memo', ['CRM 웹카달록 등록',
        openOrigin ? `자동 가입(10%): 유입 ${normalizeOrigin(m.origin)}` : null,
        rfcDropped ? `⚠ CRM 이 보낸 RFC 형식 오류로 비워 둠: ${rfcDropped}` : null,
        m.nombreComercial ? `상호명: ${m.nombreComercial}` : null,
        m.crmCode ? `CRM 코드: ${m.crmCode}` : null, m.memo].filter(Boolean).join(' · '));
      add('ship_address', addr);
      add('constancia_no', conNo);
      add('syd_ref_code', bl?.baseCode || null);
      add('syd_ref_buy_price', bl?.buy ?? null);
      add('syd_ref_list_price', bl?.sydLP ?? null);
      add('syd_ref_discount', bl?.calc?.syd_discount ?? null);
      add('ctr_ref_code', bl?.ctrCode || null);
      add('ctr_ref_list_price', bl?.ctrLP ?? null);
      add('suggested_discount', bl?.calc?.suggested_discount ?? null);
      // 0267 · **등록은 승인을 기다리지 않는다**(디렉터 지시 2026-10-16: "CRM 수신 전부
      //   사후승인으로"). 예전에는 'pending' 이라 CRM 에서 들어온 고객은 승인 전까지
      //   견적에 쓸 수 없었고 카달록에서도 정가를 봤다 — ERP 화면 등록만 10/09 에
      //   바뀌고 이 창구가 남아 있었다. ratified_at 은 비워 두므로 사후승인 목록에 모인다.
      raw('approval_status', `'approved'`);
      raw('submitted_at', 'now()');
      if (rfc) raw('rfc_claimed_at', 'now()');     // RFC 가 없으면 선점도 없다
      if (crmCols) { add('crm_customer_code', m.crmCode || null); raw('crm_registered_at', 'now()'); }
      if (originCols) add('crm_origin', m.origin || null);
      // 0278 · 광고 유입은 서류 관문 대상이 아니다. 광고를 보고 가입한 사람에게서
      //   Constancia·주소증빙을 받을 일이 없는데 관문을 걸어 두면 **10% 가 실효 0 으로
      //   깎여** 지시가 무효가 된다(0235/0247 트리거). 그래서 여기서 명시적으로 끈다.
      if (openOrigin) raw('doc_gate', 'false');
      // 20261022 · 자동 가입은 **사후승인도 없다** — 등록과 동시에 확인 완료로 닫는다.
      //   ratified_by 는 비워 둔다(사람이 확인한 게 아니다). 누가 왜 닫았는지는 note 가 말한다.
      if (autoRatify) {
        raw('approved_at', 'now()');
        raw('ratified_at', 'now()');
        add('ratified_note', WEB_RATIFY_NOTE);
      }
      try {
        row = (await query(
          `INSERT INTO customers (${cols.join(', ')})
           VALUES (${vals.join(', ')})
           RETURNING id, code`, params)).rows[0];
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
      //   (이 분기는 uq_customers_rfc_claim 충돌에서만 오므로 rfcNorm 이 반드시 있다)
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
        [row.id, autoRatify ? 'CRM(웹카달록) 자동 가입 — CUS_Origin' : 'CRM(웹카달록) 등록 요청', JSON.stringify({
          origin: 'crm', crm_customer_code: m.crmCode, crm_customer_id: m.crmId,
          // 0278 · 어떤 유입경로였고 그래서 무엇을 **우리가 정했는지** 박제한다.
          //   나중에 「왜 이 고객만 10% 냐」를 이 한 줄로 답할 수 있어야 한다.
          cus_origin: m.origin || null, open_origin: openOrigin,
          auto_ratified: !!autoRatify, rfc_dropped: rfcDropped,
          applied: openOrigin
            ? { team: WEB_TEAM_NAME, team_id: teamId, discount: WEB_DISCOUNT,
                customer_type: WEB_CUSTOMER_TYPE, doc_gate: false,
                required_fields_waived: true, sent_discount: sentDisc }
            : null,
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
      detail: { origin: 'crm', crm_customer_code: m.crmCode || null, rfc,
                auto_signup: openOrigin || undefined, via: via || undefined } });

    if (openOrigin) {
      // 20261022 · 예전에는 디렉터의 사후승인 버튼이 CRM 에 상거래정보(할인 10%)를 보냈다.
      //   사후승인이 없어졌으니 **여기서** 보낸다. RFC 가 없으면 CRM 조회 키가 없어 skipped 로
      //   남는다 — 그래서 아래 응답에도 할인율을 실어, 카달록이 바로 10% 를 쓸 수 있게 한다.
      //   ⚠ enqueueCustomerSync 는 throw 하지 않는다. 전송 실패가 가입을 되돌리지 않는다.
      await enqueueCustomerSync(row.id, 'upsert', { origin: 'crm_auto_signup', app });
    }

    // 0267/0278 · 고객은 **이미 활성**이다. 상대에게 「승인 대기」라고 말하면
    //   카달록이 그 고객을 기다리게 만든다 — 사실과 다른 상태를 전하면 안 된다.
    const body = errBody('0', 'Cliente registrado y activo en el ERP.', {
      erpCustomerCode: row.code, estatus: 'aprobado',
      asesor: asesor ? asesor.name : null,
      // 20261022 · 자동 가입은 조건이 정해져 있다 — 응답으로 바로 알려 준다(RFC 없는 고객은
      //   CRM 동기화가 나갈 수 없어서 이게 카달록이 10% 를 아는 유일한 길이다).
      ...(openOrigin ? { discountPercent: disc, paymentDays: 0, registroAutomatico: true } : {}),
    });
    await writeLog({ ...base, customer_id: Number(row.id), erp_code: row.code,
      result: 'created', http_status: 200, codigo_error: '0', mensaje: body.mensaje });
    return reply.code(200).send(body);
  } catch (e) {
    const body = errBody('ERR_INTERNAL', 'Error interno del ERP. Reintentar más tarde.');
    log?.error({ err: e }, 'crm inbound customer-registration failed');
    await writeLog({ ...base, result: 'rejected', http_status: 500,
      codigo_error: body.codigoError, mensaje: String(e.message || '').slice(0, 400) });
    return reply.code(500).send(body);
  }
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
        : keyFailMensaje(token));   // 인증 방식이 틀렸으면 그걸 짚어 준다(JWT 등)
      // ⚠ 이력에는 **무엇과 대조했는지**까지 남긴다(세 수신 창구가 같은 규칙을 쓴다).
      v.expectHint = maskSecret(activeToken(ep) || ep?.auth_token_prod || ep?.auth_token_test);
      await writeLog({ remote_ip: ip, auth_in: where, auth_ok: false, http_status: 401,
        rfc: String(raw.rfc || raw.RFC || '') || null,
        codigo_error: body.codigoError,
        mensaje: keyFailNote(v, token, { ownLabel: ep.label || ep.key, fallbackLabel: null, mask: maskSecret }),
        payload: safe, result: 'rejected' });
      return reply.code(401).send(body);
    }
    if (ep.enabled === false) {
      const body = errBody('ERR_INTERNAL', 'La recepción de altas está deshabilitada temporalmente en el ERP.');
      await writeLog({ remote_ip: ip, auth_in: where, auth_ok: true, http_status: 503,
        codigo_error: body.codigoError, mensaje: body.mensaje, payload: safe, result: 'rejected' });
      return reply.code(503).send(body);
    }

    // 20261022 · 읽기 이후는 공용 함수로 옮겼다 — 웹 가입 신청 창구(crmLeadRoutes)도
    //   CUS_Origin 이 있으면 **같은 규칙으로** 바로 고객을 만든다(규칙이 두 군데 있으면 갈린다).
    return registerInbound({ raw, safe, ip, where, reply, log: req.log, app });
  });

  // ════════════════════════════════════════════════════════════════════
  //  관리자 — 수신 이력 · 키 발급
  // ════════════════════════════════════════════════════════════════════
  const guard = { preHandler: [authGuard, requireDirector] };

  app.get('/api/crm-inbound/history', guard, async (req) => {
    if (!(await inboundLogReady())) return { migrated: false, items: [], summary: {} };
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 50));
    // 09-24 · 페이지 넘기기. offset 이 없으면 예전 그대로(최신 limit 건).
    const offset = Math.max(0, Number(req.query?.offset) || 0);
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
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = Number((await query(
      `SELECT count(*)::int AS n FROM crm_inbound_log l ${whereSql}`, params)).rows[0].n);
    params.push(limit);
    const limIdx = params.length;
    params.push(offset);
    const offIdx = params.length;
    const rows = (await query(
      `SELECT l.*, c.name AS customer_name
         FROM crm_inbound_log l LEFT JOIN customers c ON c.id=l.customer_id
        ${whereSql}
        ORDER BY l.id DESC LIMIT $${limIdx} OFFSET $${offIdx}`, params)).rows;
    const sum = (await query(
      `SELECT result, count(*)::int AS n FROM crm_inbound_log
        ${endpoint ? `WHERE COALESCE(endpoint_key,'crm_customer_registration')=$1` : ''}
        GROUP BY 1`, endpoint ? [endpoint] : [])).rows;
    const summary = { created: 0, updated: 0, rejected: 0 };
    for (const s of sum) if (s.result in summary) summary[s.result] = Number(s.n);
    return {
      migrated: true, summary, total, limit, offset,
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

  /**
   * 전용 수신 키를 **지운다** — 공용 키(다른 수신 창구의 키)로 되돌리기 위해서다.
   *
   *   ⚠ 이게 없어서 실제로 막혔다. 창구마다 전용 키를 발급할 수 있게만 해 두고 지울 방법을
   *     두지 않으면, 실수로 한 번 발급한 순간 **공용 키로는 영원히 들어오지 못한다.**
   *     상대는 「키는 같은 걸 쓴다」고 하는데 우리는 401 을 주고, 되돌릴 버튼이 없다.
   *     만들 수 있는 것은 되돌릴 수도 있어야 한다.
   */
  app.delete('/api/integrations/:key/inbound-key', guard, async (req, reply) => {
    const key = String(req.params.key || '');
    const ep = await getEndpoint(key);
    if (!ep) return reply.code(404).send({ error: 'not_found' });
    if (ep.direction !== 'in') {
      return reply.code(400).send({ error: 'not_inbound',
        note: '수신 창구에서만 쓸 수 있습니다. 전송 창구의 키는 연결 설정에서 고치세요.' });
    }
    const fb = INBOUND_KEY_FALLBACK[key];
    await query(
      `UPDATE integration_endpoints
          SET auth_token_test=NULL, auth_token_prod=NULL, auth_token=NULL,
              updated_by=$2, updated_at=now()
        WHERE key=$1`, [key, req.ctx.perm.userId || null]);
    try {
      await query(
        `INSERT INTO integration_endpoint_changes (endpoint_id, changed_by, changes)
         SELECT id, $2, $3::jsonb FROM integration_endpoints WHERE key=$1`,
        [key, req.ctx.perm.userId || null,
         JSON.stringify({ inbound_key: { old: '(전용 키)', new: fb ? '(공용 키로 되돌림)' : '(지움)' } })]);
    } catch (_) { /* 이력 실패가 삭제를 되돌리지 않는다 */ }
    invalidateEndpointCache(key);
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `integration:${key}`,
      detail: { inbound_key_cleared: true, fallback_to: fb || null } });
    return { ok: true, fallback_to: fb || null,
      note: fb
        ? '전용 키를 지웠습니다 — 이제 다른 창구의 키로 들어오는 요청을 받습니다.'
        : '전용 키를 지웠습니다. 이 창구는 이제 어떤 키로도 인증되지 않습니다 — 새로 발급하세요.' };
  });
}
