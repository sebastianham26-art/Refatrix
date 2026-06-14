import { loadPerm, isRegisteredDevice } from '../permLoader.js';
import { pageAllowed } from '../permissions.js';

// 토큰 검증 + perm/기기 상태를 req 에 부착
export async function authGuard(req, reply) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const userId = req.user?.sub;
  const perm = await loadPerm(userId);
  if (!perm) return reply.code(401).send({ error: 'unknown_user' });

  // 기기 등록 키는 헤더로 전달 (브라우저 로컬에 보관된 값)
  const rawDeviceKey = req.headers['x-device-key'] || null;
  const dev = await isRegisteredDevice(userId, rawDeviceKey);

  req.ctx = { perm, deviceId: dev.deviceId, isRegistered: dev.registered };
}

// 특정 메뉴(page) 접근을 요구하는 가드 (기기 요구 포함) — 읽기 허용(view/edit 모두)
export function requirePage(pageKey) {
  return async (req, reply) => {
    const { perm, isRegistered } = req.ctx;
    if (!pageAllowed(perm, pageKey, isRegistered)) {
      return reply.code(403).send({ error: 'forbidden', page: pageKey });
    }
  };
}

// 쓰기(저장/수정/삭제/승인)를 요구하는 가드 — 'edit' 권한 필요. 디렉터는 통과.
export function requirePageEdit(pageKey) {
  return async (req, reply) => {
    const { perm, isRegistered } = req.ctx;
    if (!pageAllowed(perm, pageKey, isRegistered)) {
      return reply.code(403).send({ error: 'forbidden', page: pageKey });
    }
    if (perm.role === 'director') return;
    const lvl = (perm.pageAccess && perm.pageAccess[pageKey]) || 'edit';
    if (lvl !== 'edit') return reply.code(403).send({ error: 'read_only', page: pageKey });
  };
}

// 여러 화면키 중 하나라도 열람 가능하면 통과 (화면키 세분화 + 레거시 'sales' 하위호환)
export function requirePageAny(pageKeys) {
  return async (req, reply) => {
    const { perm, isRegistered } = req.ctx;
    if (perm.role === 'director') return;
    const ok = pageKeys.some((k) => pageAllowed(perm, k, isRegistered));
    if (!ok) return reply.code(403).send({ error: 'forbidden', page: pageKeys[0] });
  };
}

// 여러 화면키 중 하나라도 'edit'이면 쓰기 통과 (하위호환)
export function requirePageEditAny(pageKeys) {
  return async (req, reply) => {
    const { perm, isRegistered } = req.ctx;
    if (perm.role === 'director') return;
    const anyAllowed = pageKeys.some((k) => pageAllowed(perm, k, isRegistered));
    if (!anyAllowed) return reply.code(403).send({ error: 'forbidden', page: pageKeys[0] });
    const anyEdit = pageKeys.some((k) => pageAllowed(perm, k, isRegistered) && ((perm.pageAccess && perm.pageAccess[k]) || 'edit') === 'edit');
    if (!anyEdit) return reply.code(403).send({ error: 'read_only', page: pageKeys[0] });
  };
}

export function requireDirector(req, reply, done) {
  if (req.ctx.perm.role !== 'director') {
    return reply.code(403).send({ error: 'director_only' });
  }
  done();
}
