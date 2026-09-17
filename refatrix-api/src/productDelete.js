// =====================================================================
// Refatrix ERP · productDelete.js  (2026-09-17)
// 제품(SKU) 영구 삭제 — 사전 점검 + 함께 정리할 항목 분류.
//
// 규칙(디렉터 지시)
//   · 한 번이라도 **팔린** 제품은 삭제할 수 없다.
//   · **구매(발주·수입)도 없고 판매도 없을 때만**, 디렉터가 PIN 으로 직접 지운다.
//   · 그 밖에도 products 를 참조하는 기록이 하나라도 남아 있으면 삭제하지 않는다
//     (견적·재고원장·부족분·오퍼시트·개발요청·입고 …). 무엇이 걸렸는지 화면에 그대로 보여 준다.
//   · 삭제는 **소프트가 아니라 진짜 삭제**다 — products.code 가 UNIQUE 이므로 soft delete 면
//     그 코드를 영영 다시 쓸 수 없다(`code_used_by_deleted`). 잘못 등록한 코드를 되살리는 것이
//     이 기능의 목적이라 행을 지운다. 대신 `product_change_log` 에 삭제 기록이 코드와 함께 영구히 남는다.
//
// 참조 탐색은 **DB 에 물어본다** — 표 목록을 코드에 박아 두면 나중에 만든 표를 놓친다.
//   ① information_schema : 현재 스키마(current_schema — 운영은 public)에서 `product_id` 컬럼을 가진 표 전부
//      (finder_quote_lines 처럼 **외래키가 없는** 표도 이 방법으로 잡힌다)
//   ② pg_constraint      : products(id) 를 가리키는 외래키(컬럼 이름이 product_id 가 아닌 경우 대비)
//   → 둘의 합집합을 훑는다. **모르는 표가 나오면 차단**이 기본값이다(안전한 쪽으로 틀린다).
//
// 이 파일은 실행자(exec)를 주입받아 쓰므로 트랜잭션 안/밖에서 같은 코드가 돈다.
// =====================================================================

// 표/컬럼 이름은 SQL 에 문자열로 끼워 넣어야 한다(파라미터로 못 준다).
// DB 카탈로그에서 온 이름만 쓰되, 그래도 형태를 한 번 더 검사한다.
export const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;
export const isIdent = (s) => IDENT_RE.test(String(s || ''));

// ── 함께 지우는 표(파생 데이터 · 제품 전용 이력) ──────────────────────
// 제품이 사라지면 의미가 없어지는 것들. 삭제 결과에 「몇 건을 함께 정리했는지」로 보고한다.
export const CLEANUP_TABLES = {
  product_syd_codes: 'SyD 코드',
  product_applications: '적용차종',
  product_xref_codes: '경쟁사 교차참조',
  xref_snapshot_rows: '교차참조 백업 행',
  product_status_log: '판매상태 전환 이력',
  product_status_check_items: '판매상태 점검 항목',
  product_status_check_notes: '판매상태 점검 메모',
};

// ── 연결만 끊는 표(기록 자체는 남긴다) ────────────────────────────────
// product_change_log 는 code 스냅샷을 따로 갖고 있어 product_id 만 비우면
// 「이 코드에 무슨 일이 있었나」가 그대로 보존된다(제품 이력 화면은 LEFT JOIN 이라 계속 보인다).
export const NULLIFY_TABLES = {
  product_change_log: '제품 변경 이력',
};

// ── 차단 표시용 이름(없으면 표 이름 그대로 보여 준다) ─────────────────
export const BLOCK_LABELS = {
  sales_invoice_lines: '판매(인보이스) 라인',
  sales_payment_allocations: '수금 배분',
  quote_lines: '견적 라인',
  finder_quote_lines: '제품찾기 견적 라인',
  purchase_order_lines: '구매 발주 라인',
  import_lines: '수입원가 배치 라인',
  inbound_pallet_items: '수입입고 팔렛 항목',
  stock_movements: '재고 입출고 원장',
  stock_shortages: '부족분',
  offer_sheet_items: '오퍼시트 항목',
  product_dev_requests: '개발요청',
};

// 「판매」·「구매」로 묶어 화면에 한 줄 요약을 만들기 위한 분류.
export const SALE_TABLES = ['sales_invoice_lines', 'sales_payment_allocations'];
export const PURCHASE_TABLES = ['purchase_order_lines', 'import_lines', 'inbound_pallet_items'];

export function classifyTable(table) {
  if (Object.prototype.hasOwnProperty.call(NULLIFY_TABLES, table)) return 'nullify';
  if (Object.prototype.hasOwnProperty.call(CLEANUP_TABLES, table)) return 'cleanup';
  return 'block';
}

export function tableLabel(table) {
  return CLEANUP_TABLES[table] || NULLIFY_TABLES[table] || BLOCK_LABELS[table] || table;
}

// 점검 상한 — 몇 건인지 정확히 세는 것이 목적이 아니라 「있다/없다 + 대략」이면 충분하다.
// 수만 행짜리 표를 전부 세지 않도록 LIMIT 로 잘라 센다(501 이면 「500건 이상」으로 보고).
export const COUNT_CAP = 501;

// ── ① 참조 후보(표·컬럼) 목록 ────────────────────────────────────────
export const REF_COLUMNS_SQL = `
  SELECT tname AS table_name, cname AS column_name FROM (
    SELECT c.table_name AS tname, c.column_name AS cname
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = current_schema() AND c.column_name = 'product_id'
    UNION
    SELECT src.relname, a.attname
      FROM pg_constraint k
      JOIN pg_class src ON src.oid = k.conrelid
      JOIN pg_class tgt ON tgt.oid = k.confrelid
      JOIN pg_namespace n ON n.oid = src.relnamespace AND n.nspname = current_schema()
      JOIN pg_attribute a ON a.attrelid = src.oid AND a.attnum = k.conkey[1]
     WHERE k.contype = 'f' AND tgt.relname = 'products' AND array_length(k.conkey, 1) = 1
  ) u
   ORDER BY 1, 2`;

export async function refColumns(exec) {
  const rows = (await exec(REF_COLUMNS_SQL)).rows || [];
  return rows
    .map((r) => ({ table: String(r.table_name), column: String(r.column_name) }))
    .filter((r) => r.table !== 'products' && isIdent(r.table) && isIdent(r.column));
}

// ── ② 참조 건수 세기 ─────────────────────────────────────────────────
export function countSql(table, column, cap = COUNT_CAP) {
  if (!isIdent(table) || !isIdent(column)) throw new Error('bad_identifier');
  const lim = Number.isInteger(cap) && cap > 0 && cap <= 100000 ? cap : COUNT_CAP;
  return `SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM "${table}" WHERE "${column}" = $1 LIMIT ${lim}) s`;
}

export async function scanReferences(exec, productId, cols, cap = COUNT_CAP) {
  const out = [];
  for (const { table, column } of cols) {
    const n = Number((await exec(countSql(table, column, cap), [productId])).rows[0].n) || 0;
    if (n > 0) out.push({ table, column, count: n, capped: n >= cap, kind: classifyTable(table), label: tableLabel(table) });
  }
  return out;
}

// ── ③ 점검 결과 조립 ─────────────────────────────────────────────────
// product: { id, code, name, stock_qty }
// refs   : scanReferences 결과
export function buildDeleteCheck(product, refs) {
  const stock = Number(product?.stock_qty || 0);
  const blockers = refs.filter((r) => r.kind === 'block')
    .map((r) => ({ table: r.table, label: r.label, count: r.count, capped: !!r.capped }));
  const cleanups = refs.filter((r) => r.kind === 'cleanup' || r.kind === 'nullify')
    .map((r) => ({ table: r.table, label: r.label, count: r.count, capped: !!r.capped, kind: r.kind }));

  const sum = (names) => refs.filter((r) => names.includes(r.table)).reduce((s, r) => s + r.count, 0);
  const sold = sum(SALE_TABLES);
  const purchased = sum(PURCHASE_TABLES);

  if (stock !== 0) {
    blockers.unshift({ table: '__stock__', label: '현재 재고수량', count: stock, capped: false });
  }

  const reasons = [];
  if (sold > 0) reasons.push(`판매 이력이 있습니다 (${sold}건) — 판매된 제품은 삭제할 수 없습니다.`);
  if (purchased > 0) reasons.push(`구매(발주·수입) 이력이 있습니다 (${purchased}건).`);
  if (stock !== 0) reasons.push(`재고수량이 ${stock}개 남아 있습니다 (0이어야 삭제할 수 있습니다).`);
  const others = blockers.filter((b) => b.table !== '__stock__' && !SALE_TABLES.includes(b.table) && !PURCHASE_TABLES.includes(b.table));
  if (others.length) {
    reasons.push('다른 기록에 사용 중입니다 — ' + others.map((b) => `${b.label} ${b.count}${b.capped ? '건 이상' : '건'}`).join(' · '));
  }

  return {
    product: product ? { id: Number(product.id), code: product.code, name: product.name || null, stock_qty: stock } : null,
    can_delete: blockers.length === 0,
    sold_count: sold,
    purchase_count: purchased,
    blockers,
    cleanups,
    reasons,
  };
}

// ── ④ 실제 정리(트랜잭션 안에서만 호출) ──────────────────────────────
// 반환: { cleaned: { 표이름: 건수 }, nulled: { 표이름: 건수 } }
export async function purgeReferences(exec, productId, refs) {
  const cleaned = {}; const nulled = {};
  for (const r of refs) {
    if (r.kind === 'nullify') {
      const res = await exec(`UPDATE "${r.table}" SET "${r.column}" = NULL WHERE "${r.column}" = $1`, [productId]);
      nulled[r.table] = res.rowCount || 0;
    } else if (r.kind === 'cleanup') {
      const res = await exec(`DELETE FROM "${r.table}" WHERE "${r.column}" = $1`, [productId]);
      cleaned[r.table] = res.rowCount || 0;
    }
  }
  return { cleaned, nulled };
}

// 삭제 기록에 남길 「함께 정리한 항목」 한 줄 요약.
export function describeCleanup(cleaned = {}, nulled = {}) {
  const parts = [];
  for (const [t, n] of Object.entries(cleaned)) if (n > 0) parts.push(`${tableLabel(t)} ${n}건`);
  for (const [t, n] of Object.entries(nulled)) if (n > 0) parts.push(`${tableLabel(t)} ${n}건(연결 해제)`);
  return parts.length ? parts.join(' · ') : null;
}
