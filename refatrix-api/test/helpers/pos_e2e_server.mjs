// e2e 전용 서버: 장착 위치 라우트(실 PG) + 제품 목록·상세 스텁. stub-auth 로 실행.
import Fastify from 'fastify';
import positionRoutes from '../../src/routes/positionRoutes.js';
const app = Fastify({ bodyLimit: 30 * 1024 * 1024 });
app.addHook('onRequest', async (req, reply) => {
  reply.header('Access-Control-Allow-Origin', '*'); reply.header('Access-Control-Allow-Headers', '*'); reply.header('Access-Control-Allow-Methods', '*');
  req.headers['x-test-user'] = '1:director';
});
app.options('/*', async (req, reply) => reply.code(204).send());
await app.register(positionRoutes);
const P = [['CQ0166L', 'HORQUILLA IZQ'], ['CQ0166R', 'HORQUILLA DER'], ['GY2109G', 'AMORTIGUADOR'], ['ZZ0001', 'SIN DATOS']];
app.get('/api/products', async () => ({ total: P.length, items: P.map(([code, name], i) => ({ id: i + 1, code, name, scode: '', app: 'KIA SPORTAGE 2011-2016', stock_qty: 5, active: true })) }));
app.get('/api/products/:id/drilldown', async () => ({}));
app.get('/api/*', async () => ({ items: [] }));
await app.listen({ port: Number(process.env.PORT || 18787), host: '127.0.0.1' });
console.log('ready');
