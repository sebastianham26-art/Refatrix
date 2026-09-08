// 외부 서비스 API 키 보관소 — 키 1개 = service_secrets 의 1행.
//
//   지금까지 Anthropic·OpenAI·WhatsApp 키는 Railway 환경변수에만 있었다. 키가 바뀌면
//   콘솔에 들어가 값을 고치고 재배포해야 했고, 그 사이 AI 요약·전사·브리핑이 조용히 멎었다.
//   → 여기에 두면 디렉터가 화면에서 바꾸고, 재배포 없이 60초 안(저장 시 즉시)에 반영된다.
//
// ── 설계 3줄 ────────────────────────────────────────────────────────────────
//  1) **환경변수는 되돌아갈 자리로 남는다.** DB 행이 있으면 그 값이 이기고, 비면 기동 시점의
//     환경변수 값으로 되돌아간다. 마이그레이션 전에도 지금 동작이 그대로다.
//  2) **호출부는 하나도 고치지 않는다.** 로딩할 때 process.env 에 값을 심어 준다(hydrate).
//     기존 코드의 `process.env.ANTHROPIC_API_KEY` 가 그대로 새 값을 읽는다.
//  3) **비밀값은 암호화해서 넣는다.** AES-256-GCM · 열쇠는 환경변수 APP_SECRET_KEY 하나뿐이라
//     DB 백업이 유출돼도 키는 읽히지 않는다. 화면으로는 값이 절대 내려가지 않는다.
import crypto from 'node:crypto';
import { query } from './db.js';

// ── 등록부 ────────────────────────────────────────────────────────────────
//   uses 는 화면의 「어디에 쓰이나」 목록이다 — 키를 지웠을 때 무엇이 멎는지 미리 보여 준다.
export const SERVICES = [
  {
    key: 'anthropic',
    label: 'Anthropic (Claude)',
    desc: 'AI 요약·번역·초안 생성',
    console: 'https://console.anthropic.com/settings/keys',
    fields: [
      { name: 'ANTHROPIC_API_KEY', label: 'API 키', secret: true, required: true, hint: 'sk-ant- 로 시작하는 값' },
      { name: 'VISIT_AI_MODEL', label: '방문·상담 요약 모델', secret: false, hint: '비우면 claude-sonnet-4-5' },
      { name: 'WBR_DRAFT_MODEL', label: 'WBR 초안 모델', secret: false },
      { name: 'WBR_MBR_MODEL', label: 'MBR 요약 모델', secret: false },
      { name: 'DAILY_SUMMARY_MODEL', label: '일일요약 모델', secret: false },
      { name: 'AI_SCAN_MODEL', label: 'AI 스캔 모델', secret: false },
    ],
    uses: [
      '고객상담 — AI 요약 · 한국어 번역 · 기간 인사이트',
      '방문 녹음 — AI 요약 · 후속조치 자동 등록',
      'WBR 주간보고 초안 · MBR 월간 요약',
      '일일 요약(WhatsApp 발송본)',
      '아침 브리핑 AI · 전시회 분석',
    ],
  },
  {
    key: 'openai',
    label: 'OpenAI (Whisper)',
    desc: '녹음 음성 → 글자 전사',
    console: 'https://platform.openai.com/api-keys',
    fields: [
      { name: 'OPENAI_API_KEY', label: 'API 키', secret: true, required: true, hint: 'sk- 로 시작하는 값' },
      { name: 'VISIT_STT_MODEL', label: '전사 모델', secret: false, hint: '비우면 whisper-1' },
    ],
    uses: [
      '고객상담 미팅 녹음 전사',
      '방문 상담 녹음 전사',
    ],
  },
  {
    key: 'whatsapp',
    label: 'WhatsApp Business Cloud (Meta)',
    desc: '자동 발송(브리핑 · 일일요약 · 오퍼시트)',
    console: 'https://business.facebook.com/',
    fields: [
      { name: 'WHATSAPP_TOKEN', label: '영구 토큰', secret: true, required: true, hint: 'Meta 앱 → 시스템 사용자 영구 토큰' },
      { name: 'WHATSAPP_PHONE_ID', label: '발신 전화번호 ID', secret: false, required: true, hint: '숫자 ID(전화번호가 아님)' },
      { name: 'WHATSAPP_API_VERSION', label: 'Graph API 버전', secret: false, hint: '비우면 v20.0' },
      { name: 'WHATSAPP_TEMPLATE', label: '기본 템플릿명', secret: false, hint: '24시간 창 밖 폴백용(본문 {{1}} 1개)' },
      { name: 'WHATSAPP_TEMPLATE_LANG', label: '템플릿 언어', secret: false, hint: '비우면 es_MX' },
      { name: 'OFFERSHEET_WA_TEMPLATE', label: '오퍼시트 템플릿명', secret: false },
      { name: 'DAILY_SUMMARY_WA_TO', label: '일일요약 수신 번호', secret: false, hint: '521 + 10자리' },
    ],
    uses: [
      '영업사원 아침 브리핑 발송',
      '일일 요약 발송',
      '오퍼시트 고객 발송',
    ],
  },
];

export const FIELD_INDEX = new Map();
for (const s of SERVICES) for (const f of s.fields) FIELD_INDEX.set(f.name, { ...f, service: s.key });

// ── 기동 시점 환경변수 스냅샷 ───────────────────────────────────────────────
//   DB 값을 지우면 여기로 되돌아간다. hydrate 가 process.env 를 덮어쓰기 전에 떠 둔다.
const BOOT_ENV = {};
for (const name of FIELD_INDEX.keys()) {
  BOOT_ENV[name] = Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined;
}

// ── 암호화 ────────────────────────────────────────────────────────────────
const MASTER = String(process.env.APP_SECRET_KEY || '').trim();
let derived = null;
function keyBuf() {
  if (!MASTER) return null;
  if (!derived) derived = crypto.scryptSync(MASTER, 'refatrix.secrets.v1', 32);
  return derived;
}
export function masterKeyReady() { return !!MASTER; }

export function encryptValue(plain) {
  const k = keyBuf();
  if (!k) throw new Error('no_master_key');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

/** 저장값 → 평문. 못 풀면 null(열쇠가 바뀌었거나 값이 깨진 경우) — 던지지 않는다. */
export function decryptValue(stored) {
  const s = String(stored || '');
  if (!s) return null;
  if (s.startsWith('p1:')) return s.slice(3);
  if (!s.startsWith('v1:')) return null;
  const k = keyBuf();
  if (!k) return null;
  try {
    const raw = Buffer.from(s.slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', k, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch (_) { return null; }
}

/** 값이 무엇인지 짐작만 되게 — 앞 4 · 뒤 4 만. 짧으면 전부 가린다. */
export function maskValue(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 12) return '•'.repeat(Math.min(s.length, 8));
  return s.slice(0, 4) + '…' + s.slice(-4) + ' (' + s.length + '자)';
}

// ── 테이블 준비 여부 ───────────────────────────────────────────────────────
//   긍정만 영구 캐시. 서버가 뜬 뒤 `npm run migrate` 를 돌려도 30초 안에 알아챈다.
let tableReady = false;
let lastProbe = 0;
const PROBE_MS = 30000;
export async function secretsReady() {
  if (tableReady) return true;
  if (Date.now() - lastProbe < PROBE_MS) return false;
  lastProbe = Date.now();
  try {
    const r = await query(`SELECT to_regclass('public.service_secrets') AS t`);
    tableReady = !!(r.rows[0] && r.rows[0].t);
  } catch (_) { tableReady = false; }
  return tableReady;
}

// ── 로딩 · 하이드레이션 ────────────────────────────────────────────────────
//   상태: name → { source:'db'|'env'|'none', value, error?:'decrypt', updated_at, updated_by_name }
let STATE = new Map();
let lastLoad = 0;

export function secretState() { return STATE; }
export function lastLoadedAt() { return lastLoad ? new Date(lastLoad).toISOString() : null; }

/** DB 를 읽어 process.env 에 심는다. 실패해도 지금 동작을 깨지 않는다(환경변수 유지). */
export async function hydrateSecrets() {
  const next = new Map();
  let rows = [];
  if (await secretsReady()) {
    try {
      rows = (await query(
        `SELECT s.name, s.value_enc, s.is_secret, s.updated_at, u.name AS updated_by_name
           FROM service_secrets s LEFT JOIN users u ON u.id = s.updated_by`)).rows;
    } catch (_) { rows = []; }
  }
  const byName = new Map(rows.map((r) => [r.name, r]));

  for (const [name] of FIELD_INDEX) {
    const row = byName.get(name);
    const stored = row && row.value_enc ? String(row.value_enc) : '';
    if (stored) {
      const plain = decryptValue(stored);
      if (plain === null) {
        // 열쇠(APP_SECRET_KEY)가 없거나 바뀌었다 — 환경변수로 버틴다. 화면이 경고를 띄운다.
        next.set(name, { source: 'env', value: BOOT_ENV[name] || '', error: 'decrypt',
          updated_at: row.updated_at, updated_by_name: row.updated_by_name });
        restoreEnv(name);
        continue;
      }
      next.set(name, { source: 'db', value: plain, error: null,
        updated_at: row.updated_at, updated_by_name: row.updated_by_name });
      process.env[name] = plain;
      continue;
    }
    // DB 에 값이 없다 → 기동 시점 환경변수로 되돌린다.
    restoreEnv(name);
    const envVal = BOOT_ENV[name];
    next.set(name, { source: envVal ? 'env' : 'none', value: envVal || '', error: null,
      updated_at: row ? row.updated_at : null, updated_by_name: row ? row.updated_by_name : null });
  }
  STATE = next;
  lastLoad = Date.now();
  return STATE;
}

function restoreEnv(name) {
  const v = BOOT_ENV[name];
  if (v === undefined) delete process.env[name];
  else process.env[name] = v;
}

/** 60초마다 다시 읽는다 — 다른 인스턴스/콘솔에서 바뀐 값도 따라온다. */
export function startSecretRefresh(app, ms = 60000) {
  hydrateSecrets().then(() => {
    try { app && app.log && app.log.info('[secrets] hydrated'); } catch (_) {}
  }).catch(() => {});
  const t = setInterval(() => { hydrateSecrets().catch(() => {}); }, ms);
  if (t.unref) t.unref();
  return t;
}

// ── 화면용 상태 ────────────────────────────────────────────────────────────
export function publicServices() {
  return SERVICES.map((s) => ({
    key: s.key, label: s.label, desc: s.desc, console: s.console, uses: s.uses,
    ready: s.fields.filter((f) => f.required).every((f) => !!(STATE.get(f.name) || {}).value),
    fields: s.fields.map((f) => {
      const st = STATE.get(f.name) || { source: 'none', value: '' };
      return {
        name: f.name, label: f.label, secret: !!f.secret, required: !!f.required, hint: f.hint || null,
        source: st.source,                       // db(화면에서 넣음) | env(Railway) | none
        has_value: !!st.value,
        // 비밀값은 마스킹만, 설정값은 그대로 — 어느 쪽도 원본 비밀은 나가지 않는다.
        preview: f.secret ? maskValue(st.value) : String(st.value || ''),
        error: st.error || null,
        updated_at: st.updated_at || null,
        updated_by_name: st.updated_by_name || null,
      };
    }),
  }));
}

// ── 저장 ──────────────────────────────────────────────────────────────────
//   규칙(연동 관리 화면과 동일): 빈칸 = 그대로 둠 · '-' 한 글자 = 지움(환경변수로 복귀).
export const CLEAR_TOKEN = '-';

export async function saveSecrets(values, userId) {
  if (!(await secretsReady())) return { error: 'migration_required' };
  const patch = values && typeof values === 'object' ? values : {};
  const names = Object.keys(patch).filter((n) => FIELD_INDEX.has(n));
  if (!names.length) return { error: 'nothing_to_save' };

  const changed = [];
  for (const name of names) {
    const f = FIELD_INDEX.get(name);
    const raw = patch[name];
    if (raw === undefined || raw === null) continue;
    const v = String(raw).trim();
    if (v === '') continue;                                  // 빈칸 = 유지

    if (v === CLEAR_TOKEN) {                                 // 지우기
      await query(
        `INSERT INTO service_secrets (name, value_enc, is_secret, updated_at, updated_by)
         VALUES ($1, NULL, $2, now(), $3)
         ON CONFLICT (name) DO UPDATE SET value_enc=NULL, updated_at=now(), updated_by=EXCLUDED.updated_by`,
        [name, !!f.secret, userId || null]);
      await logChange(name, 'clear', userId);
      changed.push({ name, action: 'clear' });
      continue;
    }

    if (f.secret && !masterKeyReady()) return { error: 'no_master_key' };
    if (f.secret && v.length < 8) return { error: 'too_short', field: name };
    if (/[\r\n]/.test(v)) return { error: 'newline_in_value', field: name };

    const enc = f.secret ? encryptValue(v) : 'p1:' + v;
    await query(
      `INSERT INTO service_secrets (name, value_enc, is_secret, updated_at, updated_by)
       VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (name) DO UPDATE
         SET value_enc=EXCLUDED.value_enc, is_secret=EXCLUDED.is_secret,
             updated_at=now(), updated_by=EXCLUDED.updated_by`,
      [name, enc, !!f.secret, userId || null]);
    await logChange(name, 'set', userId);
    changed.push({ name, action: 'set' });
  }

  // 값이 하나도 바뀌지 않았으면 "저장했습니다" 라고 말하지 않는다(빈칸만 보낸 경우).
  if (!changed.length) return { error: 'nothing_to_save' };

  await hydrateSecrets();                                    // 저장 즉시 반영
  return { ok: true, changed };
}

async function logChange(name, action, userId) {
  try {
    await query(
      `INSERT INTO service_secret_changes (name, action, changed_by) VALUES ($1,$2,$3)`,
      [name, action, userId || null]);
  } catch (_) { /* 이력 실패가 저장을 깨지 않는다 */ }
}

export async function listChanges(limit = 40) {
  if (!(await secretsReady())) return [];
  try {
    return (await query(
      `SELECT c.name, c.action, c.changed_at, u.name AS changed_by_name
         FROM service_secret_changes c LEFT JOIN users u ON u.id = c.changed_by
        ORDER BY c.changed_at DESC LIMIT $1`, [Math.min(Number(limit) || 40, 200)])).rows;
  } catch (_) { return []; }
}

// ── 연결 테스트 ────────────────────────────────────────────────────────────
//   저장된 값 **그대로** 쏜다 — 테스트를 통과한 값이 곧 실제 호출에 쓰이는 값이다.
//   응답에 키는 절대 싣지 않는다.
async function fetchWithTimeout(url, opts, ms = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

export async function testService(key) {
  const val = (n) => String((STATE.get(n) || {}).value || '');
  try {
    if (key === 'anthropic') {
      const k = val('ANTHROPIC_API_KEY');
      if (!k) return { ok: false, reason: 'no_key', note: 'API 키가 설정돼 있지 않습니다.' };
      const r = await fetchWithTimeout('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' },
      });
      const body = await r.text();
      return { ok: r.ok, status: r.status, note: r.ok ? '키가 유효합니다.' : httpNote(r.status), body: clip(body) };
    }
    if (key === 'openai') {
      const k = val('OPENAI_API_KEY');
      if (!k) return { ok: false, reason: 'no_key', note: 'API 키가 설정돼 있지 않습니다.' };
      const r = await fetchWithTimeout('https://api.openai.com/v1/models', {
        headers: { authorization: 'Bearer ' + k },
      });
      const body = await r.text();
      return { ok: r.ok, status: r.status, note: r.ok ? '키가 유효합니다.' : httpNote(r.status), body: clip(body) };
    }
    if (key === 'whatsapp') {
      const tok = val('WHATSAPP_TOKEN');
      const pid = val('WHATSAPP_PHONE_ID');
      if (!tok || !pid) return { ok: false, reason: 'no_key', note: '토큰과 전화번호 ID 가 둘 다 필요합니다.' };
      const ver = val('WHATSAPP_API_VERSION') || 'v20.0';
      const r = await fetchWithTimeout(
        `https://graph.facebook.com/${ver}/${encodeURIComponent(pid)}?fields=display_phone_number,verified_name,quality_rating`,
        { headers: { authorization: 'Bearer ' + tok } });
      const body = await r.text();
      return { ok: r.ok, status: r.status, note: r.ok ? '토큰·전화번호 ID 가 유효합니다.' : httpNote(r.status), body: clip(body) };
    }
    return { ok: false, reason: 'unknown_service' };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    return { ok: false, reason: aborted ? 'timeout' : 'network',
      note: aborted ? '응답이 12초 안에 오지 않았습니다.' : '연결하지 못했습니다: ' + String(e.message || e) };
  }
}

function httpNote(status) {
  if (status === 401) return '키가 거부됐습니다(401) — 값이 틀렸거나 폐기된 키입니다.';
  if (status === 403) return '권한이 없습니다(403) — 키는 살아 있으나 이 작업 권한이 없습니다.';
  if (status === 404) return '대상을 찾지 못했습니다(404) — 전화번호 ID 를 확인하세요.';
  if (status === 429) return '호출 한도 초과(429) — 키는 유효합니다.';
  return '실패(' + status + ')';
}
function clip(s) { const t = String(s || ''); return t.length > 1200 ? t.slice(0, 1200) + '…' : t; }
