import { query } from './db.js';

// 화면(메뉴)과 실제 API 권한 키 매핑 — 포털 "내 메뉴"와 라우트 requirePage가 같은 키를 쓰도록.
// 공통 화면(dashboard/board/salesperf)은 별도 권한 없이 누구나(authGuard) 접근.
export const SCREEN_PAGE_KEY = {
  sales: 'sales',
  pipeline: 'pipeline',
  customers: 'customers',
  targets: 'targets',
  marketing: 'marketing',
  finance: 'transactions',   // 재무 화면 → transactions 권한
  settlement: 'settlement',
  budget: 'budget',
  importcost: 'inventory',   // 수입원가 화면 → inventory 권한
  products: 'products',
  // 공통(권한 불필요): dashboard, board, salesperf
  // 디렉터 전용: users
};

// 역할별 기본 권한: pages = [[page_key, access]], fields = [field_key]
// 'ALL' = 모든 페이지 edit (디렉터)
export const ROLE_DEFAULTS = {
  director: { pages: 'ALL', fields: ['sales_amount', 'ar_amount', 'mkt_amount'] },
  sales: {
    pages: [['quote', 'edit'], ['sales', 'edit'], ['stock', 'edit'], ['shortage', 'edit'], ['devrequest', 'edit'],
            ['pipeline', 'edit'], ['customers', 'edit'], ['targets', 'view']],
    fields: ['sales_amount'],
  },
  sales_support: {
    // 영업과 동일하되: 파이프라인은 열람만, AR(settlement)·수입원가(inventory) 추가
    pages: [['quote', 'edit'], ['sales', 'edit'], ['stock', 'edit'], ['shortage', 'edit'], ['devrequest', 'view'],
            ['pipeline', 'view'], ['customers', 'edit'], ['targets', 'view'],
            ['settlement', 'edit'], ['inventory', 'edit']],
    fields: ['sales_amount', 'ar_amount'],
  },
  treasury: {
    pages: [['transactions', 'edit'], ['settlement', 'edit'], ['budget', 'edit']],
    fields: ['sales_amount', 'ar_amount'],
  },
  marketing: {
    pages: [['marketing', 'edit'], ['devrequest', 'view'], ['targets', 'view'], ['customers', 'view']],
    fields: ['mkt_amount'],
  },
  ops: {
    pages: [['products', 'edit'], ['inventory', 'edit'], ['stock', 'edit'], ['devrequest', 'edit'], ['sales', 'view']],
    fields: [],
  },
  viewer: {
    pages: [],            // 공통 화면(대시보드·일정·영업대시보드)만
    fields: [],
  },
};

const ALL_PAGES = ['quote', 'sales', 'stock', 'shortage', 'devrequest', 'pipeline', 'customers', 'targets', 'marketing', 'transactions', 'settlement', 'budget', 'inventory', 'products'];

/**
 * 역할 기본 권한을 사용자에게 부여.
 *  - 페이지: 이미 있으면 건드리지 않음(수동 설정 보존), 없으면 추천대로 추가
 *  - 필드: 추천 필드는 visible=true로 켬
 * 반환: 부여한 페이지/필드 목록
 */
export async function applyRoleDefaults(userId, role) {
  const def = ROLE_DEFAULTS[role];
  if (!def) return { pages: [], fields: [] };
  const pages = def.pages === 'ALL' ? ALL_PAGES.map((k) => [k, 'edit']) : def.pages;
  const grantedPages = [];
  for (const [pk, acc] of pages) {
    await query(
      `INSERT INTO user_page_access (user_id, page_key, device_req, access)
       VALUES ($1,$2,'anywhere',$3) ON CONFLICT (user_id, page_key) DO NOTHING`,
      [userId, pk, acc]);
    grantedPages.push(pk);
  }
  const grantedFields = [];
  for (const fk of def.fields) {
    await query(
      `INSERT INTO user_field_access (user_id, field_key, visible)
       VALUES ($1,$2,true) ON CONFLICT (user_id, field_key) DO UPDATE SET visible=true`,
      [userId, fk]);
    grantedFields.push(fk);
  }
  return { pages: grantedPages, fields: grantedFields };
}
