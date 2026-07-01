// =====================================================================
// Refatrix · perfMonitor (진단용, 2026-07-01)
//  서버가 "가끔 20초씩 멈추는" 원인을 잡기 위한 감시기. 부작용 없음 — 로그만 남긴다.
//   (1) 이벤트 루프 지연: 단일 스레드 Node 가 동기 작업으로 N ms 이상 막히면 경고.
//   (2) 느린 요청: 응답이 N ms 이상 걸린 요청의 method/path/시간/상태를 기록.
//  Railway → 서비스 → Deploy Logs 에서 아래 문구를 검색:
//    "loop_block"  → 루프가 막힌 순간과 시간(lag_ms)
//    "slow_req"    → 그 순간 느렸던 요청들(어느 화면/API 가 방아쇠인지 단서)
// =====================================================================
export function installPerfMonitor(app, opts = {}) {
  const LOOP_LAG_MS = opts.loopLagMs || 1000; // 루프가 이만큼 이상 막히면 경고
  const SLOW_REQ_MS = opts.slowReqMs || 2000; // 이만큼 이상 걸린 요청 기록
  const CHECK_MS = 500;

  // (1) 이벤트 루프 지연 감시 — 예상보다 늦게 돈 만큼이 곧 '막힌 시간'.
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const drift = now - last - CHECK_MS;
    last = now;
    if (drift >= LOOP_LAG_MS) {
      app.log.warn({ evt: 'loop_block', lag_ms: drift }, `event loop blocked ~${drift}ms`);
    }
  }, CHECK_MS);
  if (timer.unref) timer.unref();

  // (2) 느린 요청 기록.
  app.addHook('onRequest', (req, reply, done) => { req._t0 = process.hrtime.bigint(); done(); });
  app.addHook('onResponse', (req, reply, done) => {
    try {
      if (req._t0) {
        const ms = Number(process.hrtime.bigint() - req._t0) / 1e6;
        if (ms >= SLOW_REQ_MS) {
          app.log.warn(
            { evt: 'slow_req', ms: Math.round(ms), method: req.method, url: req.url, status: reply.statusCode },
            `slow_req ${req.method} ${req.url} ${Math.round(ms)}ms`);
        }
      }
    } catch (e) { /* 진단 로깅 실패는 무시 */ }
    done();
  });

  app.log.info('perfMonitor installed (loop_block / slow_req logging)');
}
