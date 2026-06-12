// 위젯 레지스트리 — 모든 위젯의 번호·이름·카테고리·필드토글·필요권한 정의.
// 디렉터 구성 화면과 유저 대시보드가 같은 정의를 공유한다.
// field 토글: 디렉터가 유저별로 위젯 안의 세부정보 표시 여부를 정함.
//   민감 필드(sale_price 등)는 서버측 user_field_access로도 게이트됨(이중 보호).

export const WIDGETS = [
  {
    key: 'W01_sales_perf', no: 'W-01', name: '영업 성과(목표 대비)', cat: '영업',
    source: 'portal.perf', need: ['targets', 'sales'],
    fields: [
      { key: 'amount', name: '금액 표시', def: true, sensitive: false, note: '끄면 달성률(%)만 표시' },
    ],
  },
  {
    key: 'W02_pipeline', no: 'W-02', name: '파이프라인 요약', cat: '영업',
    source: 'portal.pipeline', need: ['pipeline'],
    fields: [],
  },
  {
    key: 'W03_pending', no: 'W-03', name: '펜딩 · 할 일', cat: '공통',
    source: 'portal.badges', need: [],
    fields: [],
  },
  {
    key: 'W09_stalled', no: 'W-09', name: '정체 고객(30일+)', cat: '영업',
    source: 'portal.badges', need: ['pipeline'],
    fields: [
      { key: 'ar', name: '연체액 표시', def: false, sensitive: false },
    ],
  },
  {
    key: 'W08_mkt_budget', no: 'W-08', name: '마케팅 예산 현황', cat: '마케팅',
    source: 'marketing.overview', need: ['marketing'],
    fields: [
      { key: 'amount', name: '금액 표시', def: true, sensitive: false, note: '끄면 소진율(%)만 표시' },
    ],
  },
  {
    key: 'W10_process', no: 'W-10', name: '업무 프로세스 지도', cat: '공통',
    source: 'portal.badges', need: [],
    fields: [],
  },

  // ===== 영업 카테고리 표시형 위젯(클릭 시 해당 화면으로 이동) =====
  {
    key: 'S01_customer_status', no: 'S-01', name: '고객 현황 요약', cat: '영업',
    source: 'salesdata.customers', link: 'customers', need: ['customers'],
    fields: [
      { key: 'outstanding', name: '총 미수금 표시', def: true, sensitive: false, note: '끄면 고객수·연체수만' },
    ],
  },
  {
    key: 'S02_target_status', no: 'S-02', name: '매출목표 승인 현황', cat: '영업',
    source: 'salesdata.target_status', link: 'targets', need: ['targets'],
    fields: [],
  },
  {
    key: 'S03_pipeline_kanban', no: 'S-03', name: '파이프라인 칸반 요약', cat: '영업',
    source: 'portal.pipeline', link: 'pipeline', need: ['pipeline'],
    fields: [],
  },
  {
    key: 'S04_bottleneck', no: 'S-04', name: '파이프라인 병목', cat: '영업',
    source: 'portal.badges', link: 'pipeline', need: ['pipeline'],
    fields: [],
  },
  {
    key: 'S05_recent_meetings', no: 'S-05', name: '최근 미팅 활동', cat: '영업',
    source: 'salesdata.recent_meetings', link: 'pipeline', need: ['pipeline'],
    fields: [],
  },
  {
    key: 'S06_directives', no: 'S-06', name: '디렉터 지시 현황', cat: '영업',
    source: 'salesdata.directives', link: 'pipeline', need: ['pipeline'],
    fields: [],
  },
  {
    key: 'S07_target_detail', no: 'S-07', name: '매출목표 요약(회사)', cat: '영업',
    source: 'portal.perf', link: 'targets', need: ['targets'],
    fields: [
      { key: 'amount', name: '금액 표시', def: true, sensitive: false, note: '끄면 달성률만' },
    ],
  },
];

export const WIDGET_BY_KEY = Object.fromEntries(WIDGETS.map((w) => [w.key, w]));

// 역할 기본값(디렉터가 아직 구성 안 한 신규 유저에게 보여줄 기본 세트)
export const ROLE_DEFAULTS = {
  director: ['W10_process', 'W03_pending', 'W01_sales_perf', 'W02_pipeline', 'W08_mkt_budget'],
  sales: ['W03_pending', 'W09_stalled', 'W02_pipeline'],
  marketing: ['W03_pending', 'W08_mkt_budget'],
  default: ['W03_pending'],
};

// 위젯 settings 기본값(필드 토글) 계산
export function defaultSettings(widgetKey) {
  const w = WIDGET_BY_KEY[widgetKey];
  const s = {};
  if (w) for (const f of w.fields) s[f.key] = f.def;
  return s;
}
