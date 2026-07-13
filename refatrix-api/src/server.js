// redeploy 0710
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
import grossProfitRoutes from './routes/grossProfitRoutes.js';
import budgetRoutes from './routes/budgetRoutes.js';
import customerRoutes from './routes/customerRoutes.js';
import targetRoutes from './routes/targetRoutes.js';
import meetingRoutes from './routes/meetingRoutes.js';
import marketingRoutes from './routes/marketingRoutes.js';
import marketingSpendRoutes from './routes/marketingSpendRoutes.js';
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
import commissionRoutes from './routes/commissionRoutes.js';
import wbrRoutes from './routes/wbrRoutes.js';
import presenceRoutes from './routes/presenceRoutes.js';
import notaCreditoRoutes from './routes/notaCreditoRoutes.js';
import fieldSurveyRoutes from './routes/fieldSurveyRoutes.js';
import xrefRoutes from './routes/xrefRoutes.js';
import finderRoutes from './routes/finderRoutes.js';
import processKpiRoutes from './routes/processKpiRoutes.js';
import warehouseRoutes from './routes/warehouseRoutes.js';
import portalAlertsRoutes from './routes/portalAlertsRoutes.js';
import dailyBriefingRoutes from './routes/dailyBriefingRoutes.js';
import briefingPendingRoutes from './routes/briefingPendingRoutes.js';
import briefingAiRoutes from './routes/briefingAiRoutes.js';
import stockCountRoutes from './routes/stockCountRoutes.js';
import purchaseRoutes from './routes/purchaseRoutes.js';
import { installPerfMonitor } from './perfMonitor.js';

export function buildApp() {
  const app = Fastify({ logger: true, bodyLimit: 12 * 1024 * 1024, trustProxy: true }); // 12MB (증빙서류 5MB base64 대비) · trustProxy: Railway 프록시 뒤 실제 클라이언트 IP(X-Forwarded-For) 인식(접속 위치 추정용)
  installPerfMonitor(app); // 진단: 이벤트 루프 지연 + 느린 요청 로깅(부작용 없음)

  // 본문 없는 POST(예: 박스 생성)도 Content-Type: application/json 으로 오면
  // 기본 파서가 빈 본문을 거부해 400(Bad Request)이 난다. 빈/공백 본문은 {} 로 허용.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, function (request, body, done) {
    if (body === undefined || body === null || String(body).trim() === '') { done(null, {}); return; }
    try { done(null, JSON.parse(body)); } catch (err) { err.statusCode = 400; done(err, undefined); }
  });
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
  app.register(grossProfitRoutes);
  app.register(budgetRoutes);
  app.register(customerRoutes);
  app.register(targetRoutes);
  app.register(meetingRoutes);
  app.register(marketingRoutes);
  app.register(marketingSpendRoutes);
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
  app.register(commissionRoutes);
  app.register(wbrRoutes);
  app.register(presenceRoutes);
  app.register(notaCreditoRoutes);
  app.register(fieldSurveyRoutes);
  app.register(xrefRoutes);
  app.register(finderRoutes);
  app.register(processKpiRoutes);
  app.register(warehouseRoutes);
  app.register(portalAlertsRoutes);
  app.register(dailyBriefingRoutes);
  app.register(briefingPendingRoutes);
  app.register(briefingAiRoutes);
  app.register(stockCountRoutes);
  app.register(purchaseRoutes);

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
