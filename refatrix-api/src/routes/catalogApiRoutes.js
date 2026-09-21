// 카탈로그 조회 API (0221) — 공개 창구 + 관리 화면용 라우트
//
//   공개:  /api/catalog/v1/...        키를 가진 고객사가 호출한다. 로그인 없음.
//   관리:  /api/catalog/admin/...     디렉터만. 고객사 등록·키 발급·이력.
//
//   공개 창구의 규칙(계약서 3·13항)
//     · 접속창 밖      → 403 ERR_FUERA_DE_VENTANA + proximaVentana
//     · 그 주 동기화를 이미 닫았으면 → 429 ERR_YA_SINCRONIZADO + proximaVentana
//     · 접속창 안 호출 수 초과 → 429 ERR_RATE_LIMIT
//     · 어떤 경우에도 **호출 1건 = 이력 1행**. 상대와 이야기할 때 근거가 되는 건 이 표뿐이다.
import crypto from 'node:crypto';
import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import {
  mxParts, mxIso, windowState, clientByToken, clientById, fetchPage, fetchOne,
  countProducts, listBrands, openRun, advanceRun, callsInWindow, logCall,
  ipAllowed, decodeCursor, encodeCursor, pageLimit, catalogTablesReady,
  purchasePrice, usedDiscount,
} from '../catalogPull.js';

const guard = { preHandler: [authGuard, requireDirector] };

const MSG = {
  ERR_API_KEY: 'API key ausente, incorrecta o revocada.',
  ERR_IP: 'La direccion IP desde la que llaman no esta autorizada.',
  ERR_NOT_FOUND: 'El codigo no existe en el catalogo.',
  ERR_RATE_LIMIT: 'Se excedio el numero de llamadas permitidas dentro de la ventana.',
  ERR_INTERNAL: 'Error temporal del lado de Refatrix. Reintenten con espera creciente.',
};

async function safeLog(args) { try { await logEvent(args); } catch (_) { /* ignore */ } }

/** 상대가 읽는 건 codigoError 와 mensaje 뿐이다 — 항상 같은 모양으로 돌려준다. */
function err(reply, status, code, mensaje, extra = {}) {
  return reply.code(status).send({ codigoError: code, mensaje: mensaje || MSG[code] || '', ...extra });
}

/** 키 읽기 — 헤더가 정본이다. 쿼리로 와도 받아 주되 **응답에 경고를 실어** 고치게 한다. */
function readKey(req) {
  const h = req.headers || {};
  const hv = (n) => { const v = h[n]; return v == null ? '' : String(Array.isArray(v) ? v[0] : v).trim(); };
  for (const n of ['x-api-key', 'apikey', 'x-apikey']) {
    const v = hv(n);
    if (v) return { token: v, where: 'header' };
  }
  const auth = hv('authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    return { token: (m ? m[1] : auth).trim(), where: 'header' };
  }
  const q = req.query || {};
  for (const n of ['apiKey', 'apikey', 'api_key', 'key']) {
    if (q[n] != null && String(q[n]).trim()) return { token: String(q[n]).trim(), where: 'query' };
  }
  return { token: null, where: 'none' };
}

const AVISO_QUERY = 'La llave llego en la direccion (query). El contrato pide el encabezado x-api-key: '
  + 'la direccion queda escrita en registros y proxies. Por favor cambien a encabezado.';

/**
 * 공개 창구의 공통 관문. 통과하면 { client, win, run, env } 를 돌려준다.
 *   막혔으면 { stop: true } 다 — 이미 응답을 보낸 뒤이므로 호출부는 reply 를 그대로 돌려주면 된다.
 *   ⚠ 여기서 Fastify 의 reply 를 await 하면 안 된다. reply 는 thenable 이라
 *     await 하면 undefined 가 되고, 관문이 막은 줄 모른 채 본문이 실행된다.
 */
async function gate(req, reply, { needsRun }) {
  const t0 = Date.now();
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const path = req.raw.url ? String(req.raw.url).split('?')[0] : '';
  const qs = req.raw.url && req.raw.url.includes('?') ? String(req.raw.url).split('?')[1] : '';
  const base = { remote_ip: ip, path, query: qs ? qs.replace(/(apiKey|apikey|api_key|key)=[^&]*/gi, '$1=***') : '' };
  const fail = async (status, code, mensaje, extra) => {
    await logCall({ ...base, http_status: status, codigo_error: code, ms: Date.now() - t0,
      client_id: extra && extra.client_id, env: extra && extra.env });
    err(reply, status, code, mensaje, extra && extra.body);
    return true;
  };

  if (!(await catalogTablesReady())) {
    return { stop: await fail(503, 'ERR_INTERNAL', 'El servicio aun no esta habilitado.') };
  }

  const { token, where } = readKey(req);
  if (!token) return { stop: await fail(401, 'ERR_API_KEY', 'Falta el encabezado x-api-key.') };

  const client = await clientByToken(token);
  if (!client) return { stop: await fail(401, 'ERR_API_KEY') };
  if (!client.enabled) {
    return { stop: await fail(401, 'ERR_API_KEY', 'La llave esta deshabilitada. Contacten a Refatrix.',
      { client_id: client.id, env: client.env }) };
  }
  if (!ipAllowed(client, ip)) {
    return { stop: await fail(403, 'ERR_IP', null, { client_id: client.id, env: client.env }) };
  }

  const now = Date.now();
  const win = windowState(client, now);
  // 테스트 키는 접속창을 적용하지 않는다 — 개발자가 평일에 붙어 봐야 한다(계약서 2.1·17항).
  if (client.env === 'prod' && !win.open) {
    return { stop: await fail(403, 'ERR_FUERA_DE_VENTANA',
      ventanaMsg(client), { client_id: client.id, env: client.env,
        body: { proximaVentana: win.nextOpen } }) };
  }

  // 레이트리밋 — 이 접속창이 열린 시각부터 센다.
  const p = mxParts(now);
  const sinceIso = mxIso(p.ymd, Number(client.window_start_hour));
  const used = await callsInWindow(client.id, new Date(sinceIso).toISOString());
  if (used >= Number(client.max_calls)) {
    return { stop: await fail(429, 'ERR_RATE_LIMIT', null, { client_id: client.id, env: client.env }) };
  }

  let run = null;
  if (needsRun) {
    const r = await openRun(client, win.periodKey, client.env,
      { fresh: !(req.query && req.query.cursor) });
    if (!r.ok) {
      return { stop: await fail(429, 'ERR_YA_SINCRONIZADO',
        'La sincronizacion de este periodo ya se completo.',
        { client_id: client.id, env: client.env, body: { proximaVentana: win.nextOpen } }) };
    }
    run = r.run;
  }

  return { client, win, run, env: client.env, t0, base, aviso: where === 'query' ? AVISO_QUERY : null };
}

function ventanaMsg(c) {
  const dias = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  const hh = (h) => String(h).padStart(2, '0') + ':00';
  const cuando = c.window_dow == null ? 'todos los dias' : `los ${dias[Number(c.window_dow)]}`;
  return `La consulta esta disponible ${cuando} de ${hh(c.window_start_hour)} a ${hh(c.window_end_hour)} `
    + '(hora del centro de Mexico).';
}

export default async function catalogApiRoutes(app) {
  // ─────────────────────────── 공개 창구 ───────────────────────────

  /** 전체 카탈로그 — cursor 가 null 이 될 때까지 도는 것이 「한 번의 동기화」다. */
  app.get('/api/catalog/v1/products', async (req, reply) => {
    const g = await gate(req, reply, { needsRun: true });
    if (g.stop) return reply;
    try {
      const limit = pageLimit(req.query && req.query.limit, g.client.page_limit);
      const afterId = decodeCursor(req.query && req.query.cursor);
      const { productos, lastId } = await fetchPage(g.client, { afterId, limit });
      const done = productos.length < limit;
      const total = await countProducts(g.client);
      await advanceRun(g.run, productos.length, done);
      await logCall({ ...g.base, client_id: g.client.id, env: g.env, http_status: 200,
        items: productos.length, ms: Date.now() - g.t0, note: done ? 'ultima pagina' : null });
      const body = {
        generado: nowMxIso(),
        total,
        cursor: done || lastId == null ? null : encodeCursor(lastId),
        productos,
      };
      if (g.aviso) body.aviso = g.aviso;
      return body;
    } catch (e) {
      req.log.error({ e }, 'catalog products failed');
      await logCall({ ...g.base, client_id: g.client.id, env: g.env, http_status: 500,
        codigo_error: 'ERR_INTERNAL', ms: Date.now() - g.t0, note: String(e && e.message || e).slice(0, 300) });
      return err(reply, 500, 'ERR_INTERNAL');
    }
  });

  /** 단건 — 확인용. 주간 동기화 회차를 열지도 닫지도 않는다. */
  app.get('/api/catalog/v1/products/:codigo', async (req, reply) => {
    const g = await gate(req, reply, { needsRun: false });
    if (g.stop) return reply;
    try {
      const producto = await fetchOne(g.client, req.params.codigo);
      if (!producto) {
        await logCall({ ...g.base, client_id: g.client.id, env: g.env, http_status: 404,
          codigo_error: 'ERR_NOT_FOUND', ms: Date.now() - g.t0 });
        return err(reply, 404, 'ERR_NOT_FOUND');
      }
      await logCall({ ...g.base, client_id: g.client.id, env: g.env, http_status: 200,
        items: 1, ms: Date.now() - g.t0 });
      const body = { generado: nowMxIso(), producto };
      if (g.aviso) body.aviso = g.aviso;
      return body;
    } catch (e) {
      req.log.error({ e }, 'catalog product failed');
      await logCall({ ...g.base, client_id: g.client.id, env: g.env, http_status: 500,
        codigo_error: 'ERR_INTERNAL', ms: Date.now() - g.t0 });
      return err(reply, 500, 'ERR_INTERNAL');
    }
  });

  /** 공개 중인 대응품번 브랜드 — 고객사가 비교 컬럼을 코드에 고정하지 않게. */
  app.get('/api/catalog/v1/brands', async (req, reply) => {
    const g = await gate(req, reply, { needsRun: false });
    if (g.stop) return reply;
    try {
      const marcas = await listBrands(g.client);
      await logCall({ ...g.base, client_id: g.client.id, env: g.env, http_status: 200,
        items: marcas.length, ms: Date.now() - g.t0 });
      return { generado: nowMxIso(), marcas };
    } catch (e) {
      req.log.error({ e }, 'catalog brands failed');
      return err(reply, 500, 'ERR_INTERNAL');
    }
  });

  // ─────────────────────────── 관리 (디렉터) ───────────────────────────

  app.get('/api/catalog/admin/clients', guard, async () => {
    if (!(await catalogTablesReady())) return { migrated: false, items: [] };
    const rows = (await query(
      `SELECT c.*, cu.name AS customer_name, cu.code AS customer_code, cu.discount AS customer_discount,
              (SELECT max(created_at) FROM catalog_api_calls l WHERE l.client_id=c.id) AS last_call,
              (SELECT max(closed_at)  FROM catalog_api_runs  r WHERE r.client_id=c.id AND r.env='prod') AS last_sync,
              (SELECT max(closed_at)  FROM catalog_api_runs  r WHERE r.client_id=c.id AND r.env='test') AS last_test_sync
         FROM catalog_api_clients c
         LEFT JOIN customers cu ON cu.id=c.customer_id AND cu.deleted_at IS NULL
        ORDER BY c.id`)).rows;
    return { migrated: true, items: rows.map(publicClient) };
  });

  app.post('/api/catalog/admin/clients', guard, async (req, reply) => {
    if (!(await catalogTablesReady())) return reply.code(503).send({ error: 'migration_required' });
    const label = String(req.body?.label || '').trim();
    if (!label) return reply.code(400).send({ error: 'label_required' });
    const r = (await query(
      `INSERT INTO catalog_api_clients (label, customer_id, created_by, updated_by)
       VALUES ($1,$2,$3,$3) RETURNING id`,
      [label, numOrNull(req.body?.customer_id), req.ctx.perm.userId || null])).rows[0];
    await safeLog({ userId: req.ctx.perm.userId, action: 'create',
      target: `catalog_client:${r.id}`, detail: { label } });
    return { ok: true, id: Number(r.id) };
  });

  // 화면에서 바꿀 수 있는 것만 받는다 — 키는 여기서 못 바꾼다(발급 전용 경로가 따로 있다).
  const EDITABLE = ['label', 'customer_id', 'enabled', 'window_enforced', 'window_dow',
    'window_start_hour', 'window_end_hour', 'syncs_per_period', 'max_calls', 'page_limit',
    'stock_mode', 'img_base_url', 'brands', 'include_inactive', 'ip_allow', 'note',
    'exclude_prefixes', 'ref_source'];

  app.patch('/api/catalog/admin/clients/:id', guard, async (req, reply) => {
    if (!(await catalogTablesReady())) return reply.code(503).send({ error: 'migration_required' });
    const id = Number(req.params.id);
    const cur = await clientById(id);
    if (!cur) return reply.code(404).send({ error: 'not_found' });

    const patch = {};
    for (const k of EDITABLE) if (k in (req.body || {})) patch[k] = req.body[k];
    const bad = validatePatch(patch);
    if (bad.length) return reply.code(400).send({ error: 'validation', fields: bad });
    if (!Object.keys(patch).length) return { ok: true, unchanged: true };

    const sets = []; const params = [];
    for (const [k, v] of Object.entries(patch)) {
      params.push(normalizeValue(k, v));
      sets.push(`${k} = $${params.length}`);
    }
    params.push(req.ctx.perm.userId || null);
    sets.push(`updated_by = $${params.length}`);
    sets.push('updated_at = now()');
    params.push(id);
    await query(`UPDATE catalog_api_clients SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    await safeLog({ userId: req.ctx.perm.userId, action: 'update',
      target: `catalog_client:${id}`, detail: { op: 'catalog_client', fields: Object.keys(patch) } });
    return { ok: true };
  });

  /**
   * 키 발급 — 서버가 만든다. 응답에 **한 번만** 평문으로 실려 나가고 다시는 볼 수 없다.
   *   분실하면 다시 발급하고 상대에게 새 키를 준다(이전 키는 그 순간 무효).
   */
  app.post('/api/catalog/admin/clients/:id/key', guard, async (req, reply) => {
    if (!(await catalogTablesReady())) return reply.code(503).send({ error: 'migration_required' });
    const id = Number(req.params.id);
    const cur = await clientById(id);
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    const env = ['test', 'prod'].includes(String(req.body?.env)) ? String(req.body.env) : 'prod';
    const token = 'rfx_' + env + '_' + crypto.randomBytes(24).toString('hex');
    const col = env === 'prod' ? 'token_prod' : 'token_test';
    const at = env === 'prod' ? 'token_prod_at' : 'token_test_at';
    await query(`UPDATE catalog_api_clients SET ${col}=$1, ${at}=now(), updated_by=$2, updated_at=now()
                  WHERE id=$3`, [token, req.ctx.perm.userId || null, id]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'update',
      target: `catalog_client:${id}`, detail: { op: 'catalog_key_issued', env } });
    return { ok: true, env, token,
      note: '이 키는 지금 한 번만 보입니다. 고객사 기술 담당자에게 안전한 경로로 전달하세요.' };
  });

  app.post('/api/catalog/admin/clients/:id/revoke', guard, async (req, reply) => {
    if (!(await catalogTablesReady())) return reply.code(503).send({ error: 'migration_required' });
    const id = Number(req.params.id);
    const env = ['test', 'prod'].includes(String(req.body?.env)) ? String(req.body.env) : 'prod';
    const col = env === 'prod' ? 'token_prod' : 'token_test';
    await query(`UPDATE catalog_api_clients SET ${col}=NULL, updated_by=$1, updated_at=now() WHERE id=$2`,
      [req.ctx.perm.userId || null, id]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'update',
      target: `catalog_client:${id}`, detail: { op: 'catalog_key_revoked', env } });
    return { ok: true, env };
  });

  /**
   * 미리보기 — **고객이 받을 것과 똑같은 응답**을 디렉터가 먼저 본다.
   *   접속창도, 주 1회 제한도, 호출 이력도 건드리지 않는다. 가격이 맞는지 여기서 확인한다.
   */
  app.get('/api/catalog/admin/clients/:id/preview', guard, async (req, reply) => {
    if (!(await catalogTablesReady())) return reply.code(503).send({ error: 'migration_required' });
    const c = await clientById(Number(req.params.id));
    if (!c) return reply.code(404).send({ error: 'not_found' });
    const code = String(req.query?.codigo || '').trim();
    const productos = code
      ? [await fetchOne(c, code)].filter(Boolean)
      : (await fetchPage(c, { limit: Math.max(1, Math.min(20, Number(req.query?.limit) || 3)) })).productos;
    const win = windowState(c);
    return {
      ok: true,
      cliente: publicClient(c),
      precio_base: {
        customer_id: c.customer_id ? Number(c.customer_id) : null,
        customer_name: c.customer_name || null,
        descuento_maestro: c.customer_discount == null ? null : Number(c.customer_discount),
        descuento_aplicado: usedDiscount(c.customer_discount),
        ejemplo: { precioLista: 1000, precioCompra: purchasePrice(1000, c.customer_discount) },
      },
      ventana: { abierta: win.open, proxima: win.nextOpen, periodo: win.periodKey },
      total: await countProducts(c),
      productos,
    };
  });

  /**
   * 검증용 전체 내보내기 — **고객이 받게 될 것과 똑같은 값**을 한 번에 돌려준다.
   *   디렉터 전용. 접속창·주 1회 제한·호출 이력을 건드리지 않는다(우리 확인이지 고객 호출이 아니다).
   *   화면이 이 응답으로 엑셀을 만든다.
   */
  app.get('/api/catalog/admin/clients/:id/export', guard, async (req, reply) => {
    if (!(await catalogTablesReady())) return reply.code(503).send({ error: 'migration_required' });
    const c = await clientById(Number(req.params.id));
    if (!c) return reply.code(404).send({ error: 'not_found' });

    // 고객이 cursor 로 도는 것과 **같은 경로**로 모은다 — 다른 질의를 쓰면 검증이 의미를 잃는다.
    const productos = [];
    let afterId = null;
    for (let page = 0; page < 200; page++) {       // 200 × 1000 = 20만 건 안전장치
      const r = await fetchPage(c, { afterId, limit: 1000 });
      productos.push(...r.productos);
      if (r.productos.length < 1000 || r.lastId == null) break;
      afterId = r.lastId;
    }
    await safeLog({ userId: req.ctx.perm.userId, action: 'export',
      target: `catalog_client:${c.id}`, detail: { op: 'catalog_export', items: productos.length } });
    return {
      ok: true,
      generado: nowMxIso(),
      cliente: publicClient(c),
      total: productos.length,
      productos,
    };
  });

  /** 호출 이력 — 상대가 "우리는 호출했다"고 할 때 답할 수 있어야 한다. */
  app.get('/api/catalog/admin/clients/:id/calls', guard, async (req, reply) => {
    if (!(await catalogTablesReady())) return reply.code(503).send({ error: 'migration_required' });
    const id = Number(req.params.id);
    const limit = Math.max(1, Math.min(300, Number(req.query?.limit) || 100));
    const calls = (await query(
      `SELECT * FROM catalog_api_calls WHERE client_id=$1 ORDER BY id DESC LIMIT $2`, [id, limit])).rows;
    const runs = (await query(
      `SELECT * FROM catalog_api_runs WHERE client_id=$1 ORDER BY id DESC LIMIT 20`, [id])).rows;
    return {
      ok: true,
      calls: calls.map((r) => ({
        id: Number(r.id), created_at: r.created_at, remote_ip: r.remote_ip, env: r.env,
        path: r.path, query: r.query, http_status: r.http_status, codigo_error: r.codigo_error,
        items: r.items == null ? null : Number(r.items), ms: r.ms == null ? null : Number(r.ms),
        note: r.note,
      })),
      runs: runs.map((r) => ({
        id: Number(r.id), period_key: r.period_key, env: r.env, started_at: r.started_at,
        closed_at: r.closed_at, pages: Number(r.pages), productos: Number(r.productos),
      })),
    };
  });

  /** 고객 선택용 — 화면에서 고객을 고를 때 할인율을 같이 보여 준다. */
  app.get('/api/catalog/admin/customers', guard, async (req) => {
    const q = String(req.query?.q || '').trim();
    const params = [];
    let where = `deleted_at IS NULL`;
    if (q) { params.push(`%${q}%`); where += ` AND (name ILIKE $1 OR code ILIKE $1)`; }
    const rows = (await query(
      `SELECT id, code, name, discount FROM customers WHERE ${where} ORDER BY name LIMIT 50`, params)).rows;
    return { items: rows.map((r) => ({ id: Number(r.id), code: r.code, name: r.name,
      discount: r.discount == null ? 0 : Number(r.discount) })) };
  });
}

// ─────────────────────────── 도우미 ───────────────────────────

function nowMxIso() {
  const p = mxParts();
  const d = new Date(Date.now() - 360 * 60000);
  return mxIso(p.ymd, d.getUTCHours(), d.getUTCMinutes());
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeValue(k, v) {
  if (['enabled', 'window_enforced', 'include_inactive'].includes(k)) return !!v;
  if (['customer_id', 'window_dow', 'window_start_hour', 'window_end_hour',
       'syncs_per_period', 'max_calls', 'page_limit'].includes(k)) return numOrNull(v);
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** 화면이 바꾼 값이 DB 의 CHECK 에 걸리기 전에 **한국어로** 막는다. */
export function validatePatch(patch) {
  const bad = [];
  const num = (v) => (v == null || v === '' ? null : Number(v));
  if ('window_dow' in patch) {
    const d = num(patch.window_dow);
    if (d != null && (!Number.isInteger(d) || d < 0 || d > 6)) bad.push('window_dow_invalid');
  }
  const s = 'window_start_hour' in patch ? num(patch.window_start_hour) : null;
  const e = 'window_end_hour' in patch ? num(patch.window_end_hour) : null;
  if (s != null && (!Number.isInteger(s) || s < 0 || s > 23)) bad.push('window_start_invalid');
  if (e != null && (!Number.isInteger(e) || e < 1 || e > 24)) bad.push('window_end_invalid');
  if (s != null && e != null && e <= s) bad.push('window_range_invalid');
  if ('page_limit' in patch) {
    const n = num(patch.page_limit);
    if (n != null && (!Number.isInteger(n) || n < 10 || n > 1000)) bad.push('page_limit_invalid');
  }
  if ('max_calls' in patch) {
    const n = num(patch.max_calls);
    if (n != null && (!Number.isInteger(n) || n < 1 || n > 100000)) bad.push('max_calls_invalid');
  }
  if ('stock_mode' in patch && patch.stock_mode != null
      && !['qty', 'range'].includes(String(patch.stock_mode))) bad.push('stock_mode_invalid');
  if ('ref_source' in patch && patch.ref_source != null
      && !['scode', 'xref', 'both'].includes(String(patch.ref_source))) bad.push('ref_source_invalid');
  if ('exclude_prefixes' in patch && patch.exclude_prefixes) {
    const bad2 = String(patch.exclude_prefixes).split(',').map((x) => x.trim())
      .filter((x) => x && !/^[A-Za-z0-9._-]+$/.test(x));
    if (bad2.length) bad.push('exclude_prefixes_invalid');
  }
  if ('img_base_url' in patch && patch.img_base_url) {
    const u = String(patch.img_base_url).trim();
    if (!/^https?:\/\//i.test(u)) bad.push('img_base_invalid');
    if (/\s/.test(u)) bad.push('img_base_space');
  }
  return bad;
}

/** 화면으로 내려보내는 모양 — **키 값은 절대 내려가지 않는다.** 있는지 여부만 알려 준다. */
export function publicClient(r) {
  return {
    id: Number(r.id),
    label: r.label,
    enabled: r.enabled !== false,
    customer_id: r.customer_id ? Number(r.customer_id) : null,
    customer_name: r.customer_name || null,
    customer_code: r.customer_code || null,
    customer_discount: r.customer_discount == null ? null : Number(r.customer_discount),
    descuento_aplicado: usedDiscount(r.customer_discount),
    has_prod_key: !!r.token_prod,
    has_test_key: !!r.token_test,
    token_prod_at: r.token_prod_at || null,
    token_test_at: r.token_test_at || null,
    window_enforced: r.window_enforced !== false,
    window_dow: r.window_dow == null ? null : Number(r.window_dow),
    window_start_hour: Number(r.window_start_hour),
    window_end_hour: Number(r.window_end_hour),
    syncs_per_period: Number(r.syncs_per_period),
    max_calls: Number(r.max_calls),
    page_limit: Number(r.page_limit),
    stock_mode: r.stock_mode,
    img_base_url: r.img_base_url || '',
    brands: r.brands || '',
    exclude_prefixes: r.exclude_prefixes == null ? 'PRO' : r.exclude_prefixes,
    ref_source: r.ref_source || 'scode',
    include_inactive: r.include_inactive !== false,
    ip_allow: r.ip_allow || '',
    note: r.note || '',
    last_call: r.last_call || null,
    last_sync: r.last_sync || null,
    last_test_sync: r.last_test_sync || null,
  };
}
