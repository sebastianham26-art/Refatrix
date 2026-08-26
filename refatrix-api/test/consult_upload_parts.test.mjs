// =====================================================================
// 녹음 분할 업로드 — 조각 조립 규칙 (2026-08-26)
//   큰 녹음을 3MB 조각으로 잘라 보내고 서버가 원래 base64 로 되돌린다.
//   여기서 깨지면 오디오가 통째로 망가지므로 규칙을 단단히 못박아 둔다.
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assembleUploadParts } from '../src/routes/consultRoutes.js';

const CHUNK = 3 * 1024 * 1024;   // 프런트(refatrix-consult.html)의 CS_CHUNK 와 같은 값

function chunkB64(buf, size) {
  const out = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, Math.min(buf.length, i + size)).toString('base64'));
  return out;
}
const rows = (segs) => segs.flatMap((parts, seg_no) => parts.map((b64, part_no) => ({ seg_no, part_no, b64 })));

// ── 핵심 불변식 ─────────────────────────────────────────────────────
test('3바이트 배수로 자르면 조각 base64 를 이어붙여도 원본과 완전히 같다', () => {
  assert.equal(CHUNK % 3, 0, 'CS_CHUNK 는 반드시 3의 배수여야 한다');
  for (const size of [1, 2, 3, 1000, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK * 2 + 7]) {
    const buf = randomBytes(Math.min(size, 7 * 1024 * 1024));
    assert.equal(chunkB64(buf, CHUNK).join(''), buf.toString('base64'), 'size=' + size);
  }
});

test('3의 배수가 아닌 크기로 자르면 깨진다 — 조각 크기를 함부로 바꾸면 안 되는 이유', () => {
  const buf = randomBytes(50000);
  assert.notEqual(chunkB64(buf, 1000 + 1).join(''), buf.toString('base64'));
});

test('조립 결과가 원본 base64 와 바이트 단위로 같다(디코딩 검증)', () => {
  const buf = randomBytes(4 * 1024 * 1024 + 11);
  const out = assembleUploadParts(rows([chunkB64(buf, CHUNK)]));
  assert.equal(out.error, undefined);
  assert.equal(out.joined, buf.toString('base64'));
  assert.ok(Buffer.from(out.joined, 'base64').equals(buf), '디코딩하면 원본 바이트와 동일');
  assert.equal(out.segments, 1);
  assert.equal(out.totalB64, buf.toString('base64').length);
});

// ── 여러 구간(끊겼다 이어 녹음한 경우) ───────────────────────────────
test('구간이 여러 개면 구간끼리는 | 로 잇고 조각끼리는 그냥 잇는다', () => {
  const a = randomBytes(1000), b = randomBytes(2000);
  const out = assembleUploadParts(rows([chunkB64(a, 300), chunkB64(b, 600)]));
  assert.equal(out.segments, 2);
  const [ba, bb] = out.joined.split('|');
  assert.equal(ba, a.toString('base64'));
  assert.equal(bb, b.toString('base64'));
  assert.equal(out.totalB64, ba.length + bb.length, '| 구분자는 용량 계산에서 뺀다');
});

test('구간·조각 번호가 뒤섞여 도착해도 순서대로 조립한다(재시도·병렬 대비)', () => {
  const buf = randomBytes(9000);
  const parts = chunkB64(buf, 300);
  const shuffled = rows([parts]).slice().reverse();
  assert.equal(assembleUploadParts(shuffled).joined, buf.toString('base64'));
});

// ── 깨진 입력은 조립하지 않는다 ─────────────────────────────────────
test('조각이 하나라도 빠지면 조립하지 않고 parts_gap 을 낸다', () => {
  const parts = chunkB64(randomBytes(9000), 300);
  const r = rows([parts]).filter((x) => x.part_no !== 5);
  const out = assembleUploadParts(r);
  assert.equal(out.error, 'parts_gap');
  assert.equal(out.joined, undefined, '깨진 오디오를 만들지 않는다');
});

test('기대한 조각 수와 다르면 parts_missing 을 낸다', () => {
  const parts = chunkB64(randomBytes(9000), 300);
  const all = rows([parts]);
  const out = assembleUploadParts(all.slice(0, -1), [{ parts: parts.length }]);
  assert.equal(out.error, 'parts_missing');
  assert.equal(out.have, parts.length - 1);
  assert.equal(out.want, parts.length);
});

test('기대한 구간 수와 다르면 parts_missing 을 낸다', () => {
  const out = assembleUploadParts(rows([['AAAA']]), [{ parts: 1 }, { parts: 1 }]);
  assert.equal(out.error, 'parts_missing');
  assert.equal(out.have, 1);
  assert.equal(out.want, 2);
});

test('조각이 하나도 없으면 no_parts', () => {
  assert.equal(assembleUploadParts([]).error, 'no_parts');
  assert.equal(assembleUploadParts(null).error, 'no_parts');
});

test('기대치를 안 주면(구버전 클라이언트) 있는 것만으로 조립한다', () => {
  const buf = randomBytes(3000);
  const out = assembleUploadParts(rows([chunkB64(buf, 300)]), null);
  assert.equal(out.error, undefined);
  assert.equal(out.joined, buf.toString('base64'));
});

test('한 시간짜리 미팅(≈19MB base64)도 조각 5개로 정확히 복원된다', () => {
  // 32kbps 로 1시간 ≈ 14.4MB 바이너리 ≈ 19.2MB base64
  const buf = randomBytes(14 * 1024 * 1024 + 1234);
  const parts = chunkB64(buf, CHUNK);
  assert.equal(parts.length, 5);
  const out = assembleUploadParts(rows([parts]), [{ parts: parts.length }]);
  assert.ok(Buffer.from(out.joined, 'base64').equals(buf));
});
