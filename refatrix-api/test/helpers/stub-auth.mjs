// 테스트 전용: src/middleware/authGuard.js(운영 JWT·기기 검사)를 헤더 기반 스텁으로 바꿔 끼운다.
//   실행: PGADMIN_URL=... node --import ./test/helpers/stub-auth.mjs test/price_master_pg.test.mjs
import { register } from 'node:module';
register('./stub-auth-hooks.mjs', import.meta.url);
