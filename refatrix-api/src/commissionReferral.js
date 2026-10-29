// =====================================================================
// Refatrix ERP · commissionReferral.js  (0307 · 2026-10-29)
//   소개(Referencia) 커미션 — 순수 함수만. 라우트는 routes/commissionReferralRoutes.js.
//
//   계약(디렉터 결정 · 2026-10-29 Word 계약서와 같은 내용):
//     · A(소개자)가 B(피소개 커미셔너)를 소개. B 가 **자기 커미션을 받는 매출**이 **완납(수금)**되면
//       그 수금액(IVA 제외 · NC 차감)의 계약율(기본 1%)을 A 에게 지급.
//     · 매월 1일~말일 완납분을 합산 → 다음 달 15일 지급(기존 커미션 지급 흐름과 같은 월 배치) · A 는 CFDI 발행.
//     · 효력일 = max(계약 시작일, 필수 서류 완비일, A 의 첫 전자서명일). 그 전에 완납된 매출은 대상 아님.
//     · B 가 커미션을 못 받는 매출(율 0·기간 밖·미수·취소·NC)은 A 도 0. 지급 후 매출이 줄면 다음 지급에서 차감.
// =====================================================================
import { createHash } from 'node:crypto';

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// 계약 문구 버전 — 조항 문구를 바꾸면 올린다 → 모든 소개자 재서명 대상.
export const REFERRAL_RULES_VERSION = '2026-10-29';

// ── 서류 ────────────────────────────────────────────────────────────
export const DOC_TYPES = {
  csf: { es: 'Constancia de Situación Fiscal', ko: '납세증명서(CSF)', max_days: 30 },
  domicilio: { es: 'Comprobante de domicilio', ko: '주소 증빙', max_days: 92 },
  ine: { es: 'Identificación oficial (INE o pasaporte)', ko: '신분증(INE·여권)' },
  acta: { es: 'Acta constitutiva', ko: '정관(법인)' },
  poder: { es: 'Poder del representante legal', ko: '법정대리인 위임장(법인)' },
  banco: { es: 'Datos bancarios (carátula de estado de cuenta)', ko: '은행계좌 증빙' },
};

// 필수 서류 목록 (순수). persona: 'fisica' | 'moral' (B 기준 — 법인이면 정관·위임장 추가)
export function requiredDocs(persona) {
  const out = [
    { party: 'referred', type: 'csf' }, { party: 'referred', type: 'domicilio' }, { party: 'referred', type: 'ine' },
  ];
  if (persona === 'moral') out.push({ party: 'referred', type: 'acta' }, { party: 'referred', type: 'poder' });
  out.push(
    { party: 'referrer', type: 'csf' }, { party: 'referrer', type: 'domicilio' },
    { party: 'referrer', type: 'ine' }, { party: 'referrer', type: 'banco' },
  );
  return out;
}

const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

// 서류 현황 (순수). docs: [{id, party, doc_type, issued_date, uploaded_on, file_name}] (삭제 제외)
//   반환: { items:[{party,type,label_es,label_ko,doc|null,ok,stale}], complete, missing, complete_on }
//   · 같은 종류가 여러 개면 가장 최근 업로드를 대표로.
//   · stale = 발급일이 업로드일 기준 기한(CSF 30일·주소 3개월)을 넘김 → 경고만(완비 판정은 막지 않음).
//   · complete_on = 필수 서류 각각의 「대표 파일 업로드일」 중 가장 늦은 날(모두 있을 때만).
export function docsStatus(docs, persona) {
  const items = requiredDocs(persona).map(({ party, type }) => {
    const list = (docs || []).filter((d) => d.party === party && d.doc_type === type)
      .sort((a, b) => String(b.uploaded_on).localeCompare(String(a.uploaded_on)) || Number(b.id) - Number(a.id));
    const doc = list[0] || null;
    const t = DOC_TYPES[type];
    let stale = false;
    if (doc && t.max_days && doc.issued_date && doc.uploaded_on) stale = dayDiff(doc.issued_date, doc.uploaded_on) > t.max_days;
    return { party, type, label_es: t.es, label_ko: t.ko, doc, ok: !!doc, stale };
  });
  const missing = items.filter((x) => !x.ok).length;
  const complete = missing === 0;
  const complete_on = complete ? items.map((x) => String(x.doc.uploaded_on)).sort().pop() : null;
  return { items, complete, missing, complete_on };
}

// ── 입력 검증 (순수) ────────────────────────────────────────────────
const s = (v, n) => (v == null ? '' : String(v).trim().slice(0, n));
export function normInfo(info) {
  const i = info || {};
  return {
    name: s(i.name, 200), rfc: s(i.rfc, 20).toUpperCase(), address: s(i.address, 400),
    phone: s(i.phone, 60), email: s(i.email, 160), legal_rep: s(i.legal_rep, 200),
    persona: i.persona === 'moral' ? 'moral' : 'fisica',
  };
}

export function validateReferral(b) {
  const referrer = Number(b && b.referrer_id), referred = Number(b && b.referred_id);
  if (!(referrer > 0) || !(referred > 0)) return { ok: false, error: 'users_required', note: '소개자(A)와 피소개 커미셔너(B)를 모두 선택하세요.' };
  if (referrer === referred) return { ok: false, error: 'same_user', note: '소개자와 피소개 커미셔너가 같은 사람입니다.' };
  const rate = b.rate == null || b.rate === '' ? 1 : Number(b.rate);
  if (!(rate >= 0 && rate <= 100)) return { ok: false, error: 'bad_rate', note: '소개 커미션율은 0~100% 사이여야 합니다.' };
  const start = s(b.start_date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return { ok: false, error: 'bad_start', note: '계약 시작일(YYYY-MM-DD)을 입력하세요.' };
  const end = b.end_date ? s(b.end_date, 10) : null;
  if (end !== null && !/^\d{4}-\d{2}-\d{2}$/.test(end)) return { ok: false, error: 'bad_end', note: '계약 종료일 형식이 올바르지 않습니다.' };
  if (end !== null && end < start) return { ok: false, error: 'end_before_start', note: '종료일이 시작일보다 빠릅니다.' };
  const info = normInfo(b.referred_info);
  if (!info.name) return { ok: false, error: 'name_required', note: '피소개 커미셔너(B)의 성명/상호를 입력하세요(계약서 제1조).' };
  const note = b.note != null && String(b.note).trim() ? String(b.note).trim().slice(0, 500) : null;
  return { ok: true, value: { referrer_id: referrer, referred_id: referred, rate: Math.round(rate * 1000) / 1000, start_date: start, end_date: end, referred_info: info, note } };
}

// ── 조건 · 해시 (순수) ──────────────────────────────────────────────
//   서명 대상 = 계약 문구 버전 + 당사자 + 율 + 기간 + B 정보 + 회사(상호·RFC). 하나라도 바뀌면 재서명.
export function buildReferralTerms(ref, { referrerName, referredUserName, company } = {}) {
  const info = normInfo(ref.referred_info);
  return {
    rules: REFERRAL_RULES_VERSION,
    referral_id: Number(ref.id),
    referrer: { id: Number(ref.referrer_id), name: referrerName || '' },
    referred: { id: Number(ref.referred_id), user: referredUserName || '', ...info },
    rate: Number(ref.rate),
    start: String(ref.start_date).slice(0, 10),
    end: ref.end_date ? String(ref.end_date).slice(0, 10) : null,
    company: { emisor: (company && company.emisor) || 'REFATRIX', rfc: (company && company.rfc) || '' },
  };
}
export function referralHash(terms) {
  return createHash('sha256').update(JSON.stringify(terms)).digest('hex').slice(0, 12);
}

const MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export function fechaLarga(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  return m ? `${Number(m[3])} de ${MES[Number(m[2]) - 1]} de ${m[1]}` : '—';
}
const pct = (n) => `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 })}%`;
const rateWords = (n) => (Number(n) === 1 ? 'uno por ciento' : null);

// ── 계약서 (순수) — 스페인어. Word 계약서(2026-10-27 확정본)와 같은 15개 조항. **굵게** 만 쓴다. ──
//   섹션 = { title, paras:[문단], items:[(a) 항목] , table? }
export function buildReferralDoc(terms) {
  const t = terms, B = t.referred, co = t.company.emisor || 'REFATRIX';
  const rw = rateWords(t.rate);
  const rateTxt = `**${pct(t.rate)}${rw ? ` (${rw})` : ''}**`;
  const sec = [];
  sec.push({ key: 'decl', title: 'Declaraciones', paras: [
    `**I. ${co}** declara que es una sociedad mercantil constituida conforme a las leyes mexicanas, dedicada a la distribución de autopartes, y que su representante cuenta con facultades suficientes para celebrar el presente contrato.`,
    '**II. EL REFERIDOR** declara que tiene capacidad legal para obligarse, que está inscrito en el Registro Federal de Contribuyentes, que puede emitir Comprobantes Fiscales Digitales por Internet (CFDI) y que desea referir a REFATRIX comisionistas de venta.',
    '**III. LAS PARTES** declaran que es su voluntad celebrar el presente contrato conforme a las siguientes cláusulas.',
  ] });
  sec.push({ key: 'c1', title: 'Primera. Objeto', paras: [
    'EL REFERIDOR se obliga a presentar y referir a REFATRIX a la persona cuyos datos se indican a continuación (en lo sucesivo "EL COMISIONISTA REFERIDO"), a efecto de que REFATRIX y EL COMISIONISTA REFERIDO, en su caso, celebren directamente un contrato de comisión mercantil para la promoción y venta de los productos de REFATRIX (el "Contrato del Comisionista Referido").',
    'La función de EL REFERIDOR se limita exclusivamente a la presentación y referencia de EL COMISIONISTA REFERIDO. La decisión de contratarlo y sus términos corresponden exclusivamente a REFATRIX. EL REFERIDOR no será parte del Contrato del Comisionista Referido ni tendrá derecho alguno derivado del mismo, salvo lo previsto en este instrumento.',
  ], table: { head: ['Dato', 'EL COMISIONISTA REFERIDO'], rows: [
    ['Nombre o razón social', B.name || '—'], ['RFC', B.rfc || '—'], ['Domicilio completo', B.address || '—'],
    ['Teléfono / WhatsApp', B.phone || '—'], ['Correo electrónico', B.email || '—'],
    ['Representante legal', B.persona === 'moral' ? (B.legal_rep || '—') : 'No aplica (persona física)'],
  ], tablePos: 'after1' } });
  sec.push({ key: 'c2', title: 'Segunda. Entrega de documentación', paras: [
    'EL REFERIDOR se obliga a entregar a REFATRIX, al momento de la referencia, la siguiente documentación de EL COMISIONISTA REFERIDO:',
  ], items: [
    '**a)** Constancia de Situación Fiscal vigente, con fecha de emisión no mayor a 30 (treinta) días.',
    '**b)** Comprobante de domicilio con antigüedad no mayor a 3 (tres) meses.',
    '**c)** Identificación oficial vigente (INE o pasaporte) de EL COMISIONISTA REFERIDO o, en su caso, de su representante legal.',
    '**d)** En caso de persona moral, copia del acta constitutiva y del poder de su representante legal.',
  ], paras2: [
    'Asimismo, EL REFERIDOR entregará a la firma del presente contrato su propia Constancia de Situación Fiscal, comprobante de domicilio, identificación oficial y los datos de la cuenta bancaria a su nombre para el pago de la Comisión por Referencia.',
    '**La referencia surtirá efectos únicamente a partir de la fecha en que REFATRIX reciba completa la documentación señalada en esta cláusula.** No se generará Comisión por Referencia alguna respecto de cobranzas recibidas antes de dicha fecha. EL REFERIDOR deberá informar a REFATRIX cualquier cambio en los datos de EL COMISIONISTA REFERIDO de que tenga conocimiento.',
  ] });
  sec.push({ key: 'c3', title: 'Tercera. Comisión por referencia', paras: [
    `Como única contraprestación por la referencia, REFATRIX pagará a EL REFERIDOR una comisión equivalente al ${rateTxt} del monto efectivamente cobrado por REFATRIX derivado de las ventas generadas por EL COMISIONISTA REFERIDO (la "Comisión por Referencia"). Para efectos de este contrato:`,
  ], items: [
    '**a)** La base de cálculo será el monto efectivamente cobrado y acreditado en las cuentas bancarias de REFATRIX, **antes del Impuesto al Valor Agregado (IVA)** y de cualquier otro impuesto trasladado, neto de devoluciones, bonificaciones, descuentos y notas de crédito.',
    '**b)** Únicamente se considerarán las ventas que, conforme a los registros del sistema ERP de REFATRIX, se encuentren asignadas a EL COMISIONISTA REFERIDO y por las cuales éste tenga derecho a recibir su propia comisión.',
    '**c)** La Comisión por Referencia se genera únicamente cuando EL COMISIONISTA REFERIDO genere a su vez su propia comisión. Si por cualquier causa no tuviere derecho a comisión respecto de una venta o cobranza, tampoco se generará Comisión por Referencia respecto de la misma.',
    '**d)** No se considerarán las ventas no cobradas, los cobros parciales pendientes de aplicación ni los anticipos que posteriormente sean reembolsados.',
  ], paras2: [
    'La Comisión por Referencia es adicional e independiente de la comisión que REFATRIX pague a EL COMISIONISTA REFERIDO y no la reducirá ni afectará.',
  ] });
  sec.push({ key: 'c4', title: 'Cuarta. Periodo de cálculo y fecha de pago', items: [
    '**a)** La Comisión por Referencia se calculará por mes calendario, sumando los montos efectivamente cobrados **del día primero al último día de cada mes**.',
    '**b)** REFATRIX pagará la Comisión por Referencia de cada mes **el día 15 (quince) del mes inmediato siguiente**. Si dicho día fuera inhábil, el pago se realizará el día hábil siguiente.',
    '**c)** El pago se realizará mediante transferencia electrónica a la cuenta bancaria a nombre de EL REFERIDOR que éste designe por escrito.',
  ] });
  sec.push({ key: 'c5', title: 'Quinta. Facturación', items: [
    '**a)** Como requisito indispensable para el pago, EL REFERIDOR deberá emitir y entregar a REFATRIX el **CFDI** correspondiente al monto de la Comisión por Referencia de cada mes, cumpliendo con los requisitos fiscales vigentes, **a más tardar el día 10 (diez) del mes de pago**.',
    '**b)** Si EL REFERIDOR no entrega el CFDI en tiempo, o el mismo contiene errores, el pago se realizará en la siguiente fecha de pago posterior a la recepción del CFDI correcto, sin intereses, penalidad ni responsabilidad alguna a cargo de REFATRIX.',
    '**c)** REFATRIX efectuará, en su caso, las retenciones de impuestos que conforme a la legislación fiscal vigente le correspondan.',
  ] });
  sec.push({ key: 'c6', title: 'Sexta. Transparencia y acceso a información', items: [
    `**a)** REFATRIX otorgará a EL REFERIDOR acceso de consulta, a través de su sistema ERP (sección Comisión), a la información de ventas y cobranza generadas por EL COMISIONISTA REFERIDO (${B.name || 'el comisionista referido'}), así como al cálculo de la Comisión por Referencia de cada mes.`,
    '**b)** El acceso será exclusivamente de consulta, personal e intransferible, y se limitará a la información relacionada con EL COMISIONISTA REFERIDO. EL REFERIDOR no podrá modificar información ni acceder a datos de otros clientes, comisionistas o áreas de REFATRIX.',
    '**c)** EL REFERIDOR podrá formular por escrito observaciones al cálculo dentro de los 5 (cinco) días hábiles siguientes a su publicación en el ERP. Transcurrido dicho plazo sin observaciones, el cálculo se tendrá por aceptado.',
  ] });
  sec.push({ key: 'c7', title: 'Séptima. Supuestos en que no existe obligación de pago', paras: [
    'REFATRIX no tendrá obligación de pagar la Comisión por Referencia, total o parcialmente, respecto de las ventas o cobranzas en las que se presente cualquiera de los siguientes supuestos:',
  ], items: [
    '**a)** Falta de pago, pago parcial, pago extemporáneo o insolvencia del cliente final.',
    '**b)** Cancelación de la venta, devolución de mercancía, reclamación de garantía, emisión de notas de crédito o bonificaciones.',
    '**c)** Cheques devueltos, contracargos, cancelación de transferencias o cualquier pago que no quede firme en favor de REFATRIX.',
    '**d)** Ventas o cobranzas objeto de controversia, irregularidad, error o investigación, hasta que se resuelva a favor de REFATRIX.',
    '**e)** Incumplimiento por parte de EL COMISIONISTA REFERIDO de sus obligaciones o cualquier conducta contraria a las políticas comerciales de REFATRIX.',
    '**f)** Cualquier otra causa por la cual EL COMISIONISTA REFERIDO pierda o no adquiera el derecho a su propia comisión.',
  ], paras2: [
    'Si REFATRIX hubiere pagado una Comisión por Referencia respecto de ventas o cobranzas que posteriormente se ubiquen en alguno de los supuestos anteriores, **podrá descontar el importe de las Comisiones por Referencia futuras**. Si no existieren comisiones futuras suficientes, EL REFERIDOR deberá reembolsarlo dentro de los 15 (quince) días naturales siguientes al requerimiento por escrito.',
  ] });
  sec.push({ key: 'c8', title: 'Octava. Duración del derecho a comisión', paras: [
    'EL REFERIDOR tendrá derecho a la Comisión por Referencia mientras se encuentre vigente el presente contrato y, a la vez, el Contrato del Comisionista Referido. La terminación de este último por cualquier causa extinguirá el derecho de EL REFERIDOR a Comisiones por Referencia por cobranzas posteriores, sin responsabilidad para REFATRIX.',
  ] });
  sec.push({ key: 'c9', title: 'Novena. Vigencia y terminación', items: [
    `**a)** El presente contrato tiene vigencia **a partir del ${fechaLarga(t.start)}**${t.end ? ` **y hasta el ${fechaLarga(t.end)}**` : ' por 1 (un) año, y se renovará automáticamente por periodos iguales salvo que alguna de LAS PARTES notifique por escrito su deseo de no renovarlo con al menos 30 (treinta) días naturales de anticipación'}.`,
    '**b)** Cualquiera de LAS PARTES podrá darlo por terminado anticipadamente, sin causa y sin responsabilidad, mediante aviso por escrito con 30 (treinta) días naturales de anticipación.',
    '**c)** REFATRIX podrá rescindirlo de manera inmediata, sin necesidad de declaración judicial, en caso de incumplimiento de EL REFERIDOR, en particular de sus obligaciones de confidencialidad.',
    '**d)** A la terminación, REFATRIX pagará únicamente las Comisiones por Referencia devengadas por cobranzas efectivamente recibidas hasta la fecha de terminación, sujetas a la cláusula Séptima.',
  ] });
  sec.push({ key: 'c10', title: 'Décima. Independencia de las partes', paras: [
    'La relación es de carácter estrictamente mercantil, regida por los artículos 273 y demás relativos del Código de Comercio. EL REFERIDOR actúa de manera independiente, con sus propios medios y bajo su propia responsabilidad; no existe relación laboral, de subordinación, sociedad, asociación ni mandato con REFATRIX. EL REFERIDOR es el único responsable de sus obligaciones fiscales, de seguridad social y de cualquier otra naturaleza.',
    'EL REFERIDOR no está facultado para representar a REFATRIX, celebrar contratos, otorgar descuentos, recibir pagos ni asumir obligaciones en su nombre.',
  ] });
  sec.push({ key: 'c11', title: 'Décima primera. Confidencialidad', paras: [
    'EL REFERIDOR mantendrá en estricta confidencialidad toda la información a la que tenga acceso con motivo de este contrato, incluyendo la del sistema ERP, ventas, clientes, precios, condiciones comerciales y comisiones, y no la divulgará ni utilizará para fines distintos a la verificación de la Comisión por Referencia. Esta obligación subsistirá durante la vigencia del contrato y por 2 (dos) años posteriores a su terminación.',
  ] });
  sec.push({ key: 'c12', title: 'Décima segunda. Cesión', paras: [
    'EL REFERIDOR no podrá ceder ni transmitir total o parcialmente los derechos y obligaciones de este contrato sin el consentimiento previo y por escrito de REFATRIX.',
  ] });
  sec.push({ key: 'c13', title: 'Décima tercera. Notificaciones', paras: [
    'Las notificaciones entre LAS PARTES se realizarán por escrito en sus domicilios o por correo electrónico o WhatsApp a los datos de contacto que cada parte tenga registrados en el ERP de REFATRIX.',
  ] });
  sec.push({ key: 'c14', title: 'Décima cuarta. Modificaciones y firma electrónica', paras: [
    'Cualquier modificación a este contrato deberá constar por escrito. Cuando REFATRIX cambie en el ERP alguna condición de este contrato, EL REFERIDOR deberá aceptarla de nuevo en el ERP.',
    'LAS PARTES reconocen que la aceptación de este contrato en el ERP de REFATRIX mediante **firma autógrafa digitalizada y PIN personal** de EL REFERIDOR, con registro de fecha, hora, versión, dirección IP y dispositivo, constituye su consentimiento expreso por medios electrónicos en términos de los artículos 89 y siguientes del Código de Comercio, y produce los mismos efectos que la firma autógrafa.',
  ] });
  sec.push({ key: 'c15', title: 'Décima quinta. Legislación aplicable y jurisdicción', paras: [
    'Para la interpretación y cumplimiento del presente contrato, LAS PARTES se someten a las leyes federales de los Estados Unidos Mexicanos y a la jurisdicción de los tribunales competentes de la ciudad de Monterrey, Nuevo León, renunciando a cualquier otro fuero que pudiera corresponderles.',
  ] });

  const version = referralHash(t);
  return {
    title: 'Contrato de Comisión Mercantil por Referencia',
    version, rules_version: REFERRAL_RULES_VERSION,
    parties: {
      company: co, company_rfc: t.company.rfc || null,
      referrer: t.referrer.name || '', referred: B.name || t.referred.user || '',
      rate: t.rate, start: t.start, end: t.end,
    },
    intro: `Contrato de comisión mercantil por referencia que celebran, por una parte, **${co}** (en lo sucesivo "REFATRIX") y, por la otra, **${t.referrer.name || 'EL REFERIDOR'}** (en lo sucesivo "EL REFERIDOR"), a quienes en conjunto se les denominará "LAS PARTES".`,
    sections: sec,
    declaration: `Leí y acepto el Contrato de Comisión por Referencia (versión #${version}) por la referencia de **${B.name || 'EL COMISIONISTA REFERIDO'}**, con una comisión del **${pct(t.rate)}** sobre lo cobrado sin IVA. Mi firma y mi PIN confirman esta aceptación.`,
  };
}

// ── 효력일 (순수) ───────────────────────────────────────────────────
//   서류 미완비 또는 서명 전이면 null(아직 효력 없음 → 소개 커미션 0).
export function effectiveFrom({ start_date, docs_complete_on, first_signed_on }) {
  if (!start_date || !docs_complete_on || !first_signed_on) return null;
  return [String(start_date).slice(0, 10), String(docs_complete_on).slice(0, 10), String(first_signed_on).slice(0, 10)].sort().pop();
}

// ── 인보이스별 소개 커미션 (순수) ──────────────────────────────────
//   c   = commissionRoutes.computeLine(row) 결과(B 기준)
//   row = 같은 행(last_pay_date, rp_paid, rp_amount, rp_base 포함)
//   ctx = { rate, effective (YYYY-MM-DD|null), end (YYYY-MM-DD|null) }
//   status:
//     paid      : 이미 A 에게 지급(금액 동결)
//     confirmed : 완납 · B 커미션 있음 · 효력 기간 안 → 지급 대상(settle_ym = 완납월)
//     pending   : B 커미션 있음 · 아직 미수(완납 시 대상)
//     before    : 효력일 전에 완납(대상 아님) / inactive: 아직 효력 없음(서류·서명)
//     after_end : 계약 종료 후 완납
//     none      : B 가 커미션을 받지 않는 매출 → 목록에서 뺀다
export function computeReferralLine(c, row, ctx) {
  const rate = Number(ctx.rate) || 0;
  const bEarns = c.mode === 'payment' ? (c.accrued > 0 || c.potential > 0) : c.expected > 0;
  const paid = row.rp_paid === true;
  const lastPay = row.last_pay_date ? String(row.last_pay_date).slice(0, 10) : null;
  const base = r2(c.mode === 'payment' ? c.collected_base : c.base);
  if (paid) {
    // 지급분은 지급 시점 금액으로 동결(율·기간 변경에도 불변). base 는 표시용 현재 기준액.
    return { status: 'paid', base, amount: r2(row.rp_amount), settleYm: row.rp_settle_ym || (lastPay ? lastPay.slice(0, 7) : null), b_earns: bEarns };
  }
  if (!bEarns) return { status: 'none', base, amount: 0, settleYm: null, b_earns: false };
  if (!c.fullyPaid) {
    const estBase = r2(c.base);
    return { status: 'pending', base: estBase, amount: 0, potential: r2(estBase * rate / 100), settleYm: null, b_earns: true };
  }
  if (!ctx.effective) return { status: 'inactive', base, amount: 0, settleYm: null, b_earns: true };
  if (!lastPay || lastPay < ctx.effective) return { status: 'before', base, amount: 0, settleYm: null, b_earns: true };
  if (ctx.end && lastPay > ctx.end) return { status: 'after_end', base, amount: 0, settleYm: null, b_earns: true };
  const amount = r2(base * rate / 100);
  if (!(amount > 0)) return { status: 'none', base, amount: 0, settleYm: null, b_earns: true };
  return { status: 'confirmed', base, amount, settleYm: lastPay.slice(0, 7), b_earns: true };
}

// 지급 후 B 매출 조정 → A 차액 (순수). row: {paid_amount, paid_base, cur_base, deleted, nc_base}
//   paid_base = 지급 시점 인보이스 순매출(ex-IVA · NC 차감) · cur_base = 지금 순매출.
//   지급 당시 실효율 유지: 새 금액 = 현재 순매출 × 지급액 / 지급 당시 순매출. 줄어든 경우만(차감).
export function computeReferralAdjustment(row) {
  const paidAmt = Number(row.paid_amount) || 0;
  const paidBase = Number(row.paid_base) || 0;
  if (!(paidBase > 0)) return null;
  const curBase = row.deleted ? 0 : Math.max(0, Number(row.cur_base) || 0);
  if (curBase >= paidBase - 0.005) return null;          // 매출이 늘어난 경우는 추가 지급하지 않는다(수금 기준 — 새 수금은 새 라인)
  const newAmt = r2(curBase * paidAmt / paidBase);
  const delta = r2(newAmt - paidAmt);
  if (Math.abs(delta) < 0.01) return null;
  const reason = row.deleted ? 'deleted' : (Number(row.nc_base) > 0 ? 'nota_credito' : 'amount_change');
  return { amount: delta, new_amount: newAmt, new_base: r2(curBase), paid_amount: r2(paidAmt), paid_base: r2(paidBase), reason };
}

// 손서명 이미지 검증 (순수). PNG dataURL · 200KB 이하 · 너무 작은(빈) 이미지 거부.
export const SIGNATURE_MAX_BYTES = 200 * 1024;
export function decodeSignature(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return { ok: false, error: 'signature_required', note: 'Firma con el dedo o el ratón en el recuadro.' };
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 200) return { ok: false, error: 'signature_empty', note: 'La firma está vacía. Firma en el recuadro.' };
  if (buf.length > SIGNATURE_MAX_BYTES) return { ok: false, error: 'signature_too_large', note: 'La imagen de la firma es demasiado grande.' };
  if (!(buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG')) return { ok: false, error: 'signature_bad', note: 'La firma no es una imagen válida.' };
  return { ok: true, dataUrl: `data:image/png;base64,${m[1]}`, bytes: buf.length };
}

// 상태 (순수): 서명 이력의 최신 해시 vs 현재 해시
export function signStatus(currentHash, latest) {
  if (!latest) return 'pending';
  return latest.version_hash === currentHash ? 'signed' : 'changed';
}

// ── A 화면 요약 (순수) ──────────────────────────────────────────────
//   lines = referralLines() 결과. 월별: 매출 = 그 달 발행분 순매출 · 수금/커미션 = 그 달 완납 확정·지급분.
export function summarizeReferral(lines) {
  const L = lines || [];
  const months = {}; const custs = {};
  const M = (ym) => (months[ym] ||= { ym, sales: 0, collected: 0, commission: 0, paid: 0, unpaid: 0, invoices: 0 });
  for (const l of L) {
    const iym = String(l.inv_date || '').slice(0, 7);
    if (iym) { const m = M(iym); m.sales = r2(m.sales + l.sale_base); m.invoices += 1; }
    const earned = l.status === 'confirmed' || l.status === 'paid';
    if (earned && l.settle_ym) {
      const m = M(l.settle_ym);
      m.collected = r2(m.collected + l.base); m.commission = r2(m.commission + l.amount);
      if (l.status === 'paid') m.paid = r2(m.paid + l.amount); else m.unpaid = r2(m.unpaid + l.amount);
    }
    const c = (custs[l.customer_id] ||= { customer_id: l.customer_id, customer_name: l.customer_name, customer_code: l.customer_code, sales: 0, collected: 0, open: 0, commission: 0, potential: 0, invoices: 0 });
    c.sales = r2(c.sales + l.sale_base); c.invoices += 1; c.open = r2(c.open + (l.open_amount || 0));
    if (earned) { c.collected = r2(c.collected + l.base); c.commission = r2(c.commission + l.amount); }
    if (l.status === 'pending') c.potential = r2(c.potential + (l.potential || 0));
  }
  const sum = (k, f) => r2(L.filter(f || (() => true)).reduce((s, l) => s + Number(l[k] || 0), 0));
  const earned = (l) => l.status === 'confirmed' || l.status === 'paid';
  return {
    months: Object.values(months).sort((a, b) => b.ym.localeCompare(a.ym)).map((m) => {
      const [y, mm] = m.ym.split('-').map(Number);
      return { ...m, pay_date: `${mm === 12 ? y + 1 : y}-${String(mm === 12 ? 1 : mm + 1).padStart(2, '0')}-15` };
    }),
    customers: Object.values(custs).sort((a, b) => b.sales - a.sales),
    totals: {
      sales: sum('sale_base'), collected: sum('base', earned), commission: sum('amount', earned),
      paid: sum('amount', (l) => l.status === 'paid'), unpaid: sum('amount', (l) => l.status === 'confirmed'),
      potential: sum('potential', (l) => l.status === 'pending'), invoices: L.length,
    },
  };
}
