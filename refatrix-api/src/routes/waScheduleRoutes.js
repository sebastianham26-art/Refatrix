// =====================================================================
// Refatrix ERP · waScheduleRoutes.js — 관리 › WhatsApp 발송 시각 (0262) · 디렉터 전용
//   GET /api/wa-schedules            작업별 설정 + 다음 발송 예정 + 최근 발송 결과
//   PUT /api/wa-schedules/:job       { send_time:'HH:MM', target_day:'today'|'yesterday', enabled, skip_empty_sunday }
// =====================================================================
import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { JOBS, isJob, TIME_RE, TARGETS, WINDOW_MIN, loadSchedules, clearScheduleCache, mxParts, nextRun } from '../waSchedule.js';

const G = { preHandler: [authGuard, requireDirector] };

async function lastSends() {
  const out = {};
  const safe = async (sql) => { try { return (await query(sql)).rows; } catch (_) { return []; } };
  for (const r of await safe(`SELECT kind, MAX(sent_at) AS at FROM treasury_wa_sends WHERE sent_at IS NOT NULL GROUP BY kind`)) {
    out[r.kind === 'monthly' ? 'treasury_monthly' : 'treasury_daily'] = r.at;
  }
  const ds = await safe(`SELECT MAX(wa_sent_at) AS at FROM daily_summaries WHERE wa_sent_at IS NOT NULL`);
  if (ds[0] && ds[0].at) out.daily_summary = ds[0].at;
  return out;
}

export default async function waScheduleRoutes(app) {
  app.get('/api/wa-schedules', G, async () => {
    const sc = await loadSchedules(undefined, { fresh: true });
    const now = mxParts();
    const last = await lastSends();
    return {
      now_mx: `${now.ymd} ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`,
      window_min: WINDOW_MIN,
      items: Object.keys(JOBS).map((j) => ({ ...sc[j], next_run: nextRun(sc[j], now), last_sent_at: last[j] || null })),
    };
  });

  app.put('/api/wa-schedules/:job', G, async (req, reply) => {
    const job = String(req.params.job || '');
    if (!isJob(job)) return reply.code(404).send({ error: 'unknown_job' });
    const b = req.body || {};
    const cur = (await loadSchedules(undefined, { fresh: true }))[job];
    const send_time = b.send_time != null ? String(b.send_time).trim() : cur.send_time;
    if (!TIME_RE.test(send_time)) return reply.code(400).send({ error: 'bad_time', detail: 'HH:MM (00:00~23:59)' });
    const target_day = b.target_day != null ? b.target_day : cur.target_day;
    if (!TARGETS.includes(target_day)) return reply.code(400).send({ error: 'bad_target' });
    const enabled = typeof b.enabled === 'boolean' ? b.enabled : cur.enabled;
    const skip = typeof b.skip_empty_sunday === 'boolean' ? b.skip_empty_sunday : cur.skip_empty_sunday;
    try {
      await query(
        `INSERT INTO wa_schedules (job, send_time, target_day, enabled, skip_empty_sunday, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (job) DO UPDATE SET send_time=EXCLUDED.send_time, target_day=EXCLUDED.target_day, enabled=EXCLUDED.enabled,
           skip_empty_sunday=EXCLUDED.skip_empty_sunday, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [job, send_time, target_day, enabled, skip, req.ctx.perm.userId]);
    } catch (e) {
      if (/wa_schedules/.test(String(e && e.message))) return reply.code(503).send({ error: 'migration_required', detail: 'npm run migrate (0262)' });
      throw e;
    }
    clearScheduleCache();
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `wa_schedule:${job}`,
      detail: { from: { send_time: cur.send_time, target_day: cur.target_day, enabled: cur.enabled }, to: { send_time, target_day, enabled } } });
    const sc = (await loadSchedules(undefined, { fresh: true }))[job];
    return { ...sc, next_run: nextRun(sc, mxParts()) };
  });
}
