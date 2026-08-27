// 운영 파일에서 viewRegistered 블록을 그대로 추출해 jsdom 에서 실행한다(복붙 아님).
import fs from 'fs';
import { JSDOM } from 'jsdom';
import * as XLSXmod from 'xlsx';
const XLSX = { ...XLSXmod };

const html = fs.readFileSync('/home/claude/repo/refatrix-inbound.html', 'utf8');
function block(startMark, endMark) {
  const a = html.indexOf(startMark);
  if (a < 0) throw new Error('not found: ' + startMark);
  const b = html.indexOf(endMark, a);
  if (b < 0) throw new Error('end not found');
  return html.slice(a, b);
}
// VIEW_CSS ~ viewRegistered 끝(다음 함수 dlShipFile 직전)
const src = block("  var VIEW_CSS='<style>'", '  function dlShipFile(');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test/' });
const store = {};
const written = [];
const toasts = [];

const DETAIL = {
  shipment: { invoice_no: 'D26-81319563', eta: '2026-08-20', status: 'receiving' },
  pallets: [
    { id: 1, order_no: '100RA26D1C', pl_no: 1, status: 'done', cartons_expected: 42, qty_expected: 672,
      items: [{ id: 11, code: 'CE0796L', name: '오일필터', cartons: 40, qty: 640, rack: 'A-01-03', registered: true },
              { id: 12, code: 'CE0088L', name: '', cartons: 2, qty: 32, rack: '', registered: false }] },
    { id: 2, order_no: '100RA26D1C', pl_no: 2, status: 'checking', cartons_expected: 10, qty_expected: 120,
      items: [{ id: 21, code: 'CL0211L', name: '<b>브레이크</b> "패드"', cartons: 10, qty: 120, rack: 'B-02-01', registered: true }] },
    { id: 3, order_no: '', pl_no: 1, status: 'wait', cartons_expected: 5, qty_expected: 60,
      items: [{ id: 31, code: 'CQ0445L', name: 'x', cartons: 5, qty: 60, rack: '', registered: true }] },
  ],
};

const ctx = {
  window: dom.window, document: dom.window.document, XLSX,
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  DETAIL, SHIP: 77, LANG: 'ko',
  L: (ko, es) => (ctx.LANG === 'es' ? es : ko),
  esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  fmt: (n) => Number(n || 0).toLocaleString(ctx.LANG === 'es' ? 'es-MX' : 'ko-KR'),
  toast: (m) => toasts.push(m),
  PAL_LBL: { wait: ['대기', 'En espera'], unloaded: ['하차됨', 'Descargado'], checking: ['적치중', 'Acomodando'], checked: ['검수됨', 'Verificado'], done: ['완료', 'Listo'] },
  poParts: (v) => { const t = String(v == null ? '' : v).trim(); const m = t.match(/^(\d*[A-Za-z]{2,})[\s\-_.]*(\d[\dA-Za-z\-_.\/]*)$/); return (m && m[2]) ? { pfx: m[1], po: m[2] } : { pfx: '', po: t }; },
  palGroups: () => {
    const map = {}, keys = [];
    DETAIL.pallets.forEach((p) => { const k = String(p.order_no == null ? '' : p.order_no); if (!map[k]) { map[k] = { key: k, pals: [] }; keys.push(k); } map[k].pals.push(p); });
    return keys.map((k) => { const G = map[k]; G.N = G.pals.length;
      G.cartons = G.pals.reduce((a, p) => a + (p.cartons_expected || 0), 0);
      G.qty = G.pals.reduce((a, p) => a + (p.qty_expected || 0), 0); return G; });
  },
};

// 자식 창(window.open) 대역 — 별도 jsdom 문서
let child = null;
let blobSeq = 0;
const blobs = new Map();
function newChild() {
  const d = new JSDOM('<!doctype html><html><head></head><body></body></html>').window;
  d.print = () => { child.printed = (child.printed || 0) + 1; };
  // jsdom 에 없을 수 있는 URL.createObjectURL 대역 — 만들어진 Blob 을 붙잡아 둔다
  d.URL = d.URL || {};
  d.URL.createObjectURL = (b) => { const u = 'blob:test/' + (++blobSeq); blobs.set(u, b); return u; };
  d.URL.revokeObjectURL = (u) => { blobs.delete(u); };
  child = d; return d;
}
ctx.window.open = () => newChild();
// XLSX.write 는 실제로 돌리되(포맷 검증) 워크북을 붙잡아 둔다
const realWrite = XLSXmod.write;
XLSX.write = (wb, opt) => { written.push({ wb, opt }); return realWrite(wb, opt); };
// 링크에 실제로 물린 파일명·blob 을 읽는 헬퍼
const dl = () => { const a = child.document.getElementById('vXls');
  return a ? { name: a.getAttribute('download'), href: a.getAttribute('href'), text: a.textContent, blob: blobs.get(a.getAttribute('href')) } : null; };

const fn = new Function(...Object.keys(ctx), src + '\n; return { viewRegistered: viewRegistered, VIEW_CSS: VIEW_CSS };');
const api = fn(...Object.values(ctx));

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('✅ ' + name); } else { fail++; console.log('❌ ' + name + (extra ? ' — ' + extra : '')); } };

// ── ① 한국어 기본 렌더
api.viewRegistered();
let txt = child.document.body.textContent;
let htmlOut = child.document.body.innerHTML;
t('한국어 제목', txt.includes('ERP 등재 내역'));
t('한국어 표 머리글', txt.includes('품명') && txt.includes('카톤') && txt.includes('상태'));
t('상태 한국어', txt.includes('완료') && txt.includes('적치중') && txt.includes('대기'));
t('버튼 3개', ['vPrint', 'vXls', 'vLang'].every((id) => child.document.getElementById(id)));
t('토글 버튼 라벨 Español', child.document.getElementById('vLang').textContent.includes('Español'));
t('미등록 SKU ⚠', txt.includes('⚠'));
t('합계 수량 852 EA', txt.includes('852'), txt.slice(0, 200));
t('XSS 이스케이프', !htmlOut.includes('<b>브레이크') && htmlOut.includes('&lt;b&gt;'));
t('PO 없는 그룹 = 번호 없음', txt.includes('번호 없음'));
t('문서 lang=ko', child.document.documentElement.lang === 'ko');

// ── ② 언어 토글 → 스페인어
child.document.getElementById('vLang').click();
txt = child.document.body.textContent;
t('스페인어 제목', txt.includes('Registro en ERP'));
t('스페인어 머리글', txt.includes('Descripción') && txt.includes('Cajas') && txt.includes('Ubic.'));
t('상태 스페인어', txt.includes('Listo') && txt.includes('Acomodando') && txt.includes('En espera'));
t('토글 라벨 한국어로 바뀜', child.document.getElementById('vLang').textContent.includes('한국어'));
t('PO 없는 그룹 = Sin número', txt.includes('Sin número'));
t('본문 LANG 불변', ctx.LANG === 'ko');
t('선택 기억(localStorage)', store.wh_viewlang === 'es');
t('문서 lang=es', child.document.documentElement.lang === 'es');

// ── ③ 다시 토글 → 한국어 복귀
child.document.getElementById('vLang').click();
t('한국어 복귀', child.document.body.textContent.includes('ERP 등재 내역'));
t('선택 기억 ko', store.wh_viewlang === 'ko');

// ── ④ 엑셀 다운로드 링크 (한국어) — 스크립트 클릭이 아니라 진짜 <a download>
child.document.getElementById('vLang').click();   // es
child.document.getElementById('vLang').click();   // ko 복귀 → 마지막 build 는 한국어
const dko = dl();
t('다운로드는 <a> 태그', child.document.getElementById('vXls').tagName === 'A');
t('blob href 물림', !!dko && /^blob:/.test(dko.href || ''), JSON.stringify(dko && dko.href));
t('download 파일명', !!dko && dko.name === 'ERP등재내역_D26-81319563.xlsx', dko && dko.name);
t('blob MIME = xlsx', !!dko && dko.blob && /spreadsheetml/.test(dko.blob.type), dko && dko.blob && dko.blob.type);
t('엑셀은 렌더마다 1회만 생성', written.length >= 1);
{
  const wb = written[written.length - 1].wb;
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: true });
  t('bookType xlsx / type array', written[written.length - 1].opt.bookType === 'xlsx' && written[written.length - 1].opt.type === 'array');
  t('시트명 등재내역', wb.SheetNames[0] === '등재내역', wb.SheetNames[0]);
  t('머리글 9열', aoa[0].length === 9 && aoa[0][0] === 'ORDER NO' && aoa[0][3] === '품명');
  t('데이터 4행', aoa.slice(1).filter((r) => r && r[2]).length === 4, JSON.stringify(aoa.slice(1, 6)));
  const r1 = aoa[1];
  t('첫 행 값', r1[0] === '100RA26D1C' && r1[1] === 1 && r1[2] === 'CE0796L' && r1[4] === 40 && r1[5] === 640 && r1[6] === 'A-01-03' && r1[7] === '완료');
  t('수량은 숫자 셀', typeof ws['F2'].v === 'number' && ws['F2'].t === 'n');
  t('미등록 표기', aoa[2][8] === '미등록', JSON.stringify(aoa[2]));
  const last = aoa[aoa.length - 1];
  t('합계 행', last[0] === '합계' && last[4] === 57 && last[5] === 852, JSON.stringify(last));
  t('열 너비 지정', Array.isArray(ws['!cols']) && ws['!cols'].length === 9);
}

// ── ⑤ 스페인어 전환 시 파일도 다시 만들어진다
const beforeN = written.length;
child.document.getElementById('vLang').click();
const des = dl();
t('토글하면 파일 재생성', written.length === beforeN + 1);
t('스페인어 파일명', !!des && /^Registro_ERP_D26-81319563\.xlsx$/.test(des.name || ''), des && des.name);
{
  const wb = written[written.length - 1].wb;
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  t('스페인어 머리글', aoa[0][3] === 'Descripción' && aoa[0][7] === 'Estado');
  t('스페인어 상태값', aoa[1][7] === 'Listo');
  t('스페인어 시트명', wb.SheetNames[0] === 'Registro', wb.SheetNames[0]);
}
child.document.getElementById('vLang').click();   // ko 로 되돌림

// ── ⑤-2 XLSX 미로드(현장 PDA·CDN 차단) → CSV 로 자동 대체
{
  const savedUtils = XLSX.utils, savedWrite = XLSX.write;
  XLSX.utils = undefined;                          // "XLSX not loaded" 경로
  api.viewRegistered();
  const c = dl();
  t('CSV 대체 파일명', !!c && /\.csv$/.test(c.name || ''), c && c.name);
  t('CSV 라벨 안내', !!c && c.text.includes('CSV'));
  t('CSV MIME', !!c && c.blob && /text\/csv/.test(c.blob.type), c && c.blob && c.blob.type);
  XLSX.utils = savedUtils; XLSX.write = savedWrite;
}
api.viewRegistered();                              // 정상 상태로 복귀

// ── ⑥ 인쇄 버튼
child.document.getElementById('vPrint').click();
t('인쇄 호출', child.printed === 1);

// ── ⑦ 팝업 차단(window.open null) 시 안전
ctx.window.open = () => null;
let threw = false;
try { api.viewRegistered(); } catch (e) { threw = true; }
t('팝업 차단 시 예외 없음', !threw);

// ── ⑧ 팔렛 0건
DETAIL.pallets = [];
ctx.window.open = () => newChild();
api.viewRegistered();
t('팔렛 없음 안내', child.document.body.textContent.includes('Sin pallets') || child.document.body.textContent.includes('팔렛이 없습니다'));

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
