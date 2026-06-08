import 'node:process';

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || '',
  jwtSecret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret',
  // 토큰 유효기간
  tokenTtl: process.env.TOKEN_TTL || '12h',
};

if (!config.databaseUrl) {
  // 실제 구동 시 필수. 로컬 문법 점검에서는 경고만.
  console.warn('[config] DATABASE_URL 이 설정되지 않았습니다 (.env 참고).');
}
