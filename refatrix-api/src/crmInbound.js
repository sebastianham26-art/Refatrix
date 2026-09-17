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

/**
 * 웹 가입 신청(리드) 본문 → ERP 내부 형태. (0210)
 *   신규고객 등록(mapInbound)과 다른 점: **회사명이 필수**이고 상업정보는 아예 안 본다.
 *   가입 화면에서 고객이 상업조건을 스스로 정하는 게 아니기 때문이다.
 */
export function mapLead(body) {
  const f = flattenBody(body);
  return {
    crmLeadCode: S(pick(f, ['crmLeadCode', 'leadId', 'leadCode', 'crmCustomerCode', 'customerCode',
      'codigoCliente', 'codigo', 'solicitudId', 'idSolicitud'])),
    empresa: S(pick(f, ['empresa', 'nombreEmpresa', 'razonSocial', 'compania', 'company',
      'nombreComercial', 'businessName'])),
    nombre: S(pick(f, ['nombre', 'name', 'nombreContacto', 'nombreUsuario', 'firstName'])),
    apellido: S(pick(f, ['apellido', 'apellidos', 'lastName', 'surname', 'apellidoPaterno'])),
    telefono: S(pick(f, ['telefono', 'phone', 'tel', 'celular', 'telefonoContacto', 'mobile', 'whatsapp'])),
    correo: S(pick(f, ['correo', 'email', 'correoElectronico', 'mail', 'correoCliente'])),
    rfc: S(pick(f, ['rfc', 'RFC', 'rfcCliente', 'taxId'])),
    ciudad: S(pick(f, ['ciudad', 'city', 'municipio'])),
    estado: S(pick(f, ['estado', 'state', 'provincia'])),
    direccion: S(pick(f, ['direccion', 'address', 'domicilio', 'calle'])),
    mensaje: S(pick(f, ['mensaje', 'comentario', 'comentarios', 'nota', 'notas', 'observaciones', 'message'])),
    solicitadoEn: S(pick(f, ['solicitadoEn', 'fechaRegistro', 'createdAt', 'fecha'])),
  };
}

/**
 * 견적요청 수신 본문 → ERP 내부 형태 (0220)
 *
 *   ⚠ 고객은 **RFC 또는 CRM 고객코드**로만 받는다. 숫자 id 는 일부러 읽지 않는다 —
 *     예전에 CRM 이 자기 시스템의 고객번호를 보내서 ERP 의 **남의 고객(NAJAR)** 에
 *     견적이 붙었다. 숫자는 두 시스템에서 뜻이 다르므로 열쇠로 쓸 수 없다.
 */
export function mapQuote(body) {
  const f = flattenBody(body);
  const rawLines = pick(f, ['lineas', 'lines', 'items', 'partidas', 'detalle', 'productos', 'renglones']);
  const lines = (Array.isArray(rawLines) ? rawLines : []).map((raw) => {
    const l = flattenBody(raw);
    return {
      code: S(pick(l, ['codigo', 'code', 'sku', 'clave', 'claveProducto', 'numeroParte', 'partNumber', 'ctr', 'codigoCtr'])),
      qty: N(pick(l, ['cantidad', 'qty', 'quantity', 'cant', 'piezas', 'unidades'])),
    };
  });
  const comentario = S(pick(f, ['comentario', 'comentarios', 'mensaje', 'memo', 'nota', 'notas', 'observaciones']));
  // 포털 견적번호 — **반드시 잡아야 한다.** 이 번호가 곧 ERP 견적번호이고 중복 방지 키다.
  //   디렉터 지시(2026-09-17): CRM 견적번호는 **무조건 COT 로 들어온다.**
  //   그래서 세 겹으로 찾는다. 뒤로 갈수록 덜 확실하지만, 놓치는 것보다는 낫다.
  //     ① 전용 필드 (가장 확실 — 개발자에게 이걸 부탁했다)
  //     ② 메모·비고 문구 안의 COT-…
  //     ③ 본문 **어디든** 있는 COT-… (필드 이름을 우리가 모르는 경우의 마지막 안전망)
  const crmQuoteNo = S(pick(f, ['cotizacionCrm', 'cotizacion', 'folio', 'folioCotizacion', 'quoteNo',
    'numeroCotizacion', 'idCotizacion', 'cotizacionId']))
    || folioFromText(comentario)
    || folioAnywhere(body);
  return {
    crmQuoteNo,
    rfc: S(pick(f, ['rfc', 'RFC', 'rfcCliente', 'taxId'])),
    crmCustomerCode: S(pick(f, ['clienteCrm', 'crmCustomerCode', 'customerCode', 'codigoCliente', 'clienteCodigo'])),
    fecha: S(pick(f, ['fecha', 'fechaCotizacion', 'quoteDate', 'fechaSolicitud', 'solicitadoEn'])),
    comentario,
    solicitante: S(pick(f, ['solicitante', 'usuario', 'contacto', 'correo', 'email', 'nombre'])),
    lines,
  };
}

/** 메모 문구에서 포털 견적번호(COT-…)를 뽑아낸다. 전용 필드가 없을 때만 쓰는 차선책. */
export function folioFromText(s) {
  // COT 뒤에 **구분자나 숫자**가 와야 한다 — 그래야 「COTA123」 같은 평범한 낱말을
  //   견적번호로 오해하지 않는다. 틀린 번호를 넣는 것은 못 찾는 것보다 나쁘다
  //   (못 찾으면 Q-#### 로 가고 화면이 경고한다. 틀리면 아무도 모른다).
  //   끝은 반드시 영숫자 — 문장 끝의 마침표·쉼표를 번호에 끌고 들어오지 않게.
  const m = /\b(COT(?:[-_/]|(?=\d))[A-Za-z0-9._/-]{1,35}[A-Za-z0-9])\b/i.exec(String(s || ''));
  return m ? m[1].toUpperCase() : null;
}

/**
 * 본문 **어디에 있든** COT-… 를 찾아낸다 — 마지막 안전망.
 *
 *   CRM 견적번호는 무조건 COT 로 온다. 그런데 필드 이름은 우리가 다 알 수 없다
 *   (첫 연동 때도 계약서와 다른 이름으로 왔다). 이름을 못 알아봐서 번호를 통째로
 *   놓치면 견적번호가 갈리고 중복 방지도 사라진다 — 그게 가장 비싼 실패다.
 *
 *   ⚠ 이건 **추측**이다. 전용 필드가 언제나 이긴다. 그리고 줄(lineas)은 건너뛴다 —
 *     제품 코드가 우연히 COT 로 시작해도 견적번호로 오해하면 안 된다.
 */
export function folioAnywhere(body, _depth = 0) {
  if (body == null || _depth > 4) return null;
  if (typeof body === 'string') return folioFromText(body);
  if (typeof body !== 'object') return null;
  if (Array.isArray(body)) {
    for (const v of body.slice(0, 200)) {
      const hit = folioAnywhere(v, _depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const k of Object.keys(body)) {
    // 줄 배열 안은 보지 않는다(제품 코드와 헷갈릴 자리다).
    if (['lineas', 'lines', 'items', 'partidas', 'detalle', 'productos', 'renglones']
      .includes(String(k).toLowerCase())) continue;
    const hit = folioAnywhere(body[k], _depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * 포털 견적번호를 **ERP 견적번호로 그대로 쓸 수 있는가** 판정한다 (0221).
 *
 *   디렉터 결정: 웹에서 들어온 견적은 ERP 에서도 **같은 번호**로 남긴다.
 *   고객이 전화로 「COT-2026…」 라고 말하면 영업사원이 그 번호로 바로 찾을 수 있어야 한다.
 *   번호가 두 개면 통화 중에 대조표를 열어야 하고, 그 순간 실수가 난다.
 *
 *   다만 **아무 문자열이나 번호 칸에 넣지는 않는다.** 번호는 화면·인쇄물·검색에 그대로 나가므로
 *   모양이 이상하면(공백·너무 김·이상한 문자) 포기하고 우리 번호(Q-####)를 쓴다.
 *   이때도 원문은 external_quote_no 에 그대로 남으니 잃어버리는 것은 없다.
 */
export function folioAsQuoteNo(folio) {
  const s = String(folio == null ? '' : folio).trim();
  if (!s) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{2,39}$/.test(s)) return null;
  return s;
}

/** 견적일자로 쓸 수 있는가 — 아니면 오늘로 둔다(상대 형식 때문에 접수를 막지 않는다). */
export function quoteDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** 줄 검증 — 코드가 없거나 수량이 0 이하면 상대가 고쳐야 한다(우리가 추측하지 않는다). */
export function badQuoteLines(lines) {
  const out = [];
  (Array.isArray(lines) ? lines : []).forEach((l, i) => {
    if (!l.code) out.push({ linea: i + 1, motivo: 'codigo_requerido' });
    else if (!(Number(l.qty) > 0)) out.push({ linea: i + 1, codigo: l.code, motivo: 'cantidad_invalida' });
  });
  return out;
}

// 가입 신청의 필수값 — 이 다섯이 없으면 영업사원이 연락할 방법도, 회사를 특정할 방법도 없다.
export const LEAD_REQUIRED = ['empresa', 'nombre', 'telefono', 'correo', 'rfc'];

export function missingLeadFields(m) {
  return LEAD_REQUIRED.filter((k) => !m[k]);
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
