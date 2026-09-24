// =====================================================================
// Refatrix ERP · noPrice.js — 정가 없는 제품은 매출로 가지 않는다 (2026-09-24)
//
//   디렉터 지시: 「정가가 없는 제품이 견적에 들어오면 정가를 찾아서 넣도록 안내하고,
//                 정가가 없는데 매출로 연결되지 않도록 해줘.」
//
//   · 견적 작성·저장은 막지 않는다 — 고객이 찾은 기록(수요)은 남아야 한다.
//   · **매출 등록(직접)과 견적→매출 전환**만 막는다. 매출 단가는 제품의 현재 정가로 계산되므로
//     제품 마스터에 정가를 넣으면 그 즉시 전환이 가능해진다(견적을 다시 만들 필요 없음).
//   · 판촉물(코드 PRO…)은 원래 정가 없이 나가는 품목이라 예외 — 다른 화면의 PRO 규칙과 같다.
// =====================================================================
import { query } from './db.js';

export const isPromoCode = (code) => /^PRO/i.test(String(code == null ? '' : code).trim());

/** 정가가 없다 = NULL 또는 0 이하 (판촉물 제외). */
export function lacksListPrice(p) {
  if (!p || isPromoCode(p.code)) return false;
  const v = p.list_price == null || p.list_price === '' ? null : Number(p.list_price);
  return !(Number.isFinite(v) && v > 0);
}

export const NO_PRICE_NOTE =
  '정가(List Price)가 없는 제품이 있어 매출로 넘길 수 없습니다. 제품/마케팅 › 제품 찾기에서 그 제품의 ✎ 수정으로 정가를 입력한 뒤 다시 진행하세요. '
  + '· Hay productos sin precio de lista: capture el precio en el catálogo antes de facturar.';

/** 제품 id 목록 중 정가 없는 것 — [{product_id, code, name}] */
export async function noPriceItems(productIds, exec = query) {
  const ids = [...new Set((productIds || []).map(Number).filter((x) => Number.isFinite(x) && x > 0))];
  if (!ids.length) return [];
  const rows = (await exec(
    `SELECT id, code, name, list_price FROM products WHERE id = ANY($1) AND deleted_at IS NULL`, [ids])).rows;
  return rows.filter(lacksListPrice).map((r) => ({ product_id: Number(r.id), code: r.code, name: r.name }));
}
