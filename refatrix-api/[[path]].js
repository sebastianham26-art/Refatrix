// Cloudflare Pages Function — /api/* 를 Railway 백엔드로 중계 (Telcel 모바일망 railway.app 차단 우회)
// 위치: repo 루트/functions/api/[[path]].js  → push 하면 refatrix.pages.dev/api/* 로 자동 배포
// 브라우저 → refatrix.pages.dev(Cloudflare) → Railway : 통신사는 pages.dev 만 보게 됨
const UPSTREAM = 'https://refatrix-production.up.railway.app';

export async function onRequest({ request }) {
  const url = new URL(request.url);
  const target = UPSTREAM + url.pathname + url.search;

  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.set('x-forwarded-host', url.host);

  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;

  try {
    const resp = await fetch(target, init);
    const out = new Response(resp.body, resp);
    out.headers.set('x-refatrix-proxy', 'pages');
    return out;
  } catch (e) {
    return new Response(JSON.stringify({ error: 'proxy_upstream_failed', detail: String(e) }), {
      status: 502, headers: { 'content-type': 'application/json' },
    });
  }
}
