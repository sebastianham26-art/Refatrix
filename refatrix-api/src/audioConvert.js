// =====================================================================
// Refatrix ERP · audioConvert.js — 휴대폰 녹음 파일 → 전사용 오디오 변환 (2026-11-02)
//
//   왜 필요한가:
//     휴대폰 기본 녹음앱(삼성 음성녹음·아이폰 음성메모·통화녹음)은 m4a / mp3 / 3gp / amr
//     등으로 저장한다. 1시간 미팅이 m4a 로 30~60MB 라 Whisper 의 25MB 한도를 넘고,
//     mp4(m4a) 구조는 audioSplit.js(webm 전용)로 자를 수 없다. amr·3gp 는 Whisper 가
//     아예 받지 않는다.
//
//   그래서 서버의 ffmpeg 로 **어떤 형식이든** 16kHz 모노 Opus(ogg, 32kbps)로 바꾸면서
//   20분 단위로 나눈다. 1시간 ≈ 14MB → 구간당 ≈ 5MB. 사람 목소리 전사에는 충분한 음질.
//
//   ffmpeg 찾는 순서: FFMPEG_PATH 환경변수 → PATH 의 ffmpeg → (설치돼 있으면) ffmpeg-static.
//   Railway(Railpack)에서는 변수 RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg 로 설치한다.
//   ffmpeg 가 없어도 Whisper 가 받는 형식이고 24MB 이하인 파일은 그대로 전사된다.
// =====================================================================
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const CONVERT_SEG_SEC = 20 * 60;          // 구간 길이(초) — audioSplit 의 SPLIT_MAX_MS 와 같은 기준
export const CONVERT_BITRATE = '32k';
export const CONVERT_TIMEOUT_MS = Number(process.env.CONSULT_CONVERT_TIMEOUT_MS) || 15 * 60 * 1000;
export const PASS_MAX_BYTES = 24 * 1024 * 1024;  // ffmpeg 없이 그대로 보낼 수 있는 상한(Whisper 25MB)

// Whisper 가 직접 받는 확장자(공식 목록) — 이 밖의 형식(amr·3gp·aac·caf·opus…)은 변환 필수
const WHISPER_EXT = new Set(['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm', 'ogg', 'flac']);

// 업로드 허용 확장자(휴대폰·녹음기에서 흔한 것 + 영상 파일의 소리)
export const UPLOAD_EXT = ['m4a', 'mp3', 'mp4', 'wav', 'aac', 'amr', '3gp', '3ga', 'ogg', 'oga', 'opus',
  'webm', 'flac', 'caf', 'wma', 'mpga', 'mpeg', 'mov', 'qta', 'awb'];

const EXT_MIME = {
  m4a: 'audio/mp4', mp4: 'audio/mp4', mov: 'video/quicktime', qta: 'audio/mp4', mp3: 'audio/mpeg', mpga: 'audio/mpeg',
  mpeg: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac', amr: 'audio/amr', awb: 'audio/amr-wb', '3gp': 'audio/3gpp',
  '3ga': 'audio/3gpp', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', flac: 'audio/flac',
  caf: 'audio/x-caf', wma: 'audio/x-ms-wma',
};

export function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || '').trim());
  return m ? m[1].toLowerCase() : '';
}

// 파일명 정리 — 화면 표시용(경로·제어문자 제거, 120자)
export function cleanFileName(name) {
  const base = String(name == null ? '' : name).split(/[\\/]/).pop() || '';
  const t = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return t.length > 120 ? t.slice(0, 119) + '…' : t;
}

// 업로드 파일의 mime 결정: 확장자가 우선(휴대폰 브라우저는 type 을 비우거나 엉뚱하게 준다)
export function fileMimeOf(name, type) {
  const e = extOf(name);
  if (e && EXT_MIME[e]) return EXT_MIME[e];
  const t = String(type || '').split(';')[0].trim().toLowerCase();
  return /^(?:audio|video)\/[\w.+-]+$/.test(t) ? t : 'application/octet-stream';
}

export function isUploadAllowed(name, type) {
  const e = extOf(name);
  if (e) return UPLOAD_EXT.includes(e);
  return /^(?:audio|video)\//i.test(String(type || ''));
}

// ffmpeg 없이 Whisper 에 그대로 보낼 수 있는가
export function canPassThrough(name, mime, bytes) {
  if (!(Number(bytes) > 0) || Number(bytes) > PASS_MAX_BYTES) return false;
  const e = extOf(name);
  if (e) return WHISPER_EXT.has(e);
  return /^audio\/(?:mp4|m4a|x-m4a|mpeg|mp3|wav|x-wav|webm|ogg|flac)$/i.test(String(mime || ''));
}

// Whisper 에 보낼 때 쓰는 mime(파일 확장자 결정용) — transcribe() 의 확장자 규칙과 맞춘다
export function whisperMimeOf(name, mime) {
  const e = extOf(name);
  if (e === 'wav') return 'audio/wav';
  if (e === 'flac') return 'audio/flac';
  return mime || 'audio/mp4';
}

// ── ffmpeg 위치 찾기(10분 캐시) ──────────────────────────────────────
let ffCache = null;          // { bin, at }
function probe(bin) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const fin = (ok) => { if (!done) { done = true; if (timer) clearTimeout(timer); resolve(ok); } };
    try {
      const p = spawn(bin, ['-hide_banner', '-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('error', () => fin(false));
      p.on('close', (code) => fin(code === 0 && /ffmpeg version/i.test(out)));
      timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} fin(false); }, 8000);
    } catch (_) { fin(false); }
  });
}
export async function findFfmpeg(force = false) {
  if (!force && ffCache && Date.now() - ffCache.at < 10 * 60 * 1000) return ffCache.bin;
  const cands = [];
  if (process.env.FFMPEG_PATH) cands.push(process.env.FFMPEG_PATH);
  cands.push('ffmpeg');
  try {
    const mod = await import('ffmpeg-static');          // 선택 의존성 — 없으면 건너뜀
    const p = mod && (mod.default || mod);
    if (typeof p === 'string') cands.push(p);
  } catch (_) {}
  let bin = null;
  for (const c of cands) { if (await probe(c)) { bin = c; break; } }
  ffCache = { bin, at: Date.now() };
  return bin;
}
export function _resetFfmpegCache() { ffCache = null; }

// ffmpeg stderr 에서 길이(Duration: HH:MM:SS.xx) 읽기
export function parseDuration(stderr) {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(String(stderr || ''));
  if (!m) return null;
  const s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(s) && s > 0 ? Math.round(s) : null;
}

function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let err = '';
    let timedOut = false;
    let p;
    try { p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e) { resolve({ code: -1, stderr: String(e && e.message) }); return; }
    p.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-100000); });
    const timer = setTimeout(() => { timedOut = true; try { p.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stderr: err + String(e && e.message) }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr: err, timedOut }); });
  });
}

// ffmpeg 오류문에서 사람이 볼 한 줄만
function lastError(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = lines.reverse().find((l) => /invalid|error|not supported|no such|could not|unknown|does not contain/i.test(l));
  return (hit || lines[0] || 'ffmpeg').slice(0, 200);
}

// ── 변환: 아무 형식 → 16kHz 모노 Opus(ogg) 20분 구간들 ──────────────────
//   반환: { ok:true, segments:[Buffer], mime, durationSec, encoder } | { ok:false, error, transient }
export async function convertToSegments(buf, opts = {}) {
  const bin = opts.bin || await findFfmpeg();
  if (!bin) return { ok: false, error: 'ffmpeg_missing', transient: false };
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, error: 'convert: empty', transient: false };
  const segSec = Number(opts.segSec) || CONVERT_SEG_SEC;
  const timeoutMs = Number(opts.timeoutMs) || CONVERT_TIMEOUT_MS;
  const dir = await mkdtemp(path.join(tmpdir(), 'rfx-conv-'));
  try {
    const inPath = path.join(dir, 'in.bin');
    await writeFile(inPath, buf);
    // libopus 가 있으면 ogg/opus, 없으면 mp3 로(둘 다 Whisper 가 받는다)
    const plans = [
      { ext: 'ogg', mime: 'audio/ogg', encoder: 'libopus', codec: ['-c:a', 'libopus', '-b:a', CONVERT_BITRATE, '-application', 'voip'] },
      { ext: 'mp3', mime: 'audio/mpeg', encoder: 'libmp3lame', codec: ['-c:a', 'libmp3lame', '-b:a', CONVERT_BITRATE] },
    ];
    let lastErr = 'convert: failed';
    for (const pl of plans) {
      const pattern = path.join(dir, 'seg_%03d.' + pl.ext);
      const args = ['-hide_banner', '-nostdin', '-y', '-i', inPath, '-vn', '-sn', '-dn',
        '-ac', '1', '-ar', '16000', ...pl.codec,
        '-f', 'segment', '-segment_time', String(segSec), '-segment_format', pl.ext, '-reset_timestamps', '1',
        pattern];
      const r = await run(bin, args, timeoutMs);
      if (r.timedOut) return { ok: false, error: 'convert: timeout', transient: true };
      const files = (await readdir(dir)).filter((f) => f.startsWith('seg_') && f.endsWith('.' + pl.ext)).sort();
      if (r.code === 0 && files.length) {
        const segments = [];
        for (const f of files) {
          const b = await readFile(path.join(dir, f));
          if (b.length > 512) segments.push(b);          // 끝에 생기는 빈 꼬리 구간은 버린다
        }
        if (!segments.length) return { ok: false, error: 'convert: no_audio', transient: false };
        return { ok: true, segments, mime: pl.mime, durationSec: parseDuration(r.stderr), encoder: pl.encoder };
      }
      // 인코더가 없을 때만 다음 방식으로. 입력 자체가 깨졌으면 바로 실패.
      for (const f of files) await rm(path.join(dir, f), { force: true });
      lastErr = 'convert: ' + lastError(r.stderr);
      if (!/Unknown encoder|Encoder not found|encoder .* not found/i.test(r.stderr)) break;
    }
    return { ok: false, error: lastErr, transient: false };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
