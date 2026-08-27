// 운영 파일에서 존 표시 블록(zoneList/zoneBigHtml/zoneChip)을 그대로 추출해 실행한다(복붙 아님).
import fs from 'fs';

const html = fs.readFileSync('/home/claude/repo/refatrix-inbound.html', 'utf8');
const a = html.indexOf('  function zoneNo(i){');
const b = html.indexOf("  $('langToggle').textContent", a);
if (a < 0 || b < 0) throw new Error('블록을 찾지 못함');
const src = html.slice(a, b);

const ctx = {
  L: (ko) => ko,
  esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
};
const f = new Function('L', 'esc', src + '\n; return {zoneList, zoneBigHtml, zoneChip, zoneNo};')(ctx.L, ctx.esc);

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n + (e ? ' — ' + e : '')); } };
const count = (s, re) => (s.match(re) || []).length;

// ── ① 존 없음
{
  const h = f.zoneBigHtml({ zones: [] });
  t('존 없음: 빨간 배너', h.includes('zbig none') && h.includes('존 미지정'));
  t('존 없음: 칩은 ?', f.zoneChip({ zones: [] }).includes('>?<'));
}

// ── ② 존 1개 — 기존 화면 그대로
{
  const i = { zone: 2, zone_name: 'A동 뒤', zones: [{ zone: 2, name: 'A동 뒤' }] };
  const h = f.zoneBigHtml(i);
  t('존 1개: 배너 1개', count(h, /class="zbig/g) === 1, h);
  t('존 1개: 색 클래스 z2', h.includes('zbig z2'));
  t('존 1개: 이름 표시', h.includes('존 2 · A동 뒤'));
  t('존 1개: "여러 존" 안내 없음', !h.includes('zmulti'));
  t('존 1개: 기존 문구 유지', h.includes('이 박스를 옮길 곳'));
  t('존 1개: 칩 1개', count(f.zoneChip(i), /zchip2/g) === 1);
}

// ── ③ 존 2개 — 전부 보여준다(디렉터 결정)
{
  const i = { zone: 1, zone_name: 'A동 앞', zones: [{ zone: 1, name: 'A동 앞' }, { zone: 2, name: 'A동 뒤' }] };
  const h = f.zoneBigHtml(i);
  t('존 2개: 배너 2개', count(h, /class="zbig/g) === 2, h);
  t('존 2개: 색 z1·z2 각각', h.includes('zbig z1') && h.includes('zbig z2'));
  t('존 2개: 이름 둘 다', h.includes('A동 앞') && h.includes('A동 뒤'));
  t('존 2개: 확인 안내', h.includes('zmulti') && h.includes('2개 존에 걸쳐'));
  t('존 2개: 머리말이 "여러 존"', h.includes('옮길 곳 (여러 존)') && !h.includes('이 박스를 옮길 곳'));
  t('존 2개: 칩 2개', count(f.zoneChip(i), /zchip2/g) === 2);
}

// ── ④ 존 3개
{
  const i = { zones: [{ zone: 2, name: 'A동 뒤' }, { zone: 3, name: 'B동' }, { zone: 4, name: '2층' }] };
  const h = f.zoneBigHtml(i);
  t('존 3개: 배너 3개', count(h, /class="zbig/g) === 3);
  t('존 3개: 안내에 개수', h.includes('3개 존에 걸쳐'));
}

// ── ⑤ 구버전 응답(zones 없음) 하위호환
{
  const i = { zone: 3, zone_name: 'B동' };
  t('zones 없어도 zone 으로 동작', f.zoneList(i).length === 1 && f.zoneList(i)[0].zone === 3);
  t('구버전: 배너 1개', count(f.zoneBigHtml(i), /class="zbig/g) === 1);
  t('구버전: 칩 1개', count(f.zoneChip(i), /zchip2/g) === 1);
}

// ── ⑥ 신규 SKU 기본 존 표기 유지
{
  const i = { zone: 1, zone_name: '기본', zones: [{ zone: 1, name: '기본' }], zone_is_default: true };
  t('신규 기본 존 문구', f.zoneBigHtml(i).includes('신규 SKU 기본 존'));
}

// ── ⑦ 존 이름 XSS
{
  const i = { zones: [{ zone: 1, name: '<img src=x onerror=1>' }] };
  const h = f.zoneBigHtml(i);
  t('존 이름 이스케이프', !h.includes('<img') && h.includes('&lt;img'), h.slice(0, 200));
}

// ── ⑧ 빈 배열/누락 방어
{
  t('undefined 안전', f.zoneList(undefined).length === 0);
  t('zones 빈 배열 + zone null', f.zoneList({ zones: [], zone: null }).length === 0);
}

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
