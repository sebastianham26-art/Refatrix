// =====================================================================
// Refatrix ERP · priceMaster.js  (2026-09-24 · v2 · 마이그레이션 0229)
// 가격 마스터 — FOB 구매가(USD) · List 정가(MXN) 테이블 + 날짜별 이력 + 변경 도구
//             + 경쟁사 SYD 리스트 보관·비교 + 구매 기록의 FOB 검증.
//
// 가격의 흐름(설계서 REFATRIX_설계_2026-09-24_price_master_v2.md)
//   · List → 판매가 = List × (1 − 고객 할인율)  (견적이 이미 이렇게 계산 — 무변경)
//   · FOB  → 구매 기록 단가를 주문일 당시 FOB 와 비교
//   · SYD  → 날짜별 리스트 · 직전 리스트와 비교 · 우리 List 제안가
//
// 현재값은 제품 행(products.list_price · fob_usd · list_price_syd), 이력은 product_price_history.
// 계산식은 **SQL 한 곳**(nvSql)에만 있다 — 미리보기와 실제 적용이 같은 식을 쓴다.
//
// 결정(2026-09-24 디렉터)
//   반올림 기본 0.01 · 정가만(고객가는 할인율) · 기본 활성만 · PIN 확인
//   구매 검증 허용 오차 0(1센트라도 다르면 표시) · CTR 1개에 SYD 여럿이면 **가장 높은 SYD**
//   SYD 목표 비율 기본값 = 현재 실제 평균(CTR ÷ SYD)
// =====================================================================
import { query, withTx } from './db.js';

export const PRICE_TYPES = ['list', 'fob'];
export const PRICE_COL = { list: 'list_price', fob: 'fob_usd' };   // SQL 에 끼워 넣는 칼럼 — 이 표 밖의 값은 쓰지 않는다
export const ROUNDINGS = { list: [0.01, 1, 10], fob: [0.001, 0.01] };
export const DEFAULT_ROUNDING = 0.01;
export const MAX_SELECTED = 20000;
const MX_OFFSET_MIN = -360;              // 멕시코 중부시간(UTC-6, 서머타임 없음)
const PROBE_MS = 30000;

const colOf = (t) => { const c = PRICE_COL[t]; if (!c) throw new Error('bad_price_type'); return c; };
export const normType = (t) => (t === 'fob' ? 'fob' : 'list');

// ── 준비 여부(0229) — 긍정만 영구 캐시 ─────────────────────────────────
let ready = false; let probeAt = 0;
export async function priceMasterReady(force = false) {
  if (ready) return true;
  if (!force && Date.now() - probeAt < PROBE_MS) return false;
  probeAt = Date.now();
  try {
    const r = await query(`SELECT to_regclass('public.product_price_history') AS h, to_regclass('public.syd_price_lists') AS s`);
    ready = !!(r.rows[0] && r.rows[0].h && r.rows[0].s);
  } catch (_) { ready = false; }
  return ready;
}
export function _resetReadyForTest() { ready = false; probeAt = 0; }

// ── 날짜 · 환율 ──────────────────────────────────────────────────────
export function mxToday(now = Date.now()) {
  return new Date(now + MX_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}
export function isYmd(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
/** 최신 USD→MXN 환율(재무 › 환율). 없으면 null — 배수 칸만 비고 나머지는 동작한다. */
export async function latestFx(exec = query) {
  try {
    const r = (await exec(
      `SELECT rate, to_char(rate_date,'YYYY-MM-DD') AS d FROM fx_rates
        WHERE base='USD' AND quote='MXN' ORDER BY rate_date DESC LIMIT 1`)).rows[0];
    return r ? { rate: Number(r.rate), date: r.d } : null;
  } catch (_) { return null; }
}

// ── SYD 코드 정규화 — 대응품번 표(product_syd_codes) 매칭과 같은 규칙 ─────
export function sydNorm(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
export const SYD_NORM_SQL = (col) => `regexp_replace(upper(${col}),'[^A-Z0-9]','','g')`;

// ── 입력 정규화 ──────────────────────────────────────────────────────
const NONE = '__none__';
const cleanList = (v, max = 400) => (Array.isArray(v) ? v : [])
  .map((x) => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, max);
const numOr = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

export function normalizeFilter(f) {
  const src = f && typeof f === 'object' ? f : {};
  const codes = (Array.isArray(src.codes) ? src.codes : String(src.codes || '').split(/[\s,;]+/))
    .map((x) => String(x || '').trim().toUpperCase()).filter(Boolean);
  return {
    origin: [...new Set(cleanList(src.origin).map((x) => (x === NONE ? NONE : x.toUpperCase())))],
    cat: [...new Set(cleanList(src.cat).map((x) => x.toUpperCase()))],
    maker: [...new Set(cleanList(src.maker).map((x) => x.toUpperCase()))],
    material: [...new Set(cleanList(src.material).map((x) => (x === NONE ? NONE : x.toLowerCase())))],
    codes: [...new Set(codes)].slice(0, MAX_SELECTED),
    q: String(src.q || '').trim().slice(0, 80),
    active_only: src.active_only !== false,          // 기본 활성만
    list_min: numOr(src.list_min), list_max: numOr(src.list_max),
    ratio_min: numOr(src.ratio_min), ratio_max: numOr(src.ratio_max),   // CTR List ÷ SYD List
    mult_min: numOr(src.mult_min), mult_max: numOr(src.mult_max),       // List ÷ (FOB × 환율)
  };
}

/**
 * 변경 내용 검증. mode: pct | ratio (set 은 items 로 따로)
 *   반환 { price_type, mode, direction, pct, ratio, rounding } 또는 { error }
 */
export function normalizeChange(b) {
  const price_type = normType(b && b.price_type);
  const mode = b && b.mode === 'ratio' ? 'ratio' : 'pct';
  if (mode === 'ratio' && price_type !== 'list') return { error: 'ratio_list_only' };
  const r = b && b.rounding != null && b.rounding !== '' ? Number(b.rounding) : DEFAULT_ROUNDING;
  if (!ROUNDINGS[price_type].includes(r)) return { error: 'bad_rounding' };
  if (mode === 'ratio') {
    const ratio = numOr(b.ratio);
    if (ratio == null || ratio <= 0 || ratio > 10) return { error: 'bad_ratio' };
    return { price_type, mode, direction: null, pct: null, ratio: Math.round(ratio * 10000) / 10000, rounding: r };
  }
  const direction = Number(b && b.direction);
  if (direction !== 1 && direction !== -1) return { error: 'bad_direction' };
  const pct = numOr(String(b && b.pct != null ? b.pct : '').replace(',', '.'));
  if (pct == null || pct <= 0 || pct > 100) return { error: 'bad_pct' };
  const pct3 = Math.round(pct * 1000) / 1000;
  if (direction === -1 && pct3 >= 100) return { error: 'bad_pct' };   // 0 은 만들 수 없다
  return { price_type, mode, direction, pct: pct3, ratio: null, rounding: r };
}

/**
 * 새 가격 식(SQL). 파라미터 번호: dir · pct · rnd · ratio.
 *   pct   : 반올림( 현재 × (100 ± %) / 100 ÷ 단위 ) × 단위
 *   ratio : 반올림( SYD List × 비율 ÷ 단위 ) × 단위
 *   set   : 제품별 목표가(price_change_items.target_price — 저장 때 이미 반올림)
 */
export function nvSql(mode, curExpr, P, itemAlias = 'i') {
  const R = `$${P.rnd}::numeric`;
  if (mode === 'set') return `${itemAlias}.target_price`;
  if (mode === 'ratio') return `(ROUND(p.list_price_syd * $${P.ratio}::numeric / ${R}) * ${R})`;
  return `(ROUND(${curExpr} * (100 + $${P.dir}::numeric * $${P.pct}::numeric) / 100 / ${R}) * ${R})`;
}
/** 이 방식으로 계산 가능한 제품인가(SQL 조건) */
export function eligibleSql(mode, curExpr) {
  if (mode === 'ratio') return `p.list_price_syd > 0`;
  if (mode === 'set') return `TRUE`;
  return `${curExpr} > 0`;
}
// 호환: v1 식(= pct, list)
export function newPriceSql(oldExpr, dirP, pctP, rndP) {
  return nvSql('pct', oldExpr, { dir: dirP, pct: pctP, rnd: rndP });
}

/** JS 사본 — 화면 예상값·테스트 대조용. 센타보(또는 단위) 정수로 계산해 부동소수 오차를 피한다. */
export function roundTo(v, unit = 0.01) {
  const x = Number(v);
  if (!Number.isFinite(x)) return null;
  const k = Math.round(1 / unit);                                // 0.001→1000 · 0.01→100 · 1→1 · 10→0.1
  if (unit >= 1) { const q = Math.floor(Math.round(x * 1e6) / 1e6 / unit + 0.5 + 1e-9); return q * unit; }
  const scaled = Math.round(x * k * 1e6) / 1e6;
  return Math.sign(scaled) * Math.floor(Math.abs(scaled) + 0.5 + 1e-9) / k;
}
export function calcNewPrice(old, direction, pct, rounding = DEFAULT_ROUNDING) {
  const o = Number(old);
  if (!Number.isFinite(o) || o <= 0) return null;
  return roundTo(o * (100 + direction * pct) / 100, rounding);
}

/**
 * 조건 → WHERE (p = products). fx = 최신 환율(배수 조건에 필요).
 * 조건끼리는 AND, 한 조건 안의 여러 값은 OR.
 */
export function buildFilterWhere(filter, params, { fx = null } = {}) {
  const f = normalizeFilter(filter);
  const parts = ['p.deleted_at IS NULL'];
  if (f.active_only) parts.push('p.is_active');
  if (f.origin.length) {
    params.push(f.origin);
    parts.push(`COALESCE(NULLIF(upper(trim(p.origin)),''),'${NONE}') = ANY($${params.length}::text[])`);
  }
  if (f.cat.length) {
    params.push(f.cat);
    parts.push(`upper(trim(COALESCE(p.name,''))) = ANY($${params.length}::text[])`);
  }
  if (f.maker.length) {
    params.push(f.maker);
    parts.push(`p.id IN (SELECT pa.product_id FROM product_applications pa WHERE upper(pa.maker) = ANY($${params.length}::text[]))`);
  }
  if (f.material.length) {
    params.push(f.material);
    parts.push(`COALESCE(NULLIF(lower(trim(p.material)),''),'${NONE}') = ANY($${params.length}::text[])`);
  }
  if (f.codes.length) {
    params.push(f.codes);
    parts.push(`upper(p.code) = ANY($${params.length}::text[])`);
  }
  if (f.q) {
    params.push(`%${f.q}%`);
    const i = params.length;
    parts.push(`(p.code ILIKE $${i} OR COALESCE(p.name,'') ILIKE $${i} OR COALESCE(p.app,'') ILIKE $${i}
      OR p.id IN (SELECT pa2.product_id FROM product_applications pa2
                   WHERE pa2.app_text ILIKE $${i} OR COALESCE(pa2.model,'') ILIKE $${i}))`);
  }
  const range = (expr, lo, hi) => {
    if (lo != null) { params.push(lo); parts.push(`${expr} >= $${params.length}::numeric`); }
    if (hi != null) { params.push(hi); parts.push(`${expr} <= $${params.length}::numeric`); }
  };
  range('p.list_price', f.list_min, f.list_max);
  if (f.ratio_min != null || f.ratio_max != null) {
    parts.push('p.list_price > 0 AND p.list_price_syd > 0');
    range('(p.list_price / p.list_price_syd)', f.ratio_min, f.ratio_max);
  }
  if ((f.mult_min != null || f.mult_max != null)) {
    if (!(fx > 0)) parts.push('FALSE');                       // 환율이 없으면 배수 조건은 아무것도 고르지 않는다
    else {
      params.push(fx);
      const fxP = params.length;
      parts.push('p.list_price > 0 AND p.fob_usd > 0');
      range(`(p.list_price / (p.fob_usd * $${fxP}::numeric))`, f.mult_min, f.mult_max);
    }
  }
  return parts.join(' AND ');
}

/** 대상 WHERE — selected 면 체크한 id 만, 아니면 조건 결과. */
export function buildTargetWhere({ scope, filter, product_ids }, params, opt = {}) {
  if (scope === 'selected') {
    const ids = [...new Set((Array.isArray(product_ids) ? product_ids : []).map(Number)
      .filter((n) => Number.isInteger(n) && n > 0))].slice(0, MAX_SELECTED);
    params.push(ids);
    return `p.deleted_at IS NULL AND p.id = ANY($${params.length}::bigint[])`;
  }
  return buildFilterWhere(filter, params, opt);
}

/** 조건을 사람 말로 */
export function describeFilter(scope, filter, count) {
  if (scope === 'selected' || scope === 'items') return `선택 ${count ?? ''}개`.trim();
  const f = normalizeFilter(filter);
  const out = [];
  if (f.origin.length) out.push('원산지 ' + f.origin.map((x) => (x === NONE ? '(없음)' : x)).join(', '));
  if (f.cat.length) out.push('품목 ' + f.cat.join(', '));
  if (f.maker.length) out.push('메이커 ' + f.maker.join(', '));
  if (f.material.length) out.push('소재 ' + f.material.map((x) => (x === NONE ? '(미지정)' : x)).join(', '));
  if (f.codes.length) out.push(`코드 ${f.codes.length}개`);
  if (f.q) out.push(`검색 「${f.q}」`);
  const rg = (lab, lo, hi) => { if (lo != null || hi != null) out.push(`${lab} ${lo ?? ''}~${hi ?? ''}`); };
  rg('List', f.list_min, f.list_max); rg('CTR÷SYD', f.ratio_min, f.ratio_max); rg('배수', f.mult_min, f.mult_max);
  if (!out.length) out.push('전체');
  if (!f.active_only) out.push('비활성 포함');
  return out.join(' · ');
}

// ── 가격 변경 훅(화면 수정·제품 엑셀 업로드) ─────────────────────────────
// 트랜잭션 안에서 호출. 장부 기록이 실패해도 제품 저장은 살아야 하므로 SAVEPOINT 로 감싼다.
const numOrNull = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
export function priceChanged(a, b) {
  const x = numOrNull(a); const y = numOrNull(b);
  if (x == null && y == null) return false;
  return x !== y;
}
export async function recordPriceChange(c, { productId, oldPrice, newPrice, source, userId = null, today = null, priceType = 'list' }) {
  if (!priceChanged(oldPrice, newPrice)) return false;
  if (!(await priceMasterReady())) return false;          // 0229 전 — 조용히 쉰다
  try {
    await c.query('SAVEPOINT price_hist');
    await c.query(
      `INSERT INTO product_price_history (product_id, price_type, effective_date, old_price, new_price, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [productId, normType(priceType), today || mxToday(), numOrNull(oldPrice), numOrNull(newPrice), source, userId]);
    await c.query('RELEASE SAVEPOINT price_hist');
    return true;
  } catch (e) {
    try { await c.query('ROLLBACK TO SAVEPOINT price_hist'); } catch (_) {}
    try { console.error('[price_history] failed:', source, productId, e.message); } catch (_) {}
    return false;
  }
}

// ── 묶음 만들기 ──────────────────────────────────────────────────────
/**
 * 묶음 1건을 만든다(트랜잭션 c 안). 오늘이면 바로 적용.
 *   spec: { price_type, mode, origin, direction, pct, ratio, rounding, effective_date, note, scope,
 *           filter, product_ids, items:[{product_id, price}], syd_list_id, fx, userId, today }
 *   반환 { id, product_count, applied }  — 대상 0 이면 Error('no_targets')
 */
export async function createBatch(c, spec) {
  const t = normType(spec.price_type);
  const col = colOf(t);
  const mode = spec.mode === 'set' ? 'set' : spec.mode === 'ratio' ? 'ratio' : 'pct';
  const scope = mode === 'set' ? 'items' : (spec.scope === 'selected' ? 'selected' : 'filter');
  const filter = scope === 'filter' ? normalizeFilter(spec.filter) : null;
  const rounding = spec.rounding != null ? Number(spec.rounding) : DEFAULT_ROUNDING;
  const ins = (await c.query(
    `INSERT INTO price_change_batches (price_type, mode, origin, effective_date, direction, pct, ratio, rounding, scope, filter,
                                       syd_list_id, status, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'scheduled',$12,$13) RETURNING id`,
    [t, mode, spec.origin || 'bulk', spec.effective_date, spec.direction ?? null, spec.pct ?? null, spec.ratio ?? null,
     rounding, scope, filter ? JSON.stringify(filter) : null, spec.syd_list_id || null, spec.note || null, spec.userId || null])).rows[0];
  const id = Number(ins.id);
  let n = 0;
  if (mode === 'set') {
    const ids = []; const prices = [];
    const seen = new Set();
    for (const it of (Array.isArray(spec.items) ? spec.items : []).slice(0, MAX_SELECTED)) {
      const pid = Number(it && it.product_id); const pr = numOr(it && it.price);
      if (!Number.isInteger(pid) || pid <= 0 || pr == null || pr <= 0 || seen.has(pid)) continue;
      seen.add(pid); ids.push(pid); prices.push(roundTo(pr, rounding));
    }
    if (ids.length) {
      const r = await c.query(
        `INSERT INTO price_change_items (batch_id, product_id, target_price)
         SELECT $1, x.pid, x.price FROM unnest($2::bigint[], $3::numeric[]) AS x(pid, price)
           JOIN products p ON p.id = x.pid AND p.deleted_at IS NULL`, [id, ids, prices]);
      n = r.rowCount || 0;
    }
  } else {
    const tp = [id];
    const tw = buildTargetWhere({ scope, filter, product_ids: spec.product_ids }, tp, { fx: spec.fx });
    const r = await c.query(
      `INSERT INTO price_change_items (batch_id, product_id)
       SELECT $1, p.id FROM products p WHERE ${tw} AND ${eligibleSql(mode, 'p.' + col)}`, tp);
    n = r.rowCount || 0;
  }
  if (!n) { const e = new Error('no_targets'); e.code = 'NO_TARGETS'; throw e; }
  await c.query(`UPDATE price_change_batches SET product_count=$2 WHERE id=$1`, [id, n]);
  let applied = null;
  if (spec.effective_date <= (spec.today || mxToday())) applied = await applyBatch(c, id, { userId: spec.userId, lockWait: true });
  return { id, product_count: n, applied };
}

// ── 묶음 적용 ────────────────────────────────────────────────────────
/**
 * 예약 묶음 1건 적용(트랜잭션 c 안). 이미 적용·취소된 묶음이면 아무것도 하지 않는다.
 * 다른 워커가 같은 묶음을 잡고 있으면(SKIP LOCKED) 건너뛴다 — 두 번 적용될 수 없다.
 */
export async function applyBatch(c, batchId, { userId = null, lockWait = false } = {}) {
  const b = (await c.query(
    `SELECT id, status, price_type, mode, direction, pct, ratio, rounding, to_char(effective_date,'YYYY-MM-DD') AS eff
       FROM price_change_batches WHERE id=$1 FOR UPDATE${lockWait ? '' : ' SKIP LOCKED'}`, [batchId])).rows[0];
  if (!b || b.status !== 'scheduled') return null;
  const t = normType(b.price_type); const col = colOf(t); const cur = 'p.' + col;
  const P = { dir: 2, pct: 3, rnd: 4, ratio: 5 };
  const nv = nvSql(b.mode, cur, P);
  const params = [batchId, b.direction == null ? 0 : Number(b.direction), b.pct == null ? 0 : Number(b.pct),
    Number(b.rounding), b.ratio == null ? 0 : Number(b.ratio), userId, b.eff, t];
  const res = await c.query(
    `WITH tgt AS (
        SELECT p.id, ${cur} AS old, ${nv} AS nv,
               $2::numeric AS _d, $3::numeric AS _p, $4::numeric AS _r, $5::numeric AS _q
          FROM price_change_items i JOIN products p ON p.id = i.product_id
         WHERE i.batch_id = $1 AND p.deleted_at IS NULL AND ${eligibleSql(b.mode, cur)}
         FOR UPDATE OF p
     ), upd AS (
        UPDATE products p SET ${col} = t.nv, updated_by = $6, updated_at = now()
          FROM tgt t
         WHERE p.id = t.id AND t.nv > 0 AND t.nv IS DISTINCT FROM t.old
        RETURNING p.id, t.old, t.nv
     ), hist AS (
        INSERT INTO product_price_history (product_id, price_type, effective_date, old_price, new_price, source, batch_id, created_by)
        SELECT id, $8, $7::date, old, nv, 'batch', $1, $6 FROM upd
        RETURNING product_id, old_price, new_price
     )
     UPDATE price_change_items i SET old_price = h.old_price, new_price = h.new_price, result = 'applied'
       FROM hist h WHERE i.batch_id = $1 AND i.product_id = h.product_id`, params);
  const applied = res.rowCount || 0;
  const sk = await c.query(
    `UPDATE price_change_items i
        SET result = COALESCE((SELECT CASE WHEN p.deleted_at IS NOT NULL THEN 'deleted'
                                           WHEN NOT (${eligibleSql(b.mode, cur)}) THEN ${b.mode === 'ratio' ? `'no_syd'` : `'no_price'`}
                                           WHEN ${nv} <= 0 THEN 'to_zero'
                                           ELSE 'no_change' END
                                 FROM products p WHERE p.id = i.product_id), 'deleted'),
            old_price = (SELECT ${cur} FROM products p WHERE p.id = i.product_id),
            new_price = NULL
      WHERE i.batch_id = $1 AND i.result IS NULL
        AND $2::numeric IS NOT NULL AND $3::numeric IS NOT NULL AND $4::numeric IS NOT NULL AND $5::numeric IS NOT NULL`,
    params.slice(0, 5));
  const skipped = sk.rowCount || 0;
  await c.query(
    `UPDATE price_change_batches SET status='applied', applied_at=now(), applied_by=$2,
            applied_count=$3, skipped_count=$4 WHERE id=$1`, [batchId, userId, applied, skipped]);
  return { applied, skipped };
}

/** 적용일이 된 예약 묶음을 만든 순서대로 적용(같은 날 여러 묶음 = 차례로 복리). */
export async function applyDue({ today = mxToday(), log = null } = {}) {
  if (!(await priceMasterReady())) return { ran: 0 };
  const due = (await query(
    `SELECT id FROM price_change_batches
      WHERE status='scheduled' AND effective_date <= $1::date
      ORDER BY effective_date, id`, [today])).rows;
  let ran = 0;
  for (const r of due) {
    try {
      const out = await withTx((c) => applyBatch(c, Number(r.id), { userId: null }));
      if (out) { ran++; try { log && log.info && log.info(`[priceMaster] 예약 #${r.id} 적용 — ${out.applied}개 변경, ${out.skipped}개 제외`); } catch (_) {} }
    } catch (e) {
      try { console.error('[priceMaster] apply failed', r.id, e.message); } catch (_) {}
      break;           // 순서가 중요하다(복리) — 앞 묶음이 실패하면 뒤 묶음도 멈춘다
    }
  }
  return { ran };
}

let timer = null;
export function startPriceMasterWorker(app) {
  if (timer) return;
  const tick = () => { applyDue({ log: app && app.log }).catch(() => {}); };
  timer = setInterval(tick, 5 * 60000);        // 5분 — 00:00(멕시코) 예약은 00:05 안에 적용
  if (timer.unref) timer.unref();
  const t0 = setTimeout(tick, 20000);          // 기동 20초 뒤 한 번(밤사이 재배포로 놓친 예약 줍기)
  if (t0.unref) t0.unref();
  try { app?.log?.info?.('[priceMaster] 가격 예약 감시 시작 — 5분 주기'); } catch (_) {}
}

// ── 되돌리기 ─────────────────────────────────────────────────────────
/** 묶음 단위. 그 뒤에 같은 가격 종류의 다른 변경이 없고 현재값 = 이 묶음이 넣은 값인 제품만. */
export async function revertBatch(c, batchId, { userId = null, today = mxToday() } = {}) {
  const b = (await c.query(`SELECT id, status, price_type FROM price_change_batches WHERE id=$1 FOR UPDATE`, [batchId])).rows[0];
  if (!b) return { error: 'not_found' };
  if (b.status !== 'applied') return { error: 'not_applied', status: b.status };
  const t = normType(b.price_type); const col = colOf(t);
  const res = await c.query(
    `WITH h AS (
        SELECT x.id, x.product_id, x.old_price, x.new_price
          FROM product_price_history x
         WHERE x.batch_id = $1 AND x.source = 'batch'
     ), ok AS (
        SELECT h.id, h.product_id, h.old_price, h.new_price
          FROM h JOIN products p ON p.id = h.product_id
         WHERE p.deleted_at IS NULL
           AND p.${col} = h.new_price
           AND NOT EXISTS (SELECT 1 FROM product_price_history y
                            WHERE y.product_id = h.product_id AND y.price_type = $4 AND y.id > h.id)
         FOR UPDATE OF p
     ), upd AS (
        UPDATE products p SET ${col} = ok.old_price, updated_by = $2, updated_at = now()
          FROM ok WHERE p.id = ok.product_id
        RETURNING p.id, ok.new_price AS was, ok.old_price AS back
     ), hist AS (
        INSERT INTO product_price_history (product_id, price_type, effective_date, old_price, new_price, source, batch_id, created_by)
        SELECT id, $4, $3::date, was, back, 'revert', $1, $2 FROM upd
        RETURNING product_id
     )
     UPDATE price_change_items i SET result = 'reverted'
       FROM hist WHERE i.batch_id = $1 AND i.product_id = hist.product_id`,
    [batchId, userId, today, t]);
  const reverted = res.rowCount || 0;
  const skippedRows = (await c.query(
    `SELECT p.code,
            CASE WHEN p.id IS NULL OR p.deleted_at IS NOT NULL THEN 'deleted'
                 WHEN EXISTS (SELECT 1 FROM product_price_history y
                               WHERE y.product_id = i.product_id AND y.price_type = $2
                                 AND y.batch_id IS DISTINCT FROM i.batch_id
                                 AND y.id > (SELECT MAX(z.id) FROM product_price_history z
                                              WHERE z.batch_id = i.batch_id AND z.product_id = i.product_id AND z.source='batch'))
                      THEN 'later_change'
                 ELSE 'price_differs' END AS reason
       FROM price_change_items i LEFT JOIN products p ON p.id = i.product_id
      WHERE i.batch_id = $1 AND i.result = 'applied'
      ORDER BY p.code`, [batchId, t])).rows;
  if (reverted === 0) return { error: 'nothing_to_revert', skipped: skippedRows };
  await c.query(`UPDATE price_change_items SET result='revert_skipped' WHERE batch_id=$1 AND result='applied'`, [batchId]);
  await c.query(
    `UPDATE price_change_batches SET status='reverted', reverted_at=now(), reverted_by=$2,
            reverted_count=$3, revert_skipped_count=$4 WHERE id=$1`,
    [batchId, userId, reverted, skippedRows.length]);
  return { reverted, skipped: skippedRows };
}

// ── 경쟁사 SYD 리스트 ────────────────────────────────────────────────
/**
 * 업로드 행 정리: [{code, price, familia}] → { items:[{norm, code, price, familia}], dup, errors:[{row, code, reason}] }
 * 같은 코드가 두 번 나오면 **첫 값**을 쓰고 dup 로 센다.
 */
export function parseSydRows(rows) {
  const items = []; const errors = []; const seen = new Set(); let dup = 0;
  (Array.isArray(rows) ? rows : []).forEach((r, i) => {
    const code = String(r && r.code != null ? r.code : '').trim();
    const norm = sydNorm(code);
    const price = numOr(r && r.price);
    const rowNo = (r && r._row) || i + 1;
    if (!norm) { errors.push({ row: rowNo, code, reason: 'no_code' }); return; }
    if (price == null || price <= 0) { errors.push({ row: rowNo, code, reason: 'bad_price' }); return; }
    if (seen.has(norm)) { dup++; return; }
    seen.add(norm);
    const fam = String(r && r.familia != null ? r.familia : '').trim().toUpperCase().slice(0, 80) || null;
    items.push({ norm, code: code.slice(0, 80), price: Math.round(price * 100) / 100, familia: fam });
  });
  return { items, dup, errors };
}

/** 이 리스트 바로 앞 리스트(기준일이 앞서거나, 같은 날이면 먼저 올린 것) */
export async function prevSydList(exec, listId) {
  const r = (await exec(
    `SELECT p.id FROM syd_price_lists p, syd_price_lists c
      WHERE c.id = $1 AND (p.list_date < c.list_date OR (p.list_date = c.list_date AND p.id < c.id))
      ORDER BY p.list_date DESC, p.id DESC LIMIT 1`, [listId])).rows[0];
  return r ? Number(r.id) : null;
}
export async function latestSydListId(exec = query) {
  const r = (await exec(`SELECT id FROM syd_price_lists ORDER BY list_date DESC, id DESC LIMIT 1`)).rows[0];
  return r ? Number(r.id) : null;
}

/** 두 리스트 비교 집계 */
export async function compareSydCounts(exec, listId, prevId) {
  if (!prevId) {
    const n = (await exec(`SELECT COUNT(*)::int AS n FROM syd_price_items WHERE list_id=$1`, [listId])).rows[0].n;
    return { up: 0, down: 0, same: 0, new: n, gone: 0 };
  }
  const r = (await exec(
    `SELECT COALESCE(SUM(CASE WHEN a.price > b.price THEN 1 ELSE 0 END),0)::int AS up,
            COALESCE(SUM(CASE WHEN a.price < b.price THEN 1 ELSE 0 END),0)::int AS down,
            COALESCE(SUM(CASE WHEN a.price = b.price THEN 1 ELSE 0 END),0)::int AS same,
            COALESCE(SUM(CASE WHEN b.syd_norm IS NULL THEN 1 ELSE 0 END),0)::int AS new
       FROM syd_price_items a
       LEFT JOIN syd_price_items b ON b.list_id = $2 AND b.syd_norm = a.syd_norm
      WHERE a.list_id = $1`, [listId, prevId])).rows[0];
  const gone = (await exec(
    `SELECT COUNT(*)::int AS n FROM syd_price_items b
      WHERE b.list_id = $2 AND NOT EXISTS (SELECT 1 FROM syd_price_items a WHERE a.list_id = $1 AND a.syd_norm = b.syd_norm)`,
    [listId, prevId])).rows[0].n;
  return { up: r.up, down: r.down, same: r.same, new: r.new, gone };
}

/**
 * 최신 리스트로 products.list_price_syd 를 맞춘다(결정: 한 CTR 에 SYD 여럿이면 **가장 높은 값**).
 * 최신 리스트에 없는 제품은 건드리지 않는다. 반환: 바뀐 제품 수
 */
export async function syncProductSydPrices(exec, listId) {
  const r = await exec(
    `WITH ref AS (
        SELECT sc.product_id, MAX(it.price) AS ref
          FROM product_syd_codes sc
          JOIN syd_price_items it ON it.list_id = $1 AND it.syd_norm = ${SYD_NORM_SQL('sc.syd_code')}
         GROUP BY sc.product_id
     )
     UPDATE products p SET list_price_syd = ref.ref
       FROM ref WHERE p.id = ref.product_id AND p.deleted_at IS NULL
        AND p.list_price_syd IS DISTINCT FROM ref.ref`, [listId]);
  return r.rowCount || 0;
}

// ── 구매 기록 FOB 검증 ───────────────────────────────────────────────
/**
 * 구매 줄마다 **주문일 당시 FOB**(그날까지의 마지막 FOB 이력). 그날 이전 이력이 없으면 가장 이른 FOB 를 쓰고
 * basis='earliest' 로 표시(가격 마스터를 켜기 전 구매도 볼 수 있게).
 *   status: ok(같음) · over(비쌈) · under(쌈) · no_fob · unmatched(미등록 코드)
 *   tolPct: 허용 오차 %(결정: 0 — 1센트라도 다르면 표시)
 */
export const FOB_AT_SQL = (pidExpr, dateExpr) => `
  LEFT JOIN LATERAL (SELECT h.new_price AS fob FROM product_price_history h
                      WHERE h.product_id = ${pidExpr} AND h.price_type = 'fob' AND h.effective_date <= ${dateExpr}
                        AND h.new_price IS NOT NULL
                      ORDER BY h.effective_date DESC, h.id DESC LIMIT 1) fa ON TRUE
  LEFT JOIN LATERAL (SELECT h.new_price AS fob FROM product_price_history h
                      WHERE h.product_id = ${pidExpr} AND h.price_type = 'fob' AND h.new_price IS NOT NULL
                      ORDER BY h.effective_date, h.id LIMIT 1) fe ON TRUE`;

export function fobStatus(cost, fob, productId, tolPct = 0) {
  if (productId == null) return 'unmatched';
  if (fob == null) return 'no_fob';
  const c = Number(cost); const f = Number(fob);
  const diff = Math.round((c - f) * 10000) / 10000;
  if (Math.abs(diff) <= Math.abs(f) * (tolPct / 100) + 1e-9) return 'ok';
  return diff > 0 ? 'over' : 'under';
}

export async function purchaseLinesWithFob(exec, poIds) {
  if (!poIds.length) return [];
  const rows = (await exec(
    `SELECT l.id, l.po_id, l.product_id, l.input_code, l.qty, l.unit_cost_usd, l.amount_usd,
            pr.code, pr.name, pr.fob_usd AS fob_now, to_char(po.order_date,'YYYY-MM-DD') AS order_date,
            COALESCE(fa.fob, fe.fob) AS fob, CASE WHEN fa.fob IS NULL AND fe.fob IS NOT NULL THEN 'earliest' ELSE 'at_date' END AS basis
       FROM purchase_order_lines l
       JOIN purchase_orders po ON po.id = l.po_id
       LEFT JOIN products pr ON pr.id = l.product_id
       ${FOB_AT_SQL('l.product_id', 'po.order_date')}
      WHERE l.po_id = ANY($1::bigint[])
      ORDER BY l.po_id, l.id`, [poIds])).rows;
  return rows;
}

export function summarizeFob(lines, tolPct = 0) {
  const s = { lines: 0, ok: 0, over: 0, under: 0, no_fob: 0, unmatched: 0, diff_usd: 0, over_usd: 0, under_usd: 0 };
  for (const l of lines) {
    const st = fobStatus(l.unit_cost_usd, l.fob, l.product_id, tolPct);
    l.fob_status = st; s.lines++; s[st]++;
    if (st === 'over' || st === 'under') {
      const d = Math.round((Number(l.unit_cost_usd) - Number(l.fob)) * Number(l.qty) * 100) / 100;
      l.diff_usd = d; s.diff_usd += d; if (d > 0) s.over_usd += d; else s.under_usd += d;
    } else l.diff_usd = null;
  }
  s.diff_usd = Math.round(s.diff_usd * 100) / 100; s.over_usd = Math.round(s.over_usd * 100) / 100; s.under_usd = Math.round(s.under_usd * 100) / 100;
  return s;
}

/** 구매 화면용: PO 별 FOB 불일치 줄 수(비쌈+쌈). 0229 전이면 빈 맵. */
export async function fobMismatchByPo(poIds) {
  const out = new Map();
  if (!poIds.length || !(await priceMasterReady())) return out;
  const lines = await purchaseLinesWithFob(query, poIds);
  for (const l of lines) {
    const st = fobStatus(l.unit_cost_usd, l.fob, l.product_id, 0);
    const o = out.get(Number(l.po_id)) || { bad: 0, over: 0, under: 0, no_fob: 0 };
    if (st === 'over' || st === 'under') { o.bad++; o[st]++; }
    if (st === 'no_fob') o.no_fob++;
    out.set(Number(l.po_id), o);
  }
  return out;
}

/** 구매 업로드 미리보기·상세용: 제품별 날짜 기준 FOB. 0229 전이면 null */
export async function fobAtDate(productIds, ymd) {
  if (!(await priceMasterReady())) return null;             // 0229 전 — 검증 자체를 쉰다(「FOB 없음」으로 보이지 않게)
  const out = new Map();
  const ids = [...new Set(productIds.filter((x) => x != null).map(Number))];
  if (!ids.length) return out;
  const r = (await query(
    `SELECT x.pid, COALESCE(fa.fob, fe.fob) AS fob
       FROM unnest($1::bigint[]) AS x(pid)
       ${FOB_AT_SQL('x.pid', '$2::date')}`, [ids, ymd])).rows;
  for (const row of r) out.set(Number(row.pid), row.fob == null ? null : Number(row.fob));
  return out;
}

export const RESULT_KO = {
  applied: '적용', no_price: '가격 없음', no_syd: 'SYD 없음', deleted: '삭제됨', no_change: '변화 없음',
  to_zero: '0 이하 → 제외', reverted: '되돌림', revert_skipped: '되돌리기 제외',
};
export const SKIP_REASON_KO = { later_change: '뒤에 다른 변경이 있음', price_differs: '현재 값이 다름', deleted: '삭제된 제품' };
