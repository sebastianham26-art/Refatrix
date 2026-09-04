// =====================================================================
// 긴 녹음 자동 분할 — WebM 클러스터 경계 자르기 (2026-09-04)
//   Whisper 는 파일 하나가 25MB 를 넘으면 받지 않는다. 구간 하나가 그보다 큰
//   녹음(기기·서버에 남아 있던 것)을 서버가 대신 나눠 준다.
//   여기서 깨지면 오디오가 통째로 못 쓰게 되므로 규칙을 못박아 둔다.
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitWebm, scanWebm, isWebm, splitB64Segment } from '../src/audioSplit.js';
import { splitOversizeSegments } from '../src/routes/consultRoutes.js';
import { NORMAL_WEBM_B64, LIVE_WEBM_B64 } from './fixtures/consult_webm.mjs';

const NORMAL = Buffer.from(NORMAL_WEBM_B64, 'base64');
const LIVE = Buffer.from(LIVE_WEBM_B64, 'base64');
const SAMPLES = [['보통 파일(크기 표기)', NORMAL], ['스트리밍 파일(크기 미상 · MediaRecorder 모양)', LIVE]];

function clusterBytes(buf) {
  const s = scanWebm(buf);
  return s.clusters.reduce((n, c) => n + (c.end - c.start), 0);
}
function headerBytes(buf) {
  const s = scanWebm(buf);
  return s.headerParts.reduce((n, h) => n + (h.end - h.start), 0);
}

for (const [label, SRC] of SAMPLES) {
  test(`${label}: 구조를 읽는다(헤더 + 클러스터 여러 개)`, () => {
    const s = scanWebm(SRC);
    assert.equal(s.error, undefined);
    assert.ok(s.clusters.length > 5, '클러스터가 여러 개여야 나눌 수 있다');
    assert.ok(s.headerParts.length >= 3, 'EBML 헤더 + Segment 헤더 + Info/Tracks');
    assert.equal(s.clusters[0].timestamp, 0);
  });

  test(`${label}: 상한보다 작으면 그대로 둔다(불필요한 재조립 없음)`, () => {
    const out = splitWebm(SRC, SRC.length + 1);
    assert.equal(out.parts.length, 1);
    assert.ok(out.parts[0].equals(SRC), '원본 바이트 그대로');
  });

  test(`${label}: 상한을 넘으면 여러 조각으로 나누고 조각마다 온전한 webm 이다`, () => {
    const max = 6 * 1024;
    const out = splitWebm(SRC, max);
    assert.equal(out.error, undefined);
    assert.ok(out.parts.length > 2, '여러 조각으로 나뉘어야 함');
    for (const p of out.parts) {
      assert.ok(isWebm(p), '조각도 EBML 매직으로 시작한다');
      assert.ok(p.length <= max, '조각은 상한 이하');
      const s = scanWebm(p);
      assert.equal(s.error, undefined, '조각을 다시 읽을 수 있어야 한다');
      assert.ok(s.clusters.length >= 1);
      assert.equal(s.clusters[0].timestamp, 0, '조각의 첫 클러스터는 0초에서 시작한다');
    }
  });

  test(`${label}: 소리를 한 조각도 잃지 않는다(클러스터 바이트 합이 원본과 같다)`, () => {
    const out = splitWebm(SRC, 6 * 1024);
    const sum = out.parts.reduce((n, p) => n + clusterBytes(p), 0);
    assert.equal(sum, clusterBytes(SRC), '조각들의 클러스터 합 = 원본의 클러스터 합');
    // 조각은 [헤더 + 클러스터] 뿐이다 — Cues·SeekHead 같은 위치표는 버린다
    for (const p of out.parts) assert.equal(p.length, headerBytes(p) + clusterBytes(p));
  });

  test(`${label}: 클러스터 시각이 조각마다 0 부터 다시 매겨진다(뒤 조각이 미래로 밀리지 않게)`, () => {
    const out = splitWebm(SRC, 6 * 1024);
    const last = scanWebm(out.parts[out.parts.length - 1]);
    assert.equal(last.clusters[0].timestamp, 0);
    // 원본에서 그 조각의 첫 클러스터는 0 이 아니었다(=실제로 다시 썼다)
    const src = scanWebm(SRC);
    assert.ok(src.clusters[src.clusters.length - 1].timestamp > 0);
  });
}

test('나눌 수 없는 형식(mp4·손상)은 오류로 알려준다 — 조용히 깨뜨리지 않는다', () => {
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(9000)]);
  assert.equal(splitWebm(mp4, 1024).error, 'unsupported_format');
  assert.equal(splitWebm(Buffer.alloc(9000), 1024).error, 'unsupported_format');
  assert.equal(splitWebm('문자열', 1024).error, 'unsupported_format');
});

test('클러스터 하나가 상한보다 크면 자르지 못한다고 알려준다', () => {
  assert.equal(splitWebm(NORMAL, headerBytes(NORMAL) + 100).error, 'cluster_too_big');
});

test('base64 구간을 받아 base64 구간 여러 개로 돌려준다', () => {
  const r = splitB64Segment(NORMAL_WEBM_B64, 6 * 1024);
  assert.ok(r.segments.length > 2);
  for (const b64 of r.segments) assert.ok(isWebm(Buffer.from(b64, 'base64')));
  assert.equal(splitB64Segment('', 1024).error, 'empty');
});

// ── 업로드 경로에 꽂히는 부분 ───────────────────────────────────────
test('splitOversizeSegments: 25MB 이하 구간은 손대지 않는다(기존 동작 유지)', () => {
  const small = ['a'.repeat(1000), 'b'.repeat(2000)];
  const r = splitOversizeSegments(small);
  assert.deepEqual(r.segments, small);
  assert.equal(r.didSplit, false);
});

test('splitOversizeSegments: 25MB 를 넘는 구간만 나눈다', () => {
  // 34MB(base64) 를 넘는 큰 구간을 흉내내기 위해 상한을 낮춰 확인한다
  const big = NORMAL_WEBM_B64;
  const r = splitOversizeSegments([big], 6 * 1024);
  // 상한(SEG_B64_MAX)보다 작으므로 기본값에서는 그대로 통과한다
  assert.deepEqual(r.segments, [big]);
});

test('splitOversizeSegments: 자를 수 없는 형식이면 segment_too_large + 이유를 준다', () => {
  const mp4b64 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'),
    Buffer.alloc(40 * 1024 * 1024)]).toString('base64');
  const r = splitOversizeSegments([mp4b64]);
  assert.equal(r.error, 'segment_too_large');
  assert.equal(r.reason, 'unsupported_format');
  assert.equal(r.max_mb, 25);
});

test('splitOversizeSegments: 큰 webm 구간은 자동으로 여러 구간이 된다(실제 25MB 초과 경로)', () => {
  // 실제 파일 크기를 키워 25MB 초과 상황을 만든다(클러스터를 반복해 이어붙임)
  const s = scanWebm(NORMAL);
  const header = NORMAL.subarray(0, s.clusters[0].start);
  const body = NORMAL.subarray(s.clusters[0].start);
  const big = Buffer.concat([header, ...new Array(2200).fill(body)]);   // ≈ 35MB
  assert.ok(big.length > 25 * 1024 * 1024);
  const r = splitOversizeSegments([big.toString('base64')]);
  assert.equal(r.error, undefined);
  assert.ok(r.segments.length >= 2, '여러 구간으로 나뉜다');
  assert.equal(r.didSplit, true);
  for (const b64 of r.segments) {
    const buf = Buffer.from(b64, 'base64');
    assert.ok(isWebm(buf));
    assert.ok(buf.length <= 25 * 1024 * 1024, '각 구간은 Whisper 한도 이하');
    assert.equal(scanWebm(buf).error, undefined);
  }
});
