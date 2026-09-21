import { reserveStartAt, reserveExpiresAt, mexicanHolidays, isBusinessDay } from '../src/quoteExpiry.js';
let pass=0, fail=0;
const mx = (s) => new Date(s + '-06:00');          // MX 벽시계 → UTC
const eq = (name, got, want) => { const g=new Date(got).toISOString(), w=mx(want).toISOString();
  if (g===w) { pass++; } else { fail++; console.log('FAIL', name, 'got', g, 'want', w); } };
// 2026-09-21 = 월
eq('평일 근무중', reserveStartAt(mx('2026-09-22T10:00')), '2026-09-22T10:00');
eq('평일 근무중 만료', reserveExpiresAt(mx('2026-09-22T10:00')), '2026-09-23T10:00');
eq('07:30 정각', reserveStartAt(mx('2026-09-22T07:30')), '2026-09-22T07:30');
eq('16:59', reserveStartAt(mx('2026-09-22T16:59')), '2026-09-22T16:59');
eq('17:00 정각=밖', reserveStartAt(mx('2026-09-22T17:00')), '2026-09-23T07:30');
eq('화 18:30', reserveExpiresAt(mx('2026-09-22T18:30')), '2026-09-24T07:30');
eq('수 05:00', reserveExpiresAt(mx('2026-09-23T05:00')), '2026-09-24T07:30');
eq('자정 00:00', reserveStartAt(mx('2026-09-23T00:00')), '2026-09-23T07:30');
eq('금 16:59 그대로', reserveExpiresAt(mx('2026-09-25T16:59')), '2026-09-26T16:59');   // 규칙3: 토요일 만료 그대로
eq('금 10:00 → 토 10:00 만료(변경 없음)', reserveExpiresAt(mx('2026-09-25T10:00')), '2026-09-26T10:00');
eq('금 17:30', reserveStartAt(mx('2026-09-25T17:30')), '2026-09-28T07:30');
eq('토', reserveStartAt(mx('2026-09-26T12:00')), '2026-09-28T07:30');
eq('일 23:59', reserveExpiresAt(mx('2026-09-27T23:59')), '2026-09-29T07:30');
eq('월 07:00', reserveStartAt(mx('2026-09-28T07:00')), '2026-09-28T07:30');
// 공휴일
eq('9/16(수) 독립기념일', reserveStartAt(mx('2026-09-16T11:00')), '2026-09-17T07:30');
eq('9/15 저녁 → 9/16 휴일 건너뜀', reserveStartAt(mx('2026-09-15T19:00')), '2026-09-17T07:30');
eq('11/13 금 저녁 → 11/16 혁명기념일(셋째 월) → 화', reserveStartAt(mx('2026-11-13T18:00')), '2026-11-17T07:30');
eq('12/24 목 18:00 → 25 휴일 → 28 월', reserveStartAt(mx('2026-12-24T18:00')), '2026-12-28T07:30');
eq('12/31 목 18:00 → 1/1 휴일 → 1/4 월', reserveStartAt(mx('2026-12-31T18:00')), '2027-01-04T07:30');
eq('2027-01-29 금 18:00 → 2/1 헌법기념일 → 2/2', reserveStartAt(mx('2027-01-29T18:00')), '2027-02-02T07:30');
eq('2027-03-12 금 18:00 → 3/15 후아레스 → 3/16', reserveStartAt(mx('2027-03-12T18:00')), '2027-03-16T07:30');
eq('4/30 목 18:00 → 5/1 금 휴일 → 5/4 월', reserveStartAt(mx('2026-04-30T18:00')), '2026-05-04T07:30');
eq('2030-10-01 취임일', reserveStartAt(mx('2030-10-01T09:00')), '2030-10-02T07:30');
eq('2026-10-01 평일(취임 아님)', reserveStartAt(mx('2026-10-01T09:00')), '2026-10-01T09:00');
// 표
const h26=[...mexicanHolidays(2026)].sort().join(',');
if (h26==='2026-01-01,2026-02-02,2026-03-16,2026-05-01,2026-09-16,2026-11-16,2026-12-25') pass++; else { fail++; console.log('FAIL 2026 table', h26); }
const h27=[...mexicanHolidays(2027)].sort().join(',');
if (h27==='2027-01-01,2027-02-01,2027-03-15,2027-05-01,2027-09-16,2027-11-15,2027-12-25') pass++; else { fail++; console.log('FAIL 2027 table', h27); }
// 추가 휴무 env
process.env.QUOTE_EXTRA_HOLIDAYS='2026-12-12';
eq('extra 12/11 금 18:00 → 12/14', reserveStartAt(mx('2026-12-11T18:00')), '2026-12-14T07:30');
eq('extra 평일 지정', reserveStartAt(mx('2026-10-05T09:00')), '2026-10-05T09:00');
process.env.QUOTE_EXTRA_HOLIDAYS='2026-10-05';
eq('extra 평일 휴무', reserveStartAt(mx('2026-10-05T09:00')), '2026-10-06T07:30');
delete process.env.QUOTE_EXTRA_HOLIDAYS;
if (!isBusinessDay(mx('2026-09-16T10:00')) && isBusinessDay(mx('2026-09-17T10:00'))) pass++; else { fail++; console.log('FAIL isBusinessDay'); }
// 초 단위 경계 & 잘못된 입력
eq('16:59:59', reserveStartAt(mx('2026-09-22T16:59:59')), '2026-09-22T16:59:59');
if (!isNaN(reserveExpiresAt('garbage'))) pass++; else { fail++; console.log('FAIL garbage'); }
console.log(`quoteExpiry ${pass}/${pass+fail}`); process.exit(fail?1:0);
