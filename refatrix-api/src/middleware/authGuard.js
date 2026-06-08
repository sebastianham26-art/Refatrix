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

// 특정 메뉴(page) 접근을 요구하는 가드 (기기 요구 포함)
export function requirePage(pageKey) {
  return async (req, reply) => {
    const { perm, isRegistered } = req.ctx;
    if (!pageAllowed(perm, pageKey, isRegistered)) {
      return reply.code(403).send({ error: 'forbidden', page: pageKey });
    }
  };
}

export function requireDirector(req, reply, done) {
  if (req.ctx.perm.role !== 'director') {
    return reply.code(403).send({ error: 'director_only' });
  }
  done();
}
