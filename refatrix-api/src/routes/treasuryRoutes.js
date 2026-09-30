// =====================================================================
// Refatrix ERP · treasuryRoutes.js — 재무 › 일일 자금 · 월간실적 (0240)
//   전부 디렉터 전용. 숫자 계산은 src/treasuryDaily.js(순수 함수 + 적재).
//
//   GET    /api/treasury/week?date=YYYY-MM-DD      유첨 양식(월~토): 과거=실적, 오늘부터=예정
//   GET    /api/treasury/month?month=YYYY-MM       월간실적(원장 실시간 재계산) + 스냅샷 대비 사후수정 표시
//   POST   /api/treasury/snapshots/refresh {month} 그 달 스냅샷 지금 재계산(최초본 보존)
//   GET    /api/treasury/accounts                  집계 대상 계좌(금고·불공제 자동 제외) · PATCH /:id {mode:auto|include|exclude}
//   GET    /api/treasury/recipients                수신자 목록
//   POST   /api/treasury/recipients                {name, phone, lang, get_daily, get_monthly}
//   PATCH  /api/treasury/recipients/:id            부분 수정(active 포함)
//   DELETE /api/treasury/recipients/:id            삭제(소프트)
//   GET    /api/treasury/wa/status                 설정 상태 + 최근 발송 원장
//   GET    /api/treasury/wa/preview?kind&period&lang   보낼 문구 미리보기
//   POST   /api/treasury/wa/send {kind, period?, recipient_id?}   지금 발송(수동 — 성공 이력 무시)
// =====================================================================
import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { waApiReady, normalizeWaNumber } from '../waSend.js';
import {
  isYmd, isMonth, mxNow, addDays, monthBounds, prevMonth, computeWeek, computeActualDays, summarizeMonth,
  upsertSnapshots, loadSnapshotMeta, driftOf, flatOf, prepareDaily, prepareMonthly, sendReport, maskPhone,
  activeRecipients, loadAccountScope, SEND_HOUR_MX, DAILY_SEND_UNTIL_MX, MONTHLY_CATCHUP_DAYS, MAX_ATTEMPTS, reportUrl,
} from '../treasuryDaily.js';

const G = { preHandler: [authGuard, requireDirector] };
const LANGS = ['ko', 'es'];

function scopeBrief(sc) {
  return { included_n: sc.ids.length,
    excluded: sc.accounts.filter((a) => !a.included).map((a) => ({ id: a.id, name: a.name, reason: a.reason })) };
}

function recipOut(r) {
  return { id: Number(r.id), name: r.name, phone: r.phone, phone_masked: maskPhone(r.phone), lang: r.lang,
    get_daily: r.get_daily === true, get_monthly: r.get_monthly === true, active: r.active === true };
}

export default async function treasuryRoutes(app) {
  // ── 주간(유첨 양식) ──
  app.get('/api/treasury/week', G, async (req, reply) => {
    const today = mxNow().ymd;
    const date = isYmd(req.query.date) ? req.query.date : today;
    const [w, sc] = await Promise.all([computeWeek(date, today), loadAccountScope()]);
    return { ...w, scope: scopeBrief(sc) };
  });

  // ── 월간실적 ──
  app.get('/api/treasury/month', G, async (req, reply) => {
    const today = mxNow().ymd;
    const month = isMonth(req.query.month) ? req.query.month : today.slice(0, 7);
    const { from, to } = monthBounds(month);
    if (from >= today) return reply.code(400).send({ error: 'future_month' });
    const last = to < today ? to : addDays(today, -1);
    if (last < from) return { month, from, to, today, days: [], summary: null, partial: true };   // 이번 달 1일 당일
    const days = await computeActualDays(from, last);
    const meta = await loadSnapshotMeta(from, last);
    for (const d of days) {
      const m = meta.get(d.date);
      d.snap = m ? { first_at: m.first_at, computed_at: m.computed_at, drift: driftOf(m.first, flatOf(d)) } : null;
    }
    return { month, from, to, today, partial: last < to, days, summary: summarizeMonth(days), scope: scopeBrief(await loadAccountScope()) };
  });

  app.post('/api/treasury/snapshots/refresh', G, async (req, reply) => {
    const today = mxNow().ymd;
    const month = isMonth((req.body || {}).month) ? req.body.month : today.slice(0, 7);
    const { from, to } = monthBounds(month);
    const last = to < today ? to : addDays(today, -1);
    if (last < from) return { ok: true, month, saved: 0 };
    const saved = await upsertSnapshots(await computeActualDays(from, last));
    return { ok: true, month, saved };
  });

  // ── 집계 대상 계좌 ──
  app.get('/api/treasury/accounts', G, async () => loadAccountScope());

  app.patch('/api/treasury/accounts/:id', G, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad_id' });
    const mode = (req.body || {}).mode;
    const val = { auto: null, include: false, exclude: true };
    if (!(mode in val)) return reply.code(400).send({ error: 'bad_mode' });
    const r = (await query(`UPDATE accounts SET treasury_exclude=$1 WHERE id=$2 AND deleted_at IS NULL RETURNING id`, [val[mode], id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `account:${id}`, detail: { treasury_scope: mode } });
    return loadAccountScope();
  });

  // ── 수신자 ──
  app.get('/api/treasury/recipients', G, async () => {
    const rows = (await query(`SELECT * FROM treasury_wa_recipients WHERE deleted_at IS NULL ORDER BY id`)).rows;
    return { items: rows.map(recipOut) };
  });

  app.post('/api/treasury/recipients', G, async (req, reply) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 80);
    const phone = normalizeWaNumber(b.phone);
    if (!name) return reply.code(400).send({ error: 'name_required' });
    if (!phone) return reply.code(400).send({ error: 'bad_phone' });
    const lang = LANGS.includes(b.lang) ? b.lang : 'es';
    const dup = (await query(`SELECT id FROM treasury_wa_recipients WHERE phone=$1 AND deleted_at IS NULL`, [phone])).rows[0];
    if (dup) return reply.code(409).send({ error: 'duplicate_phone', id: Number(dup.id) });
    const r = (await query(
      `INSERT INTO treasury_wa_recipients (name, phone, lang, get_daily, get_monthly, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, phone, lang, b.get_daily !== false, b.get_monthly !== false, req.ctx.perm.userId])).rows[0];
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `treasury_recipient:${r.id}`, detail: { to: maskPhone(phone) } });
    return recipOut(r);
  });

  app.patch('/api/treasury/recipients/:id', G, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad_id' });
    const b = req.body || {};
    const sets = []; const args = [];
    const put = (col, v) => { args.push(v); sets.push(`${col}=$${args.length}`); };
    if (b.name != null) { const n = String(b.name).trim().slice(0, 80); if (!n) return reply.code(400).send({ error: 'name_required' }); put('name', n); }
    if (b.phone != null) {
      const p = normalizeWaNumber(b.phone); if (!p) return reply.code(400).send({ error: 'bad_phone' });
      const dup = (await query(`SELECT id FROM treasury_wa_recipients WHERE phone=$1 AND deleted_at IS NULL AND id<>$2`, [p, id])).rows[0];
      if (dup) return reply.code(409).send({ error: 'duplicate_phone', id: Number(dup.id) });
      put('phone', p);
    }
    if (b.lang != null) { if (!LANGS.includes(b.lang)) return reply.code(400).send({ error: 'bad_lang' }); put('lang', b.lang); }
    for (const k of ['get_daily', 'get_monthly', 'active']) if (typeof b[k] === 'boolean') put(k, b[k]);
    if (!sets.length) return reply.code(400).send({ error: 'nothing_to_update' });
    args.push(id);
    const r = (await query(`UPDATE treasury_wa_recipients SET ${sets.join(', ')}, updated_at=now()
                             WHERE id=$${args.length} AND deleted_at IS NULL RETURNING *`, args)).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return recipOut(r);
  });

  app.delete('/api/treasury/recipients/:id', G, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad_id' });
    const r = (await query(`UPDATE treasury_wa_recipients SET deleted_at=now(), active=false WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `treasury_recipient:${id}` });
    return { ok: true };
  });

  // ── 발송 ──
  app.get('/api/treasury/wa/status', G, async () => {
    const recent = (await query(
      `SELECT s.kind, s.period, s.recipient_id, r.name, s.to_masked, s.status, s.error, s.attempts, s.sent_at, s.updated_at
         FROM treasury_wa_sends s LEFT JOIN treasury_wa_recipients r ON r.id=s.recipient_id
        ORDER BY s.updated_at DESC LIMIT 40`)).rows.map((x) => ({ ...x, recipient_id: Number(x.recipient_id), attempts: Number(x.attempts) }));
    return {
      api_ready: waApiReady(),
      token_set: !!process.env.WHATSAPP_TOKEN, phone_id_set: !!process.env.WHATSAPP_PHONE_ID,
      template: process.env.TREASURY_WA_TEMPLATE || process.env.WHATSAPP_TEMPLATE || null,
      enabled: process.env.TREASURY_DAILY_ENABLED !== '0',
      schedule: { send_hour_mx: SEND_HOUR_MX, daily_until_mx: DAILY_SEND_UNTIL_MX, monthly_days: MONTHLY_CATCHUP_DAYS, max_attempts: MAX_ATTEMPTS },
      report_url: reportUrl(),
      recent,
    };
  });

  function defaults(kind, period) {
    const today = mxNow().ymd;
    if (kind === 'monthly') {
      const p = isMonth(period) ? period : prevMonth(today.slice(0, 7));
      if (monthBounds(p).from >= today) return { error: 'future_month' };
      return { today, period: p };
    }
    const p = isYmd(period) ? period : addDays(today, -1);
    if (p >= today) return { error: 'not_closed' };           // 오늘·미래는 마감 전
    return { today, period: p };
  }

  app.get('/api/treasury/wa/preview', G, async (req, reply) => {
    const kind = req.query.kind === 'monthly' ? 'monthly' : 'daily';
    const lang = LANGS.includes(req.query.lang) ? req.query.lang : 'es';
    const d = defaults(kind, req.query.period);
    if (d.error) return reply.code(400).send({ error: d.error });
    const prepared = kind === 'monthly' ? await prepareMonthly(d.period, d.today) : await prepareDaily(d.period, d.today);
    return { kind, period: d.period, lang, ...prepared.build(lang) };
  });

  app.post('/api/treasury/wa/send', G, async (req, reply) => {
    const b = req.body || {};
    const kind = b.kind === 'monthly' ? 'monthly' : 'daily';
    if (!waApiReady()) return reply.code(503).send({ error: 'wa_not_configured', detail: 'Railway 변수 WHATSAPP_TOKEN · WHATSAPP_PHONE_ID 가 필요합니다.' });
    const d = defaults(kind, b.period);
    if (d.error) return reply.code(400).send({ error: d.error });
    let recipients;
    if (b.recipient_id != null) {
      const r = (await query(`SELECT id, name, phone, lang FROM treasury_wa_recipients WHERE id=$1 AND deleted_at IS NULL`, [Number(b.recipient_id)])).rows[0];
      if (!r) return reply.code(404).send({ error: 'recipient_not_found' });
      recipients = [r];
    } else {
      recipients = await activeRecipients(kind);
      if (!recipients.length) return reply.code(400).send({ error: 'no_recipients' });
    }
    const prepared = kind === 'monthly' ? await prepareMonthly(d.period, d.today) : await prepareDaily(d.period, d.today);
    const results = await sendReport({ kind, period: d.period, recipients, prepared, force: true });
    await logEvent({ userId: req.ctx.perm.userId, action: 'export', target: `treasury_wa:${kind}:${d.period}`,
      detail: { n: results.length, ok: results.filter((x) => x.ok).length } });
    return { kind, period: d.period, results };
  });
}
