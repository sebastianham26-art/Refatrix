// CRM → ERP 수신 — 웹카달록 신규고객 등록.
//
//   상대 개발자가 어떤 이름으로 보낼지 100% 확정할 수 없다(첫 호출부터 계약서와 달랐다:
//   crmCustomerCode 대신 customerCode 를 보냈다). 그래서 **관대하게 읽는다**:
//   같은 뜻의 이름을 모두 후보로 두고, 대소문자·언더스코어를 무시하고 찾는다.
//   단, 저장은 엄격하게 한다 — RFC 형식 검증, 필수 5개, 멱등(같은 RFC 재전송 시 갱신).
//
//   순수 함수만 둔다(DB 접근 없음) → 테스트에서 그대로 부른다.

/** 키 이름 정규화: 대소문자·_·-·공백 무시. */
function nk(s) { return String(s || '').toLowerCase().replace(/[\s_\-.]/g, ''); }

/**
 * 본문을 평평하게 만든다.
 *   · { cliente: {...} } / { customer: {...} } / { data: {...} } 처럼 한 겹 감싼 형태를 풀어 준다.
 *   · 감싼 것과 바깥 것이 겹치면 **안쪽이 이긴다**(감싼 쪽이 실제 데이터이므로).
 */
export function flattenBody(body) {
  const b = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};
  const out = { ...b };
  for (const k of Object.keys(b)) {
    const v = b[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = nk(k);
      if (['cliente', 'customer', 'data', 'payload', 'body', 'datos'].includes(inner)) {
        for (const k2 of Object.keys(v)) out[k2] = v[k2];
      }
    }
  }
  return out;
}

/** 후보 이름 중 처음 발견되는 값(빈 문자열은 없는 것으로 본다). */
export function pick(flat, names) {
  const map = new Map();
  for (const k of Object.keys(flat)) {
    const n = nk(k);
    if (!map.has(n)) map.set(n, flat[k]);
  }
  for (const name of names) {
    const v = map.get(nk(name));
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    return v;
  }
  return null;
}

const S = (v) => (v == null ? null : String(v).trim() || null);
const N = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[, ]/g, '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
};

/** 수신 본문 → ERP 내부 형태. 이름이 달라도 최대한 알아본다. */
export function mapInbound(body) {
  const f = flattenBody(body);
  return {
    rfc: S(pick(f, ['rfc', 'RFC', 'rfcCliente', 'taxId', 'nrfc'])),
    nombre: S(pick(f, ['nombre', 'name', 'razonSocial', 'nombreRazonSocial', 'nombreCliente', 'businessName', 'companyName'])),
    apellido: S(pick(f, ['apellido', 'apellidos', 'lastName', 'surname', 'apellidoPaterno'])),
    telefono: S(pick(f, ['telefono', 'phone', 'tel', 'celular', 'telefonoContacto', 'mobile'])),
    correo: S(pick(f, ['correo', 'email', 'correoElectronico', 'mail', 'correoCliente'])),

    crmCode: S(pick(f, ['crmCustomerCode', 'customerCode', 'codigoCliente', 'codigo', 'clienteCodigo', 'crmCode'])),
    crmId: S(pick(f, ['customerId', 'crmCustomerId', 'idCliente', 'clienteId'])),
    nombreComercial: S(pick(f, ['nombreComercial', 'tradeName', 'aliasComercial'])),
    tipo: S(pick(f, ['tipo', 'tipoCliente', 'customerType', 'giro'])),
    tier: S(pick(f, ['tier', 'nivel', 'categoria'])),

    discountPercent: N(pick(f, ['discountPercent', 'descuento', 'descuentoCtr', 'descCtr', 'ctrEstimado', 'ctrAdicional', 'descuentoSolicitado'])),
    descuentoSyd: N(pick(f, ['descuentoSyd', 'descSyd', 'sydDiscount'])),
    paymentDays: N(pick(f, ['paymentDays', 'diasPago', 'diasCredito', 'creditDays', 'plazo'])),
    sydRefBuyPrice: N(pick(f, ['sydRefBuyPrice', 'precioCompraSinIva', 'precioCompra', 'precioCompraSinIvaCodigo1516050', 'buyPrice', 'precioSyd'])),
    sydRefCode: S(pick(f, ['sydRefCode', 'codigoReferencia', 'refCode', 'codigoSyd'])),

    vendedorCorreo: S(pick(f, ['vendedorCorreo', 'asesorCorreo', 'correoVendedor', 'sellerEmail', 'vendedorEmail', 'asesorEmail'])),
    vendedorNombre: S(pick(f, ['vendedorNombre', 'asesor', 'vendedor', 'sellerName', 'asesorNombre'])),

    estado: S(pick(f, ['estado', 'state', 'provincia'])),
    ciudad: S(pick(f, ['ciudad', 'city', 'municipio'])),
    direccion: S(pick(f, ['direccion', 'address', 'domicilio', 'calle'])),
    estatusCrm: S(pick(f, ['estatusCrm', 'estatus', 'status', 'estado_crm'])),
    constanciaNo: S(pick(f, ['constanciaNo', 'constancia', 'folioConstancia'])),
    transactionUser: S(pick(f, ['transactionUser', 'usuario', 'user', 'usuarioCrm'])) || 'crm',
    solicitadoEn: S(pick(f, ['solicitadoEn', 'fechaRegistro', 'createdAt', 'fecha'])),
    memo: S(pick(f, ['memo', 'nota', 'notas', 'comentarios', 'observaciones'])),
  };
}

export const REQUIRED = ['rfc', 'nombre', 'apellido', 'telefono', 'correo'];

/** 필수 5개 검사 — 없으면 어느 필드인지 이름으로 돌려준다(상대가 고치기 쉽게). */
export function missingRequired(m) {
  return REQUIRED.filter((k) => !m[k]);
}

/**
 * 수신 API 키 읽기 — 헤더·쿼리·본문 어디로 와도 받는다.
 *   상대 구현이 어디에 실을지 확정 전이므로 셋 다 열어 둔다(우리 쪽 위험은 없다).
 *   @returns {{token:string|null, where:'header'|'query'|'body'|'none'}}
 */
export function readInboundKey(req) {
  const h = req.headers || {};
  const hv = (n) => { const v = h[n]; return v == null ? '' : String(Array.isArray(v) ? v[0] : v).trim(); };
  for (const n of ['x-api-key', 'apikey', 'x-apikey', 'x-erp-key']) {
    const v = hv(n);
    if (v) return { token: v, where: 'header' };
  }
  const auth = hv('authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    return { token: (m ? m[1] : auth).trim(), where: 'header' };
  }
  const q = req.query || {};
  for (const n of ['apiKey', 'apikey', 'api_key', 'key', 'token']) {
    if (q[n] != null && String(q[n]).trim()) return { token: String(q[n]).trim(), where: 'query' };
  }
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  for (const n of ['apiKey', 'apikey', 'api_key', 'token']) {
    if (b[n] != null && String(b[n]).trim()) return { token: String(b[n]).trim(), where: 'body' };
  }
  return { token: null, where: 'none' };
}

/** 타이밍 공격에 덜 취약한 비교(길이가 다르면 즉시 false). */
export function sameToken(a, b) {
  const x = String(a || ''); const y = String(b || '');
  if (!x || !y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/**
 * 이 수신 요청의 키가 유효한가.
 *   test·prod 키 **둘 다** 받아 준다 — 상대가 어느 환경 키를 쓰는지에 따라 수신이 끊기면
 *   원인 파악이 어렵고, 어느 쪽이든 우리가 발급한 키라는 사실은 같다(어느 쪽인지는 이력에 남는다).
 */
export function verifyInboundKey(ep, token) {
  const test = String(ep?.auth_token_test || ep?.auth_token || '');
  const prod = String(ep?.auth_token_prod || '');
  if (!test && !prod) return { ok: false, reason: 'no_key_configured' };
  if (!token) return { ok: false, reason: 'missing' };
  if (sameToken(token, prod)) return { ok: true, env: 'prod' };
  if (sameToken(token, test)) return { ok: true, env: 'test' };
  return { ok: false, reason: 'mismatch' };
}

/**
 * 이력에 남길 본문 — **키 값을 지운다.**
 *   상대가 키를 본문에 실어 보낼 수 있게 열어 뒀으므로(readInboundKey), 원문을 그대로
 *   저장하면 수신 이력 화면과 DB 백업에 우리 키가 평문으로 남는다. 이력의 목적은
 *   "무슨 필드가 왔는지" 확인이지 키 보관이 아니다.
 */
export function scrubPayload(body) {
  if (!body || typeof body !== 'object') return {};
  const secret = ['apikey', 'token', 'authorization', 'password', 'secret'];   // 이미 소문자·구분자 제거 후 비교
  const hit = (k) => secret.includes(String(k).toLowerCase().replace(/[\s_\-.]/g, ''));
  const walk = (v, depth) => {
    if (Array.isArray(v)) return depth > 4 ? [] : v.map((x) => walk(x, depth + 1));
    if (v && typeof v === 'object') {
      if (depth > 4) return {};
      const o = {};
      for (const k of Object.keys(v)) o[k] = hit(k) ? '***' : walk(v[k], depth + 1);
      return o;
    }
    return v;
  };
  return walk(body, 0);
}

/** 응답 본문 — 상대 API 와 같은 모양({codigoError, mensaje})으로 맞춘다. */
export function errBody(code, mensaje, extra = {}) {
  return { codigoError: code, mensaje, ...extra };
}
