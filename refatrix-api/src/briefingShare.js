// =====================================================================
// Refatrix ERP · briefingShare.js
//   "오늘의 브리핑 · 미결 누적"의 socio(파트너) 공유 옵션 — 디렉터가 켜고 끈다.
//   브리핑 라우트와 미결 라우트가 같은 게이트를 쓰도록 공용화(기준 1곳).
//
//   · 저장 위치: company_settings(id=1).briefing_share_socio  (기본 FALSE)
//   · 열람 허용: 디렉터(항상) / socio(옵션 ON 일 때만) / 그 외 없음
//   · 조치(스누즈·무시·자동todo·AI스캔·토글 변경)는 디렉터 전용 — 각 라우트에서 별도 강제.
// =====================================================================
import { query } from './db.js';

// 현재 공유 옵션 값. 설정행이 없거나 조회 실패해도 안전하게 false(디렉터 전용).
export async function getShareSocio() {
  try {
    const r = (await query(`SELECT briefing_share_socio FROM company_settings WHERE id=1`)).rows[0];
    return !!(r && r.briefing_share_socio);
  } catch (_) {
    return false;
  }
}

// 공유 옵션 변경(디렉터 전용 — 호출부에서 역할 확인). 설정행이 없으면 생성.
export async function setShareSocio(value, userId) {
  const v = !!value;
  await query(
    `INSERT INTO company_settings (id, briefing_share_socio, updated_by, updated_at)
     VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET briefing_share_socio=EXCLUDED.briefing_share_socio,
                                    updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [v, userId]);
  return v;
}

// 열람 게이트 — 브리핑/미결 GET 이 공용으로 사용.
//   returns { allowed, role, share_socio, can_toggle, read_only }
//     allowed    : 카드를 볼 수 있는가
//     can_toggle : 공유 옵션을 바꿀 수 있는가(디렉터만)
//     read_only  : 조치 버튼을 숨겨야 하는가(socio = true)
export async function briefingViewer(perm) {
  const role = (perm && perm.role) || '';
  const share = await getShareSocio();
  if (role === 'director') {
    return { allowed: true, role, share_socio: share, can_toggle: true, read_only: false };
  }
  if (role === 'socio') {
    return { allowed: share, role, share_socio: share, can_toggle: false, read_only: true };
  }
  return { allowed: false, role, share_socio: share, can_toggle: false, read_only: true };
}
