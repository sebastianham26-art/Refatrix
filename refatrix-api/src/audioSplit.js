// =====================================================================
// Refatrix ERP · audioSplit.js — 긴 녹음(WebM/Matroska)을 여러 개의 온전한
// 파일로 자르는 순수 함수. 네트워크·DB 접근 없음.
//
//   왜 필요한가: Whisper 는 **파일 하나가 25MB** 를 넘으면 받지 않는다.
//   화면은 녹음 중에 구간을 나눠 담지만(2026-09-04c), 그 전에 녹음됐거나
//   기기에 남아 있던 긴 녹음은 **구간 하나가 통째로 25MB 이상**일 수 있다.
//   바이트로 그냥 자르면 EBML 헤더가 없는 쓰레기가 되므로, 여기서
//   **클러스터 경계**로 잘라 각 조각을 그 자체로 재생 가능한 webm 으로 만든다.
//
//   만드는 방법:
//     조각 = [EBML 헤더 + Segment 헤더 + Info + Tracks] + [클러스터 여러 개]
//     · Segment 크기는 '알 수 없음'으로 다시 쓴다(원본 크기를 그대로 두면 거짓말이 된다)
//     · SeekHead/Cues 는 원본 파일 위치를 가리키므로 버린다
//     · 각 조각의 첫 클러스터 시각이 0 이 되도록 클러스터 타임스탬프를 다시 쓴다
//       (같은 자리에 같은 바이트 수로 쓰므로 크기는 변하지 않는다)
//
//   mp4(아이폰 사파리 폴백)는 구조가 달라 여기서 자르지 않는다 — 호출부가
//   'unsupported_format' 을 받아 사용자에게 그대로 알린다.
// =====================================================================

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_SEEKHEAD = 0x114d9b74;
const ID_INFO = 0x1549a966;
const ID_TRACKS = 0x1654ae6b;
const ID_CLUSTER = 0x1f43b675;
const ID_CUES = 0x1c53bb6b;
const ID_TIMESTAMP = 0xe7;              // 클러스터의 첫 자식(Timecode/Timestamp)
const ID_DURATION = 0x4489;             // Info 안의 Duration(부동소수)
const ID_VOID = 0xec;

// 조각 하나의 목표 상한(바이트). Whisper 25MB 한도에 여유를 둔다.
export const SPLIT_MAX_BYTES = 18 * 1024 * 1024;

export function isWebm(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4
    && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
}

// ── EBML 가변길이 정수 ────────────────────────────────────────────────
function vintLen(first) {
  for (let i = 0; i < 8; i++) if (first & (0x80 >> i)) return i + 1;
  return 0;                              // 0x00 = 잘못된 값
}
// 요소 ID: 마커 비트를 포함한 원래 바이트를 그대로 숫자로 읽는다
function readId(buf, pos) {
  if (pos >= buf.length) return null;
  const len = vintLen(buf[pos]);
  if (!len || len > 4 || pos + len > buf.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = (id * 256) + buf[pos + i];
  return { id, len };
}
// 요소 크기: 마커 비트를 뺀 값. 값 비트가 전부 1이면 '알 수 없음'.
function readSize(buf, pos) {
  if (pos >= buf.length) return null;
  const len = vintLen(buf[pos]);
  if (!len || pos + len > buf.length) return null;
  let value = buf[pos] & (0xff >> len);
  let allOnes = value === (0xff >> len);
  for (let i = 1; i < len; i++) {
    value = (value * 256) + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { size: allOnes ? null : value, len, unknown: allOnes };
}
// 같은 자리·같은 폭으로 '알 수 없는 크기'를 다시 쓴다
function writeUnknownSize(buf, pos) {
  const len = vintLen(buf[pos]);
  if (!len) return;
  buf[pos] = (0x80 >> (len - 1)) | (0xff >> len);
  for (let i = 1; i < len; i++) buf[pos + i] = 0xff;
}

// 클러스터 시작인지 확인 — ID 뒤에 크기가 오고 그 다음이 Timestamp(0xE7) 여야 한다.
// (오디오 데이터 안에서 우연히 같은 4바이트가 나오는 것을 걸러낸다)
function looksLikeCluster(buf, pos) {
  const id = readId(buf, pos);
  if (!id || id.id !== ID_CLUSTER) return false;
  const sz = readSize(buf, pos + id.len);
  if (!sz) return false;
  return buf[pos + id.len + sz.len] === ID_TIMESTAMP;
}
function findNextCluster(buf, from) {
  for (let i = from; i + 8 < buf.length; i++) {
    if (buf[i] === 0x1f && buf[i + 1] === 0x43 && buf[i + 2] === 0xb6 && buf[i + 3] === 0x75
        && looksLikeCluster(buf, i)) return i;
  }
  return buf.length;
}

// Info 안의 Duration(4/8바이트 부동소수) 위치를 찾는다 — 조각마다 다시 써 준다.
// 못 찾으면 null(그대로 두어도 소리는 정상, 표시상의 길이만 원본 값으로 남는다).
function findDuration(buf, from, to) {
  let pos = from;
  while (pos < to) {
    const el = readId(buf, pos);
    if (!el) return null;
    const sz = readSize(buf, pos + el.len);
    if (!sz || sz.size == null) return null;
    const payload = pos + el.len + sz.len;
    if (el.id === ID_DURATION && (sz.size === 4 || sz.size === 8)) return { pos: payload, len: sz.size };
    pos = payload + sz.size;
  }
  return null;
}

// ── webm 구조 훑기 ───────────────────────────────────────────────────
//   { headerParts:[{start,end}], clusters:[{start,end,timestamp,tsPos,tsLen}] }
export function scanWebm(buf) {
  if (!isWebm(buf)) return { error: 'unsupported_format' };
  const ebml = readId(buf, 0);
  const ebmlSize = ebml && readSize(buf, ebml.len);
  if (!ebml || !ebmlSize || ebmlSize.size == null) return { error: 'bad_ebml' };
  const headerParts = [{ start: 0, end: ebml.len + ebmlSize.len + ebmlSize.size }];

  let pos = headerParts[0].end;
  const seg = readId(buf, pos);
  if (!seg || seg.id !== ID_SEGMENT) return { error: 'no_segment' };
  const segSize = readSize(buf, pos + seg.len);
  if (!segSize) return { error: 'bad_segment' };
  // Segment 헤더(ID+크기)까지가 조각마다 필요한 앞부분
  headerParts.push({ start: pos, end: pos + seg.len + segSize.len, segSizePos: pos + seg.len });
  pos += seg.len + segSize.len;

  const clusters = [];
  while (pos < buf.length) {
    const el = readId(buf, pos);
    if (!el) break;
    const sz = readSize(buf, pos + el.len);
    if (!sz) break;
    const payload = pos + el.len + sz.len;
    let end;
    if (sz.size == null) {
      end = el.id === ID_CLUSTER ? findNextCluster(buf, payload) : buf.length;
    } else {
      end = Math.min(buf.length, payload + sz.size);
    }
    if (el.id === ID_CLUSTER) {
      // 첫 자식이 Timestamp 면 조각마다 0 부터 시작하도록 다시 쓸 수 있다
      let timestamp = null, tsPos = -1, tsLen = 0;
      if (buf[payload] === ID_TIMESTAMP) {
        const tsz = readSize(buf, payload + 1);
        if (tsz && tsz.size != null && tsz.size <= 8) {
          tsPos = payload + 1 + tsz.len; tsLen = tsz.size;
          timestamp = 0;
          for (let i = 0; i < tsLen; i++) timestamp = (timestamp * 256) + buf[tsPos + i];
        }
      }
      clusters.push({ start: pos, end, timestamp, tsPos, tsLen });
    } else if (!clusters.length && el.id !== ID_SEEKHEAD && el.id !== ID_CUES && el.id !== ID_VOID) {
      // 클러스터 앞에 오는 Info·Tracks 는 조각마다 그대로 붙인다.
      // SeekHead·Cues 는 원본 파일 위치를 가리키므로 버린다.
      const part = { start: pos, end };
      if (el.id === ID_INFO) {
        const d = findDuration(buf, payload, end);
        if (d) { part.durPos = d.pos; part.durLen = d.len; }
      }
      headerParts.push(part);
    }
    if (end <= pos) break;              // 진행이 없으면(손상) 중단
    pos = end;
  }
  if (!clusters.length) return { error: 'no_clusters' };
  return { headerParts, clusters };
}

// ── 자르기 ───────────────────────────────────────────────────────────
//   maxBytes 이하가 되도록 클러스터 경계에서 자른다.
//   자를 필요가 없으면 [원본] 하나를 그대로 돌려준다.
//   { parts:[Buffer] } | { error:'unsupported_format'|'cluster_too_big'|… }
export function splitWebm(buf, maxBytes = SPLIT_MAX_BYTES) {
  if (!Buffer.isBuffer(buf)) return { error: 'unsupported_format' };
  if (buf.length <= maxBytes) return { parts: [buf] };
  const scan = scanWebm(buf);
  if (scan.error) return { error: scan.error };

  const header = Buffer.concat(scan.headerParts.map((h) => buf.subarray(h.start, h.end)));
  // 조각의 Segment 크기는 '알 수 없음'으로 — 원본 크기를 그대로 두면 거짓이 된다
  let off = 0;
  for (const h of scan.headerParts) {
    if (h.segSizePos != null) writeUnknownSize(header, off + (h.segSizePos - h.start));
    off += h.end - h.start;
  }
  const room = maxBytes - header.length;
  if (room <= 0) return { error: 'header_too_big' };

  const groups = [];
  let cur = [];
  let curBytes = 0;
  for (const cl of scan.clusters) {
    const size = cl.end - cl.start;
    if (size > room) return { error: 'cluster_too_big' };
    if (curBytes + size > room && cur.length) { groups.push(cur); cur = []; curBytes = 0; }
    cur.push(cl); curBytes += size;
  }
  if (cur.length) groups.push(cur);

  // Duration 위치(합쳐 만든 header 기준)
  let durAt = -1, durLen = 0, off2 = 0;
  for (const h of scan.headerParts) {
    if (h.durPos != null) { durAt = off2 + (h.durPos - h.start); durLen = h.durLen; }
    off2 += h.end - h.start;
  }
  // 마지막 조각의 길이 어림값 — 클러스터 평균 간격을 꼬리로 더한다
  const first = scan.clusters[0].timestamp || 0;
  const last = scan.clusters[scan.clusters.length - 1].timestamp || 0;
  const tail = scan.clusters.length > 1 ? (last - first) / (scan.clusters.length - 1) : 0;

  const parts = groups.map((group, gi) => {
    const base = group[0].timestamp || 0;
    const next = groups[gi + 1];
    const partDur = next ? ((next[0].timestamp || 0) - base)
                         : Math.max(0, (group[group.length - 1].timestamp || 0) - base + tail);
    const chunks = group.map((cl) => {
      const copy = Buffer.from(buf.subarray(cl.start, cl.end));   // 원본은 건드리지 않는다
      if (base && cl.timestamp != null && cl.tsPos >= 0) {
        // 조각의 첫 클러스터가 0 이 되도록 같은 폭으로 다시 쓴다
        let v = Math.max(0, cl.timestamp - base);
        const at = cl.tsPos - cl.start;
        for (let i = cl.tsLen - 1; i >= 0; i--) { copy[at + i] = v % 256; v = Math.floor(v / 256); }
      }
      return copy;
    });
    let head = header;
    if (durAt >= 0 && partDur > 0) {
      head = Buffer.from(header);       // 조각마다 자기 길이를 적는다(원본 길이를 물려주지 않게)
      if (durLen === 4) head.writeFloatBE(partDur, durAt); else head.writeDoubleBE(partDur, durAt);
    }
    return Buffer.concat([head, ...chunks]);
  });
  return { parts };
}

// base64 구간 하나를 받아, 25MB 한도를 넘으면 여러 base64 구간으로 나눈다.
//   { segments:[b64] } | { error }
export function splitB64Segment(b64, maxBytes = SPLIT_MAX_BYTES) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  if (!buf.length) return { error: 'empty' };
  const out = splitWebm(buf, maxBytes);
  if (out.error) return { error: out.error };
  return { segments: out.parts.map((p) => p.toString('base64')) };
}
