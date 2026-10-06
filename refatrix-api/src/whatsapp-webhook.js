// whatsapp-webhook.js
// Refatrix ERP · WhatsApp 웹훅 수신 (Meta 콜백 URL: /webhooks/whatsapp)
//
// 필요 환경변수 (Railway):
//   WA_VERIFY_TOKEN  Meta "인증 토큰" 칸에 입력한 값과 똑같이
//   WA_APP_SECRET    Meta 앱 > 앱 설정 > 기본 > "앱 시크릿 코드"
//
// 서버 진입점에서 (fastify-plugin으로 감싸지 말 것 — JSON 파서 변경이 이 경로에만 적용되도록):
//   import whatsappWebhook from './whatsapp-webhook.js';
//   fastify.register(whatsappWebhook, { db: pool });   // pool: pg Pool (query 함수가 있는 객체)
//
// 테이블(wa_events)은 서버 시작 시 자동 생성됨 (이미 있으면 그대로 둠)

import crypto from 'node:crypto';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS wa_events (
    id           BIGSERIAL PRIMARY KEY,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind         TEXT NOT NULL CHECK (kind IN ('message', 'status')),
    wamid        TEXT NOT NULL,
    phone        TEXT,
    msg_type     TEXT,
    body         TEXT,
    status       TEXT,
    error        JSONB,
    raw          JSONB NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS wa_events_dedupe
    ON wa_events (wamid, kind, (COALESCE(status, '')));
  CREATE INDEX IF NOT EXISTS wa_events_phone_time
    ON wa_events (phone, received_at DESC);`;

export default async function whatsappWebhook(fastify, opts) {
  const { WA_VERIFY_TOKEN, WA_APP_SECRET } = process.env;
  const db = opts.db ?? fastify.pg; // pg Pool 또는 @fastify/postgres

  if (!db?.query) throw new Error('whatsappWebhook: DB(pool) 객체를 { db: pool } 로 넘겨주세요');
  await db.query(CREATE_TABLE_SQL);

  // 서명 검증에 원본 바이트가 필요하므로, 이 플러그인 안에서만 raw body 보관
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body;
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch (err) {
      err.statusCode = 400;
      done(err);
    }
  });

  // 1) Meta 검증 요청 ("확인 및 저장" 버튼을 누를 때 호출됨)
  fastify.get('/webhooks/whatsapp', async (req, reply) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token && token === WA_VERIFY_TOKEN) {
      return reply.type('text/plain').send(challenge);
    }
    return reply.code(403).send();
  });

  // 2) 실제 알림 수신 (고객 메시지, 발송 상태)
  fastify.post('/webhooks/whatsapp', async (req, reply) => {
    if (!isValidSignature(req.rawBody, req.headers['x-hub-signature-256'], WA_APP_SECRET)) {
      req.log.warn('whatsapp webhook: invalid signature');
      return reply.code(401).send();
    }
    try {
      await saveEvents(db, req.body);
    } catch (err) {
      // 저장 실패해도 200을 돌려줘야 Meta가 같은 알림을 계속 재전송하지 않음
      req.log.error({ err }, 'whatsapp webhook: save failed');
    }
    return reply.code(200).send();
  });
}

function isValidSignature(rawBody, header, secret) {
  if (!rawBody || !header || !secret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const INSERT_SQL = `
  INSERT INTO wa_events (kind, wamid, phone, msg_type, body, status, error, raw)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (wamid, kind, (COALESCE(status, ''))) DO NOTHING`;

async function saveEvents(db, payload) {
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};

      // 고객이 보낸 메시지
      for (const m of value.messages ?? []) {
        const body =
          m.text?.body ??
          m.button?.text ??
          m.interactive?.button_reply?.title ??
          m.interactive?.list_reply?.title ??
          m.image?.caption ??
          m.document?.filename ??
          null;
        await db.query(INSERT_SQL, ['message', m.id, m.from, m.type, body, null, null, m]);
      }

      // 우리가 보낸 메시지의 상태 (sent / delivered / read / failed)
      for (const s of value.statuses ?? []) {
        await db.query(INSERT_SQL, [
          'status',
          s.id,
          s.recipient_id,
          null,
          null,
          s.status,
          s.errors ? JSON.stringify(s.errors) : null,
          s,
        ]);
      }
    }
  }
}
