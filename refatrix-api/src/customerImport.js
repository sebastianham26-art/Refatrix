// 고객 엑셀 업로드 파싱·검증(순수 함수)
// 양식 컬럼(한글 헤더) → 내부 필드
export const CUST_COLUMN_MAP = {
  '고객코드': 'code',
  '고객명': 'name',
  '팀': 'team',
  '회사종류': 'customer_type',
  'RFC': 'rfc',
  '담당자': 'owner',
  '단계': 'stage',
  '연락처': 'contact',
  '전화': 'phone',
  '할인율': 'discount',
  '외상일': 'credit_days',
  '메모': 'memo',
};

export const CUST_TEMPLATE_HEADERS = Object.keys(CUST_COLUMN_MAP);
export const CUSTOMER_TYPES = ['refraccionaria', 'Mayoreo', 'Flotia', 'taller', 'publico'];

export function buildHeaderIndex(headerRow) {
  const idx = {};
  (headerRow || []).forEach((h, i) => {
    const key = String(h == null ? '' : h).trim();
    if (CUST_COLUMN_MAP[key]) idx[CUST_COLUMN_MAP[key]] = i;
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
  // resolve: { teamByName:{}, ownerByName:{}, stageByName:{}, existingByCode:Set }
  const result = { create: [], update: [], errors: [] };
  for (const p of parsedRows) {
    const errs = validateCustRow(p);
    // 팀 해석
    let teamId = null;
    if (p.team) { teamId = resolve.teamByName[p.team.toLowerCase()] ?? null; if (!teamId) errs.push('팀 이름 매칭 안됨: ' + p.team); }
    else errs.push('팀 누락');
    if (p.owner && !(p.owner.toLowerCase() in resolve.ownerByName)) errs.push('담당자 매칭 안됨: ' + p.owner);
    if (p.stage && !(p.stage.toLowerCase() in resolve.stageByName)) errs.push('단계 매칭 안됨: ' + p.stage);
    if (errs.length) { result.errors.push({ name: p.name, code: p.code, errors: errs }); continue; }
    const isUpdate = p.code && resolve.existingByCode.has(p.code.toLowerCase());
    (isUpdate ? result.update : result.create).push({ code: p.code, name: p.name, team: p.team, customer_type: p.customer_type });
  }
  return result;
}
