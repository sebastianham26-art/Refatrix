// =====================================================================
// Refatrix ERP · waWebhookRoutes.js — WhatsApp 웹훅 수신 (0253 · 2026-10-06)
//   GET  /api/wa/webhook        Meta 등록 확인(hub.challenge) — 공개, 확인 토큰으로 검증
//   POST /api/wa/webhook        상태·수신 알림 — 공개, X-Hub-Signature-256 서명으로 검증
//   GET  /api/wa/webhook/info   설정 상태·최근 수신(디렉터)
// =====================================================================
import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { applyWebhook, verifySignature, webhookConfigured } from '../waWebhook.js';

const DEFAULT_API = 'https://refatrix-production.up.railway.app';

export default async function waWebhookRoutes(app) {
  app.get('/api/wa/webhook', async (req, reply) => {
    const q = req.query || {};
    const want = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    if (q['hub.mode'] === 'subscribe' && want && q['hub.verify_token'] === want) {
      return reply.type('text/plain').send(String(q['hub.challenge'] || ''));
    }
    return reply.code(403).send({ error: 'verify_failed' });
  });

  app.post('/api/wa/webhook', async (req, reply) => {
    if (!process.env.WHATSAPP_APP_SECRET) return reply.code(503).send({ error: 'no_app_secret' });
    if (!verifySignature(req.rawBody, req.headers['x-hub-signature-256'])) {
      req.log.warn('wa webhook: bad signature');
      return reply.code(401).send({ error: 'bad_signature' });
    }
    try {
      const r = await applyWebhook(req.body);
      if (r.failed || r.reopened) req.log.info({ wa_webhook: r }, 'wa webhook');
    } catch (e) {
      // 0253 마이그레이션 전이거나 DB 오류 — 500 이면 Meta 가 재전송하므로 그대로 알린다.
      req.log.error({ err: e && e.message }, 'wa webhook apply failed');
      return reply.code(500).send({ error: 'apply_failed' });
    }
    return { ok: true };
  });

  app.get('/api/wa/webhook/info', { preHandler: [authGuard, requireDirector] }, async () => {
    const base = (process.env.PUBLIC_API_URL || DEFAULT_API).replace(/\/+$/, '');
    let last = null, n24 = null;
    try {
      last = (await query(`SELECT GREATEST((SELECT max(updated_at) FROM wa_message_status), (SELECT max(updated_at) FROM wa_inbound)) AS at`)).rows[0].at;
      n24 = (await query(`SELECT count(*)::int AS n FROM wa_message_status WHERE updated_at > now() - interval '24 hours'`)).rows[0].n;
    } catch { /* 0253 전 */ }
    return {
      configured: webhookConfigured(),
      verify_token_set: !!process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
      app_secret_set: !!process.env.WHATSAPP_APP_SECRET,
      callback_url: base + '/api/wa/webhook',
      last_event_at: last, statuses_24h: n24,
    };
  });
}
