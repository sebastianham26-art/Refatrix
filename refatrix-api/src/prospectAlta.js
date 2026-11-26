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
  infoCompleteness, scoreOf, deriveStage, stageRank, nameSimilarity,
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

let scoreCols = null;
async function hasScoreCols(q) {
  if (scoreCols != null) return scoreCols;
  try { scoreCols = (await q(`SELECT 1 FROM information_schema.columns WHERE table_name='prospects' AND column_name='score' LIMIT 1`)).rows.length > 0; }
  catch (_) { scoreCols = false; }
  return scoreCols;
}

// ── 기록 → 정보 충족도 · 점수 · 단계(자동) · 제안 ── (0336)
//   방문 수, 저장된 Alta 값, 관심 확인(사람), 견적 기록/ERP 견적, 고객 연결, 첫 인보이스, 최근 AI 제안을 모아 다시 계산한다.
//   단계는 앞으로만 자동 이동(중간 단계도 이력에 남김). 점수·단계가 바뀌면 prospect_score_log 한 줄.
export async function recomputeProspect(q, prospectId, { userId = null, reason = null } = {}) {
  if (!(await hasScoreCols(q))) return null;
  const id = Number(prospectId);
  const p = (await q(`SELECT id, stage, owner_user_id, customer_id, score FROM prospects WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
  if (!p) return null;
  const ev = (await q(
    `SELECT (SELECT COUNT(*)::int FROM sales_consults c WHERE c.prospect_id=$1 AND c.deleted_at IS NULL) AS visits,
            EXISTS (SELECT 1 FROM quotes qq WHERE qq.status <> 'cancelled'
                      AND (qq.prospect_id=$1 OR ($2::bigint IS NOT NULL AND qq.customer_id=$2))) AS quoted,
            EXISTS (SELECT 1 FROM prospect_stage_history h WHERE h.prospect_id=$1 AND h.to_stage IN ('interesado','cotizado') AND NOT h.auto) AS interest_confirmed,
            ($2::bigint IS NOT NULL AND EXISTS (SELECT 1 FROM sales_invoices si WHERE si.customer_id=$2 AND si.status='posted' AND si.deleted_at IS NULL)
              AND COALESCE((SELECT approval_status FROM customers WHERE id=$2),'approved') = 'approved') AS sale,
            (SELECT r.alta_draft->>'etapa_sugerida' || ':' || r.id FROM sales_consult_recordings r JOIN sales_consults c ON c.id=r.consult_id
               WHERE c.prospect_id=$1 AND c.deleted_at IS NULL AND r.alta_status='done' ORDER BY r.id DESC LIMIT 1) AS ai_stage_rec,
            (SELECT suggestion_dismissed FROM prospects WHERE id=$1) AS dismissed`,
    [id, p.customer_id == null ? null : Number(p.customer_id)])).rows[0];
  const vals = Object.fromEntries((await q(`SELECT field_key, value FROM prospect_crm_values WHERE prospect_id=$1`, [id])).rows.map((r) => [r.field_key, r.value]));
  const info = infoCompleteness(vals);
  const e = { owner: p.owner_user_id != null, visits: ev.visits, info_pct: info.pct, interest_confirmed: ev.interest_confirmed,
    interest: ev.interest_confirmed || ev.quoted || p.customer_id != null, quoted: ev.quoted, linked: p.customer_id != null, sale: ev.sale,
    ai_stage: ev.ai_stage_rec && ev.ai_stage_rec !== ev.dismissed ? String(ev.ai_stage_rec).split(':')[0] : null };
  const sc = scoreOf(e);
  // 단계: 앞으로만, 건너뛴 자동 단계도 이력에 남긴다(첫 도달 KPI)
  const d = deriveStage(e, p.stage);
  let stage = p.stage;
  const ladder = ['asignado', 'contactado', 'perfilado', 'interesado', 'registro', 'cotizado', 'cliente_activo'];
  if (stage !== 'descartado' || e.sale) {
    for (const st of ladder) {
      if (stageRank(st) > stageRank(d.auto)) break;
      if (st === 'interesado' && !e.interest_confirmed) continue;   // 관심은 사람이 확인(제안만)
      if (st === 'registro' && !e.linked) continue;                 // 등록 없이 게스트 견적이면 등록 이력은 남기지 않는다
      const nx = stage === 'descartado' ? (st === 'cliente_activo' ? st : null) : autoAdvance(stage, st);
      if (nx) { await moveStage(q, id, stage, nx, { userId, auto: true, reason: reason || 'registro automático' }); stage = nx; }
    }
  }
  const sug = d.suggest && stageRank(d.suggest.stage) !== stageRank(stage) && !(d.suggest.stage !== 'descartado' && stageRank(d.suggest.stage) <= stageRank(stage)) ? d.suggest : null;
  await q(`UPDATE prospects SET score=$2, info_pct=$3, score_parts=$4, score_at=now(),
                  suggested_stage=$5, suggestion_reason=$6, suggested_at=CASE WHEN $5::text IS NULL THEN NULL ELSE COALESCE(suggested_at, now()) END
            WHERE id=$1`, [id, sc.total, info.pct, JSON.stringify({ ...sc.parts, info_pct: info.pct, sections: info.sections }), sug ? sug.stage : null, sug ? sug.reason : null]);
  if (sc.total !== Number(p.score) || stage !== p.stage) {
    const owner = (await q(`SELECT owner_user_id FROM prospects WHERE id=$1`, [id])).rows[0].owner_user_id;
    await q(`INSERT INTO prospect_score_log (prospect_id, owner_user_id, score, prev_score, info_pct, stage, reason, user_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, owner, sc.total, Number(p.score) || 0, info.pct, stage, reason, userId]);
  }
  return { score: sc.total, prev: Number(p.score) || 0, info_pct: info.pct, stage, suggestion: sug };
}
export async function recomputeProspectSafe(prospectId, opts = {}, log) {
  try { return await withTx((client) => recomputeProspect(client.query.bind(client), prospectId, opts)); }
  catch (e) { try { log && log.warn && log.warn({ err: String(e && e.message) }, 'prospect recompute failed'); } catch (_) {} return null; }
}

export async function attachConsultToProspect({ consultId, prospectId, perm, lat = null, lng = null }) {
  if (!(await hasProspectCols())) return null;
  const pid = Number(prospectId);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const userId = Number(perm.userId);
  let isDir = perm.role === 'director';
  if (!isDir) { try { isDir = (await query(`SELECT 1 FROM prospect_managers WHERE user_id=$1`, [userId])).rows.length > 0; } catch (_) { /* 0338 전 */ } }
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
              WHERE s.route_id=r.id AND r.user_id=$1 AND (r.route_date=(now() AT TIME ZONE 'America/Mexico_City')::date OR r.route_date IS NULL)
                AND s.prospect_id=$2 AND s.consult_id IS NULL`, [owner == null ? userId : owner, pid, Number(consultId)]);
    await recomputeProspect(q, pid, { userId, reason: 'check-in' });
    return { prospect_id: pid, checkin_dist_m: dist };
  });
}
// 빠른 녹음에서 연결한 후보를 바꾸거나 뺄 때 — 상담·루트 정류장 연결만 푼다(지나간 단계 이력은 그대로)
export async function detachConsultFromProspect({ consultId, userId }) {
  if (!(await hasProspectCols())) return null;
  return withTx(async (client) => {
    const q = client.query.bind(client);
    const c = (await q(`SELECT prospect_id FROM sales_consults WHERE id=$1 FOR UPDATE`, [Number(consultId)])).rows[0];
    if (!c || !c.prospect_id) return { prospect_id: null };
    const pid = Number(c.prospect_id);
    await q(`UPDATE sales_consults SET prospect_id=NULL, checkin_dist_m=NULL WHERE id=$1`, [Number(consultId)]);
    await q(`UPDATE prospect_route_stops SET consult_id=NULL WHERE consult_id=$1`, [Number(consultId)]);
    await recomputeProspect(q, pid, { userId: Number(userId), reason: 'check-in quitado' });
    return { prospect_id: pid, detached: true };
  });
}
export async function detachConsultFromProspectSafe(args, log) {
  try { return await detachConsultFromProspect(args); }
  catch (e) { try { log && log.warn && log.warn({ err: String(e && e.message) }, 'prospect detach failed'); } catch (_) {} return null; }
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
  await recomputeProspectSafe(Number(p.id), { reason: 'resumen IA' });
  await logEvent({ userId: null, action: 'update', target: `consult_recording:${recId}`,
    detail: { alta_draft: Object.keys(draft.campos).length, prospect_id: Number(p.id) } }).catch(() => {});
  return { ok: true, fields: Object.keys(draft.campos).length };
}
export async function prospectAltaDraftSafe(args, log) {
  try { return await prospectAltaDraft(args); }
  catch (e) { try { log && log.warn && log.warn({ err: String(e && e.message) }, 'prospect alta draft failed'); } catch (_) {} return null; }
}

// 고객이 연결된 후보 다시 계산 — ERP 견적·승인·첫 인보이스가 생기면 단계·점수 반영
// 게스트 ERP 견적 자동 연결: 담당자가 만든 게스트 견적의 상호가 그 담당 후보의 상호와 거의 같으면(첫 방문 이후 견적) 연결
export async function syncGuestQuotes() {
  const qs = (await query(
    `SELECT q.id, q.guest_name, q.created_by, q.created_at FROM quotes q
      WHERE q.prospect_id IS NULL AND q.customer_id IS NULL AND q.status <> 'cancelled' AND q.guest_name IS NOT NULL
        AND q.created_at > now() - INTERVAL '120 days'`)).rows;
  const touched = new Set();
  for (const qt of qs) {
    const cands = (await query(
      `SELECT p.id, p.nom_estab, p.raz_social FROM prospects p
        WHERE p.deleted_at IS NULL AND p.owner_user_id=$1
          AND EXISTS (SELECT 1 FROM sales_consults c WHERE c.prospect_id=p.id AND c.deleted_at IS NULL AND c.created_at <= $2)`,
      [qt.created_by, qt.created_at])).rows;
    let best = null; let bs = 0;
    for (const c of cands) { const sc = Math.max(nameSimilarity(qt.guest_name, c.nom_estab), nameSimilarity(qt.guest_name, c.raz_social)); if (sc > bs) { bs = sc; best = c; } }
    if (best && bs >= 0.6) { await query(`UPDATE quotes SET prospect_id=$2 WHERE id=$1 AND prospect_id IS NULL`, [qt.id, best.id]); touched.add(Number(best.id)); }
  }
  for (const id of touched) await recomputeProspectSafe(id, { reason: 'cotización ERP' });
  return touched.size;
}
export async function refreshCustomerStages() {
  if (!(await hasProspectCols())) return 0;
  if (await hasScoreCols(query)) await syncGuestQuotes().catch(() => {});
  const rows = (await query(
    `SELECT id FROM prospects WHERE deleted_at IS NULL AND customer_id IS NOT NULL AND stage <> 'cliente_activo'`)).rows;
  let n = 0;
  for (const r of rows) {
    const out = await recomputeProspectSafe(Number(r.id), { reason: 'cliente ERP' });
    if (out && out.stage === 'cliente_activo') n++;
  }
  return n;
}
