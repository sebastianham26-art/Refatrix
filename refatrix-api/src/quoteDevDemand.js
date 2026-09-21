// =====================================================================
// Refatrix ERP · quoteDevDemand.js — 견적의 「카탈로그 미등록 코드」 → 개발요청 대장 (2026-09-21)
//
//   왜 이 파일이 있나
//     예전에는 미등록 코드를 **견적이 끝날 때만**(매출 전환 · 24시간 만료) 대장에 적었다.
//     그래서 ⓐ 막 입력한 견적은 하루 동안 아무 기록이 없었고,
//            ⓑ 포장지시서를 출력한 뒤 전환하지 않은 견적은 만료 처리에서 빠져 **끝내 기록되지 않았다.**
//     (실제 사례: CQ0988L — 견적에 넣었는데 「개발 요청」에 안 보였다.)
//
//     이제 **견적이 저장되는 순간** 적는다. 경로가 다섯 개라도 규칙은 여기 한 곳에만 둔다:
//       견적 저장 · 수정 · 복제 · 포털(CRM) 수신 · (안전망) 매출 전환 · 만료
//
//   규칙
//     1. 대상 = product_id 가 비어 있는 줄 중 **지금도 카탈로그에서 코드를 못 찾는 것**.
//        SYD 가 여러 제품에 걸린 줄(multi_match)은 존재하는 코드이므로 개발 대상이 아니다.
//     2. 중복 = 같은 견적 + 같은 코드(대소문자·기호 무시, devDemand.normCode 와 같은 기준).
//        수정·재저장·전환·만료가 몇 번 겹쳐도 한 견적의 한 코드는 대장에 **한 줄**이다.
//     3. 수량이 바뀌면 아직 「접수」 상태인 요청만 따라간다(검토가 시작된 건은 건드리지 않는다).
//     4. 요청일 = 견적일. 고객이 그 부품을 찾은 날이 기준이다.
//     5. 취소·삭제된 견적은 새로 적지 않는다.
//     6. 사람이 지운 요청(deleted_at)은 되살리지 않는다.
// =====================================================================
import { resolveCode } from './quoteBuild.js';
import { normCode } from './devDemand.js';

// SQL 쪽 정규화 — normCode 와 같은 결과(대문자, 영숫자만)
export const NORM_SQL = (col) => `upper(regexp_replace(COALESCE(${col},''), '[^A-Za-z0-9]', '', 'g'))`;

/**
 * 견적 한 건의 미등록 코드를 개발요청 대장에 반영한다. **호출자의 트랜잭션(c) 안에서** 돈다.
 *
 * @param c           node-pg PoolClient (withTx 가 넘겨 준 것)
 * @param quoteId     견적 id
 * @param opts.customerId  고객을 덮어쓸 때(불특정 견적을 전환하며 고객을 지정한 경우)
 * @param opts.userId      작성자(없으면 견적 작성자)
 * @returns { created: [{id, code, qty}], updated: n, skipped_known: [code] }
 */
export async function recordQuoteDevDemand(c, quoteId, opts = {}) {
  const out = { created: [], updated: 0, skipped_known: [] };
  const q = (await c.query(
    `SELECT id, customer_id, quote_date, status, created_by, deleted_at FROM quotes WHERE id=$1`,
    [Number(quoteId)])).rows[0];
  if (!q || q.deleted_at || q.status === 'cancelled') return out;
  const customerId = Number(opts.customerId) || (q.customer_id != null ? Number(q.customer_id) : null);
  const userId = Number(opts.userId) || (q.created_by != null ? Number(q.created_by) : null);

  const lines = (await c.query(
    `SELECT input_code, qty FROM quote_lines
      WHERE quote_id=$1 AND product_id IS NULL AND COALESCE(btrim(input_code),'') <> ''
      ORDER BY line_no, id`, [q.id])).rows;
  if (!lines.length) return out;

  // 같은 코드가 두 줄이면 합친다(대장에는 한 줄).
  const byNorm = new Map();
  for (const l of lines) {
    const norm = normCode(l.input_code);
    if (!norm) continue;
    const g = byNorm.get(norm);
    if (g) g.qty += Number(l.qty) || 0;
    else byNorm.set(norm, { norm, code: String(l.input_code).trim(), qty: Number(l.qty) || 0 });
  }

  for (const g of byNorm.values()) {
    // 규칙 1 — 지금 카탈로그에서 풀리는 코드면 개발 대상이 아니다(multi_match 등).
    const res = await resolveCode(g.code);
    if (res.matches.length) { out.skipped_known.push(g.code); continue; }

    // 지운(deleted_at) 요청도 「이미 있음」으로 본다 — 사람이 오타라서 지운 것을 수정 한 번에 되살리면 안 된다.
    const ex = (await c.query(
      `SELECT id, status, requested_qty, deleted_at FROM product_dev_requests
        WHERE source_quote_id=$1 AND ${NORM_SQL('input_code')} = $2
        ORDER BY (deleted_at IS NULL) DESC, id LIMIT 1`, [q.id, g.norm])).rows[0];
    const qty = g.qty > 0 ? g.qty : null;
    if (ex) {
      // 규칙 3 — 접수 상태에서만 수량을 따라간다.
      if (!ex.deleted_at && ex.status === 'received' && Number(ex.requested_qty || 0) !== Number(qty || 0)) {
        await c.query(
          `UPDATE product_dev_requests SET requested_qty=$1, updated_by=$2, updated_at=now() WHERE id=$3`,
          [qty, userId, ex.id]);
        out.updated++;
      }
      continue;
    }
    const r = (await c.query(
      `INSERT INTO product_dev_requests (input_code, customer_id, requested_qty, requested_at, source_quote_id, status, created_by)
       VALUES ($1,$2,$3,COALESCE($4::date,CURRENT_DATE),$5,'received',$6) RETURNING id`,
      [g.code, customerId, qty, q.quote_date || null, q.id, userId])).rows[0];
    out.created.push({ id: Number(r.id), code: g.code, qty });
  }
  return out;
}

/** 저장 응답용 — 미등록 코드 목록(이번에 새로 적었든 이미 있었든). */
export async function quoteDevLines(c, quoteId) {
  const rows = (await c.query(
    `SELECT d.id, d.input_code, d.requested_qty, d.status
       FROM product_dev_requests d
      WHERE d.source_quote_id=$1 AND d.deleted_at IS NULL
      ORDER BY d.id`, [Number(quoteId)])).rows;
  return rows.map((r) => ({ id: Number(r.id), code: r.input_code,
    qty: r.requested_qty != null ? Number(r.requested_qty) : null, status: r.status }));
}

// 영업사원이 읽는 안내 — 스페인어(판매중단 안내와 같은 톤: 막는 말이 아니라 「어디에 남는지」).
export const esDevNote = (rows) =>
  `Códigos fuera de catálogo en esta cotización: ${rows.length} `
  + `(${rows.map((x) => x.code).filter(Boolean).join(', ')}). La cotización sigue su curso normal; `
  + `estos códigos quedan registrados como solicitud de desarrollo en Ventas > 개발 요청 (Solicitudes de desarrollo).`;
