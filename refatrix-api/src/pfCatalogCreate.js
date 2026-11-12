// =====================================================================
// Refatrix ERP · pfCatalogCreate.js — REFATRIX Platform 신규 CTR 생성 (0326 · 2026-11-11 · v2 2026-11-12)
//   v2: SYD 카탈로그 · 매칭테스트 「ERP에 CTR 없음」 행 검토 자동 등록(source refatrix-rowreview) 대응
//       · 품목은 코드 · 한글 · 스페인어 · 영어 이름 모두 받고, 모르는 값은 막지 않고 warnings 로 알린다
//       · 출처(source)별 ERP 기록 문구 · 409 existing 에 source · syd_codes · from_platform
//   POST /api/pf-catalog/items  (요청서: ERP 개발 요청 — 신규 CTR 제품 생성 API 2026-11-11)
//
//   흐름
//     샘플 검토(sample_review.html)에서 맞는 CTR 이 없음 → 개발팀이 신규 코드를 정함 → 이 API
//     → products 1행(개발 중 · 판매 비활성) + SYD · 적용차종 · OE 파생 데이터
//     → 카탈로그 점검 「확인완료」(status ok · confirmed_by_name = 플랫폼 로그인 이름) → SYD 카탈로그 기록 열에 바로 보임
//
//   양보하지 않은 것
//     1) 같은 코드(삭제된 제품 포함 · 대소문자 무시)는 절대 새로 만들지 않는다 → 409 CODE_EXISTS
//     2) 가격 · 재고 · 원가는 받지도 쓰지도 않는다(정가 0 · 재고 0 기본값).
//     3) 판매 비활성(is_active=false) + 공장상태 「개발(development)」 로 시작한다.
//        → 가격 없는 품목이 CRM · 고객 카탈로그에 「판매 중 $0」 으로 나가지 않고, 구매 추천에도 잡히지 않는다.
//        가격을 넣고 ERP 제품 화면에서 활성으로 바꾸면 그때부터 판다.
//     4) 칸 규칙은 카탈로그 점검 확인완료와 같다(normValue · canonPos) — 같은 값이 두 경로에서 다르게 저장되지 않는다.
// =====================================================================
import { query, withTx } from './db.js';
import { splitSyd, parseApplications } from './productImport.js';
import { parseOe } from './oeParse.js';
import { syncOe } from './oeCodes.js';
import { canonPos } from './productPositions.js';
import { normValue, FP_SQL } from './pfCatalog.js';

export const CATEGORIES = {
  ball: '볼조인트', tre: '타이로드 엔드 · 이너', ctl: '컨트롤암', stb: '스태빌라이저 링크',
  bush: '부싱', shk: '쇼크업소버', mnt: '마운트', idl: '아이들러 · 피트먼 암', other: '기타',
};
export const DEFAULT_SOURCE = 'refatrix-sample-review';
// 출처 → ERP 기록에 남는 이름. 모르는 출처도 받는다(이름은 「플랫폼」).
export const SOURCES = { 'refatrix-sample-review': '샘플 검토', 'refatrix-rowreview': 'SYD 카탈로그 행 검토' };
export const sourceLabel = (s) => SOURCES[s] || '플랫폼';

// 품목 별칭 — 행 검토는 품명으로 품목을 추정해 보낸다(코드가 아니라 이름일 수 있음). 공백 · 하이픈 · 밑줄 · 대소문자 무시.
const CAT_ALIAS = {
  ball: ['ball', 'balljoint', '볼조인트', '볼', 'rotula', 'rótula', 'rotulas'],
  tre: ['tre', 'tierod', 'tierodend', 'innertierod', '타이로드', '타이로드엔드', '타이로드엔드이너', '이너', 'terminal', 'terminaldedireccion', 'terminaldedirección', 'barraaxial', 'axial', 'bieleta'],
  ctl: ['ctl', 'controlarm', 'arm', '컨트롤암', 'horquilla', 'brazo', 'brazodecontrol'],
  stb: ['stb', 'stabilizerlink', 'stablink', 'sway', 'link', '스태빌라이저링크', '스태빌라이저', '링크', 'tornilloestabilizador', 'estabilizador', 'linkestabilizador'],
  bush: ['bush', 'bushing', '부싱', 'buje', 'bujes'],
  shk: ['shk', 'shock', 'shockabsorber', 'strut', '쇼크업소버', '쇼크', 'amortiguador', 'amortiguadores'],
  mnt: ['mnt', 'mount', 'strutmount', '마운트', 'soporte', 'base', 'basedeamortiguador'],
  idl: ['idl', 'idler', 'idlerarm', 'pitman', 'pitmanarm', '아이들러', '피트먼', '아이들러피트먼암', 'brazoloco', 'brazopitman'],
  other: ['other', 'etc', '기타', 'otro', 'otros'],
};
const catKey = (x) => String(x).toLowerCase().normalize('NFC').replace(/[\s·.\-_/]+/g, '');
const CAT_MAP = new Map();
for (const [k, list] of Object.entries(CAT_ALIAS)) { CAT_MAP.set(k, k); for (const a of list) CAT_MAP.set(catKey(a), k); }
for (const [k, label] of Object.entries(CATEGORIES)) CAT_MAP.set(catKey(label), k);
/** 품목 값 → 코드. 빈 값 null · 모르는 값 undefined. */
export function canonCategory(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return null;
  const k = CAT_MAP.get(catKey(t));
  return k || undefined;
}
// 코드: 영문 대문자 · 숫자 · 하이픈, 3~30자. PRO(사내) · K0001…(VIO 키트)는 카탈로그 점검 대상이 아니라 막는다.
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,29}$/;

// 0326 이 아직 없으면 생성만 쉰다(501 → 플랫폼은 「ERP 전송 대기」 로 둔다). 긍정은 영구, 부정은 30초마다.
let ready = false; let probeAt = 0;
export async function pfCreateReady() {
  if (ready) return true;
  if (Date.now() - probeAt < 30000) return false;
  probeAt = Date.now();
  try { ready = !!(await query(`SELECT to_regclass('public.pf_catalog_creates') AS t`)).rows[0].t; } catch (_) { ready = false; }
  return ready;
}
export function setPfCreateReady(v) { ready = !!v; probeAt = Date.now(); }

const str = (v, n) => (v == null ? '' : String(v)).slice(0, n);

/**
 * 요청 본문 검사 · 정규화(순수 — DB 를 모른다).
 *   returns { values:{code,name,scode,app,oe,material,pos}, category, source, note } | { error, field?, detail? }
 */
export function parseCreate(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) return { error: 'bad_body', detail: 'JSON 객체가 필요합니다.' };
  const code = String(b.code == null ? '' : b.code).replace(/\s+/g, '').toUpperCase();
  if (!code) return { error: 'code_required', field: 'code', detail: '신규 CTR 코드를 입력하세요.' };
  if (!CODE_RE.test(code)) return { error: 'bad_code', field: 'code', detail: '코드는 영문 대문자 · 숫자 · 하이픈 3~30자입니다.' };
  if (/^PRO/.test(code) || /^K[0-9]{4,}$/.test(code)) return { error: 'code_reserved', field: 'code', detail: 'PRO… · K0001… 코드는 사내 · 키트용이라 만들 수 없습니다.' };
  const name = normValue('name', str(b.name, 300));
  if (!name) return { error: 'name_required', field: 'name', detail: '제품명을 입력하세요.' };
  const values = { code, name };
  for (const f of ['scode', 'app', 'oe', 'material']) values[f] = normValue(f, str(b[f], 8000));
  const posIn = str(b.pos, 200);
  if (posIn.trim()) {
    const p = canonPos(posIn);
    if (p === undefined) return { error: 'bad_pos', field: 'pos', detail: `장착위치를 읽을 수 없습니다: ${posIn.trim()}` };
    values.pos = p;
  } else values.pos = null;
  // 품목 — 모르는 값이어도 제품은 만든다(자동 재전송이 400 으로 멈추지 않게). 받은 원문은 warnings · 생성 기록에 남긴다.
  const catIn = String(b.category == null ? '' : b.category).trim().slice(0, 60);
  const cat = canonCategory(catIn);
  const warnings = [];
  if (cat === undefined) warnings.push({ type: 'category_unknown', value: catIn, detail: `품목을 알 수 없어 비워 두었습니다: ${catIn}` });
  const source = String(b.source == null ? '' : b.source).trim().toLowerCase().slice(0, 60) || DEFAULT_SOURCE;
  const note = String(b.note == null ? '' : b.note).replace(/\r\n?/g, '\n').trim().slice(0, 1000) || null;
  return { values, category: cat || null, category_in: catIn || null, source, note, warnings };
}

/** 그 코드를 쓰는 제품(삭제 포함 · 대소문자 무시). */
async function findCode(exec, code) {
  return (await exec(
    `SELECT p.id, p.code, p.deleted_at,
            (SELECT max(cr.created_at) FROM pf_catalog_creates cr WHERE cr.product_id = p.id) AS created_via,
            (SELECT cr.source FROM pf_catalog_creates cr WHERE cr.product_id = p.id ORDER BY cr.created_at DESC LIMIT 1) AS created_source,
            ARRAY(SELECT s.syd_code FROM product_syd_codes s WHERE s.product_id = p.id ORDER BY s.syd_code) AS syd_codes
       FROM products p WHERE upper(btrim(p.code)) = $1 ORDER BY p.deleted_at NULLS FIRST LIMIT 1`, [code])).rows[0] || null;
}

/** CODE_EXISTS 응답 본문 — 플랫폼이 「매칭 컨펌으로 연결」 안내에 쓸 수 있게 기존 제품을 알려 준다. */
function existsBody(row) {
  return {
    error: 'CODE_EXISTS',
    detail: row.deleted_at ? '삭제된 ERP 제품이 이 코드를 쓰고 있습니다. 다른 코드를 쓰세요.' : '이미 있는 CTR 코드입니다. 매칭 컨펌으로 연결하세요.',
    existing: { id: Number(row.id), code: row.code, deleted: !!row.deleted_at,
      // from_sample_review 는 v1 이름(플랫폼 생성이면 출처와 관계없이 true) — v2 부터 from_platform · source 를 같이 준다
      from_sample_review: !!row.created_via, from_platform: !!row.created_via, source: row.created_source || null,
      created_at: row.created_via || null, syd_codes: (row.syd_codes || []).map(String) },
  };
}

/**
 * 신규 CTR 생성 — 한 트랜잭션.
 *   returns { ok, id, code, warnings } | { status:409, body } | { error, field, detail }
 */
export async function createItem(body, { pf }) {
  const p = parseCreate(body);
  if (p.error) return p;
  const v = p.values;
  const syd = [...new Set(splitSyd(v.scode))];
  const apps = parseApplications(v.app);
  const oeItems = parseOe(v.oe);

  try {
    return await withTx(async (c) => {
      const q = c.query.bind(c);
      // 같은 코드를 동시에 두 번 보내도 한 번만 — 코드로 트랜잭션 잠금(xact 끝나면 풀림)
      await q(`SELECT pg_advisory_xact_lock(hashtext('pf_create:' || $1))`, [v.code]);
      const dup = await findCode(q, v.code);
      if (dup) return { status: 409, body: existsBody(dup) };

      const srcLabel = sourceLabel(p.source);
      const reason = `개발 중 — REFATRIX Platform ${srcLabel} 신규 생성`;
      const ins = (await q(
        `INSERT INTO products (code, name, scode, app, oe, material, mount_pos,
                               is_active, inactive_reason, status_changed_at, factory_status, factory_info_updated_at,
                               created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7, false, $8, now(), 'development', now(), NULL, NULL) RETURNING id`,
        [v.code, v.name, v.scode, v.app, v.oe, v.material, v.pos, reason])).rows[0];
      const id = Number(ins.id);
      for (const sc of syd) await q(`INSERT INTO product_syd_codes (product_id, syd_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, sc]);
      for (const a of apps) {
        await q(`INSERT INTO product_applications (product_id, app_text, maker, model, year_from, year_to) VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, a.app_text, a.maker, a.model, a.year_from, a.year_to]);
      }
      if (oeItems.length) await syncOe(c, id, oeItems);

      // 제품 이력 — 「신규(Platform)」 · 확인자는 _pf(ERP 사용자가 아니라 changed_by 는 비운다)
      const changes = {};
      for (const [k, x] of Object.entries(v)) if (x != null) changes[k] = { from: null, to: x };
      changes.is_active = { from: null, to: false };
      changes.factory_status = { from: null, to: 'development' };
      changes._pf = { from: null, to: pf.name };
      await q(`INSERT INTO product_change_log (product_id, code, action, source, changes, changed_by)
               VALUES ($1,$2,'create','platform',$3::jsonb,NULL)`, [id, v.code, JSON.stringify(changes)]);
      await q(`INSERT INTO product_factory_log (batch_id, product_id, code, field, old_value, new_value, source, changed_by)
               VALUES ($1,$2,$3,'factory_status',NULL,'development','platform',NULL)`, [`pf-create-${id}`, id, v.code]);

      // 카탈로그 점검 — 만든 값 그대로 「확인완료」(status ok)
      const fp = (await q(`SELECT ${FP_SQL('p')} AS h FROM products p WHERE p.id = $1`, [id])).rows[0].h;
      await q(
        `INSERT INTO pf_catalog_review (product_id, draft, confirmed_hash, confirmed_at, confirmed_by, confirmed_by_name, confirm_count, confirmed_source, updated_at)
         VALUES ($1, '{}'::jsonb, $2, now(), $3, $4, 1, 'platform', now())`, [id, fp, pf.key, pf.name]);
      const applied = {};
      for (const f of ['name', 'scode', 'app', 'oe', 'material', 'pos']) if (v[f] != null) applied[f] = { from: null, to: v[f] };
      const catTxt = p.category ? ` · ${CATEGORIES[p.category]}` : '';
      const srcTxt = p.source === DEFAULT_SOURCE ? '' : ` · ${srcLabel}`;   // 샘플 검토는 v1 문구 그대로
      const noteV = (`[신규 CTR 생성${catTxt}${srcTxt}] ` + (p.note || '')).trim().slice(0, 1000);
      await q(
        `INSERT INTO pf_catalog_confirms (product_id, code, pf_user, pf_user_name, applied, conflicts, note, crm_queued, source)
         VALUES ($1,$2,$3,$4,$5::jsonb,NULL,$6,true,'platform')`,
        [id, v.code, pf.key, pf.name, JSON.stringify(applied), noteV]);
      await q(
        `INSERT INTO pf_catalog_creates (product_id, code, category, source, pf_user, pf_user_name, payload, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [id, v.code, p.category, p.source, pf.key, pf.name, JSON.stringify(p.category_in && !p.category ? { ...v, category_in: p.category_in } : v), p.note]);

      // 참고 경고(막지 않음) — 이 SYD 가 이미 다른 CTR 에 연결돼 있으면 알려 준다
      const warnings = [...p.warnings];
      if (syd.length) {
        const other = (await q(
          `SELECT s.syd_code, array_agg(DISTINCT p.code ORDER BY p.code) AS codes
             FROM product_syd_codes s JOIN products p ON p.id = s.product_id
            WHERE s.syd_code = ANY($1::text[]) AND s.product_id <> $2 AND p.deleted_at IS NULL
            GROUP BY s.syd_code ORDER BY s.syd_code`, [syd, id])).rows;
        for (const o of other) warnings.push({ type: 'syd_linked_elsewhere', syd: o.syd_code, codes: o.codes });
      }
      return { ok: true, id, code: v.code, category: p.category, source: p.source, source_label: srcLabel, warnings, has_oe: oeItems.length > 0, has_syd: syd.length > 0 };
    });
  } catch (e) {
    // 잠금을 피한 경합(예: ERP 화면 직접 추가와 동시) — UNIQUE 위반은 409 로
    if (e && e.code === '23505') {
      const dup = await findCode(query, v.code).catch(() => null);
      return { status: 409, body: dup ? existsBody(dup) : { error: 'CODE_EXISTS', detail: '이미 있는 CTR 코드입니다.' } };
    }
    throw e;
  }
}
