# REFATRIX 핫픽스 2026-10-05b — 연체 $0.03(반올림 잔액) 제거

## 증상
Oscar 실적 조회 「연체 $0.03」. 클릭하면 인보이스 3건(LUEMI 2건, REFACCIONARIA ABC 1건)이 각각 $0.01 연체로 나오는데, 같은 줄의 상태는 「완납」.

## 원인
완납 판정은 1센타보 허용(현금 수금 + 0.01 ≥ 합계)인데, 미수·연체 금액은 허용 없이 잔액(0.01)을 그대로 셌다. 두 기준이 달랐다.

## 수정
`commissionBonus.js` buildPerf — 완납으로 판정된 인보이스는 미수·연체·연체이월·「지금 낼 금액」을 모두 0 으로. 커미션 계산은 원래 같은 1센타보 기준이라 변화 없음.
1센타보를 넘는 잔액(예: BAGO $0.21)은 진짜 미수라 그대로 표시된다.

## 클릭해도 팝업이 안 열렸던 이유
브라우저가 이전 화면(build b0928adj)을 캐시하고 있었다. 서버의 화면은 이미 새 버전이었다. 이번 배포 후 Ctrl+Shift+R → 탭 제목 `build b1005pay2` 확인.

## 배포
| 파일 | 레포 경로 |
|---|---|
| commissionBonus.js | `refatrix-api/src/routes/commissionBonus.js` |
| refatrix-commission.html | `refatrix-commission.html` (빌드 토큰만 b1005pay2) |
| commission_paydate.test.js | `refatrix-api/test/commission_paydate.test.js` (선택) |

마이그레이션 없음. 백엔드 push → Railway Success → 프런트 push → Ctrl+Shift+R.

## 검증
커미션 테스트 89건 통과(신규: 반올림 잔액 1건). 운영 화면에서 연체 팝업 열림 확인(캐시 새로고침 후).
