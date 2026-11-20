// =====================================================================
// Refatrix ERP · consultVisitSync.js — 📱 원클릭 빠른 녹음 → 영업활동 방문 기록 (2026-11-20 · 0333)
//
//   디렉터 요청: 하단 🎙 로 녹음한 미팅이 영업활동 「🧭 방문·동선 / 📋 방문 리뷰 / 아침 브리핑」에도 남게.
//   빠른 녹음 상담(sales_consults.quick_rec) 1건 = 방문(sales_visits) 1건 으로 짝지어 계속 맞춘다.
//     · 방문 생성 : 위치(GPS)가 확보되는 순간(방문 테이블은 좌표 필수). 날짜·시각 = 상담 생성 시각.
//     · 정보 갱신 : 업체명·고객 연결·대상자(+직함)·연락처·이메일·위치 → 방문에 그대로.
//     · AI 요약   : 고객상담 녹음 요약이 끝나면 방문 녹음(sales_visit_recordings, consult_rec_id)에 옮겨 적고,
//                   방문 노트에 [AI요약] 블록 병합(방문 녹음과 같은 규칙) → 방문 리뷰·브리핑·한국어 토글 그대로 동작.
//     · 펜딩      : 상담 펜딩 ↔ 방문 펜딩 1:1(consult_pending_id). 완료 체크는 어느 쪽에서 해도 양쪽 반영.
//     · 삭제      : 상담을 지우면 짝 방문도 지운다(소프트). 방문만 지우면 다시 살리지 않는다.
//   동기화는 **언제나 덤**이다 — 실패해도 상담 저장·녹음·요약은 막지 않는다(호출부에서 catch).
//   빠른 녹음이 아닌 일반 상담·일반 방문은 건드리지 않는다.
// =====================================================================
import { query, withTx } from './db.js';
import { mergeNote, summaryToNotes } from './visitAi.js';

// ── 0333 적용 여부 — 배포 직후 migrate 전에도 화면이 깨지지 않게(미적용이면 60초마다 재확인) ──
let colsOk = false, colsAt = 0;
export async function hasQuickCols() {
  if (colsOk) return true;
  if (Date.now() - colsAt < 60000) return false;
  colsAt = Date.now();
  try {
    const r = await query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name = 'sales_consults' AND column_name IN ('contact_title','info_pending','quick_rec','visit_id'))
           OR (table_name = 'sales_visit_recordings' AND column_name = 'consult_rec_id')
           OR (table_name = 'sales_visit_pendings' AND column_name = 'consult_pending_id')`);
    colsOk = (r.rows || []).length >= 6;
  } catch (_) { colsOk = false; }
  return colsOk;
}
export function resetQuickColsCache() { colsOk = false; colsAt = 0; }

export function metPersonOf(name, title) {
  const a = String(name || '').trim(), b = String(title || '').trim();
  return [a, b].filter(Boolean).join(' · ') || null;
}

// 빠른 녹음 상담 1건을 짝 방문에 맞춘다. 결과 객체는 테스트·로그용.
export async function syncConsultVisit(consultId) {
  const id = Number(consultId);
  if (!Number.isInteger(id) || id <= 0) return { skipped: 'bad_id' };
  if (!(await hasQuickCols())) return { skipped: 'no_cols' };
  return withTx(async (client) => {
    const q = client.query.bind(client);
    const c = (await q(
      `SELECT id, to_char(consult_date,'YYYY-MM-DD') AS consult_date, company_name, customer_id,
              contact_name, contact_title, wa_phone, email, geo_lat, geo_lng, geo_accuracy,
              created_by, created_at, deleted_at, quick_rec, visit_id
         FROM sales_consults WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!c || !c.quick_rec) return { skipped: 'not_quick' };
    let visitId = c.visit_id != null ? Number(c.visit_id) : null;

    if (c.deleted_at) {
      if (visitId) await q(`UPDATE sales_visits SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [visitId]);
      return { visit_id: visitId, deleted: true };
    }
    const met = metPersonOf(c.contact_name, c.contact_title);
    const hasGeo = c.geo_lat != null && c.geo_lng != null;
    let created = false;
    if (!visitId) {
      if (!hasGeo) return { skipped: 'no_geo' };      // 방문 기록은 좌표가 필수 — 위치가 오면 그때 만든다
      visitId = Number((await q(
        `INSERT INTO sales_visits
           (visit_date, visited_at, customer_id, place_name, geo_lat, geo_lng, geo_accuracy,
            met_person, contact_email, contact_phone, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [c.consult_date, c.created_at, c.customer_id, c.company_name, Number(c.geo_lat), Number(c.geo_lng),
          c.geo_accuracy != null ? Number(c.geo_accuracy) : null, met, c.email, c.wa_phone, Number(c.created_by)])).rows[0].id);
      await q(`UPDATE sales_consults SET visit_id = $2 WHERE id = $1`, [id, visitId]);
      created = true;
    } else {
      const v = (await q(`SELECT id, deleted_at FROM sales_visits WHERE id = $1`, [visitId])).rows[0];
      if (!v || v.deleted_at) return { visit_id: visitId, skipped: 'visit_deleted' };   // 방문만 지운 경우 되살리지 않음
      await q(
        `UPDATE sales_visits
            SET place_name = $2, customer_id = $3, met_person = $4, contact_email = $5, contact_phone = $6,
                geo_lat = COALESCE($7, geo_lat), geo_lng = COALESCE($8, geo_lng), geo_accuracy = COALESCE($9, geo_accuracy)
          WHERE id = $1`,
        [visitId, c.company_name, c.customer_id, met, c.email, c.wa_phone,
          hasGeo ? Number(c.geo_lat) : null, hasGeo ? Number(c.geo_lng) : null,
          hasGeo && c.geo_accuracy != null ? Number(c.geo_accuracy) : null]);
    }

    // ── AI 요약(가장 최근에 끝난 상담 녹음) → 방문 녹음 + 방문 노트 [AI요약] ──
    let recMirrored = false;
    const r = (await q(
      `SELECT id, mode, mime, duration_sec, transcript, summary_json, created_by, processed_at
         FROM sales_consult_recordings WHERE consult_id = $1 AND status = 'done' AND summary_json IS NOT NULL
        ORDER BY id DESC LIMIT 1`, [id])).rows[0];
    if (r) {
      const sj = typeof r.summary_json === 'string' ? r.summary_json : JSON.stringify(r.summary_json);
      const mode = r.mode === 'memo' ? 'memo' : 'full';
      const ex = (await q(`SELECT id FROM sales_visit_recordings WHERE consult_rec_id = $1`, [Number(r.id)])).rows[0];
      if (ex) {
        await q(
          `UPDATE sales_visit_recordings SET visit_id=$2, summary_json=$3, transcript=$4, status='done', error=NULL,
                  duration_sec=$5, processed_at=COALESCE($6, now()) WHERE id=$1`,
          [Number(ex.id), visitId, sj, r.transcript, r.duration_sec, r.processed_at]);
      } else {
        await q(
          `INSERT INTO sales_visit_recordings
             (visit_id, mode, mime, duration_sec, status, transcript, summary_json, created_by, processed_at, consult_rec_id)
           VALUES ($1,$2,$3,$4,'done',$5,$6,$7,COALESCE($8, now()),$9)`,
          [visitId, mode, r.mime, r.duration_sec, r.transcript, sj, Number(r.created_by), r.processed_at, Number(r.id)]);
      }
      let summary = null;
      try { summary = typeof r.summary_json === 'string' ? JSON.parse(r.summary_json) : r.summary_json; } catch (_) {}
      if (summary) {
        const notes = summaryToNotes(summary);
        const v = (await q(`SELECT talk_note, insight_note FROM sales_visits WHERE id=$1`, [visitId])).rows[0] || {};
        await q(`UPDATE sales_visits SET talk_note=$2, insight_note=$3 WHERE id=$1`,
          [visitId, mergeNote(v.talk_note, notes.talkAppend), mergeNote(v.insight_note, notes.insightAppend)]);
      }
      recMirrored = true;
    }

    // ── 펜딩 1:1 ──
    const cps = (await q(
      `SELECT id, content, to_char(due_date,'YYYY-MM-DD') AS due_date, done, done_at, done_by
         FROM sales_consult_pendings WHERE consult_id = $1 ORDER BY id ASC`, [id])).rows;
    const vps = (await q(
      `SELECT id, consult_pending_id FROM sales_visit_pendings WHERE visit_id = $1 AND consult_pending_id IS NOT NULL`, [visitId])).rows;
    const byCp = new Map(vps.map((p) => [Number(p.consult_pending_id), Number(p.id)]));
    const keep = new Set(cps.map((p) => Number(p.id)));
    for (const p of vps) {
      if (!keep.has(Number(p.consult_pending_id))) await q(`DELETE FROM sales_visit_pendings WHERE id = $1`, [Number(p.id)]);
    }
    for (const p of cps) {
      const vpId = byCp.get(Number(p.id));
      if (vpId) {
        await q(`UPDATE sales_visit_pendings SET content=$2, due_date=$3, done=$4, done_at=$5, done_by=$6 WHERE id=$1`,
          [vpId, p.content, p.due_date, !!p.done, p.done_at, p.done_by]);
      } else {
        await q(
          `INSERT INTO sales_visit_pendings (visit_id, content, due_date, done, done_at, done_by, consult_pending_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [visitId, p.content, p.due_date, !!p.done, p.done_at, p.done_by, Number(p.id)]);
      }
    }
    return { visit_id: visitId, created, rec_mirrored: recMirrored, pendings: cps.length };
  });
}

// 실패해도 본 작업을 막지 않는 호출(라우트·큐에서 사용)
export async function syncConsultVisitSafe(consultId, log) {
  try { return await syncConsultVisit(consultId); }
  catch (e) { try { if (log) log.warn({ err: String(e && e.message) }, 'consult→visit sync failed'); } catch (_) {} return { error: String(e && e.message) }; }
}

// 완료 체크를 짝 쪽에도 — 상담 펜딩 → 방문 펜딩
export async function mirrorConsultPendingDone(consultPendingId, done, userId) {
  if (!(await hasQuickCols())) return 0;
  try {
    const r = await query(
      `UPDATE sales_visit_pendings SET done=$2, done_at = CASE WHEN $2 THEN now() ELSE NULL END,
              done_by = CASE WHEN $2 THEN $3::bigint ELSE NULL END
        WHERE consult_pending_id = $1`, [Number(consultPendingId), !!done, Number(userId)]);
    return r.rowCount || 0;
  } catch (_) { return 0; }
}
// 방문 펜딩 → 상담 펜딩
export async function mirrorVisitPendingDone(visitPendingId, done, userId) {
  if (!(await hasQuickCols())) return 0;
  try {
    const r = await query(
      `UPDATE sales_consult_pendings SET done=$2, done_at = CASE WHEN $2 THEN now() ELSE NULL END,
              done_by = CASE WHEN $2 THEN $3::bigint ELSE NULL END
        WHERE id IN (SELECT consult_pending_id FROM sales_visit_pendings WHERE id = $1 AND consult_pending_id IS NOT NULL)`,
      [Number(visitPendingId), !!done, Number(userId)]);
    return r.rowCount || 0;
  } catch (_) { return 0; }
}
