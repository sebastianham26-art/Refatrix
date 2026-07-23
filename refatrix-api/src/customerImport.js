// 고객 엑셀 업로드 파싱·검증(순수 함수)
// 양식 컬럼(한글+스페인어 이중언어 헤더) → 내부 필드
// 헤더 표기는 "한글 (Español)" 형식으로 다운로드되며, 업로드 시에는
// 한글 전용 / 스페인어 전용 / 이중언어 헤더를 모두 인식한다(하위호환 유지).

// 컬럼 정의 단일 소스: 내부필드 · 한글 · 스페인어
export const CUST_COLUMNS = [
  { field: 'code',          ko: '고객코드', es: 'Código' },
  { field: 'name',          ko: '고객명',   es: 'Nombre' },
  { field: 'team',          ko: '팀',       es: 'Equipo' },
  { field: 'customer_type', ko: '회사종류', es: 'Tipo' },
  { field: 'rfc',           ko: 'RFC',      es: 'RFC' },
  { field: 'owner',         ko: '담당자',   es: 'Responsable' },
  { field: 'stage',         ko: '단계',     es: 'Etapa' },
  { field: 'contact',       ko: '이메일 주소', es: 'Email' },
  { field: 'phone',         ko: '전화',     es: 'Teléfono' },
  { field: 'discount',      ko: '할인율',   es: 'Descuento %' },
  { field: 'credit_days',   ko: '외상일',   es: 'Días crédito' },
  { field: 'memo',          ko: '메모',     es: 'Nota' },
];

// 하위호환용: 한글 헤더 → 내부 필드 (기존 참조 보존)
export const CUST_COLUMN_MAP = Object.fromEntries(CUST_COLUMNS.map((c) => [c.ko, c.field]));

// 다운로드 양식 헤더: "한글 (Español)" (한글==스페인어면 한글만, 예: RFC)
export const CUST_TEMPLATE_HEADERS = CUST_COLUMNS.map((c) =>
  c.es && c.es !== c.ko ? `${c.ko} (${c.es})` : c.ko
);

export const CUSTOMER_TYPES = ['refraccionaria', 'Mayoreo', 'Flotia', 'taller', 'publico'];

// 헤더 문자열 정규화: 악센트 제거 · 소문자 · 공백 정리
function normHeader(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // 악센트 제거 (é→e, í→i 등)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// 인식 가능한 모든 헤더 형태 → 내부 필드 (정규화 키)
const HEADER_LOOKUP = (() => {
  const m = {};
  const put = (label, field) => {
    const k = normHeader(label);
    if (k && m[k] == null) m[k] = field;
  };
  for (const c of CUST_COLUMNS) {
    put(c.ko, c.field);                 // 한글 전용 (기존 파일 하위호환)
    put(c.es, c.field);                 // 스페인어 전용
    put(`${c.ko} (${c.es})`, c.field);  // 이중언어 (신규 양식)
    put(`${c.es} (${c.ko})`, c.field);  // 역순 표기도 허용
  }
  // 추가 별칭(사용자가 흔히 쓸 수 있는 표기)
  const EXTRA = [
    ['name', 'Cliente'],
    ['owner', 'Vendedor'],
    ['customer_type', 'Tipo de cliente'],
    ['customer_type', 'Tipo empresa'],
    ['memo', 'Observaciones'],
    ['discount', 'Descuento'],
    ['credit_days', 'Días de crédito'],
    ['code', 'Código cliente'],
    // 연락처 → 이메일 주소 개명에 따른 하위호환(기존 양식·표기 전부 인식)
    ['contact', '연락처'],
    ['contact', 'Contacto'],
    ['contact', '연락처 (Contacto)'],
    ['contact', 'Contacto (연락처)'],
    ['contact', '이메일'],
    ['contact', 'E-mail'],
    ['contact', 'Correo'],
    ['contact', 'Correo electrónico'],
  ];
  for (const [field, alias] of EXTRA) put(alias, field);
  return m;
})();

export function buildHeaderIndex(headerRow) {
  const idx = {};
  (headerRow || []).forEach((h, i) => {
    const field = HEADER_LOOKUP[normHeader(h)];
    if (field && idx[field] == null) idx[field] = i;
  });
  return idx;
}

function cell(row, idx, key) {
  if (idx[key] == null) return '';
  const v = row[idx[key]];
  return v == null ? '' : String(v).trim();
}

// 한 행 파싱 → {code,name,team,customer_type,...} (값만, id 해석은 라우트에서)
export function parseCustRow(row, idx) {
  if (!row || row.every((c) => c == null || String(c).trim() === '')) return null;
  const obj = {
    code: cell(row, idx, 'code') || null,
    name: cell(row, idx, 'name'),
    team: cell(row, idx, 'team') || null,
    customer_type: cell(row, idx, 'customer_type') || null,
    rfc: cell(row, idx, 'rfc') || null,
    owner: cell(row, idx, 'owner') || null,
    stage: cell(row, idx, 'stage') || null,
    contact: cell(row, idx, 'contact') || null,
    phone: cell(row, idx, 'phone') || null,
    discount: cell(row, idx, 'discount') || '',
    credit_days: cell(row, idx, 'credit_days') || '',
    memo: cell(row, idx, 'memo') || null,
  };
  obj.discount = obj.discount === '' ? 0 : Number(String(obj.discount).replace(/[^0-9.\-]/g, '')) || 0;
  obj.credit_days = obj.credit_days === '' ? 0 : parseInt(String(obj.credit_days).replace(/[^0-9\-]/g, ''), 10) || 0;
  return obj;
}

// 검증: 이름 필수, 회사종류 유효성(있으면), 팀 필수(미리보기에서 팀 해석 결과로 최종 판단)
export function validateCustRow(obj) {
  const errs = [];
  if (!obj.name) errs.push('고객명 누락');
  if (obj.customer_type && !CUSTOMER_TYPES.includes(obj.customer_type)) errs.push('회사종류 값 오류');
  return errs;
}

// 미리보기 집계
export function buildCustPreview(parsedRows, resolve) {
  // resolve: { teamByName:{}, ownerByName:{}, stageByName:{}, existingByCode:Set, existingByCodeData:{} }
  const result = { create: [], update: [], errors: [] };
  const existData = resolve.existingByCodeData || {};
  // 할인율·외상일은 엑셀 일괄수정 대상에서 제외(고객 폼의 이유·조건 + 디렉터 승인 경로로만 변경)
  const CMP = [
    ['name', '고객명'], ['rfc', 'RFC'], ['customer_type', '회사종류'],
    ['contact', '이메일 주소'], ['phone', '전화'], ['memo', '메모'],
  ];
  for (const p of parsedRows) {
    const errs = validateCustRow(p);
    let teamId = null;
    if (p.team) { teamId = resolve.teamByName[p.team.toLowerCase()] ?? null; if (!teamId) errs.push('팀 이름 매칭 안됨: ' + p.team); }
    else errs.push('팀 누락');
    if (p.owner && !(p.owner.toLowerCase() in resolve.ownerByName)) errs.push('담당자 매칭 안됨: ' + p.owner);
    if (p.stage && !(p.stage.toLowerCase() in resolve.stageByName)) errs.push('단계 매칭 안됨: ' + p.stage);
    if (errs.length) { result.errors.push({ name: p.name, code: p.code, errors: errs }); continue; }
    const isUpdate = p.code && resolve.existingByCode.has(p.code.toLowerCase());
    if (isUpdate) {
      const cur = existData[p.code.toLowerCase()] || {};
      const changes = [];
      for (const [k, label] of CMP) {
        let nv = p[k]; let ov = cur[k];
        if (k === 'discount') { nv = Number(nv) || 0; ov = Number(ov) || 0; }
        else if (k === 'credit_days') { nv = parseInt(nv, 10) || 0; ov = parseInt(ov, 10) || 0; }
        else { nv = (nv == null || nv === '') ? null : String(nv); ov = (ov == null || ov === '') ? null : String(ov); }
        if (String(nv ?? '') !== String(ov ?? '')) changes.push({ field: label, from: ov, to: nv });
      }
      // 팀 변경
      if (cur.team_id != null && Number(cur.team_id) !== Number(teamId)) changes.push({ field: '팀', from: cur.team_name, to: p.team });
      // 할인/외상일이 다르게 입력됐어도 적용되지 않음을 미리보기에 안내
      const termsSkipped = (Number(p.discount) || 0) !== (Number(cur.discount) || 0)
        || (parseInt(p.credit_days, 10) || 0) !== (parseInt(cur.credit_days, 10) || 0);
      result.update.push({ code: p.code, name: p.name, team: p.team, customer_type: p.customer_type, changes, unchanged: changes.length === 0, terms_skipped: termsSkipped });
    } else {
      result.create.push({ code: p.code, name: p.name, team: p.team, customer_type: p.customer_type });
    }
  }
  return result;
}
