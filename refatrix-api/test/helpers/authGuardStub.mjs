// 테스트 스텁 — 인증만 대체. 헤더 x-test-user = "id:role", x-test-pages = "pricemaster=view,purchase=edit"
//   pricemaster 키는 운영 authGuard 와 같은 규칙(pageAllowed + 열람/수정)으로 검사하고, 나머지 화면 키는 통과(기존 테스트 호환).
import { pageAllowed } from '../../src/permissions.js';
const STRICT = new Set(['pricemaster']);
export async function authGuard(req, reply) {
  const [id, role] = String(req.headers['x-test-user'] || '1:director').split(':');
  const pages = {}; const pageAccess = {};
  for (const kv of String(req.headers['x-test-pages'] || '').split(',').filter(Boolean)) {
    const [k, a] = kv.split('='); pages[k] = 'anywhere'; pageAccess[k] = a || 'edit';
  }
  req.ctx = { perm: { userId: Number(id), role, pages, pageAccess, fields: new Set(), items: {} }, deviceId: null, isRegistered: true };
}
export function requirePage(pageKey) {
  return async (req, reply) => {
    if (!STRICT.has(pageKey)) return;
    if (!pageAllowed(req.ctx.perm, pageKey, true)) return reply.code(403).send({ error: 'forbidden', page: pageKey });
  };
}
export function requirePageEdit(pageKey) {
  return async (req, reply) => {
    if (!STRICT.has(pageKey)) return;
    const { perm } = req.ctx;
    if (!pageAllowed(perm, pageKey, true)) return reply.code(403).send({ error: 'forbidden', page: pageKey });
    if (perm.role === 'director') return;
    const lvl = (perm.pageAccess && perm.pageAccess[pageKey]) || 'edit';
    if (lvl !== 'edit') return reply.code(403).send({ error: 'read_only', page: pageKey });
  };
}
export function requirePageAny() { return async () => {}; }
export function requirePageEditAny() { return async () => {}; }
export function requireDirector(req, reply, done) {
  if (req.ctx.perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
  done();
}
