#!/usr/bin/env node
// 카탈로그 조회 API (0221) — 기존 파일 2개에 필요한 줄만 끼워 넣는다.
//
//   왜 덮어쓰지 않는가: server.js 와 refatrix-nav.js 는 다른 작업(견적요청 수신 등)도
//   같은 파일을 고친다. 통째로 덮으면 그 기능이 조용히 사라진다. 그래서 **필요한 줄만** 넣는다.
//
//   실행:  레포 최상위(refatrix-api 폴더가 보이는 곳)에서
//            node apply_catalog_api.mjs
//   두 번 실행해도 안전하다(이미 들어 있으면 건너뛴다).
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';

const CHANGES = [];
const SKIPPED = [];
let failed = false;

function patch(file, steps) {
  if (!existsSync(file)) {
    console.error(`✗ ${file} 를 찾을 수 없다. 레포 최상위에서 실행했는지 확인할 것.`);
    failed = true;
    return;
  }
  let src = readFileSync(file, 'utf8');
  const before = src;
  for (const s of steps) {
    if (src.includes(s.marker)) { SKIPPED.push(`${file} · ${s.name}`); continue; }
    if (!s.anchor.test(src)) {
      console.error(`✗ ${file} · ${s.name} — 넣을 자리를 못 찾았다. 아래를 손으로 넣을 것:\n${s.manual}\n`);
      failed = true;
      continue;
    }
    src = src.replace(s.anchor, s.insert);
    CHANGES.push(`${file} · ${s.name}`);
  }
  if (src !== before) writeFileSync(file, src);
}

// ── ① 서버에 라우트 등록 ────────────────────────────────────────────
patch('refatrix-api/src/server.js', [
  {
    name: 'import catalogApiRoutes',
    marker: "from './routes/catalogApiRoutes.js'",
    anchor: /(import\s+crmInboundRoutes\s+from\s+'\.\/routes\/crmInboundRoutes\.js';)/,
    insert: `$1\nimport catalogApiRoutes from './routes/catalogApiRoutes.js';`,
    manual: "import catalogApiRoutes from './routes/catalogApiRoutes.js';",
  },
  {
    name: 'app.register(catalogApiRoutes)',
    marker: 'app.register(catalogApiRoutes)',
    anchor: /(app\.register\(crmInboundRoutes\);[^\n]*)/,
    insert: `$1\n  app.register(catalogApiRoutes);   // 고객 → ERP 조회(카탈로그 풀 API · 0221)`,
    manual: '  app.register(catalogApiRoutes);',
  },
]);

// ── ② 포털 메뉴 ─────────────────────────────────────────────────────
patch('refatrix-nav.js', [
  {
    name: '화면 등록(catalogApi)',
    marker: 'catalogApi:{file:',
    anchor: /(integrations:\{file:'refatrix-integrations\.html'[^\n]*\n)/,
    insert: `$1    catalogApi:{file:'refatrix-catalog-api.html',name:'카탈로그 조회 API',desc:'고객사가 우리 카탈로그를 가져가는 창구 — 키 발급·접속창·가격 확인'},\n`,
    manual: "    catalogApi:{file:'refatrix-catalog-api.html',name:'카탈로그 조회 API',desc:'…'},   ← SCREENS 목록 안",
  },
  {
    name: '권한(디렉터 전용)',
    marker: "catalogApi:'__director__'",
    anchor: /(integrations:'__director__',)/,
    insert: `$1 catalogApi:'__director__',`,
    manual: "PAGEKEY 에  catalogApi:'__director__',  추가",
  },
  {
    name: '관리 그룹에 추가',
    marker: "'integrations','catalogApi'",
    anchor: /('integrations','apikeys')/,
    insert: `'integrations','catalogApi','apikeys'`,
    manual: "관리 그룹 screens 배열의 'integrations' 뒤에 'catalogApi' 추가",
  },
]);

// ── ③ 메뉴 캐시 토큰 올리기 ─────────────────────────────────────────
//   화면들은 refatrix-nav.js?v=<토큰> 으로 메뉴를 불러온다. 토큰을 그대로 두면
//   브라우저가 **예전 메뉴를 계속 쓴다** — 나만 Ctrl+Shift+R 해서 보이고 직원들은 못 본다.
const NAV_TOKEN = '20260917catalog';
{
  const files = readdirSync('.').filter((f) => f.endsWith('.html'));
  let n = 0;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (!/refatrix-nav\.js\?v=/.test(src)) continue;
    const out = src.replace(/refatrix-nav\.js\?v=[^"'\s>]*/g, `refatrix-nav.js?v=${NAV_TOKEN}`);
    if (out !== src) { writeFileSync(f, out); n++; }
  }
  if (n) CHANGES.push(`*.html · 메뉴 캐시 토큰 → ${NAV_TOKEN} (${n}개 화면)`);
  else SKIPPED.push(`*.html · 메뉴 캐시 토큰 (이미 ${NAV_TOKEN})`);
}

// ── 결과 ────────────────────────────────────────────────────────────
console.log('');
if (CHANGES.length) {
  console.log('넣은 것:');
  for (const c of CHANGES) console.log('  + ' + c);
}
if (SKIPPED.length) {
  console.log('이미 들어 있어 건너뛴 것:');
  for (const c of SKIPPED) console.log('  = ' + c);
}
if (!CHANGES.length && !SKIPPED.length) console.log('아무것도 하지 않았다.');
console.log('');
if (failed) {
  console.error('일부는 자동으로 넣지 못했다. 위에 적힌 줄을 손으로 넣은 뒤 다시 실행해 확인할 것.');
  process.exit(1);
}
console.log('완료. 다음: npm run migrate (0221) → 프론트 배포 → Ctrl+Shift+R');
