// 프로모션 배너 연동 (0237) — 연동 관리 › 프로모션 배너 탭의 뒷단. 디렉터 전용.
//   등록·수정·전송·취소·삭제 + 창구별 전송 상태 + 공개 배너 이미지(CRM 이 불러가는 주소).
//   전송 이력의 재시도·재전송은 기존 crmSyncRoutes 가 그대로 처리한다(entity='promo').
import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { publicEndpoint, getEndpoint } from '../integrations.js';
import {
  promoReady, getPromo, promoTargets, listPromoEndpoints, deliveries, publishPromo, cancelPromo,
  decodeBannerDataUrl, sha256Hex, validatePromo, promoPhase, mxToday, sizeCheck, buildPromoPayload,
  bannerUrl, parseBannerFile, promoCode, PROMO_COLS, PROMO_ENTITY, PROMO_CATEGORY, BANNER_MAX_BYTES,
} from '../promoSync.js';

export const PROMO_ROUTES_REV = '20260929promo';

const ERR_NOTE = {
  migration_required: 'npm run migrate (0237) 를 먼저 실행하세요.',
  title_required: '제목을 입력하세요.',
  title_too_long: '제목은 120자 이내입니다.',
  description_too_long: '설명은 4000자 이내입니다.',
  type_invalid: '할인 종류가 올바르지 않습니다.',
  value_required: '할인값을 입력하세요(0보다 커야 합니다).',
  value_pct_range: '할인율은 100% 를 넘을 수 없습니다.',
  date_invalid: '시작일·종료일을 YYYY-MM-DD 로 입력하세요.',
  date_order: '종료일이 시작일보다 빠릅니다.',
  date_past: '종료일이 이미 지났습니다 — 지난 프로모션은 전송할 수 없습니다.',
  link_invalid: '클릭 이동 주소는 http:// 또는 https:// 로 시작해야 하고 공백이 없어야 합니다.',
  priority_invalid: '노출 순서는 0~9999 정수입니다.',
  image_required: '배너 이미지를 올려야 전송할 수 있습니다.',
  targets_required: '전송할 곳(창구)을 하나 이상 고르세요.',
  targets_invalid: '프로모션 창구가 아닌 곳이 섞여 있습니다.',
  image_empty: '이미지가 비어 있습니다.',
  image_bad_format: '이미지 형식을 읽지 못했습니다.',
  image_bad_mime: 'PNG · JPG · WEBP · GIF 만 올릴 수 있습니다.',
  image_too_large: `이미지는 ${Math.round(BANNER_MAX_BYTES / 1024 / 1024)}MB 이하여야 합니다.`,
  image_unreadable: '이미지의 가로·세로를 읽지 못했습니다 — 다른 파일로 저장해 올려 주세요.',
  not_found: '프로모션을 찾을 수 없습니다.',
  already_cancelled: '이미 취소된 프로모션입니다.',
  not_published: '아직 전송한 적 없는 프로모션입니다.',
};

function bad(reply, code, status = 400, extra = {}) {
  return reply.code(status).send({ error: code, note: ERR_NOTE[code] || null, ...extra });
}

function publicPromo(p, today, targets = [], eps = []) {
  const byKey = new Map(eps.map((e) => [e.key, e]));
  return {
    id: Number(p.id), code: promoCode(p.id),
    title: p.title, description: p.description || '', promo_type: p.promo_type,
    discount_value: p.discount_value == null ? null : Number(p.discount_value),
    conditions: p.conditions || '', start_date: p.start_date, end_date: p.end_date,
    link_url: p.link_url || '', priority: Number(p.priority), auto_withdraw: !!p.auto_withdraw,
    status: p.status, phase: promoPhase(p, today), version: Number(p.version),
    image: p.image_sha ? {
      url: bannerUrl(p), mime: p.image_mime, name: p.image_name, bytes: Number(p.image_bytes),
      w: Number(p.image_w), h: Number(p.image_h),
    } : null,
    targets,
    size_warnings: targets.map((k) => {
      const ep = byKey.get(k);
      const c = sizeCheck(p, ep);
      return c.ok ? null : { key: k, label: ep ? ep.label : k, required: c.required, actual: c.actual };
    }).filter(Boolean),
    published_at: p.published_at, cancelled_at: p.cancelled_at, withdrawn_at: p.withdrawn_at,
    created_at: p.created_at, updated_at: p.updated_at,
  };
}

function cleanBody(b) {
  const type = String(b.promo_type || 'porcentaje');
  return {
    title: String(b.title == null ? '' : b.title).trim(),
    description: String(b.description == null ? '' : b.description).trim() || null,
    promo_type: type,
    discount_value: type === 'otro' || b.discount_value === '' || b.discount_value == null ? null : Number(b.discount_value),
    conditions: String(b.conditions == null ? '' : b.conditions).trim() || null,
    start_date: String(b.start_date || ''), end_date: String(b.end_date || ''),
    link_url: String(b.link_url == null ? '' : b.link_url).trim() || null,
    priority: b.priority === '' || b.priority == null ? 100 : Number(b.priority),
    auto_withdraw: b.auto_withdraw === undefined ? true : !!b.auto_withdraw,
  };
}

export default async function promoRoutes(app) {
  const guard = { preHandler: [authGuard, requireDirector] };

  async function ready(reply) {
    if (await promoReady()) return true;
    bad(reply, 'migration_required', 503);
    return false;
  }

  // ── 공개 배너 이미지 — CRM(과 고객 브라우저)이 인증 없이 불러간다 ─────────────────
  //   주소 = <id>-<내용해시 16자>.<ext>. 해시가 맞지 않으면 404 — 추측으로 다른 그림을 못 본다.
  //   삭제된 프로모션·초안(한 번도 전송 안 함)은 내주지 않는다.
  app.get('/api/public/promo-banners/:file', async (req, reply) => {
    const f = parseBannerFile(req.params.file);
    if (!f || !(await promoReady())) return reply.code(404).send({ error: 'not_found' });
    const r = (await query(
      `SELECT image, image_mime, image_sha FROM crm_promotions
        WHERE id=$1 AND deleted_at IS NULL AND image IS NOT NULL
          AND (status <> 'draft' OR published_at IS NOT NULL)`, [f.id])).rows[0];
    if (!r || String(r.image_sha || '').slice(0, 16) !== f.sha16) return reply.code(404).send({ error: 'not_found' });
    reply.header('Content-Type', r.image_mime || 'application/octet-stream');
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(r.image);
  });

  // ERP 화면용 미리보기(초안 포함) — 인증 필요
  app.get('/api/promotions/:id/image', guard, async (req, reply) => {
    if (!(await ready(reply))) return;
    const r = (await query(`SELECT image, image_mime FROM crm_promotions WHERE id=$1 AND deleted_at IS NULL`,
      [Number(req.params.id)])).rows[0];
    if (!r || !r.image) return reply.code(404).send({ error: 'not_found' });
    reply.header('Content-Type', r.image_mime || 'application/octet-stream');
    reply.header('Cache-Control', 'private, max-age=60');
    return reply.send(r.image);
  });

  // ── 전송 창구(=CRM 들) ─────────────────────────────────────────────
  app.get('/api/promotions/targets', guard, async (req, reply) => {
    if (!(await ready(reply))) return;
    const eps = await listPromoEndpoints();
    const items = [];
    for (const e of eps) {
      // getEndpoint 를 거쳐야 「키 물려받기」(auth_from)가 반영된다 — 목록과 실제 전송이 같은 말을 하게.
      const pe = publicEndpoint((await getEndpoint(e.key)) || { ...e, source: 'db' });
      items.push({ key: pe.key, label: pe.label, enabled: pe.enabled, env: pe.env, active_url: pe.active_url,
               has_token: pe.has_token, auth_from: pe.auth_from, token_borrowed_label: pe.token_borrowed_label,
               banner_w: e.banner_w == null ? null : Number(e.banner_w), banner_h: e.banner_h == null ? null : Number(e.banner_h),
               method_delete: pe.method_delete });
    }
    return { items };
  });

  // ── 목록 ────────────────────────────────────────────────────────────
  app.get('/api/promotions', guard, async (req, reply) => {
    if (!(await ready(reply))) return;
    const today = await mxToday();
    const rows = (await query(
      `SELECT ${PROMO_COLS} FROM crm_promotions p WHERE p.deleted_at IS NULL
        ORDER BY (p.status='cancelled'), p.end_date < (now() AT TIME ZONE 'America/Mexico_City')::date, p.start_date DESC, p.id DESC
        LIMIT 300`)).rows;
    const ids = rows.map((r) => Number(r.id));
    const tmap = new Map();
    const smap = new Map();
    if (ids.length) {
      for (const t of (await query(`SELECT promotion_id, endpoint_key FROM crm_promotion_targets WHERE promotion_id = ANY($1::bigint[])`, [ids])).rows) {
        const k = Number(t.promotion_id); if (!tmap.has(k)) tmap.set(k, []); tmap.get(k).push(t.endpoint_key);
      }
      // 창구별 최근 1건의 상태를 세어 목록 배지로(보냄·대기·실패)
      for (const s of (await query(
        `SELECT entity_id, status, count(*)::int AS n FROM (
            SELECT DISTINCT ON (entity_id, endpoint_key) entity_id, endpoint_key, status
              FROM crm_customer_outbox
             WHERE entity=$1 AND entity_id = ANY($2::bigint[]) AND status <> 'skipped'
             ORDER BY entity_id, endpoint_key, id DESC) x
          GROUP BY entity_id, status`, [PROMO_ENTITY, ids])).rows) {
        const k = Number(s.entity_id); if (!smap.has(k)) smap.set(k, { sent: 0, pending: 0, failed: 0 });
        smap.get(k)[s.status] = Number(s.n);
      }
    }
    const eps = await listPromoEndpoints();
    return {
      today,
      items: rows.map((p) => ({ ...publicPromo(p, today, tmap.get(Number(p.id)) || [], eps),
        send: smap.get(Number(p.id)) || { sent: 0, pending: 0, failed: 0 } })),
    };
  });

  // ── 단건 + 창구별 전송 상태 + 최근 이력 ────────────────────────────────
  app.get('/api/promotions/:id', guard, async (req, reply) => {
    if (!(await ready(reply))) return;
    const p = await getPromo(req.params.id);
    if (!p) return bad(reply, 'not_found', 404);
    const today = await mxToday();
    const eps = await listPromoEndpoints();
    const history = (await query(
      `SELECT id, endpoint_key, op, origin, status, attempts, http_status, codigo_error, last_error, created_at, sent_at, env,
              payload->>'version' AS version
         FROM crm_customer_outbox WHERE entity=$1 AND entity_id=$2 ORDER BY id DESC LIMIT 60`,
      [PROMO_ENTITY, Number(p.id)])).rows.map((r) => ({ ...r, id: Number(r.id), attempts: Number(r.attempts),
        http_status: r.http_status == null ? null : Number(r.http_status), version: r.version == null ? null : Number(r.version) }));
    return { promo: publicPromo(p, today, await promoTargets(p.id), eps), deliveries: await deliveries(p.id), history };
  });

  // ── 보낼 본문 미리보기(보내지 않는다) ─────────────────────────────────
  app.get('/api/promotions/:id/preview', guard, async (req, reply) => {
    if (!(await ready(reply))) return;
    const p = await getPromo(req.params.id);
    if (!p) return bad(reply, 'not_found', 404);
    const eps = await listPromoEndpoints();
    const key = String(req.query.endpoint || '').trim();
    const ep = eps.find((e) => e.key === key) || eps[0] || null;
    const u = (await query(`SELECT login_id, name, role FROM users WHERE id=$1`, [req.ctx.perm.userId])).rows[0] || {};
    const f = ep && ['login_id', 'name', 'role'].includes(ep.user_field) ? ep.user_field : 'login_id';
    const next = { ...p, version: Number(p.version) + 1 };   // 다음 전송의 본문
    return { endpoint: ep ? ep.key : null,
             upsert: buildPromoPayload(next, { op: 'upsert', user: String(u[f] || 'erp'), map: ep ? ep.field_map : null }),
             delete: buildPromoPayload(next, { op: 'delete', user: String(u[f] || 'erp'), map: ep ? ep.field_map : null }) };
  });

  // ── 저장(신규·수정) — publish:true 면 저장 직후 전송 ────────────────────
  async function save(req, reply, id) {
    if (!(await ready(reply))) return;
    const b = req.body || {};
    const publish = !!b.publish;
    const cur = id ? await getPromo(id) : null;
    if (id && !cur) return bad(reply, 'not_found', 404);

    let img = null;
    if (b.image_data_url) {
      const d = decodeBannerDataUrl(b.image_data_url);
      if (!d.ok) return bad(reply, d.error);
      img = { ...d, sha: sha256Hex(d.buf) };
    }
    // 이미 전송 중(발행)인 건은 저장만 눌러도 다시 나간다 — 그래서 전송 기준(이미지·창구 필수)으로 검사한다.
    const needsSend = publish || !!(cur && cur.status === 'published');
    const removeImage = !!b.remove_image && !needsSend;
    const hasImage = !!img || !!(cur && cur.image_sha && !removeImage);
    const targets = Array.isArray(b.targets) ? [...new Set(b.targets.map((x) => String(x).trim()).filter(Boolean))] : null;
    const err = validatePromo({ ...b, targets: targets || (cur ? await promoTargets(id) : []) }, { publish: needsSend, hasImage });
    if (err) return bad(reply, err);
    const v = cleanBody(b);
    if (needsSend && v.end_date < await mxToday()) return bad(reply, 'date_past');
    if (targets) {
      const valid = new Set((await listPromoEndpoints()).map((e) => e.key));
      if (targets.some((k) => !valid.has(k))) return bad(reply, 'targets_invalid');
    }

    const uid = req.ctx.perm.userId || null;
    const cols = ['title', 'description', 'promo_type', 'discount_value', 'conditions', 'start_date', 'end_date',
      'link_url', 'priority', 'auto_withdraw'];
    let pid = id ? Number(id) : null;
    if (!pid) {
      const r = (await query(
        `INSERT INTO crm_promotions (${cols.join(',')}, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10,$11,$11) RETURNING id`,
        [...cols.map((c) => v[c]), uid])).rows[0];
      pid = Number(r.id);
    } else {
      await query(
        `UPDATE crm_promotions SET title=$1, description=$2, promo_type=$3, discount_value=$4, conditions=$5,
                start_date=$6::date, end_date=$7::date, link_url=$8, priority=$9, auto_withdraw=$10,
                updated_by=$11, updated_at=now(),
                -- 날짜를 늘려 다시 살린 경우 자동 내리기가 다시 걸리도록
                withdrawn_at = CASE WHEN $7::date >= (now() AT TIME ZONE 'America/Mexico_City')::date THEN NULL ELSE withdrawn_at END
          WHERE id=$12`, [...cols.map((c) => v[c]), uid, pid]);
    }
    if (img) {
      await query(
        `UPDATE crm_promotions SET image=$1, image_mime=$2, image_name=$3, image_bytes=$4, image_w=$5, image_h=$6, image_sha=$7
          WHERE id=$8`,
        [img.buf, img.mime, String(b.image_name || '').replace(/[\u0000-\u001f\\/]/g, '').slice(0, 120) || null,
         img.buf.length, img.width, img.height, img.sha, pid]);
    } else if (removeImage) {
      await query(`UPDATE crm_promotions SET image=NULL, image_mime=NULL, image_name=NULL, image_bytes=NULL,
                          image_w=NULL, image_h=NULL, image_sha=NULL WHERE id=$1`, [pid]);
    }
    if (targets) {
      await query(`DELETE FROM crm_promotion_targets WHERE promotion_id=$1 AND NOT (endpoint_key = ANY($2::text[]))`, [pid, targets]);
      for (const k of targets) {
        await query(`INSERT INTO crm_promotion_targets (promotion_id, endpoint_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [pid, k]);
      }
    }
    let sent = null;
    // 이미 전송된(발행) 프로모션을 고치면 publish 를 누르지 않아도 **고친 내용을 다시 보낸다** —
    //   ERP 와 CRM 이 다른 내용을 보여 주는 상태를 만들지 않는다. 취소된 건은 다시 살리지 않는다.
    if (needsSend) {
      sent = await publishPromo(pid, { actorUserId: uid, app,
        origin: cur && cur.status === 'published' ? 'promo_update' : 'promo_publish' });
    }
    await audit(req, id ? 'update' : 'create', { op: 'promo_save', id: pid, publish: needsSend });
    const p = await getPromo(pid);
    return { ok: true, promo: publicPromo(p, await mxToday(), await promoTargets(pid), await listPromoEndpoints()), sent };
  }

  app.post('/api/promotions', guard, (req, reply) => save(req, reply, null));
  app.put('/api/promotions/:id', guard, (req, reply) => save(req, reply, req.params.id));

  // ── 다시 전송(같은 내용, 버전 +1) ────────────────────────────────────
  app.post('/api/promotions/:id/publish', guard, async (req, reply) => {
    if (!(await ready(reply))) return;
    const p = await getPromo(req.params.id);
    if (!p) return bad(reply, 'not_found', 404);
    const targets = await promoTargets(p.id);
    const err = validatePromo({ ...p, targets }, { publish: true, hasImage: !!p.image_sha });
    if (err) return bad(reply, err);
    if (p.end_date < await mxToday()) return bad(reply, 'date_past');
    const r = await publishPromo(p.id, { actorUserId: req.ctx.perm.userId, app, origin: p.status === 'published' ? 'promo_resend' : 'promo_publish' });
    await audit(req, 'update', { op: 'promo_publish', id: Number(p.id) });
    return r;
  });

  // ── 취소 — CRM 에서 내린다 ─────────────────────────────────────────
  app.post('/api/promotions/:id/cancel', guard, async (req, reply) => {
    if (!(await ready(reply))) return;
    const p = await getPromo(req.params.id);
    if (!p) return bad(reply, 'not_found', 404);
    if (p.status === 'cancelled') return bad(reply, 'already_cancelled', 409);
    if (p.status !== 'published') return bad(reply, 'not_published', 409);
    const r = await cancelPromo(p.id, { actorUserId: req.ctx.perm.userId, app });
    await audit(req, 'update', { op: 'promo_cancel', id: Number(p.id) });
    return r;
  });

  // ── 삭제 — 화면에서 감춘다. 나간 적 있으면(발행 중) 먼저 내리기를 보낸다 ─────────
  app.delete('/api/promotions/:id', guard, async (req, reply) => {
    if (!(await ready(reply))) return;
    const p = await getPromo(req.params.id);
    if (!p) return bad(reply, 'not_found', 404);
    let withdrawn = null;
    if (p.status === 'published') withdrawn = await cancelPromo(p.id, { actorUserId: req.ctx.perm.userId, app });
    await query(`UPDATE crm_promotions SET deleted_at=now(), updated_by=$2 WHERE id=$1`, [Number(p.id), req.ctx.perm.userId || null]);
    await audit(req, 'delete', { op: 'promo_delete', id: Number(p.id) });
    return { ok: true, withdrawn };
  });

  async function audit(req, action, detail) {
    try {
      await query(`INSERT INTO audit_log (user_id, action, target, detail) VALUES ($1,$2,$3,$4)`,
        [req.ctx.perm.userId, action, 'crm_promotion', JSON.stringify(detail || {})]);
    } catch (_) { /* 감사로그 실패가 작업을 막지 않는다 */ }
  }

  try { app.log.info(`[promoRoutes] loaded rev ${PROMO_ROUTES_REV} (category=${PROMO_CATEGORY})`); } catch (_) {}
}
