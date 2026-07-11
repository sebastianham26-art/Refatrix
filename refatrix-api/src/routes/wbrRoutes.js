import { query } from '../db.js';
import { authGuard, requirePage, requirePageEdit, requireDirector } from '../middleware/authGuard.js';
import { validateReceiptDataUrl } from '../ar.js';
import { logEvent } from '../audit.js';
import { pageAllowed } from '../permissions.js';
import { summarizeSla } from '../stageSla.js';
import { buildStageCohorts, getSlaKpi } from '../stageCohorts.js';

// buildStageCohorts / getSlaKpi 는 stageCohorts.js 공용 모듈로 이동(wbr·portal·창고 단일 기준).

// 고객명 노출 권한 없으면 items 의 고객명을 '비공개'로 가림
function maskSlaCustomers(sla, perm, isRegistered) {
  const canSee = perm.role === 'director' || pageAllowed(perm, 'customers', isRegistered);
  if (canSee) return { sla, can_see_customer: true };
  for (const k of ['order', 'packing', 'sat', 'collect']) {
    if (sla[k] && Array.isArray(sla[k].items)) {
      sla[k].items = sla[k].items.map((it) => ({ ...it, customer: '비공개' }));
    }
  }
  return { sla, can_see_customer: false };
}

// WBR(주간 비즈니스 리뷰) 보드 — 팀별 이슈 불릿 + 회의 메모를 단일 JSON 문서로 영속.
// 권한: 페이지키 'wbr'. 열람(view) 이상이면 조회, 수정(edit) 이상이면 저장. 디렉터는 항상 전체.
// 단일 행(id=1) 싱글톤.
export default async function wbrRoutes(app) {
  // 보드 조회 — 'wbr' 열람 권한 필요. can_edit 를 함께 내려 프런트가 열람 전용 UI 를 구성.
  app.get('/api/wbr/board', { preHandler: [authGuard, requirePage('wbr')] }, async (req) => {
    const r = (await query(`SELECT data, updated_at FROM wbr_board WHERE id=1`)).rows[0];
    const perm = req.ctx.perm;
    const canEdit = perm.role === 'director'
      || ((perm.pageAccess && perm.pageAccess['wbr']) === 'edit');
    return { data: (r && r.data) || {}, updated_at: r ? r.updated_at : null, can_edit: canEdit };
  });

  // 보드 저장(전체 덮어쓰기) — 'wbr' 수정 권한 필요. 프런트가 { data:{ issues, memo } } 전체 상태를 보냄
  app.put('/api/wbr/board', { preHandler: [authGuard, requirePageEdit('wbr')] }, async (req, reply) => {
    const data = req.body && req.body.data;
    if (data == null || typeof data !== 'object' || Array.isArray(data)) {
      return reply.code(400).send({ error: 'bad_data' });
    }
    let json;
    try { json = JSON.stringify(data); } catch { return reply.code(400).send({ error: 'bad_json' }); }
    if (json.length > 200000) return reply.code(413).send({ error: 'too_large' }); // 과대 페이로드 방어
    const uid = req.ctx.perm.userId;
    await query(
      `INSERT INTO wbr_board (id, data, updated_by, updated_at)
         VALUES (1, $1::jsonb, $2, now())
       ON CONFLICT (id) DO UPDATE
         SET data=EXCLUDED.data, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [json, uid]
    );
    logEvent({ userId: uid, deviceId: req.ctx.deviceId, action: 'wbr_board_save', target: 'wbr_board:1' });
    const r = (await query(`SELECT updated_at FROM wbr_board WHERE id=1`)).rows[0];
    return { ok: true, updated_at: r ? r.updated_at : null };
  });

  // ===== 화상회의 링크 (wbr_meeting 싱글톤) — 조회월 카드에 표시 =====
  //  열람권한: 링크 조회/클릭. 수정권한(디렉터 등): 링크 설정/변경.
  app.get('/api/wbr/meeting', { preHandler: [authGuard, requirePage('wbr')] }, async (req) => {
    const row = (await query(`SELECT url, updated_at FROM wbr_meeting WHERE id=1`)).rows[0];
    const perm = req.ctx.perm;
    const canEdit = perm.role === 'director'
      || ((perm.pageAccess && perm.pageAccess['wbr']) === 'edit');
    return { url: (row && row.url) || '', updated_at: row ? row.updated_at : null, can_edit: canEdit };
  });

  app.put('/api/wbr/meeting', { preHandler: [authGuard, requirePageEdit('wbr')] }, async (req, reply) => {
    let url = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
    if (url.length > 2000) return reply.code(413).send({ error: 'too_long' });
    if (url && !/^https?:\/\//i.test(url)) {
      return reply.code(400).send({ error: 'bad_url', note: 'http:// 또는 https:// 로 시작해야 합니다.' });
    }
    const uid = req.ctx.perm.userId;
    await query(
      `INSERT INTO wbr_meeting (id, url, updated_by, updated_at) VALUES (1, $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET url=EXCLUDED.url, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [url || null, uid]);
    logEvent({ userId: uid, deviceId: req.ctx.deviceId, action: 'wbr_meeting_set', target: 'wbr_meeting:1' });
    const r = (await query(`SELECT updated_at FROM wbr_meeting WHERE id=1`)).rows[0];
    return { ok: true, url: url || '', updated_at: r ? r.updated_at : null };
  });

  // ===== 팀별 주요이슈 사진 (wbr_issue_photos) =====
  // 보드 JSON엔 사진 id만 참조. 이미지(클라 압축 JPEG data URL)는 여기 별도 저장.
  // 업로드/삭제: 'wbr' 수정 권한. 조회: 'wbr' 열람 권한.

  // 수주 단계 SLA(준수율 + 평균 리드타임) — WBR 스냅샷에 동결. 조회월(ym CSV) · 팀(team CSV/total) 연동.
  //  · 코호트는 각 단계 "정의 이벤트"의 월로 귀속(견적일/포장출력월/SAT입력월/완납월).
  //  · 팀 가시성(visibleTeamIds) 적용. 디렉터=전체.
  app.get('/api/wbr/stage-sla', { preHandler: [authGuard, requirePage('wbr')] }, async (req) => {
    const months = String(req.query.ym || '').split(',').map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}$/.test(s));
    if (!months.length) months.push(new Date().toISOString().slice(0, 7));
    const cohorts = await buildStageCohorts(req.ctx.perm, req.query.team);
    const kpi = await getSlaKpi();
    return { ym: months, sla: summarizeSla(cohorts, new Date(), kpi), kpi };
  });

  // 포털 홈용 — 전 직원 접근(authGuard만). 팀 가시성 적용.
  //   고객명은 권한자(디렉터 또는 'customers' 화면 권한)만 노출, 나머지는 '비공개'.
  //   건수·금액·단계·상태는 전원 표시.
  app.get('/api/portal/stage-sla', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const cohorts = await buildStageCohorts(perm, 'total');
    const kpi = await getSlaKpi();
    const sla = summarizeSla(cohorts, new Date(), kpi);
    const out = maskSlaCustomers(sla, perm, req.ctx.isRegistered);
    out.kpi = kpi;
    return out;
  });

  // 업로드 — { thumb, full, caption? } (둘 다 data:image/...;base64,...)
  app.post('/api/wbr/photos', { preHandler: [authGuard, requirePageEdit('wbr')] }, async (req, reply) => {
    const b = req.body || {};
    if (!b.thumb || !b.full) return reply.code(400).send({ error: 'missing_image' });
    const tv = validateReceiptDataUrl(b.thumb, 400 * 1024);        // 썸네일 ≤ 400KB
    const fv = validateReceiptDataUrl(b.full, 4 * 1024 * 1024);    // 원본 ≤ 4MB
    if (!tv.ok || !tv.mime.startsWith('image/')) return reply.code(400).send({ error: 'bad_thumb', detail: tv.error });
    if (!fv.ok || !fv.mime.startsWith('image/')) return reply.code(400).send({ error: 'bad_full', detail: fv.error });
    const uid = req.ctx.perm.userId;
    const r = (await query(
      `INSERT INTO wbr_issue_photos (thumb_data, file_data, mime, caption, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [b.thumb, b.full, fv.mime, (b.caption || null), uid])).rows[0];
    logEvent({ userId: uid, deviceId: req.ctx.deviceId, action: 'wbr_photo_add', target: `wbr_photo:${r.id}` });
    return { id: Number(r.id) };
  });

  // 썸네일 일괄 조회 — ?ids=1,2,3 → 그리드용
  app.get('/api/wbr/photos/thumbs', { preHandler: [authGuard, requirePage('wbr')] }, async (req) => {
    const ids = String((req.query && req.query.ids) || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return { items: [] };
    const ph = ids.map((_, i) => '$' + (i + 1)).join(',');
    const rows = (await query(
      `SELECT id, thumb_data, mime, caption FROM wbr_issue_photos WHERE id IN (${ph})`, ids)).rows;
    return { items: rows.map((r) => ({ id: Number(r.id), thumb: r.thumb_data, mime: r.mime, caption: r.caption })) };
  });

  // 원본 1건 — 라이트박스(클릭 시 지연 로드)
  app.get('/api/wbr/photos/:id/full', { preHandler: [authGuard, requirePage('wbr')] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' });
    const r = (await query(`SELECT id, file_data, mime, caption FROM wbr_issue_photos WHERE id=$1`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return { id: Number(r.id), full: r.file_data, mime: r.mime, caption: r.caption };
  });

  // 삭제 — 단, 어떤 스냅샷이라도 이 사진을 참조 중이면 행은 보존(과거 스냅샷이 깨지지 않도록).
  //   라이브 보드의 참조는 프런트가 board.photos 에서 빼고 저장하므로, 행만 살려두면 라이브에선 사라지고 스냅샷에선 계속 보인다.
  app.delete('/api/wbr/photos/:id', { preHandler: [authGuard, requirePageEdit('wbr')] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' });
    const ref = (await query(`SELECT 1 FROM wbr_snapshots WHERE $1 = ANY(photo_ids) LIMIT 1`, [id])).rows[0];
    if (ref) {
      // 스냅샷이 참조 중 → 하드삭제하지 않고 보존(라이브 화면에선 프런트가 참조만 제거).
      logEvent({ userId: req.ctx.perm.userId, deviceId: req.ctx.deviceId, action: 'wbr_photo_del_kept', target: `wbr_photo:${id}` });
      return { ok: true, id, kept: true };
    }
    await query(`DELETE FROM wbr_issue_photos WHERE id=$1`, [id]);
    logEvent({ userId: req.ctx.perm.userId, deviceId: req.ctx.deviceId, action: 'wbr_photo_del', target: `wbr_photo:${id}` });
    return { ok: true, id };
  });

  // ===== 주간 스냅샷(동결 보관) =====
  // 저장/삭제 = 디렉터 전용. 목록/열람 = 'wbr' 열람 권한.

  // data.board.photos 에서 참조하는 사진 id 전부 추출(하드삭제 보호용 비정규화).
  function extractPhotoIds(data) {
    const out = new Set();
    const photos = data && data.board && data.board.photos;
    if (photos && typeof photos === 'object') {
      for (const tk of Object.keys(photos)) {
        const wks = photos[tk] || {};
        for (const wk of Object.keys(wks)) {
          const arr = wks[wk];
          if (Array.isArray(arr)) for (const v of arr) { const n = Number(v); if (Number.isInteger(n) && n > 0) out.add(n); }
        }
      }
    }
    return Array.from(out);
  }

  // 저장(신규 스냅샷 생성) — { label, period_label?, data } 전체 동결 페이로드.
  app.post('/api/wbr/snapshots', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const b = req.body || {};
    const label = (typeof b.label === 'string' ? b.label.trim() : '');
    const data = b.data;
    if (!label) return reply.code(400).send({ error: 'missing_label' });
    if (label.length > 200) return reply.code(400).send({ error: 'label_too_long' });
    if (data == null || typeof data !== 'object' || Array.isArray(data)) return reply.code(400).send({ error: 'bad_data' });
    let json;
    try { json = JSON.stringify(data); } catch { return reply.code(400).send({ error: 'bad_json' }); }
    if (json.length > 2000000) return reply.code(413).send({ error: 'too_large' }); // 2MB 방어(사진은 참조만이라 충분)
    const periodLabel = (typeof b.period_label === 'string' ? b.period_label.slice(0, 300) : null);
    const photoIds = extractPhotoIds(data);
    const uid = req.ctx.perm.userId;
    const r = (await query(
      `INSERT INTO wbr_snapshots (label, period_label, data, photo_ids, created_by)
         VALUES ($1, $2, $3::jsonb, $4, $5)
       RETURNING id, created_at`,
      [label, periodLabel, json, photoIds, uid]
    )).rows[0];
    logEvent({ userId: uid, deviceId: req.ctx.deviceId, action: 'wbr_snapshot_save', target: `wbr_snapshot:${r.id}` });
    return { id: Number(r.id), created_at: r.created_at };
  });

  // 목록 — 무거운 data 는 빼고 메타만(작성자 이름 포함). 최신순.
  app.get('/api/wbr/snapshots', { preHandler: [authGuard, requirePage('wbr')] }, async () => {
    const rows = (await query(
      `SELECT s.id, s.label, s.period_label, s.created_at, u.name AS created_by_name
         FROM wbr_snapshots s
         LEFT JOIN users u ON u.id = s.created_by
        ORDER BY s.created_at DESC`
    )).rows;
    return { items: rows.map((r) => ({ id: Number(r.id), label: r.label, period_label: r.period_label, created_at: r.created_at, created_by_name: r.created_by_name || null })) };
  });

  // 1건 전체(동결 data 포함) — 열람용.
  app.get('/api/wbr/snapshots/:id', { preHandler: [authGuard, requirePage('wbr')] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' });
    const r = (await query(
      `SELECT s.id, s.label, s.period_label, s.data, s.created_at, u.name AS created_by_name
         FROM wbr_snapshots s LEFT JOIN users u ON u.id = s.created_by
        WHERE s.id=$1`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return { id: Number(r.id), label: r.label, period_label: r.period_label, data: r.data || {}, created_at: r.created_at, created_by_name: r.created_by_name || null };
  });

  // 삭제 — 디렉터 전용.
  app.delete('/api/wbr/snapshots/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' });
    const r = (await query(`DELETE FROM wbr_snapshots WHERE id=$1 RETURNING id`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    logEvent({ userId: req.ctx.perm.userId, deviceId: req.ctx.deviceId, action: 'wbr_snapshot_del', target: `wbr_snapshot:${id}` });
    return { ok: true, id };
  });
}
