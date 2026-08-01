// =====================================================================
// Refatrix ERP · devDemand.js — 「개발필요내용」 SKU 수요 집계·VIO 중요도
//   순수 함수만(외부 호출·DB 접근 없음) → 단위 테스트 용이.
//   product_dev_requests(개발요청 대장) 행들을 코드(SKU)별로 묶어
//   · 어떤 SKU 가 / 누구(고객)로부터 / 언제 / 몇 개 수요가 있었는지 (수요 이력)
//   · 적용 차종·연식 (검토입력 → 제품매칭 → VIO 추정 순으로 해석)
//   · VIO(멕시코 차량 등록대수) 연결 → 중요도 순 정렬
//   을 만든다. 부족분(stock_shortages) 대장과 같은 "기록 중심" 관리용.
// =====================================================================

export const normCode = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');

function n(v) { return Number(v) || 0; }
function d10(v) { if (!v) return null; if (v instanceof Date) return v.toISOString().slice(0, 10); return String(v).slice(0, 10); }

// 대장 행 → 코드별 그룹.
// rows: { id, input_code, customer_id, customer_name, requested_qty, requested_at,
//         status, quote_no, field_survey_id, order_memo,
//         review_maker, review_model, review_year, review_app, reviewed_at }
export function groupDemand(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const norm = normCode(r.input_code);
    if (!norm) continue;
    let g = map.get(norm);
    if (!g) {
      g = {
        norm, code: String(r.input_code || '').trim(),
        events: [], total_qty: 0, customer_count: 0,
        first_at: null, last_at: null,
        open_count: 0, developed_count: 0,
        review: { maker: null, model: null, year: null, app: null },
        _customers: new Set(), _latestReviewAt: null,
      };
      map.set(norm, g);
    }
    const date = d10(r.requested_at);
    const source = r.quote_no ? `견적 ${r.quote_no}`
      : (r.field_survey_id ? `현장조사 #${r.field_survey_id}` : '수동 접수');
    g.events.push({
      id: Number(r.id), customer: r.customer_name || '불특정',
      date, qty: r.requested_qty != null ? n(r.requested_qty) : null,
      source, status: r.status || 'received', memo: r.order_memo || null,
    });
    g.total_qty += n(r.requested_qty);
    if (r.customer_name) g._customers.add(r.customer_name);
    if (date) {
      if (!g.first_at || date < g.first_at) g.first_at = date;
      if (!g.last_at || date > g.last_at) g.last_at = date;
    }
    if (['received', 'reviewed', 'factory_requested'].includes(r.status)) g.open_count++;
    if (r.status === 'developed') g.developed_count++;
    // 검토 입력(차종·연식)은 가장 최근 검토된 행 우선
    const rvAt = d10(r.reviewed_at);
    if ((r.review_model || r.review_app || r.review_maker || r.review_year)
        && (!g._latestReviewAt || (rvAt && rvAt >= g._latestReviewAt))) {
      g._latestReviewAt = rvAt || g._latestReviewAt || '0000';
      g.review = {
        maker: r.review_maker || g.review.maker,
        model: r.review_model || g.review.model,
        year: r.review_year || g.review.year,
        app: r.review_app || g.review.app,
      };
    }
  }
  const out = [];
  for (const g of map.values()) {
    g.customer_count = g._customers.size || (g.events.length ? 1 : 0);
    g.events.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    delete g._customers; delete g._latestReviewAt;
    out.push(g);
  }
  return out;
}

const normTxt = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9가-힣]/g, '');

// 차종·연식 + VIO 연결.
//   productHit: norm → { ctr_code, app, vio_rank, vio_units, vio_model, vio_year } (교차참조/제품 매칭 결과)
//   vioModels: [{ model, years, rank, units }] (ctr_vio_rank 를 모델별로 요약한 목록)
export function attachVehicleVio(groups, productHit, vioModels) {
  const vm = (vioModels || []).map((v) => ({ ...v, _n: normTxt(v.model) }));
  return (groups || []).map((g) => {
    const hit = productHit && productHit[g.norm];
    let vehicle = null, vio = null;
    if (hit) {
      // ① 코드가 기존 제품(CTR/SYD/교차참조)과 매칭 — 제품의 적용차종 + 코드 직결 VIO
      vehicle = { text: hit.app || null, maker: null, model: hit.vio_model || null, year: hit.vio_year || null, source: 'product', matched_ctr: hit.ctr_code || null };
      if (hit.vio_rank != null) vio = { rank: n(hit.vio_rank), units: hit.vio_units != null ? n(hit.vio_units) : null, model: hit.vio_model || null, year: hit.vio_year || null, via: 'ctr_code' };
    }
    if (!vehicle && (g.review.model || g.review.app)) {
      vehicle = {
        text: g.review.app || [g.review.maker, g.review.model, g.review.year].filter(Boolean).join(' ') || null,
        maker: g.review.maker, model: g.review.model, year: g.review.year, source: 'review', matched_ctr: null,
      };
    }
    if (!vio && vehicle && vehicle.model) {
      // ② 검토 입력 차종명으로 VIO 모델 퍼지 매칭(포함 관계, 최고 순위 채택)
      const key = normTxt(vehicle.model);
      let best = null;
      if (key.length >= 3) {
        for (const v of vm) {
          if (!v._n) continue;
          if (v._n.includes(key) || key.includes(v._n)) {
            if (!best || n(v.rank) < n(best.rank)) best = v;
          }
        }
      }
      if (best) vio = { rank: n(best.rank), units: best.units != null ? n(best.units) : null, model: best.model, year: best.years || null, via: 'model_match' };
    }
    return { ...g, vehicle, vio };
  });
}

// 중요도 정렬 — mode: 'vio'(기본) | 'demand' | 'recent'
//   vio    : VIO 등록대수 큰 순(없으면 뒤) → 누적 수요량 → 고객수 → 최근
//   demand : 누적 수요량 → 고객수 → VIO → 최근
//   recent : 최근 수요일 → VIO
export function sortDemand(list, mode) {
  const arr = [...(list || [])];
  const units = (x) => (x.vio && x.vio.units != null ? x.vio.units : -1);
  const last = (x) => String(x.last_at || '');
  if (mode === 'demand') {
    arr.sort((a, b) => (b.total_qty - a.total_qty) || (b.customer_count - a.customer_count)
      || (units(b) - units(a)) || last(b).localeCompare(last(a)));
  } else if (mode === 'recent') {
    arr.sort((a, b) => last(b).localeCompare(last(a)) || (units(b) - units(a)) || (b.total_qty - a.total_qty));
  } else {
    arr.sort((a, b) => (units(b) - units(a)) || (b.total_qty - a.total_qty)
      || (b.customer_count - a.customer_count) || last(b).localeCompare(last(a)));
  }
  return arr.map((x, i) => ({ ...x, rank: i + 1 }));
}
