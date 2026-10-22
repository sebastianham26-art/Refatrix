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
// 0293 · 키트 행(구성품 하위 줄) 확인용
const C = (id, code, name, kq, st, bo, lp, rack, inc) => ({ id, code, name, kit_qty: kq, stock_qty: st, backorder_qty: bo, list_price: lp, rack_location: rack, incoming_qty: inc || 0, incoming_eta: inc ? '2026-11-05' : null, is_active: true,
  rack_stock: rack ? [{ rack, qty: Math.max(0, st - 1), kind: 'fast' }] : [] });
const KIT = { id: 50, code: 'K0001', name: 'KIT T SPORTAGE 2016-2022_CE0342L_CE0342R_CR0297x2', scode: '', app: 'KIA Sportage 2016-2022', stock_qty: 0, is_active: true, list_price: 2918,
  kit: { promo_no: 'K0001', buildable: 3, items: [C(11, 'CE0342L', 'TERMINAL EXTERIOR IZQ', 1, 35, 0, 623, 'B-12'), C(12, 'CE0342R', 'TERMINAL EXTERIOR DER', 1, 3, 20, 623, 'B-13', 40), C(13, 'CR0297', 'TERMINAL INTERIOR', 2, 32, 0, 336, null)] } };
app.get('/api/products', async (req) => /^K/i.test(String(req.query.q || '')) ? { total: 1, items: [KIT] }
  : ({ total: P.length, items: P.map(([code, name], i) => ({ id: i + 1, code, name, scode: '', app: 'KIA SPORTAGE 2011-2016', stock_qty: 5, active: true, list_price: [1333, 1333, 875.5, null][i] })) }));
app.get('/api/products/:id/drilldown', async () => ({}));
app.get('/api/*', async () => ({ items: [] }));
await app.listen({ port: Number(process.env.PORT || 18787), host: '127.0.0.1' });
console.log('ready');
