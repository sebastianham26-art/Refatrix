// =====================================================================
// Refatrix ERP · prospectAlta.js — 「영업 > 고객개발」 ↔ 기존 「고객상담」 녹음 연결 (2026-11-25)
//   ① attachConsultToProspectSafe : 빠른 녹음(체크인)으로 만든 상담을 후보에 연결
//        - 업체명 자리표시자면 후보 상호로 채움 · 체크인 거리 계산 · 검토 대기(por_revisar)
//        - 후보 단계 자동: → 컨택(contactado) · 마지막 활동 시각 · 오늘 루트 정류장에 방문 연결
//        - 미배정 후보를 방문하면 그 담당자에게 배정(디렉터가 나중에 바꿀 수 있음)
//   ② prospectAltaDraftSafe : 기존 요약이 끝난 뒤(consultRoutes.processOne) 같은 전사문으로
//        Alta de clientes 양식 초안을 만들어 sales_consult_recordings.alta_draft 에 저장.
//        → CRM 값은 바뀌지 않는다. 담당자가 화면에서 확인·「확정 후 저장」해야 들어간다.
//   ③ refreshCustomerStages : 연결된 고객이 승인 + 첫 게시 인보이스면 → 신규고객(cliente_activo)
//   0334 마이그레이션 전이면 전부 조용히 아무것도 안 한다(무회귀).
// =====================================================================
import { query, withTx } from './db.js';
import { logEvent } from './audit.js';
import {
  distanceM, autoAdvance, prefillFromProspect, buildAltaPrompt, parseAltaDraft,
} from './prospectCore.js';

export const QUICK_PLACEHOLDER = '(업체 미입력)';

let colsCache = null;
export async function hasProspectCols() {
  if (colsCache != null) return colsCache;
  try {
    const r = await query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='sales_consults' AND column_name='prospect_id' LIMIT 1`);
    colsCache = r.rows.length > 0;
  } catch (_) { colsCache = false; }
  return colsCache;
}
export function resetProspectColsCache() { colsCache = null; }

// 단계 이동 + 이력(같은 트랜잭션 q 사용 가능)
export async function moveStage(q, prospectId, from, to, { userId = null, reason = null, auto = false } = {}) {
  await q(`UPDATE prospects SET stage=$2, stage_since=now(), updated_at=now(),
                  discard_reason = CASE WHEN $2='descartado' THEN $3 ELSE NULL END
            WHERE id=$1`, [prospectId, to, reason]);
  await q(`INSERT INTO prospect_stage_history (prospect_id, from_stage, to_stage, user_id, reason, auto)
           VALUES ($1,$2,$3,$4,$5,$6)`, [prospectId, from, to, userId, reason, auto]);
}

export async function attachConsultToProspect({ consultId, prospectId, perm, lat = null, lng = null }) {
  if (!(await hasProspectCols())) return null;
  const pid = Number(prospectId);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const userId = Number(perm.userId);
  const isDir = perm.role === 'director';
  return withTx(async (client) => {
    const q = client.query.bind(client);
    const p = (await q(`SELECT id, nom_estab, owner_user_id, stage, lat, lng FROM prospects
                         WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [pid])).rows[0];
    if (!p) return { error: 'prospect_not_found' };
    const owner = p.owner_user_id == null ? null : Number(p.owner_user_id);
    if (!isDir && owner != null && owner !== userId) return { error: 'not_owner' };
    // 미배정 후보를 방문 → 방문한 담당자에게 배정
    let stage = p.stage;
    if (owner == null && !isDir) {
      await q(`UPDATE prospects SET owner_user_id=$2, assigned_at=now() WHERE id=$1`, [pid, userId]);
      await q(`INSERT INTO prospect_assign_history (prospect_id, from_user, to_user, by_user) VALUES ($1,NULL,$2,$2)`, [pid, userId]);
      const nx = autoAdvance(stage, 'asignado');
      if (nx) { await moveStage(q, pid, stage, nx, { userId, auto: true, reason: 'visita' }); stage = nx; }
    }
    const dist = distanceM(lat, lng, p.lat, p.lng);
    await q(`UPDATE sales_consults
                SET prospect_id=$2, checkin_dist_m=$3, review_status=COALESCE(review_status,'por_revisar'),
                    company_name = CASE WHEN company_name=$4 OR company_name IS NULL OR company_name='' THEN $5 ELSE company_name END,
                    info_pending = CASE WHEN company_name=$4 THEN FALSE ELSE info_pending END
              WHERE id=$1`, [Number(consultId), pid, dist, QUICK_PLACEHOLDER, p.nom_estab]);
    const nx = autoAdvance(stage, 'contactado');
    if (nx) await moveStage(q, pid, stage, nx, { userId, auto: true, reason: 'check-in' });
    await q(`UPDATE prospects SET last_activity_at=now(), updated_at=now() WHERE id=$1`, [pid]);
    // 오늘 루트 정류장이면 방문 연결
    await q(`UPDATE prospect_route_stops s SET consult_id=$3
               FROM prospect_routes r
              WHERE s.route_id=r.id AND r.user_id=$1 AND r.route_date=(now() AT TIME ZONE 'America/Mexico_City')::date
                AND s.prospect_id=$2 AND s.consult_id IS NULL`, [owner == null ? userId : owner, pid, Number(consultId)]);
    return { prospect_id: pid, checkin_dist_m: dist };
  });
}
export async function attachConsultToProspectSafe(args, log) {
  try { return await attachConsultToProspect(args); }
  catch (e) { try { log && log.warn && log.warn({ err: String(e && e.message) }, 'prospect attach failed'); } catch (_) {} return null; }
}

// 기존 요약이 끝난 직후 호출 — summarize 는 consultRoutes 의 consultAiApi.summarize(같은 키·같은 모델)
export async function prospectAltaDraft({ consultId, recId, transcript, summary, summarize }) {
  if (!(await hasProspectCols())) return null;
  const c = (await query(`SELECT id, prospect_id, company_name FROM sales_consults WHERE id=$1`, [Number(consultId)])).rows[0];
  if (!c || !c.prospect_id) return null;
  const p = (await query(`SELECT * FROM prospects WHERE id=$1`, [Number(c.prospect_id)])).rows[0];
  if (!p) return null;
  await query(`UPDATE sales_consult_recordings SET alta_status='pending', alta_error=NULL WHERE id=$1`, [Number(recId)]);
  const summaryText = summary ? [summary.resumen, ...(summary.bullets || []).map((b) => `- ${b.text}`)].filter(Boolean).join('\n') : '';
  const prompt = buildAltaPrompt({ transcript, companyName: p.nom_estab, prefill: prefillFromProspect(p), summaryText });
  const r = await summarize(prompt, 3000);
  if (!r || !r.ok) {
    await query(`UPDATE sales_consult_recordings SET alta_status='failed', alta_error=$2 WHERE id=$1`,
      [Number(recId), String((r && r.error) || 'ai').slice(0, 300)]);
    return { error: r && r.error };
  }
  const draft = parseAltaDraft(r.text);
  if (!draft) {
    await query(`UPDATE sales_consult_recordings SET alta_status='failed', alta_error='parse' WHERE id=$1`, [Number(recId)]);
    return { error: 'parse' };
  }
  await query(`UPDATE sales_consult_recordings SET alta_draft=$2, alta_status='done', alta_error=NULL WHERE id=$1`,
    [Number(recId), JSON.stringify(draft)]);
  await query(`UPDATE sales_consults SET review_status = CASE WHEN review_status='confirmado' THEN 'por_revisar' ELSE COALESCE(review_status,'por_revisar') END
                WHERE id=$1`, [Number(consultId)]);
  await logEvent({ userId: null, action: 'update', target: `consult_recording:${recId}`,
    detail: { alta_draft: Object.keys(draft.campos).length, prospect_id: Number(p.id) } }).catch(() => {});
  return { ok: true, fields: Object.keys(draft.campos).length };
}
export async function prospectAltaDraftSafe(args, log) {
  try { return await prospectAltaDraft(args); }
  catch (e) { try { log && log.warn && log.warn({ err: String(e && e.message) }, 'prospect alta draft failed'); } catch (_) {} return null; }
}

// 연결 고객이 승인됐고 게시 인보이스가 있으면 → 신규고객
export async function refreshCustomerStages() {
  if (!(await hasProspectCols())) return 0;
  const rows = (await query(
    `SELECT p.id, p.stage FROM prospects p
       JOIN customers c ON c.id = p.customer_id
      WHERE p.deleted_at IS NULL AND p.stage NOT IN ('cliente_activo','descartado')
        AND COALESCE(c.approval_status,'approved') = 'approved'
        AND EXISTS (SELECT 1 FROM sales_invoices si WHERE si.customer_id=c.id AND si.status='posted' AND si.deleted_at IS NULL)`)).rows;
  for (const r of rows) {
    await withTx(async (client) => moveStage(client.query.bind(client), Number(r.id), r.stage, 'cliente_activo',
      { auto: true, reason: 'cliente aprobado + primera factura' }));
  }
  return rows.length;
}
