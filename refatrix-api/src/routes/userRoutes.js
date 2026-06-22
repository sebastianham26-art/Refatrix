import { query, withTx } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { hashPin } from '../auth.js';
import { logEvent } from '../audit.js';
import { ROLE_DEFAULTS, SCREEN_PAGE_KEY, applyRoleDefaults } from '../roleDefaults.js';

function genPin() { return String(Math.floor(1000 + Math.random() * 9000)); }

export default async function userRoutes(app) {
  // 사용자 목록(디렉터): 역할·팀·페이지 권한
  app.get('/api/users', { preHandler: [authGuard, requireDirector] }, async () => {
    const users = (await query(
      `SELECT u.id, u.name, u.login_id, u.role, u.dept, u.team_id, t.name AS team_name
         FROM users u LEFT JOIN sales_teams t ON t.id=u.team_id
        WHERE u.deleted_at IS NULL ORDER BY u.role, u.name`)).rows;
    const pages = (await query(`SELECT user_id, page_key, access FROM user_page_access`)).rows;
    const pagesByUser = {};
    const accessByUser = {};
    for (const p of pages) { (pagesByUser[p.user_id] ||= []).push(p.page_key); (accessByUser[p.user_id] ||= {})[p.page_key] = p.access || 'edit'; }
    const grants = (await query(`SELECT user_id, team_id FROM user_team_access`)).rows;
    const teamAccessByUser = {};
    for (const g of grants) (teamAccessByUser[g.user_id] ||= []).push(Number(g.team_id));
    // 계좌 목록 + 사용자별 계좌권한(인라인 선택용)
    const accountsRows = (await query(`SELECT id, name, currency FROM accounts WHERE deleted_at IS NULL ORDER BY id`)).rows;
    const accounts = accountsRows.map((a) => ({ id: Number(a.id), name: a.name, currency: a.currency }));
    const aaRows = (await query(`SELECT user_id, account_id, can_operate, can_detail FROM user_account_access`)).rows;
    const aaByUser = {};
    for (const r of aaRows) {
      const lvl = r.can_operate === true ? 'operate' : (r.can_detail === false ? 'balance' : 'view');
      (aaByUser[r.user_id] ||= {})[Number(r.account_id)] = lvl;
    }
    return {
      accounts,
      items: users.map((u) => ({
        ...u, id: Number(u.id),
        pages: pagesByUser[u.id] || [], page_access: accessByUser[u.id] || {},
        team_access: teamAccessByUser[u.id] || [],
        account_access: aaByUser[u.id] || {},
      })),
    };
  });

  // 사용자 생성(디렉터). PIN 지정 가능(미지정 시 자동), 팀·페이지 권한 일괄 부여.
  app.post('/api/users', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const { name, dept, role, login_id, lang = 'ko', pin: pinReq, team_id, pages } = req.body || {};
    if (!name || !role || !login_id) return reply.code(400).send({ error: 'name_role_login_id_required' });
    const dup = (await query(`SELECT 1 FROM users WHERE login_id=$1`, [login_id])).rows[0];
    if (dup) return reply.code(409).send({ error: 'login_id_taken' });
    const pin = (pinReq && /^\d{4,8}$/.test(String(pinReq))) ? String(pinReq) : genPin();
    const u = (await query(
      `INSERT INTO users (name, dept, role, login_id, pin_hash, lang, team_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [name, dept || null, role, login_id, hashPin(pin), lang, team_id || null, req.ctx.perm.userId])).rows[0];
    const explicitPages = Array.isArray(pages) ? pages : [];
    for (const pk of explicitPages) {
      await query(`INSERT INTO user_page_access (user_id, page_key, device_req) VALUES ($1,$2,'anywhere') ON CONFLICT (user_id, page_key) DO NOTHING`, [u.id, pk]);
    }
    // 명시 페이지가 없으면 역할 기본 권한 자동 부여
    let applied = null;
    if (!explicitPages.length) applied = await applyRoleDefaults(u.id, role);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `user:${u.id}`, detail: applied ? { role_defaults: applied } : undefined });
    return { id: u.id, login_id, pin, applied, note: '이 PIN을 사용자에게 통보하세요. 서버에는 해시만 저장됩니다.' };
  });

  // PIN 재발급(디렉터). 지정 가능.
  app.post('/api/users/:id/reset-pin', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const id = Number(req.params.id);
    const pin = (req.body?.pin && /^\d{4,8}$/.test(String(req.body.pin))) ? String(req.body.pin) : genPin();
    await query(`UPDATE users SET pin_hash=$1, updated_by=$2 WHERE id=$3`, [hashPin(pin), req.ctx.perm.userId, id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'pin_reset', target: `user:${id}` });
    return { id, pin };
  });

  // 페이지 권한 회수(디렉터)
  app.delete('/api/users/:id/page-access', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const id = Number(req.params.id);
    const pageKey = String(req.query.page_key || '');
    await query(`DELETE FROM user_page_access WHERE user_id=$1 AND page_key=$2`, [id, pageKey]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'permission_change', target: `user:${id}`, detail: { remove_page: pageKey } });
    return { ok: true };
  });

  // 메뉴 접근/기기요구 설정(디렉터) — 권한 변경은 감사 로그에 남김
  app.put('/api/users/:id/page-access', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const id = Number(req.params.id);
    const { page_key, device_req, access } = req.body || {};
    const acc = (access === 'view' || access === 'edit') ? access : 'edit';
    await query(
      `INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, page_key) DO UPDATE SET device_req=EXCLUDED.device_req, access=EXCLUDED.access`,
      [id, page_key, device_req || 'anywhere', acc]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'permission_change', target: `user:${id}`, detail: { page_key, access: acc } });
    return { ok: true };
  });

  // 민감 필드 노출 설정(디렉터)
  app.put('/api/users/:id/field-access', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const id = Number(req.params.id);
    const { field_key, visible } = req.body || {};
    await query(
      `INSERT INTO user_field_access (user_id, field_key, visible) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, field_key) DO UPDATE SET visible=EXCLUDED.visible`,
      [id, field_key, !!visible]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'permission_change', target: `user:${id}`, detail: { field_key, visible } });
    return { ok: true };
  });

  // 기존 사용자에게 역할 기본 권한 적용(디렉터). 수동 설정은 보존하고 누락분만 추가.
  app.post('/api/users/:id/apply-role-defaults', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const u = (await query(`SELECT role FROM users WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!u) return reply.code(404).send({ error: 'not_found' });
    const applied = await applyRoleDefaults(id, u.role);
    await logEvent({ userId: req.ctx.perm.userId, action: 'permission_change', target: `user:${id}`, detail: { apply_role_defaults: u.role, applied } });
    return { ok: true, role: u.role, applied };
  });

  // 역할별 기본 권한 표(디렉터)
  app.get('/api/role-defaults', { preHandler: [authGuard, requireDirector] }, async () => {
    return { roleDefaults: ROLE_DEFAULTS, screenPageKey: SCREEN_PAGE_KEY };
  });

  // 한 계좌의 권한 레벨을 한 건 설정(인라인 드롭다운용). body: { account_id, level: 'none'|'view'|'operate' }
  app.patch('/api/users/:id/account-access', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id', got: String(req.params.id) });
    const accountId = Number(req.body?.account_id);
    const level = req.body?.level;
    if (!Number.isInteger(accountId)) return reply.code(400).send({ error: 'bad_account_id', got: String(req.body?.account_id) });
    if (!['none', 'balance', 'view', 'operate'].includes(level)) return reply.code(400).send({ error: 'bad_level' });
    const u = (await query(`SELECT id, role FROM users WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!u) return reply.code(404).send({ error: 'not_found' });
    if (u.role === 'director') return reply.code(400).send({ error: 'director_sees_all' });
    // ON CONFLICT 미사용(제약 유무와 무관): 항상 DELETE 후 필요한 경우만 INSERT.
    //   잔액만 = can_detail false / 열람 = detail true / 운영 = detail+operate true
    await withTx(async (c) => {
      await c.query(`DELETE FROM user_account_access WHERE user_id=$1 AND account_id=$2`, [id, accountId]);
      if (level !== 'none') {
        const op = level === 'operate';
        const detail = level === 'view' || level === 'operate';
        await c.query(`INSERT INTO user_account_access (user_id, account_id, can_operate, can_detail) VALUES ($1,$2,$3,$4)`,
          [id, accountId, op, detail]);
      }
    });
    await logEvent({ userId: req.ctx.perm.userId, action: 'permission_change', target: `user:${id}`,
      detail: { account_id: accountId, level } });
    return { ok: true, account_id: accountId, level };
  });

  // ===== 사용자×계좌 권한(디렉터) =====
  // 한 사용자에 대해 전체 계좌 + 그 사용자의 열람/운영 여부를 함께 반환.
  app.get('/api/users/:id/account-access', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id', got: String(req.params.id) });
    const u = (await query(`SELECT id, role FROM users WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!u) return reply.code(404).send({ error: 'not_found' });
    const accs = (await query(
      `SELECT id, name, type, currency FROM accounts WHERE deleted_at IS NULL ORDER BY id`)).rows;
    const granted = {};
    for (const r of (await query(
      `SELECT account_id, can_operate FROM user_account_access WHERE user_id=$1`, [id])).rows) {
      granted[Number(r.account_id)] = { view: true, operate: r.can_operate === true };
    }
    const isDirector = u.role === 'director';
    return {
      user_id: id, is_director: isDirector,
      items: accs.map((a) => {
        const aid = Number(a.id);
        const g = granted[aid];
        return {
          account_id: aid, name: a.name, type: a.type, currency: a.currency,
          // 디렉터는 항상 전체 열람/운영(테이블과 무관) — UI 표시용.
          view: isDirector ? true : !!g,
          operate: isDirector ? true : !!(g && g.operate),
        };
      }),
    };
  });

  // 한 사용자의 계좌 권한 전체 교체. body: { items: [{ account_id, view, operate }] }
  // view=false 면 해당 계좌 권한 제거. operate=true 는 view=true 를 함의한다.
  app.put('/api/users/:id/account-access', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id', got: String(req.params.id) });
    const u = (await query(`SELECT id, role FROM users WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!u) return reply.code(404).send({ error: 'not_found' });
    if (u.role === 'director') return reply.code(400).send({ error: 'director_sees_all' });
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    // 유효 계좌만 반영(존재·미삭제).
    const validIds = new Set((await query(`SELECT id FROM accounts WHERE deleted_at IS NULL`)).rows.map((r) => Number(r.id)));
    const keep = items
      .map((it) => ({ account_id: Number(it.account_id), operate: !!it.operate, view: it.view !== false }))
      .filter((it) => validIds.has(it.account_id) && (it.view || it.operate));
    await withTx(async (c) => {
      await c.query(`DELETE FROM user_account_access WHERE user_id=$1`, [id]);
      for (const it of keep) {
        // DELETE 후 삽입이라 충돌 없음 → ON CONFLICT 불필요(UNIQUE 제약 유무와 무관하게 동작).
        await c.query(
          `INSERT INTO user_account_access (user_id, account_id, can_operate) VALUES ($1,$2,$3)`,
          [id, it.account_id, it.operate]);
      }
    });
    await logEvent({ userId: req.ctx.perm.userId, action: 'permission_change', target: `user:${id}`,
      detail: { account_access: keep.map((k) => ({ a: k.account_id, op: k.operate })) } });
    return { ok: true, count: keep.length };
  });
}
