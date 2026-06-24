import 'node:process';

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || '',
  jwtSecret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret',
  // 토큰 유효기간 — 6시간마다 PIN 재로그인 강제(모든 사용자).
  // ⚠️ Railway 에 TOKEN_TTL 환경변수가 설정돼 있으면 이 기본값이 무시됨 → 6h 로 바꾸거나 변수 삭제.
  tokenTtl: process.env.TOKEN_TTL || '6h',
};

if (!config.databaseUrl) {
  // 실제 구동 시 필수. 로컬 문법 점검에서는 경고만.
  console.warn('[config] DATABASE_URL 이 설정되지 않았습니다 (.env 참고).');
}
