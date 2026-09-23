// 견적 조립 — **화면과 수신 창구가 같은 것을 쓴다.**
//
//   예전에는 이 함수들이 quoteRoutes.js 안에 갇혀 있었다. 그래서 CRM 이 견적을 넣으려면
//   ERP 화면용 API 를 직원 계정으로 호출하는 수밖에 없었고, 실제로 그렇게 하다가
//   **남의 고객(NAJAR)에 견적이 붙는 사고**가 났다.
//
//   이제 조립기는 여기 한 곳에 있다. 코드 해석 규칙·재고 예약·번호 채번이 바뀌면
//   화면과 수신 창구가 **같이** 바뀐다. 두 벌로 두면 반드시 어긋난다 — 이 프로젝트에서
//   이미 여러 번 겪었다.
import { query } from './db.js';
import { computeQuoteLine, stockFlag, formatQuoteNo, round2 } from './quotes.js';
import { normOe, oeToken } from './oeParse.js';
import { oeReady, oeByProduct, matchSourceFor } from './oeCodes.js';
export { stampLineMeta } from './oeCodes.js';


// ============ 고객 PO번호(Orden de compra) 정리 — 0225 ============
//
//   화면 입력과 CRM 수신이 **같은 규칙**을 쓰게 한 곳에 둔다.
//   두 벌로 두면 「화면에서 넣은 4471」과 「웹에서 온 4471 」이 다른 값이 되어
//   검색이 한쪽만 걸린다 — 이 프로젝트에서 이미 여러 번 겪은 실패 방식이다.
//
//   하는 일은 셋뿐이다. 번호를 **고치지 않는다**:
//     · 앞뒤 공백과 내부 연속 공백만 정리한다(붙여넣기로 딸려 오는 것들)
//     · 60자 상한 — 번호칸이지 메모칸이 아니다. 패킹리스트 한 줄에 들어가야 한다
//     · 빈 문자열은 null 로 — DB 에 ''(빈칸)과 NULL 이 섞이면 검색 조건이 두 배로 늘어난다
//   대소문자·하이픈·0 채움은 **손대지 않는다.** 고객이 준 번호 그대로 인쇄돼야 한다.
export const PO_MAX_LEN = 60;
export function normalizePoNo(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.slice(0, PO_MAX_LEN);
}

// ── 반쪽배포 안전장치 (0220 의 quoteColsReady 와 같은 방식) ─────────────
//
//   Railway 는 배포 뒤 **사람이 콘솔에서 `npm run migrate` 를 돌린다.** 그 사이에는
//   새 코드가 아직 없는 칼럼을 읽으려 든다. 그대로 두면 견적 저장·목록 조회가 통째로
//   죽는다 — PO번호 하나 때문에 회사가 멈추는 것은 말이 안 된다.
//   그래서 칼럼이 생길 때까지는 **PO 기능만 조용히 쉬고**, 나머지는 예전처럼 돈다.
//   긍정은 영구 캐시(재시작 없이 인식), 없을 때만 30초마다 다시 본다.
let poReadyFlag = false; let poProbeAt = 0;
export async function poColumnReady() {
  if (poReadyFlag) return true;
  if (Date.now() - poProbeAt < 30000) return false;
  poProbeAt = Date.now();
  try {
    const r = await query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='quotes' AND column_name='customer_po_no' LIMIT 1`);
    poReadyFlag = r.rows.length > 0;
  } catch (_) { poReadyFlag = false; }
  return poReadyFlag;
}
/** 시험용 — 스키마 조회를 흉내 내지 못하는 러너(pg-mem 등)에서 상태를 직접 세운다. */
export function setPoColumnReady(v) { poReadyFlag = !!v; poProbeAt = Date.now(); }

/**
 * SELECT 목록에 끼워 넣을 PO 칼럼 조각.
 * 마이그레이션 전이면 `NULL` 을 같은 이름으로 돌려준다 — **호출부의 모양이 바뀌지 않는다.**
 */
export function poSelectFrag(ready, alias = 'q') {
  return ready ? `${alias}.customer_po_no` : `NULL::text`;
}

/**
 * 검색 한 줄 — 견적번호 · 고객명 · 고객 PO 를 **한 칸에서** 찾는다.
 *
 *   사람이 「4471」 을 들고 오는지 「Refaccionaria …」 를 들고 오는지 미리 알 수 없다.
 *   칸을 셋으로 나누면 매번 어느 칸인지 고르게 되고, 고르다 틀리면 「없다」가 나온다.
 *   그래서 **하나로 받아 셋을 본다.** 대소문자 무시 부분일치.
 *
 *   `args` 에 값을 밀어 넣고 조건문을 돌려준다(호출부가 파라미터 번호를 세지 않게).
 *   `custExpr` 는 화면마다 고객 이름이 오는 자리가 달라서 받는다(불특정 고객은 guest_name).
 */
export function quoteSearchClause(kw, args, { quoteAlias = 'q', custExpr = "COALESCE(c.name, q.guest_name)", poReady = false } = {}) {
  const s = String(kw || '').trim();
  if (!s) return null;
  args.push('%' + s.toLowerCase() + '%');
  const i = args.length;
  const parts = [
    `lower(COALESCE(${quoteAlias}.quote_no,'')) LIKE $${i}`,
    `lower(COALESCE(${custExpr},'')) LIKE $${i}`,
  ];
  if (poReady) parts.push(`lower(COALESCE(${quoteAlias}.customer_po_no,'')) LIKE $${i}`);
  return '(' + parts.join(' OR ') + ')';
}


// ============ 코드 해석 (CTR 또는 SYD) ============
// 입력 코드 하나를 받아 매칭 후보를 반환. CTR 정확매칭 우선, 없으면 SYD 역검색.
// 반환: { matches: [{product_id, ctr_code, list_price, app, name, syd_codes[], matched_by, oe_codes[]}],
//         source:'ctr'|'syd'|'oe'|'oe_for'|'mixed'|'none', pick_required }
//   0228 — ② 단계에 OE(정규화 일치)를 합쳤다. FOR 로만 걸리면 pick_required=true.
export async function resolveCode(code) {
  const c = String(code || '').trim();
  if (!c) return { matches: [], source: 'none' };
  // 1) CTR 정확매칭 — 여기서 걸리면 끝(다른 표는 보지 않는다)
  const ctr = (await query(
    `SELECT id, code, name, app, list_price, is_active FROM products WHERE deleted_at IS NULL AND code=$1`, [c])).rows;
  let rows = ctr, source = 'ctr';
  const via = new Map();          // product_id → 'syd' | 'oe' | 'oe_for' (어느 표로 걸렸나)
  if (!rows.length) {
    // 2) SYD 역검색 ∪ OE(0228) — **같은 단계로 합친다.**
    //    짧은 숫자형 OE 가 다른 제품의 SYD 코드와 같을 때 SYD 를 무조건 우선하면
    //    조용히 엉뚱한 제품이 견적에 들어간다. 합쳐서 여러 개면 사람이 고른다.
    const syd = (await query(
      `SELECT p.id, p.code, p.name, p.app, p.list_price, p.is_active
         FROM product_syd_codes s JOIN products p ON p.id=s.product_id AND p.deleted_at IS NULL
        WHERE s.syd_code=$1`, [c])).rows;
    for (const r of syd) via.set(Number(r.id), 'syd');
    rows = syd.slice();
    const n = normOe(c);
    if (n && (await oeReady())) {
      const oe = (await query(
        `SELECT p.id, p.code, p.name, p.app, p.list_price, p.is_active, bool_or(o.rel='oe') AS direct
           FROM product_oe_codes o JOIN products p ON p.id=o.product_id AND p.deleted_at IS NULL
          WHERE o.oe_norm=$1
          GROUP BY p.id, p.code, p.name, p.app, p.list_price, p.is_active`, [n])).rows;
      for (const r of oe) {
        if (via.has(Number(r.id))) continue;
        via.set(Number(r.id), r.direct ? 'oe' : 'oe_for');
        rows.push(r);
      }
    }
    const kinds = new Set(via.values());
    source = !rows.length ? 'none' : (kinds.size === 1 ? [...kinds][0] : 'mixed');
  }
  if (!rows.length) return { matches: [], source: 'none' };
  const ids = rows.map((r) => r.id);
  const sydRows = (await query(`SELECT product_id, syd_code FROM product_syd_codes WHERE product_id = ANY($1)`, [ids])).rows;
  const sydByPid = {};
  for (const s of sydRows) (sydByPid[s.product_id] ||= []).push(s.syd_code);
  const oeMap = await oeByProduct(ids);
  const matches = rows.map((r) => ({
    product_id: r.id, ctr_code: r.code, name: r.name, app: r.app,
    list_price: Number(r.list_price) || 0, syd_codes: sydByPid[r.id] || [],
    // 0179 — 비활성(판매중단) SKU 는 화면에 표시는 하되 신규 라인 저장에서 막는다.
    is_active: r.is_active !== false,
    // 0228 — 무엇으로 걸렸나 + 그 제품의 OE 목록(표기 그대로)
    matched_by: source === 'ctr' ? 'ctr' : (via.get(Number(r.id)) || null),
    oe_codes: (oeMap.get(Number(r.id)) || []).map(oeToken),
  }));
  // FOR(조립품 OE)로만 걸린 경우는 한 건이어도 **자동 확정하지 않는다**(디렉터 결정 D6).
  //   조립품 번호로 부품 하나가 조용히 견적되는 것을 막는다 — 후보창에서 사람이 고른다.
  const pick_required = matches.length === 1 && matches[0].matched_by === 'oe_for';
  return { source, matches, pick_required };
}

/**
 * 화면(ERP) 경로가 **저장하는** issue 값 — 비활성만 남긴다.
 *
 *   buildLines 는 `not_found`·`multi_match`·`inactive` 세 가지를 붙인다.
 *   그중 화면 경로가 DB 에 남기는 것은 **`inactive` 하나뿐**이다.
 *   코드를 못 찾은 줄(not_found)은 예전부터 그대로 저장·확정돼 왔고, 여기서 같이
 *   막으면 이번 요구(판매중단 SKU 수요 기록)와 상관없는 동작이 조용히 바뀐다.
 *   포털 수신 창구(0220)는 지금처럼 **세 가지 전부** 저장한다 — 남이 보낸 견적은
 *   0원짜리 줄이 섞여도 사람이 볼 때까지 아무도 모르기 때문이다.
 */
export const screenIssue = (issue) => (issue === 'inactive' ? 'inactive' : null);

/**
 * 비활성 SKU 별 **판매중단 시각** — Map(product_id → Date|null).
 *
 *   견적 수정 때 「이 줄이 중단 전부터 있던 줄인가, 중단 후에 새로 들어온 요청인가」를
 *   가르는 데 쓴다. 중단 **전에** 만들어진 견적은 예전처럼 확정·인보이스 발행이 가능해야
 *   하고(0179 가 견적→매출 전환을 막지 않은 것과 같은 이유), 중단 **후에** 들어온 요청은
 *   수요로 기록하되 확정이 잠겨야 한다.
 */
export async function inactiveSinceMap(productIds) {
  const ids = [...new Set((productIds || []).map(Number).filter((x) => Number.isFinite(x) && x > 0))];
  const map = new Map();
  if (!ids.length) return map;
  const rows = (await query(
    `SELECT p.id,
            COALESCE(
              (SELECT max(l.changed_at) FROM product_status_log l
                WHERE l.product_id = p.id AND l.action = 'deactivate'),
              p.status_changed_at) AS since_at
       FROM products p
      WHERE p.id = ANY($1::bigint[]) AND p.deleted_at IS NULL AND p.is_active = FALSE`, [ids])).rows;
  for (const r of rows) map.set(Number(r.id), r.since_at || null);
  return map;
}

// 0179 · 저장하려는 라인 중 「비활성 SKU」를 골라낸다(신규 사용 차단).
//   allowedIds = 이미 그 견적에 들어 있던 product_id 집합 —
//   비활성 전에 만들어진 기존 견적을 계속 수정·정리할 수 있어야 하므로 예외로 둔다.
export async function inactiveTargets(inputLines, allowedIds = null) {
  const hits = [];
  for (const ln of (Array.isArray(inputLines) ? inputLines : [])) {
    let pid = Number(ln.product_id) || null;
    if (!pid) {
      const res = await resolveCode(ln.code);
      if (res.matches.length === 1) pid = res.matches[0].product_id;
    }
    if (!pid) continue;
    if (allowedIds && allowedIds.has(Number(pid))) continue;
    const p = (await query(
      `SELECT id, code, name FROM products WHERE id=$1 AND deleted_at IS NULL AND NOT is_active`, [pid])).rows[0];
    if (p && !hits.some((h) => h.product_id === Number(p.id))) {
      hits.push({ product_id: Number(p.id), code: p.code, name: p.name });
    }
  }
  return hits;
}

// ============ 재고 예약(블럭) · 만료(무효화) 공통 ============
// 가용재고 = 현재고 − 타 미결·미만료 견적의 reserved_qty 합. 물리 stock_qty는 예약으로 안 건드림.
// 한 견적의 매칭 라인들을 제품별로 묶어 생성순(line_no)으로 선착순 greedy 배분한다.
//  · 같은 트랜잭션(c) 안에서 product 행을 FOR UPDATE 로 잠가, 동시 저장이 같은 재고를 중복 예약하지 못하게 직렬화.
//  · '타 견적' 합은 이미 커밋된 reserved_qty 만 보이므로(잠금 대기 후 읽음) 선착순이 보장된다.
export async function assignReservations(c, quoteId) {
  const lines = (await c.query(
    `SELECT id, product_id, qty FROM quote_lines
      WHERE quote_id=$1 AND product_id IS NOT NULL ORDER BY product_id, line_no, id`, [quoteId])).rows;
  const byProd = {};
  for (const l of lines) { (byProd[Number(l.product_id)] ||= []).push(l); }
  for (const pid of Object.keys(byProd)) {
    const p = (await c.query(`SELECT stock_qty FROM products WHERE id=$1 FOR UPDATE`, [Number(pid)])).rows[0];
    const physical = p && p.stock_qty != null ? Number(p.stock_qty) : 0;
    const other = (await c.query(
      `SELECT COALESCE(SUM(ql.reserved_qty),0) AS s
         FROM quote_lines ql JOIN quotes q ON q.id=ql.quote_id
        WHERE ql.product_id=$1 AND q.id<>$2 AND q.status IN ('draft','confirmed')
          AND (q.reserve_expires_at > now() OR q.packing_printed_at IS NOT NULL)
          AND q.deleted_at IS NULL`, [Number(pid), quoteId])).rows[0];
    let remaining = Math.max(0, physical - (Number(other.s) || 0));
    for (const l of byProd[pid]) {
      const want = Number(l.qty) || 0;
      const give = Math.max(0, Math.min(want, remaining));
      remaining -= give;
      await c.query(`UPDATE quote_lines SET reserved_qty=$1 WHERE id=$2`, [give, l.id]);
    }
  }
}

// ============ 견적 저장/수정 ============
export async function nextQuoteNo(c, year) {
  const r = (await c.query(`SELECT COUNT(*)::int AS n FROM quotes WHERE quote_no LIKE $1`, [`Q-${year}-%`])).rows[0];
  return formatQuoteNo(year, (r.n || 0) + 1);
}

/**
 * 라인 입력 → 계산 후 저장용 행 생성
 *
 *   각 행에 `issue` 를 함께 붙인다 — **왜 이 줄이 이상한지**를 한 단어로 남기는 칸이다.
 *     not_found   코드를 찾지 못했다(단가 0 으로 들어간다)
 *     multi_match SYD 코드가 여러 제품에 걸렸다 — 사람이 골라야 한다
 *     inactive    판매중단 SKU
 *   화면 경로는 이 값을 저장하지 않는다(예전 그대로 동작). CRM 수신 창구만 저장해서
 *   **문제 줄이 있는 견적은 확정을 막는다.** 0원 줄이 붙은 견적이 고객에게 나가는 것이
 *   지금 가장 위험한 일이다.
 */
export async function buildLines(customerDiscount, ivaRate, inputLines) {
  const rows = [];
  let lineNo = 0;
  for (const ln of inputLines) {
    lineNo++;
    const qty = Number(ln.qty) || 0;
    let prod = null;
    let issue = null;
    let matchSource = null;
    if (ln.product_id) {
      prod = (await query(`SELECT id, code, name, app, list_price, stock_qty, is_active FROM products WHERE id=$1 AND deleted_at IS NULL`, [Number(ln.product_id)])).rows[0] || null;
      // 0228 — 자동완성·후보창에서 고른 줄도 「친 코드가 무엇이었나」를 서버가 판정한다
      if (prod) matchSource = await matchSourceFor(prod.id, ln.code || prod.code);
    } else {
      const res = await resolveCode(ln.code);
      if (res.matches.length === 1 && !res.pick_required) {
        prod = (await query(`SELECT id, code, name, app, list_price, stock_qty, is_active FROM products WHERE id=$1`, [res.matches[0].product_id])).rows[0];
        matchSource = res.matches[0].matched_by || res.source || null;
      }
      // 다중매칭(또는 FOR 로만 걸린 1건)은 저장 단계에서 product_id가 와야 함(화면에서 선택). 여기선 미매칭 처리.
      else if (res.matches.length >= 1) issue = 'multi_match';
    }
    if (!prod) {
      rows.push({ line_no: lineNo, product_id: null, input_code: ln.code || null, ctr_code: null, syd_codes: null, product_name: null, app_text: null, qty, list_price: 0, discount_rate: customerDiscount, final_price: 0, line_subtotal: 0, line_iva: 0, line_total: 0, avail_stock: null, stock_flag: 'not_found', issue: issue || 'not_found',
        match_source: 'none', oe_codes: null });
      continue;
    }
    const oeList = ((await oeByProduct([prod.id])).get(Number(prod.id)) || []).map(oeToken);
    if (prod.is_active === false) issue = 'inactive';
    const sydRows = (await query(`SELECT syd_code FROM product_syd_codes WHERE product_id=$1`, [prod.id])).rows.map((x) => x.syd_code);
    const calc = computeQuoteLine({ listPrice: prod.list_price, discountRate: customerDiscount, qty, ivaRate });
    const avail = prod.stock_qty != null ? Number(prod.stock_qty) : null;
    rows.push({
      line_no: lineNo, product_id: prod.id, input_code: ln.code || prod.code, ctr_code: prod.code,
      syd_codes: sydRows.join(' / '), product_name: prod.name, app_text: prod.app, qty,
      list_price: round2(prod.list_price), discount_rate: customerDiscount,
      final_price: calc.finalPrice, line_subtotal: calc.lineSubtotal, line_iva: calc.lineIva, line_total: calc.lineTotal,
      avail_stock: avail, stock_flag: stockFlag({ matched: true, qty, availStock: avail }),
      issue,
      match_source: matchSource, oe_codes: oeList.length ? oeList.join(' // ') : null,   // 0228
    });
  }
  return rows;
}