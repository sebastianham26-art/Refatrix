// 제품 카탈로그 전송(디렉터 전용) — 「지금 보내기」·시험 전송·미리보기·실행 이력.
//   전송 자체는 productSync.js 가 아웃박스에 적재하고, crmSync 워커가 밀어 낸다.
//   묶음별 요청·응답 원문은 기존 전송 이력 화면(crmSyncRoutes)에서 그대로 본다.
import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { getEndpoint, publicEndpoint, activeUrl } from '../integrations.js';
import { logEvent } from '../audit.js';
import {
  PRODUCT_KEY, runCatalogSync, listRuns, productTablesReady,
  fetchProducts, buildProduct, buildLote, chunk, mxNowParts, autoRanToday,
  SENDABLE_WHERE, EXCLUDED_PREFIXES,
} from '../productSync.js';

const ERR_NOTE = {
  migration_required: '0218_product_catalog_sync 마이그레이션이 필요합니다.',
  endpoint_missing: '연동 목록에 「제품정보」 창구가 없습니다.',
  no_products: '보낼 제품이 없습니다(products 가 비어 있습니다).',
  enqueue_failed: '전송 적재에 실패했습니다. 서버 로그를 확인하세요.',
};

export default async function productSyncRoutes(app) {
  const guard = { preHandler: [authGuard, requireDirector] };

  /** 지금 보낼 수 있는 상태인가 — 화면 상단 요약. */
  app.get('/api/product-sync/status', guard, async () => {
    const ep = await getEndpoint(PRODUCT_KEY);
    const pub = ep ? publicEndpoint(ep) : null;
    const ready = await productTablesReady();
    let counts = { total: 0, activos: 0, inactivos: 0, excluidos: 0 };
    try {
      // 건수는 **실제로 보낼 제품**만 센다(PRO* 제외) — 묶음 수 예상이 실전과 같아야 한다.
      const r = (await query(
        `SELECT COUNT(*)::int AS total,
                SUM(CASE WHEN is_active THEN 1 ELSE 0 END)::int AS activos
           FROM products WHERE ${SENDABLE_WHERE}`)).rows[0];
      const x = (await query(
        `SELECT COUNT(*)::int AS n
           FROM products WHERE deleted_at IS NULL AND code IS NOT NULL AND code <> ''`)).rows[0];
      const total = Number(r.total) || 0;
      counts = {
        total,
        activos: Number(r.activos) || 0,
        inactivos: total - (Number(r.activos) || 0),
        excluidos: Math.max(0, (Number(x.n) || 0) - total),
      };
    } catch (_) { /* products 조회 실패는 화면을 죽이지 않는다 */ }

    const batch = Math.max(10, Math.min(2000, Number(ep && ep.batch_size) || 500));
    const { ymd, hour } = mxNowParts();
    return {
      migration_ready: ready,
      endpoint: pub,
      settings: ep ? {
        img_base_url: ep.img_base_url || '',
        batch_size: batch,
        send_hour_mx: Number(ep.send_hour_mx) || 6,
        auto_send: !!ep.auto_send,
        body_shape: ep.body_shape || 'lote',
        field_map: ep.field_map || {},
      } : null,
      can_send: !!(ep && ep.enabled && activeUrl(ep)),
      blocked_reason: !ep ? 'endpoint_missing'
        : (!activeUrl(ep) ? 'url_missing' : (!ep.enabled ? 'endpoint_disabled' : null)),
      products: counts,
      excluded_prefixes: EXCLUDED_PREFIXES,          // 보내지 않는 코드 접두어(2026-09-21 · PRO)
      estimated_lotes: (ep && ep.body_shape === 'item')
        ? counts.total                               // 1건씩이면 요청 수 = 제품 수
        : Math.max(1, Math.ceil(counts.total / batch)),
      mx_today: ymd,
      mx_hour: hour,
      auto_ran_today: ready ? await autoRanToday(ymd) : false,
      last_runs: ready ? await listRuns({ limit: 5 }) : [],
    };
  });

  /** 미리보기 — 실제로 보내지 않는다. 계약서와 실제 값을 눈으로 대조하는 용도. */
  app.get('/api/product-sync/preview', guard, async (req) => {
    const ep = await getEndpoint(PRODUCT_KEY);
    const code = req.query && req.query.code ? String(req.query.code) : null;
    const rows = code ? await fetchProducts({ code }) : await fetchProducts({ limit: 2 });
    if (!rows.length) return { found: false, productos: [] };
    const productos = rows.map((r) => buildProduct(r, (ep && ep.img_base_url) || ''));
    const { ymd } = mxNowParts();
    return {
      found: true,
      productos,
      body_shape: (ep && ep.body_shape) || 'lote',
      field_map: (ep && ep.field_map) || {},
      sample_lote: buildLote({
        envioId: `CAT-${ymd}`, fechaCorte: ymd, lote: 1, totalLotes: 1,
        totalProductos: productos.length, transactionUser: 'admin', mode: 'full',
      }, productos, { map: (ep && ep.field_map) || {}, shape: (ep && ep.body_shape) || 'lote' }),
    };
  });

  /**
   * 전송 적재.
   *   mode=full  전체 카탈로그(마지막 묶음에 마감 신호 esUltimoLote)
   *   mode=test  앞에서 limit 건만. **마감 신호를 보내지 않는다** —
   *              시험 전송이 마감하면 CRM 이 나머지 전 제품을 감춰 버린다.
   */
  app.post('/api/product-sync/run', guard, async (req, reply) => {
    const body = req.body || {};
    const mode = String(body.mode || 'full') === 'test' ? 'test' : 'full';
    const limit = mode === 'test' ? Math.max(1, Math.min(50, Number(body.limit) || 5)) : null;
    const r = await runCatalogSync({
      mode, limit, origin: 'manual', actorUserId: req.ctx.perm.userId, app,
    });
    if (r.error) {
      const code = r.error === 'migration_required' ? 503 : 400;
      return reply.code(code).send({ error: r.error, note: ERR_NOTE[r.error] || null, detail: r.detail || null });
    }
    try {
      // ⚠ audit_log.action 은 체크 제약이 걸린 고정 목록이다 — 'product_sync' 를 그대로 넣으면
      //   제약 위반으로 기록이 통째로 버려진다(로그에만 남고 조용히 사라진다).
      //   목록에 있는 'update' 로 남기고, 무슨 작업이었는지는 detail 에 적는다(고객 전체 동기화와 같은 방식).
      logEvent({
        userId: req.ctx.perm.userId, deviceId: req.ctx.deviceId,
        action: 'update', target: `product_sync:${r.envio_id}`,
        detail: { op: 'product_sync', mode: r.mode, envio_id: r.envio_id,
          lotes: r.total_lotes, productos: r.total_productos },
      });
    } catch (_) { /* 감사로그 실패가 전송을 막지 않는다 */ }
    return r;
  });

  /** 실행 이력(일자별). 묶음 단위 원문은 전송 이력 화면에서 본다. */
  app.get('/api/product-sync/runs', guard, async (req) => {
    const limit = Number(req.query && req.query.limit) || 20;
    return { runs: await listRuns({ limit }) };
  });

  /** 실행 1건의 묶음 목록 — 어느 묶음이 실패했는지 바로 본다. */
  app.get('/api/product-sync/runs/:id/lotes', guard, async (req) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return { lotes: [] };
    const rows = (await query(
      `SELECT id, entity_label, status, attempts, http_status, codigo_error,
              last_error, sent_at, created_at, url, env
         FROM crm_customer_outbox
        WHERE entity='product' AND entity_id=$1
        ORDER BY id`, [id])).rows;
    return {
      lotes: rows.map((r) => ({
        outbox_id: Number(r.id),
        label: r.entity_label,
        status: r.status,
        attempts: Number(r.attempts),
        http_status: r.http_status == null ? null : Number(r.http_status),
        codigo_error: r.codigo_error,
        last_error: r.last_error,
        sent_at: r.sent_at,
        created_at: r.created_at,
        url: r.url, env: r.env,
      })),
    };
  });
}
