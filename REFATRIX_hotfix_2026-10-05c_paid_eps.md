# REFATRIX 핫픽스 2026-10-05c — 커미션 완납 기준을 수금 화면과 통일 (AR_PAID_EPS)

## 증상
BAGO 인보이스(4D641536…) — 수금/정산 화면에서는 미수 없음(완납), 커미션 화면에서는 잔액 $0.21 로 「완납 대기」. 적립 $62.62 가 지급 확정으로 넘어가지 않음.

## 원인
회사 공통 완납 기준은 `ar.js` 의 `AR_PAID_EPS` = **잔액 0.5 페소 미만이면 완납**(IVA 센타보 반올림 잔여, 2026-08-27 결정).
커미션 계산(commissionRoutes `computeLine`, commissionBonus `buildPerf`)만 0.01 기준을 따로 쓰고 있었다.

## 수정
두 파일 모두 `AR_PAID_EPS` 를 import 해서 같은 기준으로 완납을 판정. 정의는 한 곳(ar.js)뿐.
- 완납 판정 · 완납일 · 미수/연체 · 「지금 낼 금액」 · 완납 대기 · 수금 내역의 「완납 처리」 표시 모두 같은 기준.
- 결과: BAGO 건은 2026-10 지급 확정 커미션으로 이동(10월 배치에 반영), 「완납 대기」에서 빠짐.
- 0.5 페소 이상 남은 인보이스는 종전대로 미완납.

## 배포
| 파일 | 레포 경로 |
|---|---|
| commissionRoutes.js | `refatrix-api/src/routes/commissionRoutes.js` |
| commissionBonus.js | `refatrix-api/src/routes/commissionBonus.js` |
| refatrix-commission.html | `refatrix-commission.html` (빌드 토큰만 b1005pay3) |
| commission_paydate.test.js | `refatrix-api/test/commission_paydate.test.js` (선택) |

마이그레이션 없음. 백엔드 push → Railway Success → 프런트 push → Ctrl+Shift+R → 탭 제목 `build b1005pay3`.

## 주의
10월 배치는 아직 미확정이라 금액이 자동으로 늘어난다(BAGO 커미션 추가). 이미 확정·지급된 달은 불변.

## 검증
커미션 테스트 90건 통과(신규: 잔액 0.21 완납 / 0.5 이상 미완납) · npm test 24 통과.
