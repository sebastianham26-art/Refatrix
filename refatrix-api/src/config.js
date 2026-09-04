import 'node:process';

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || '',
  jwtSecret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret',
  // 토큰 유효기간 — 6시간마다 PIN 재로그인 강제(모든 사용자).
  // ⚠️ Railway 에 TOKEN_TTL 환경변수가 설정돼 있으면 이 기본값이 무시됨 → 6h 로 바꾸거나 변수 삭제.
  tokenTtl: process.env.TOKEN_TTL || '6h',

  // ===== ERP → CRM(웹 카달록) 고객 동기화 =====
  //   계약이 확정되기 전까지는 CRM_SYNC_ENABLED 를 켜지 않는다(기본 꺼짐).
  //   꺼져 있어도 승인 건은 crm_customer_outbox 에 쌓이므로, 켜는 순간 밀린 건이 순서대로 나간다.
  crm: {
    enabled: String(process.env.CRM_SYNC_ENABLED || '0') === '1',
    url: process.env.CRM_SYNC_URL || 'http://138.197.25.94/api/integrations/erp/customer-commercial',
    token: process.env.CRM_SYNC_TOKEN || '',                       // 예: 'Bearer xxx' 또는 API 키 값
    tokenHeader: process.env.CRM_SYNC_TOKEN_HEADER || 'Authorization',
    methodUpsert: (process.env.CRM_SYNC_METHOD_UPSERT || 'POST').toUpperCase(),
    methodDelete: (process.env.CRM_SYNC_METHOD_DELETE || 'DELETE').toUpperCase(),
    okCode: process.env.CRM_SYNC_OK_CODE || '0',                   // codigoError 성공값
    // transactionUser 로 보낼 사용자 필드 — login_id | name | role
    userField: ['login_id', 'name', 'role'].includes(process.env.CRM_SYNC_USER_FIELD || '')
      ? process.env.CRM_SYNC_USER_FIELD : 'login_id',
    timeoutMs: Number(process.env.CRM_SYNC_TIMEOUT_MS || 10000),
    workerSec: Number(process.env.CRM_SYNC_WORKER_SEC || 60),
  },
};

if (!config.databaseUrl) {
  // 실제 구동 시 필수. 로컬 문법 점검에서는 경고만.
  console.warn('[config] DATABASE_URL 이 설정되지 않았습니다 (.env 참고).');
}
