import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import { config } from './config.js';
import { authGuard, requireDirector } from './middleware/authGuard.js';
import { query } from './db.js';
import authRoutes from './routes/authRoutes.js';
import deviceRoutes from './routes/deviceRoutes.js';
import productRoutes from './routes/productRoutes.js';
import importRoutes from './routes/importRoutes.js';
import importCostRoutes from './routes/importCostRoutes.js';
import salesRoutes from './routes/salesRoutes.js';
import financeRoutes from './routes/financeRoutes.js';
import budgetRoutes from './routes/budgetRoutes.js';
import customerRoutes from './routes/customerRoutes.js';
import targetRoutes from './routes/targetRoutes.js';
import meetingRoutes from './routes/meetingRoutes.js';
import marketingRoutes from './routes/marketingRoutes.js';
import portalRoutes from './routes/portalRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import salesPerfRoutes from './routes/salesPerfRoutes.js';
import settlementVarianceRoutes from './routes/settlementVarianceRoutes.js';
import portalBoardRoutes from './routes/portalBoardRoutes.js';
import portalKpiRoutes from './routes/portalKpiRoutes.js';
import quoteRoutes from './routes/quoteRoutes.js';
import stockRoutes from './routes/stockRoutes.js';
import devRequestRoutes from './routes/devRequestRoutes.js';
import userRoutes from './routes/userRoutes.js';

export function buildApp() {
  const app = Fastify({ logger: true });
  // 외부 화면(프로토타입)에서의 요청 허용. 프로토타입 단계에서는 모든 출처 허용 +
  // 자격증명/기기키 헤더 허용. (운영 단계에서 실제 도메인으로 좁히는 것을 권장)
  app.register(fastifyCors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-device-key'],
  });
  app.register(fastifyJwt, { secret: config.jwtSecret, sign: { expiresIn: config.tokenTtl } });

  app.get('/health', async () => ({ ok: true }));

  app.register(authRoutes);
  app.register(deviceRoutes);
  app.register(productRoutes);
  app.register(importRoutes);
  app.register(importCostRoutes);
  app.register(salesRoutes);
  app.register(financeRoutes);
  app.register(budgetRoutes);
  app.register(customerRoutes);
  app.register(targetRoutes);
  app.register(meetingRoutes);
  app.register(marketingRoutes);
  app.register(portalRoutes);
  app.register(dashboardRoutes);
  app.register(salesPerfRoutes);
  app.register(settlementVarianceRoutes);
  app.register(portalBoardRoutes);
  app.register(portalKpiRoutes);
  app.register(quoteRoutes);
  app.register(stockRoutes);
  app.register(devRequestRoutes);
  app.register(userRoutes);

  // 감사 로그 조회(디렉터 전용). 열람만 가능, 수정·삭제 API 없음(무결성).
  app.get('/api/audit', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = (await query(
      `SELECT a.occurred_at, a.action, a.target, a.result, a.detail,
              u.name, u.dept, u.role
         FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
        ORDER BY a.occurred_at DESC LIMIT $1`, [limit])).rows;
    return { items: rows };
  });

  return app;
}

// 직접 실행 시 서버 기동
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const app = buildApp();
  app.listen({ port: config.port, host: '0.0.0.0' })
    .then((addr) => app.log.info(`Refatrix API on ${addr}`))
    .catch((err) => { app.log.error(err); process.exit(1); });
}
