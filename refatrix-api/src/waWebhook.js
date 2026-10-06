// =====================================================================
// Refatrix ERP · waWebhook.js — WhatsApp Cloud API 웹훅 (2026-10-06 디렉터 지시)
//   "원장에 도착 / 읽음 / 실패 사유까지 실제 상태가 찍히게"
//
//   API 응답의 「성공」은 Meta 가 메시지를 접수했다는 뜻뿐이다. 24시간 창 밖 자유 메시지,
//   결제 수단 없음 같은 실패는 접수 뒤에 웹훅(statuses)으로만 알려 온다.
//   ① statuses  → wa_message_status (접수 sent → 도착 delivered → 읽음 read / 실패 failed + 사유)
//   ② messages  → wa_inbound (번호별 마지막 수신 시각 → 24시간 창 판단, 본문은 저장 안 함)
//   ③ 일일자금 발송이 「24시간 창 밖」으로 실패하면 원장을 다시 열어(sent_at=NULL) 재시도하게 하고,
//      다음 시도는 창이 닫힌 것을 알고 이미지 헤더 템플릿으로 바로 간다(treasuryDaily.sendOne).
//
//   ── 환경변수(외부 서비스 키 화면에서도 설정) ──
//   · WHATSAPP_WEBHOOK_VERIFY_TOKEN  Meta 웹훅 등록 때 넣는 확인 토큰(직접 정한 문자열)
//   · WHATSAPP_APP_SECRET            Meta 앱 → 앱 설정 → 기본 설정 → 앱 시크릿 (서명 검증용)
//   둘 다 있어야 웹훅이 동작한다. 서명이 맞지 않는 요청은 버린다(위조 상태 방지).
// =====================================================================
import crypto from 'node:crypto';
import { query } from './db.js';
import { normalizeWaNumber } from './waSend.js';

export const WINDOW_CODES = new Set([131047, 470]);   // 24시간 창 밖(재참여 필요)

// Meta 오류 코드 → 사람이 읽는 설명(원장 툴팁·화면 표시용)
const WA_ERR_KO = {
  131047: '24시간 창 밖 — 수신자가 최근 24시간 안에 회사 번호로 메시지를 보낸 적이 없음. 승인된 템플릿으로만 보낼 수 있음',
  470: '24시간 창 밖 — 승인된 템플릿으로만 보낼 수 있음',
  131026: '수신 불가 — 이 번호가 WhatsApp 을 쓰지 않거나, 앱이 너무 오래됐거나, 새 약관에 동의하지 않음',
  131042: '결제 문제 — WhatsApp Manager 에 결제 수단이 없거나 결제가 실패함',
  131049: '생태계 보호 제한 — Meta 가 이 수신자에게 지금 전달하지 않기로 함(시간을 두고 재시도)',
  131050: '수신자가 이 비즈니스의 마케팅 메시지를 차단함',
  131051: '지원하지 않는 메시지 유형',
  131052: '수신자가 보낸 미디어를 내려받지 못함',
  131053: '미디어 업로드 오류 — 이미지 파일 형식·크기 확인',
  131056: '같은 번호로 너무 많이 보냄 — 잠시 뒤 재시도',
  131031: '발신 계정이 잠김 — WhatsApp Manager 에서 계정 상태 확인',
  131030: '테스트 번호의 허용 수신자 목록에 없는 번호',
  131000: 'Meta 측 일반 오류 — 재시도',
  131016: 'Meta 서비스 일시 장애 — 재시도',
  132000: '템플릿 변수 개수가 승인된 템플릿과 다름',
  132001: '템플릿이 없거나 해당 언어로 승인되지 않음',
  132005: '템플릿 변수 글자 수 초과',
  132012: '템플릿 변수 형식이 승인된 템플릿과 다름(예: 헤더 이미지)',
  132015: '템플릿이 일시 중지됨(품질 낮음)',
  132016: '템플릿이 비활성화됨',
  368: '정책 위반으로 발신 번호가 일시 차단됨',
  190: '토큰 만료 또는 무효',
};
export function explainWaError(code, title) {
  const c = Number(code);
  return WA_ERR_KO[c] || (title ? String(title) : (c ? `오류 ${c}` : '알 수 없는 오류'));
}

export const webhookConfigured = () =>
  !!(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN && process.env.WHATSAPP_APP_SECRET);

// X-Hub-Signature-256: sha256=<hex HMAC(app_secret, raw body)>
export function verifySignature(raw, header, secret = process.env.WHATSAPP_APP_SECRET) {
  if (!secret || !header || raw == null) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header).trim());
  if (!m) return false;
  const want = crypto.createHmac('sha256', secret).update(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8')).digest();
  const got = Buffer.from(m[1], 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const tsOf = (s) => { const n = Number(s); return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date(); };
const RANK = `CASE %s WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 4 ELSE 0 END`;
const rank = (x) => RANK.replace('%s', x);

// 웹훅 본문 1건 반영. 반환: 처리 건수 요약(로그·테스트용)
export async function applyWebhook(body, q = query) {
  const out = { statuses: 0, inbound: 0, failed: 0, reopened: 0 };
  if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return out;
  for (const entry of body.entry) {
    for (const ch of (entry && entry.changes) || []) {
      if (!ch || ch.field !== 'messages' || !ch.value) continue;
      const v = ch.value;
      for (const st of v.statuses || []) {
        if (!st || !st.id || !['sent', 'delivered', 'read', 'failed'].includes(st.status)) continue;
        const at = tsOf(st.timestamp);
        const e = (st.errors && st.errors[0]) || null;
        const code = e ? Number(e.code) || null : null;
        const detail = e ? String((e.error_data && e.error_data.details) || e.message || '').slice(0, 500) || null : null;
        await q(
          `INSERT INTO wa_message_status (message_id, recipient, status, sent_at, delivered_at, read_at, failed_at,
                                          error_code, error_title, error_detail, pricing_category, updated_at)
           VALUES ($1,$2,$3,
                   CASE WHEN $3='sent' THEN $4::timestamptz END, CASE WHEN $3='delivered' THEN $4::timestamptz END,
                   CASE WHEN $3='read' THEN $4::timestamptz END, CASE WHEN $3='failed' THEN $4::timestamptz END,
                   $5,$6,$7,$8, now())
           ON CONFLICT (message_id) DO UPDATE SET
             recipient    = COALESCE(EXCLUDED.recipient, wa_message_status.recipient),
             status       = CASE WHEN ${rank('EXCLUDED.status')} > ${rank('wa_message_status.status')}
                                 THEN EXCLUDED.status ELSE wa_message_status.status END,
             sent_at      = COALESCE(wa_message_status.sent_at, EXCLUDED.sent_at),
             delivered_at = COALESCE(wa_message_status.delivered_at, EXCLUDED.delivered_at),
             read_at      = COALESCE(wa_message_status.read_at, EXCLUDED.read_at),
             failed_at    = COALESCE(wa_message_status.failed_at, EXCLUDED.failed_at),
             error_code   = COALESCE(EXCLUDED.error_code, wa_message_status.error_code),
             error_title  = COALESCE(EXCLUDED.error_title, wa_message_status.error_title),
             error_detail = COALESCE(EXCLUDED.error_detail, wa_message_status.error_detail),
             pricing_category = COALESCE(EXCLUDED.pricing_category, wa_message_status.pricing_category),
             updated_at   = now()`,
          [st.id, normalizeWaNumber(st.recipient_id) || null, st.status, at.toISOString(),
           code, e ? String(e.title || '').slice(0, 200) || null : null, detail,
           (st.pricing && st.pricing.category) || null]);
        out.statuses++;
        if (st.status === 'failed') {
          out.failed++;
          const reason = `전달 실패(${code || '?'}): ${explainWaError(code, e && e.title)}`;
          // 일일자금 원장: 24시간 창 실패는 다시 열어 재시도(다음 시도는 템플릿으로 감). 그 밖의 실패는 상태만 표시.
          if (code && WINDOW_CODES.has(code)) {
            const r = await q(
              `UPDATE treasury_wa_sends SET status='failed', sent_at=NULL, error=$2, updated_at=now()
                WHERE message_id=$1 AND sent_at IS NOT NULL RETURNING id`, [st.id, reason]);
            out.reopened += (r.rows || []).length;
          }
        }
      }
      for (const m of v.messages || []) {
        const from = normalizeWaNumber(m && m.from);
        if (!from) continue;
        await q(
          `INSERT INTO wa_inbound (wa_from, last_at, last_type, msg_count, updated_at) VALUES ($1,$2,$3,1,now())
           ON CONFLICT (wa_from) DO UPDATE SET
             last_at   = GREATEST(wa_inbound.last_at, EXCLUDED.last_at),
             last_type = CASE WHEN EXCLUDED.last_at >= wa_inbound.last_at THEN EXCLUDED.last_type ELSE wa_inbound.last_type END,
             msg_count = wa_inbound.msg_count + 1, updated_at = now()`,
          [from, tsOf(m.timestamp).toISOString(), String(m.type || '').slice(0, 30) || null]);
        out.inbound++;
      }
    }
  }
  return out;
}

// 번호의 24시간 창 상태. 웹훅이 설정되지 않았으면 open=null(모름 — 기존 동작 유지).
export async function windowState(phone, q = query) {
  const p = normalizeWaNumber(phone);
  if (!p || !webhookConfigured()) return { open: null, last_at: null };
  try {
    const r = (await q(`SELECT last_at, (last_at > now() - interval '24 hours') AS open FROM wa_inbound WHERE wa_from=$1`, [p])).rows[0];
    return r ? { open: r.open === true, last_at: r.last_at } : { open: false, last_at: null };
  } catch { return { open: null, last_at: null }; }   // 0253 마이그레이션 전
}
