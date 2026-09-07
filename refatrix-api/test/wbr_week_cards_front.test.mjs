// =====================================================================
// refatrix-wbr.html 상단 카드 — 주간(월~금) 실적 표기 (jsdom)
//   · summary 호출에 이번주 월~금 from/to 가 실린다
//   · 카드 문구가 「이번주(월~금 …) 실적 / 목표는 월 기준」으로 바뀐다
//   · 전월 대비 → 전주 대비
//   · NC 가 섞이면 현금/NC 로 나눠 보인다
//   · 여러 팀 합산에서도 전주 대비가 계산된다
//   실행: node --test test/wbr_week_cards_front.test.mjs
// =====================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../../refatrix-wbr.html', import.meta.url), 'utf8');

let dom, win, fetchLog;

// 서버 응답(주간 모드)
const WEEK_SUMMARY = {
  yms: ['2026-09'], multi: false, carry: true, teams: [{ id: 1, name: '01_Monterrey' }], selectedTeam: '1',
  period: { from: '2026-08-31', to: '2026-09-04', days: 5, prev_from: '2026-08-24', prev_to: '2026-08-28', basis: 'week' },
  sales: { actual: 1500, target: 20000, progress: 7.5, prevActual: 1000, momPct: 50, locked: false },
  collection: { actual: 500, plan: 30000, progress: 1.67, nc: 80, cash: 420, locked: false },
  pipeline_dev: { quote: 1, negotiation: 2, won: 3, total: 6, delta: { quote: 0, negotiation: 0, won: 0 } },
};

beforeEach(() => {
  fetchLog = [];
  dom = new JSDOM(html, {
    url: 'https://example.test/refatrix-wbr.html',
    runScripts: 'dangerously',
    beforeParse(w) {
      w.fetch = async (url) => {
        fetchLog.push(String(url));
        return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(WEEK_SUMMARY)) };
      };
      w.print = () => {};
      w.__freezeDate = (iso) => {
        const R = w.__RealDate || (w.__RealDate = w.Date);
        function F(...a) { return a.length ? new R(...a) : new R(iso); }
        F.prototype = R.prototype; F.now = () => new R(iso).getTime(); F.parse = R.parse; F.UTC = R.UTC;
        w.Date = F;
      };
    },
  });
  win = dom.window;
  win.eval("session={token:'tok',user:{id:1,name:'Seb',role:'director'},api:''};");
  win.eval('isDirector=true; canEdit=true; viewMode=null;');
  win.__freezeDate('2026-09-05T10:00:00');   // 토요일 → 그 주(08-31~09-04)
});

test('① summary 호출에 이번주 월~금이 실린다 (토요일에 열어도 그 주)', async () => {
  win.eval("topYms=['2026-09']; teamSel=new Set();");
  await win.eval('loadCards()');
  const url = fetchLog.find((u) => u.includes('/api/salesperf/summary'));
  assert.ok(url, 'summary 를 부르지 않았다');
  assert.ok(url.includes('from=2026-08-31'), url);
  assert.ok(url.includes('to=2026-09-04'), url);
  assert.ok(url.includes('carry=1'), url);
});

test('② 카드 문구 — 실적은 주간, 목표는 월 기준임이 드러난다', async () => {
  win.eval("topYms=['2026-09']; teamSel=new Set();");
  await win.eval('loadCards()');
  const t = win.document.getElementById('cards').textContent;
  assert.ok(t.includes('이번주(월~금 8/31~9/4) 매출 실적'), t);
  assert.ok(t.includes('목표는') && t.includes('월 기준'), t);
  assert.ok(t.includes('이번주(월~금 8/31~9/4) 반제 실적'), t);
  assert.ok(t.includes('수금/정산 반제내역과 같은 기준'), t);
  assert.ok(t.includes('실적 월~금 8/31~9/4'), '카드 제목에 기간 표시');
  // 목표 금액은 서버가 준 «월» 값 그대로
  assert.ok(t.includes('20,000'), t);
  assert.ok(t.includes('30,000'), t);
});

test('③ 전월 대비 → 전주 대비', async () => {
  win.eval("topYms=['2026-09']; teamSel=new Set();");
  await win.eval('loadCards()');
  const t = win.document.getElementById('cards').textContent;
  assert.ok(t.includes('50% 전주 대비'), t);
  assert.ok(!t.includes('전월 대비'), '주간 모드에서 전월 대비가 남으면 안 된다');
});

test('④ NC 가 섞이면 현금/NC 를 나눠 보여준다', async () => {
  win.eval("topYms=['2026-09']; teamSel=new Set();");
  await win.eval('loadCards()');
  const t = win.document.getElementById('cards').textContent;
  assert.ok(t.includes('현금 MX$420') && t.includes('NC MX$80'), t);
});

test('⑤ 여러 팀 합산에서도 전주 대비가 계산된다', () => {
  const one = JSON.parse(JSON.stringify(WEEK_SUMMARY));
  const two = JSON.parse(JSON.stringify(WEEK_SUMMARY));
  two.sales.actual = 500; two.sales.prevActual = 500;
  two.collection.actual = 100; two.collection.nc = 0; two.collection.cash = 100;
  win.eval('window.__a=' + JSON.stringify(one) + '; window.__b=' + JSON.stringify(two) + ';');
  const agg = win.eval('aggSummaries([window.__a, window.__b])');
  assert.equal(agg.sales.actual, 2000);
  assert.equal(agg.sales.prevActual, 1500);
  assert.equal(agg.sales.momPct, 33.3, '(2000-1500)/1500');
  assert.equal(agg.collection.actual, 600);
  assert.equal(agg.collection.nc, 80);
  assert.ok(agg.period, '기간 정보가 합산에도 남아야 «전주 대비» 로 표시된다');
});

test('⑥ 기간 정보가 없으면(구 서버) 종전 «전월 대비» 문구로 되돌아간다', async () => {
  const legacy = JSON.parse(JSON.stringify(WEEK_SUMMARY));
  legacy.period = null; delete legacy.collection.nc; delete legacy.collection.cash;
  win.eval('window.__legacy=' + JSON.stringify(legacy) + ';');
  win.eval("topYms=['2026-09']; teamSel=new Set(); renderCards(window.__legacy);");
  const t = win.document.getElementById('cards').textContent;
  assert.ok(t.includes('전월 대비'), t);
  assert.ok(!t.includes('이번주(월~금'), t);
  assert.ok(!t.includes('현금 MX$'), t);
});
