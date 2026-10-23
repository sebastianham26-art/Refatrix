// 10-23 · R2 쓰기 서명(AWS SigV4) — botocore(S3SigV4Auth) 로 같은 요청을 서명한 값과 같아야 한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { r2Put, r2Config } from '../src/r2.js';

const ENV = { R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AKIDTEST', R2_SECRET_ACCESS_KEY: 'SECRETTEST/abc+123', R2_BUCKET: 'my-bucket' };
test('서명 = botocore 값 · 주소 · 공개 URL', async () => {
  let got;
  const r = await r2Put('products/K0001/K0001_1.webp', Buffer.from('hello kit image'), { contentType: 'image/webp', now: new Date('2026-10-23T16:30:00Z'), env: ENV,
    fetchImpl: async (u, o) => { got = { u, o }; return { ok: true, status: 200 }; } });
  assert.equal(got.o.headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDTEST/20261023/auto/s3/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=fb8a12c1b089f31014158df1ac3b3c169ffbc6dfb6ab240e2b7a62583c8e7485');
  assert.equal(got.u, 'https://acct123.r2.cloudflarestorage.com/my-bucket/products/K0001/K0001_1.webp');
  assert.equal(r.url, 'https://pub-d34920cb200c42ce91c5cbda135f16d6.r2.dev/products/K0001/K0001_1.webp');
});
test('설정 없음 · 실패 응답', async () => {
  assert.deepEqual(r2Config({}).missing, ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']);
  assert.equal((await r2Put('k', Buffer.from('x'), { env: {} })).error, 'r2_not_configured');
  const bad = await r2Put('k', Buffer.from('x'), { env: ENV, fetchImpl: async () => ({ ok: false, status: 403, text: async () => '<Error>AccessDenied</Error>' }) });
  assert.equal(bad.error, 'r2_put_failed'); assert.equal(bad.status, 403);
});
