// =====================================================================
// xrefMasterRoutes.js — 멕시코 경쟁사 크로스레퍼런스 마스터 업로드 · 버전 · 내려받기 (0325 · 2026-11-11)
//
//   POST /api/xref-master/upload          (디렉터) body { filename, aoa:[[…]], file_b64?, dry_run? }
//        · dry_run=true  → 저장 없이 미리보기(행 수 · 브랜드별 코드 수 · ERP CTR 로 이어지는 행 수 · 표본)
//        · 저장          → 새 버전 활성화 · 검색용 행/코드 교체 · 원본 파일 보관 → 개발요청 자동 검수 실행
//   GET  /api/xref-master/versions        (제품 · 견적 · 영업 화면) 업로드 이력
//   GET  /api/xref-master/versions/:id/file · /api/xref-master/latest/file   원본 .xlsx 내려받기
//   GET  /api/xref-master/lookup?code=&brand=   한 코드가 어디로 이어지는지(점검용)
// =====================================================================
import { query, withTx } from '../db.js';
import { authGuard, requireDirector, requirePageAny } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { parseMasterAoa, normCode, invalidateXrefMaster, xrefMasterReady, bridgeOne, normBrand, competitorCodesFor, COMPETITOR_BRANDS } from '../xrefMaster.js';
import { sweepDevRequestMatches } from '../devMatchSweep.js';

const UPLOAD_BODY_LIMIT = 40 * 1024 * 1024;   // 원본(base64) + 시트 배열 — 9,500행 파일 ≈ 4MB
const KEEP_FILES = 20;                         // 원본 파일은 최근 20개 버전만 보관(이력 행은 계속 남는다)
const VIEW_PAGES = ['products', 'quote', 'sales', 'devrequest', 'marketing'];

function safeName(s) {
  const n = String(s || 'mexico_cross_reference.xlsx').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 140);
  return /\.xlsx?$/i.test(n) ? n : n + '.xlsx';
}

export default async function xrefMasterRoutes(app) {
  const notReady = (reply) => reply.code(503).send({ error: 'migration_pending', note: '서버 마이그레이션 0325 적용 후 사용할 수 있습니다 (Railway 콘솔 npm run migrate).' });

  app.post('/api/xref-master/upload', { preHandler: [authGuard, requireDirector], bodyLimit: UPLOAD_BODY_LIMIT }, async (req, reply) => {
    if (!(await xrefMasterReady())) return notReady(reply);
    const b = req.body || {};
    const parsed = parseMasterAoa(b.aoa);
    if (!parsed.ok) return reply.code(400).send(parsed);
    if (!parsed.rows.length) return reply.code(400).send({ error: 'no_rows', note: '코드가 있는 행이 없습니다.' });
    if (!parsed.header.brands.includes('SYD')) return reply.code(400).send({ error: 'no_syd_column', note: 'SYD 열이 필요합니다.' });

    // ERP CTR 로 이어지는 행 수(미리보기 · 저장 공통) — 임시로 SYD/CTR 코드만 모아 한 번에 대조
    const sydN = new Set(), ctrN = new Set();
    for (const r of parsed.rows) {
      for (const s of (r.codes.SYD || [])) sydN.add(normCode(s));
      for (const s of (r.codes.CTR || [])) ctrN.add(normCode(s));
    }
    const knownSyd = new Set((await query(
      `SELECT DISTINCT regexp_replace(upper(s.syd_code), '[^A-Z0-9]', '', 'g') AS n
         FROM product_syd_codes s JOIN products p ON p.id = s.product_id AND p.deleted_at IS NULL
        WHERE regexp_replace(upper(s.syd_code), '[^A-Z0-9]', '', 'g') = ANY($1)`, [[...sydN]])).rows.map((x) => x.n));
    const knownCtr = new Set(ctrN.size ? (await query(
      `SELECT regexp_replace(upper(code), '[^A-Z0-9]', '', 'g') AS n FROM products
        WHERE deleted_at IS NULL AND regexp_replace(upper(code), '[^A-Z0-9]', '', 'g') = ANY($1)`, [[...ctrN]])).rows.map((x) => x.n) : []);
    let bridged = 0, noSyd = 0;
    for (const r of parsed.rows) {
      const syd = r.codes.SYD || [], ctr = r.codes.CTR || [];
      if (!syd.length && !ctr.length) noSyd++;
      if (syd.some((s) => knownSyd.has(normCode(s))) || ctr.some((s) => knownCtr.has(normCode(s)))) bridged++;
    }
    const summary = {
      filename: b.filename || null, header_row: parsed.header_row, brands: parsed.header.brands,
      rows: parsed.rows.length, codes: parsed.code_count, brand_counts: parsed.brand_counts,
      bridged_rows: bridged, unbridged_rows: parsed.rows.length - bridged, no_syd_rows: noSyd, empty_rows: parsed.empty_rows,
      sample: parsed.rows.slice(0, 5).map((r) => ({ row_no: r.row_no, codes: r.codes, descripcion: r.descripcion || null })),
    };
    if (b.dry_run) return { dry_run: true, ...summary };

    let file = null;
    if (b.file_b64) {
      try { file = Buffer.from(String(b.file_b64).replace(/^data:[^,]*,/, ''), 'base64'); } catch (_) { file = null; }
      if (file && !file.length) file = null;
    }
    const uid = req.ctx.perm.userId;
    const ver = await withTx(async (c) => {
      const v = (await c.query(
        `INSERT INTO xref_master_versions (filename, file_data, file_size, row_count, code_count, brand_counts, bridged_rows, is_active, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,$8) RETURNING id, uploaded_at`,
        [safeName(b.filename), file, file ? file.length : null, parsed.rows.length, parsed.code_count,
          JSON.stringify(parsed.brand_counts), bridged, uid])).rows[0];
      const vid = Number(v.id);
      // 행 — 2,000행씩 unnest 로 한 문장
      for (let i = 0; i < parsed.rows.length; i += 2000) {
        const ch = parsed.rows.slice(i, i + 2000);
        await c.query(
          `INSERT INTO xref_master_rows (version_id, row_no, syd_text, ctr_text, codes, descripcion, precio, aplicacion, ubicacion)
           SELECT $1, t.row_no, t.syd, t.ctr, t.codes, t.descr, t.precio, t.app, t.ubic
             FROM unnest($2::int[], $3::text[], $4::text[], $5::jsonb[], $6::text[], $7::numeric[], $8::text[], $9::text[])
                  AS t(row_no, syd, ctr, codes, descr, precio, app, ubic)`,
          [vid, ch.map((r) => r.row_no), ch.map((r) => r.syd_text), ch.map((r) => r.ctr_text),
            ch.map((r) => JSON.stringify(r.codes)), ch.map((r) => r.descripcion || null),
            ch.map((r) => (r.precio != null ? r.precio : null)), ch.map((r) => r.aplicacion || null), ch.map((r) => r.ubicacion || null)]);
      }
      const flat = [];
      for (const r of parsed.rows) for (const [brand, list] of Object.entries(r.codes)) for (const code of list) flat.push([r.row_no, brand, code, normCode(code)]);
      for (let i = 0; i < flat.length; i += 5000) {
        const ch = flat.slice(i, i + 5000);
        await c.query(
          `INSERT INTO xref_master_codes (version_id, row_no, brand, code, norm_code)
           SELECT $1, t.r, t.b, t.c, t.n FROM unnest($2::int[], $3::text[], $4::text[], $5::text[]) AS t(r, b, c, n)`,
          [vid, ch.map((x) => x[0]), ch.map((x) => x[1]), ch.map((x) => x[2]), ch.map((x) => x[3])]);
      }
      // 새 버전 활성화 · 이전 버전의 검색용 행/코드 정리 · 오래된 원본 파일 정리
      await c.query(`UPDATE xref_master_versions SET is_active = (id = $1)`, [vid]);
      await c.query(`DELETE FROM xref_master_codes WHERE version_id <> $1`, [vid]);
      await c.query(`DELETE FROM xref_master_rows WHERE version_id <> $1`, [vid]);
      await c.query(
        `UPDATE xref_master_versions SET file_data = NULL
          WHERE file_data IS NOT NULL AND id NOT IN (SELECT id FROM xref_master_versions ORDER BY id DESC LIMIT ${KEEP_FILES})`);
      return { id: vid, uploaded_at: v.uploaded_at };
    });
    invalidateXrefMaster();
    await logEvent({ userId: uid, action: 'create', target: `xref_master:${ver.id}`,
      detail: { filename: b.filename || null, rows: parsed.rows.length, codes: parsed.code_count, bridged } });
    // 크로스레퍼런스가 바뀌었다 → 개발요청 자동 검수(매칭되면 개발완료 + 팝업)
    let devMatch = null;
    try {
      const sw = await sweepDevRequestMatches({ userId: uid, notify: true });
      devMatch = { checked: sw.checked, matched: sw.matched, ambiguous: (sw.ambiguous || []).length,
        items: (sw.items || []).slice(0, 30).map((x) => ({ id: x.id, input_code: x.input_code, ctr_code: x.ctr_code, via: x.via || null })) };
    } catch (_) { devMatch = null; }
    return { ok: true, version_id: ver.id, uploaded_at: ver.uploaded_at, ...summary, sample: undefined, dev_match: devMatch };
  });

  app.get('/api/xref-master/versions', { preHandler: [authGuard, requirePageAny(VIEW_PAGES)] }, async (req, reply) => {
    if (!(await xrefMasterReady())) return { ready: false, items: [] };
    const rows = (await query(
      `SELECT v.id, v.filename, v.file_size, v.row_count, v.code_count, v.brand_counts, v.bridged_rows, v.is_active,
              v.uploaded_at, (v.file_data IS NOT NULL) AS has_file, u.name AS uploaded_by_name
         FROM xref_master_versions v LEFT JOIN users u ON u.id = v.uploaded_by
        ORDER BY v.id DESC LIMIT 30`)).rows;
    return { ready: true, items: rows.map((r) => ({
      id: Number(r.id), filename: r.filename, file_size: r.file_size != null ? Number(r.file_size) : null,
      rows: Number(r.row_count) || 0, codes: Number(r.code_count) || 0, brand_counts: r.brand_counts || {},
      bridged_rows: r.bridged_rows != null ? Number(r.bridged_rows) : null, is_active: !!r.is_active,
      uploaded_at: r.uploaded_at, uploaded_by: r.uploaded_by_name || '', has_file: !!r.has_file })) };
  });

  async function sendFile(reply, row) {
    if (!row) return reply.code(404).send({ error: 'not_found', note: '내려받을 업로드 파일이 없습니다.' });
    if (!row.file_data) return reply.code(410).send({ error: 'file_purged', note: '이 버전의 원본 파일은 보관 기간이 지나 정리되었습니다.' });
    const name = safeName(row.filename);
    const ascii = name.replace(/[^\x20-\x7E]/g, '_');
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    reply.header('X-Filename', encodeURIComponent(name));
    reply.header('Access-Control-Expose-Headers', 'Content-Disposition, X-Filename');
    return reply.send(Buffer.from(row.file_data));
  }
  app.get('/api/xref-master/latest/file', { preHandler: [authGuard, requirePageAny(VIEW_PAGES)] }, async (req, reply) => {
    if (!(await xrefMasterReady())) return notReady(reply);
    const row = (await query(
      `SELECT filename, file_data FROM xref_master_versions WHERE file_data IS NOT NULL ORDER BY is_active DESC, id DESC LIMIT 1`)).rows[0];
    await logEvent({ userId: req.ctx.perm.userId, action: 'export', target: 'xref_master:download_latest' });
    return sendFile(reply, row);
  });
  app.get('/api/xref-master/versions/:id/file', { preHandler: [authGuard, requirePageAny(VIEW_PAGES)] }, async (req, reply) => {
    if (!(await xrefMasterReady())) return notReady(reply);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'bad_id' });
    const row = (await query(`SELECT filename, file_data FROM xref_master_versions WHERE id=$1`, [id])).rows[0];
    await logEvent({ userId: req.ctx.perm.userId, action: 'export', target: `xref_master:${id}:download` });
    return sendFile(reply, row);
  });

  // 0325b · 견적 엑셀 「경쟁사 코드 열」 — body { codes:[CTR…], brands:['BAW','KYB'…] } → { items: { CTR: { BAW:[…] } } }
  //   견적 작성(엑셀 다운로드 · 전체 가격표 · Top 500 · 전체 견적) · 견적 목록 상세(엑셀 재고분)가 쓴다.
  app.post('/api/xref-master/codes-for', { preHandler: [authGuard, requirePageAny(VIEW_PAGES)], bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const b = req.body || {};
    const brands = (Array.isArray(b.brands) ? b.brands : []).map(normBrand).filter((x) => x && COMPETITOR_BRANDS.includes(x));
    const codes = (Array.isArray(b.codes) ? b.codes : []).slice(0, 40000);
    const ready = await xrefMasterReady();
    if (!brands.length || !codes.length) return { ready, brands, items: {} };
    let map = new Map();
    if (ready) map = await competitorCodesFor(codes, brands);
    else {
      // 0325 전 — 제품 교차참조만
      try {
        const xr = (await query(
          `SELECT p.code AS ctr, x.brand, x.xref_code FROM product_xref_codes x JOIN products p ON p.id = x.product_id AND p.deleted_at IS NULL
            WHERE p.code = ANY($1::text[])`, [codes.map(String)])).rows;
        for (const r of xr) { const br = normBrand(r.brand); if (!brands.includes(br)) continue;
          if (!map.has(r.ctr)) map.set(r.ctr, {}); (map.get(r.ctr)[br] = map.get(r.ctr)[br] || []).push(r.xref_code); }
      } catch (_) {}
    }
    return { ready, brands, items: Object.fromEntries(map) };
  });

  app.get('/api/xref-master/lookup', { preHandler: [authGuard, requirePageAny(VIEW_PAGES)] }, async (req, reply) => {
    if (!(await xrefMasterReady())) return notReady(reply);
    const code = String(req.query.code || '').trim();
    if (!code) return reply.code(400).send({ error: 'code_required' });
    const r = await bridgeOne(code, { brand: normBrand(req.query.brand) });
    return { code, brand: normBrand(req.query.brand), hits: r.hits,
      products: [...r.products.entries()].map(([pid, p]) => ({ product_id: pid, ...p })) };
  });
}

