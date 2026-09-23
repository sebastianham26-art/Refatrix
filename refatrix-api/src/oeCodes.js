// =====================================================================
// Refatrix ERP · oeCodes.js — OE 번호 DB 헬퍼 · 0228
//
//   규칙(파싱·표기)은 oeParse.js 한 곳에 있고, 여기는 DB 에 쓰고 읽는 일만 한다.
//
//   ── 반쪽배포 안전장치 (quoteBuild.poColumnReady 와 같은 방식) ──
//   Railway 는 백엔드 배포 뒤 사람이 콘솔에서 `npm run migrate` 를 돌린다. 그 사이에 새 코드가
//   아직 없는 표·칼럼을 건드리면 제품 조회·견적 저장이 통째로 죽는다.
//   그래서 0228 이 적용되기 전에는 **OE 기능만 조용히 쉬고** 나머지는 예전처럼 돈다.
//   긍정은 영구 캐시, 부정은 30초마다 다시 본다.
// =====================================================================
import { query } from './db.js';
import { normOe } from './oeParse.js';

let readyFlag = false; let probeAt = 0;
export async function oeReady(exec = query) {
  if (readyFlag) return true;
  if (Date.now() - probeAt < 30000) return false;
  probeAt = Date.now();
  try {
    const r = await exec(
      `SELECT
         (SELECT COUNT(*) FROM information_schema.tables  WHERE table_name='product_oe_codes')::int AS t,
         (SELECT COUNT(*) FROM information_schema.columns WHERE table_name='products'    AND column_name='oe')::int AS p,
         (SELECT COUNT(*) FROM information_schema.columns WHERE table_name='quote_lines' AND column_name='match_source')::int AS q`);
    const x = r.rows[0] || {};
    readyFlag = Number(x.t) > 0 && Number(x.p) > 0 && Number(x.q) > 0;
  } catch (_) { readyFlag = false; }
  return readyFlag;
}
/** 시험용 — 상태를 직접 세운다(false 로 두면 다음 호출에서 다시 조회하지 않고 false). */
export function setOeReady(v) { readyFlag = !!v; probeAt = Date.now(); }

/** 제품 id 목록 → Map(pid → [{oe_code, oe_norm, rel, source}]) (입력 순서 = 등록 순서). */
export async function oeByProduct(ids, exec = query) {
  const m = new Map();
  const list = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
  if (!list.length || !(await oeReady(exec))) return m;
  const rows = (await exec(
    `SELECT product_id, oe_code, oe_norm, rel, source FROM product_oe_codes
      WHERE product_id = ANY($1) ORDER BY product_id, id`, [list])).rows;
  for (const r of rows) {
    const k = Number(r.product_id);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push({ oe_code: r.oe_code, oe_norm: r.oe_norm, rel: r.rel, source: r.source });
  }
  return m;
}

/** 분해표 재동기화 — 트랜잭션 클라이언트 c 로. (SyD 의 syncSyd 와 같은 불변식: 지우고 다시 넣는다) */
export async function syncOe(c, productId, items) {
  await c.query(`DELETE FROM product_oe_codes WHERE product_id=$1`, [productId]);
  const list = (items || []).filter((it) => it && it.oe_norm);
  if (!list.length) return;
  // 한 번에 넣는다 — 1,700개 제품 × 평균 5개를 한 줄씩 넣으면 업로드 트랜잭션이 길어진다.
  await c.query(
    `INSERT INTO product_oe_codes (product_id, oe_code, oe_norm, rel, source)
     SELECT $1, x.c, x.n, x.r, x.s
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) WITH ORDINALITY AS x(c, n, r, s, o)
      ORDER BY x.o
     ON CONFLICT (product_id, oe_norm) DO NOTHING`,
    [productId, list.map((it) => it.oe_code), list.map((it) => it.oe_norm),
      list.map((it) => (it.rel === 'for' ? 'for' : 'oe')), list.map((it) => (it.source === 'syd' ? 'syd' : 'master'))]);
}

/**
 * 입력 코드가 제품의 무엇과 일치했나 — 견적 줄의 match_source.
 *   서버가 저장 시점에 판정한다(자동완성으로 골랐든, 직접 쳤든, CRM 이 보냈든 같은 기준).
 *   ctr · syd · oe · oe_for · name(제품명 일부) · other
 */
export async function matchSourceFor(productId, inputCode, exec = query) {
  const raw = String(inputCode == null ? '' : inputCode).trim();
  if (!productId || !raw) return null;
  const n = normOe(raw);
  const p = (await exec(`SELECT code, name FROM products WHERE id=$1`, [Number(productId)])).rows[0];
  if (!p) return null;
  if (normOe(p.code) === n) return 'ctr';
  const syd = (await exec(`SELECT syd_code FROM product_syd_codes WHERE product_id=$1`, [Number(productId)])).rows;
  if (syd.some((s) => normOe(s.syd_code) === n)) return 'syd';
  if (await oeReady(exec)) {
    const oe = (await exec(
      `SELECT rel FROM product_oe_codes WHERE product_id=$1 AND oe_norm=$2 ORDER BY (rel='oe') DESC LIMIT 1`,
      [Number(productId), n])).rows[0];
    if (oe) return oe.rel === 'for' ? 'oe_for' : 'oe';
  }
  if (p.name && raw.length >= 3 && String(p.name).toUpperCase().includes(raw.toUpperCase())) return 'name';
  return 'other';
}

/**
 * 견적 줄에 match_source · oe_codes 를 찍는다 — INSERT 문을 건드리지 않으려고 뒤에 UPDATE 로 붙인다.
 *   (견적 저장 경로가 네 곳이다. INSERT 를 넷 다 고치면 0228 전 반쪽배포에서 견적 저장이 죽는다.)
 */
export async function stampLineMeta(c, quoteId, lines) {
  if (!(await oeReady((t, p) => c.query(t, p))) || !Array.isArray(lines)) return;
  for (const l of lines) {
    if (l.match_source == null && l.oe_codes == null) continue;
    await c.query(`UPDATE quote_lines SET match_source=$1, oe_codes=$2 WHERE quote_id=$3 AND line_no=$4`,
      [l.match_source || null, l.oe_codes || null, quoteId, l.line_no]);
  }
}
