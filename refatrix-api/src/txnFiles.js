// 거래 영수증 파일(transaction_files, 0230) — DB·HTTP 에 의존하지 않는 순수 규칙.
//   라우트(financeRoutes.js)와 테스트가 같은 함수를 쓴다.

export const TXN_FILE_MAX_BYTES = 8 * 1024 * 1024;   // 원본 8MB (base64 팽창 후 server bodyLimit 12MB 안쪽)
export const TXN_FILE_MAX_PER_TXN = 20;              // 거래 1건당 최대 파일 수

// 영수증으로 받을 형식: 사진(image/*) · PDF · CFDI XML(멕시코 팩투라는 XML+PDF 한 쌍이 흔하다).
const XML_MIMES = new Set(['text/xml', 'application/xml']);

export function validateTxnFileDataUrl(dataUrl, maxBytes = TXN_FILE_MAX_BYTES) {
  if (typeof dataUrl !== 'string' || !dataUrl) return { ok: false, error: 'empty' };
  const m = dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) return { ok: false, error: 'bad_format' };
  const mime = m[1].toLowerCase().trim();
  if (!(mime.startsWith('image/') || mime === 'application/pdf' || XML_MIMES.has(mime))) {
    return { ok: false, error: 'bad_mime' };
  }
  const b64 = m[2].replace(/\s+/g, '');
  if (!b64) return { ok: false, error: 'empty_data' };
  const pad = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0);
  const bytes = Math.floor((b64.length * 3) / 4) - pad;
  if (bytes <= 0) return { ok: false, error: 'empty_data' };
  if (bytes > maxBytes) return { ok: false, error: 'too_large' };
  return { ok: true, mime, bytes };
}

// 파일명 정리 — 경로·제어문자 제거, 120자 제한. 빈 값이면 null.
export function cleanFileName(name) {
  if (name == null) return null;
  let s = String(name).replace(/[\u0000-\u001f\u007f]/g, '').replace(/^.*[\\/]/, '').trim();
  if (!s) return null;
  if (s.length > 120) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : '';
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s;
}

// 이 거래를 볼 수 있나 — /api/transactions 목록과 같은 규칙
//   (계좌 거래내역 열람권한 · 세부차단 · 비공개 고정비는 디렉터만). 계좌 미지정(회사 공통 예정)은 누구나.
export function txnVisibleTo(perm, t, { allow, block }) {
  const accId = t.account_id == null ? null : Number(t.account_id);
  if (accId != null && allow !== null && !allow.includes(accId)) return false;
  if (accId != null && block.includes(accId)) return false;
  if (t.is_private && perm.role !== 'director') return false;
  return true;
}

// 파일을 붙일 수 있나 — 볼 수 있어야 하고, 디렉터 · 그 거래 등록자 · 계좌 운영권한자 · 계좌 미지정 거래.
//   영수증은 금액·계좌를 바꾸지 않으므로 승인된 거래에도 수정요청 없이 붙일 수 있다.
export function canAttachTxnFile(perm, t, { visible, canOperate }) {
  if (!visible) return false;
  if (perm.role === 'director') return true;
  if (t.created_by != null && Number(t.created_by) === Number(perm.userId)) return true;
  if (t.account_id == null) return true;
  return !!canOperate;
}

// 파일을 지울 수 있나 — 디렉터 또는 올린 본인.
export function canDeleteTxnFile(perm, f) {
  if (perm.role === 'director') return true;
  return f.uploaded_by != null && Number(f.uploaded_by) === Number(perm.userId);
}
