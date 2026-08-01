// =====================================================================
// Refatrix ERP · devMatchSweep.js — 개발목록 ↔ 제품 카탈로그 자동 매칭
//   목적(디렉터 요청 2026-08-01): 제품 카탈로그(교차참조)·제품마스터가
//   정기/비정기로 업데이트될 때, 개발목록(개발필요내용)의 미완료 경쟁사
//   코드가 우리 제품과 매칭되면 → 경쟁사 코드 옆에 우리 CTR 코드를 붙이고
//   자동으로 「개발완료(developed)」 처리한다.
//
//   매칭 기준(개발필요내용 화면과 동일): 정규화 코드(대소문자·기호 무시)로
//   ① products.code(CTR) ② product_syd_codes ③ product_xref_codes 순.
//
//   호출 지점:
//   · 제품마스터 업로드 커밋 / 신규 제품 수동 생성 (productRoutes)
//   · 교차참조 카탈로그 업로드 / 스냅샷 복원 (xrefRoutes)
//   · 60분 주기 + 서버 기동 시 1회 스위퍼 (devRequestRoutes — 다른 경로 보강)
//   · 수동 점검 버튼 POST /api/dev-requests/match-sweep
//
//   완료 처리 시: result_product_id·result_ctr_code·developed_at(오늘) 기록,
//   감사로그(행별) + 관련자(고객 담당영업+디렉터)에게 집계 1건씩
//   dev_complete 알림 할일(기존 수동 개발완료와 동일 kind, 스팸 방지 위해 묶음).
// =====================================================================
import { query } from './db.js';
import { logEvent } from './audit.js';
import { normCode } from './devDemand.js';

function clip1(s, max) { s = String(s == null ? '' : s); return s.length > max ? s.slice(0, max) + '…' : s; }

// 미완료 개발요청을 카탈로그와 대조해 매칭분을 developed 로 전환.
// 반환: { checked, matched, items:[{id, input_code, ctr_code, customer_name}] }
export async function sweepDevRequestMatches({ userId = null, notify = true } = {}) {
  const reqs = (await query(
    `SELECT d.id, d.input_code, d.customer_id, c.name AS customer_name, c.owner_id AS customer_owner_id
       FROM product_dev_requests d
       LEFT JOIN customers c ON c.id = d.customer_id
      WHERE d.deleted_at IS NULL
        AND d.status IN ('received','reviewed','factory_requested')
        AND d.input_code IS NOT NULL`)).rows;
  if (!reqs.length) return { checked: 0, matched: 0, items: [] };

  // 필요한 정규화 코드 집합
  const wanted = new Set();
  for (const r of reqs) { const n = normCode(r.input_code); if (n) wanted.add(n); }
  if (!wanted.size) return { checked: reqs.length, matched: 0, items: [] };

  // norm → {product_id, pri} (CTR > SYD > xref)
  const hit = new Map();
  const claim = (norm, productId, pri) => {
    if (!norm || !wanted.has(norm)) return;
    const cur = hit.get(norm);
    if (cur && cur.pri <= pri) return;
    hit.set(norm, { product_id: Number(productId), pri });
  };
  const prods = (await query(`SELECT id, code FROM products WHERE deleted_at IS NULL`)).rows;
  const codeById = new Map();
  for (const p of prods) { codeById.set(Number(p.id), p.code); claim(normCode(p.code), p.id, 1); }
  const syds = (await query(`SELECT product_id, syd_code FROM product_syd_codes`)).rows;
  for (const s of syds) claim(normCode(s.syd_code), s.product_id, 2);
  try {
    const xrefs = (await query(`SELECT product_id, norm_code FROM product_xref_codes`)).rows;
    for (const x of xrefs) claim(String(x.norm_code || ''), x.product_id, 3);
  } catch (_) { /* 0130 미적용 시 무시 */ }

  const items = [];
  for (const r of reqs) {
    const h = hit.get(normCode(r.input_code));
    if (!h) continue;
    const ctr = codeById.get(h.product_id);
    if (!ctr) continue;
    await query(
      `UPDATE product_dev_requests
          SET status='developed',
              developed_at=COALESCE(developed_at, CURRENT_DATE),
              result_product_id=$1, result_ctr_code=$2,
              updated_by=$3, updated_at=now()
        WHERE id=$4 AND deleted_at IS NULL AND status IN ('received','reviewed','factory_requested')`,
      [h.product_id, ctr, userId, Number(r.id)]);
    logEvent({
      userId, action: 'update', target: `dev_request:${r.id}`,
      detail: { auto_match: true, input_code: r.input_code, ctr },
    });
    items.push({
      id: Number(r.id), input_code: r.input_code, ctr_code: ctr,
      customer_name: r.customer_name || null, customer_owner_id: r.customer_owner_id != null ? Number(r.customer_owner_id) : null,
    });
  }

  // 집계 알림(스팸 방지: 수신자별 1건) — 고객 담당영업 + 디렉터. 기존 개발완료 알림과 동일 kind.
  if (notify && items.length) {
    try {
      const recipients = new Set();
      for (const it of items) if (it.customer_owner_id) recipients.add(it.customer_owner_id);
      const dirs = (await query(`SELECT id FROM users WHERE role='director' AND deleted_at IS NULL`)).rows;
      for (const u of dirs) recipients.add(Number(u.id));
      const lines = items.slice(0, 15).map((it) =>
        `${it.input_code} → ${it.ctr_code}${it.customer_name ? ' (' + it.customer_name + ')' : ''}`);
      const more = items.length > 15 ? ` 외 ${items.length - 15}건` : '';
      const title = `개발완료(카탈로그 자동 매칭): ${items.length}건`;
      const detail = clip1(`카탈로그/제품마스터 업데이트로 개발목록의 경쟁사 코드가 우리 제품과 매칭되어 자동 개발완료 처리되었습니다. 고객에게 안내하세요.\n` + lines.join('\n') + more, 1800);
      for (const uid of recipients) {
        await query(
          `INSERT INTO todos (title, detail, assignee_id, due_date, kind, created_by)
           VALUES ($1,$2,$3,CURRENT_DATE,'dev_complete',$4)`,
          [title, detail, uid, userId]);
      }
    } catch (_) { /* 알림 실패해도 완료 처리 자체는 유지 */ }
  }
  return { checked: reqs.length, matched: items.length, items };
}
