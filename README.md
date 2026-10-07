# 화면 시각·날짜를 멕시코 시간으로 — 전 화면 일괄 수정 · 2026-10-07

## 원인
서버는 모든 시각을 UTC 로 저장한다. 화면이 그 문자열을 그대로 잘라 썼기 때문에
**UTC 가 그대로 표시**됐다 — 멕시코(UTC−6)보다 6시간 빠르다.
예) 21:06 로 보이던 동기화 시각 = 실제 15:06.

같은 뿌리에서 두 가지가 틀리고 있었다.

1. **시각 표시** — `2026-10-07T21:06` 을 잘라 쓰던 곳 → 6시간 빠르게 보임
2. **오늘 날짜** — `new Date().toISOString()` 으로 오늘을 구하던 곳
   → 멕시코 **오후 6시 이후에는 날짜가 하루 넘어감**. 입력창 기본값, 파일 이름, 날짜 비교에 영향.

## 수정
각 화면에 세 줄짜리 공용 함수를 넣고 전부 그걸 쓰게 했다. **서버·DB 변경 없음.**

- `mxHora(v)` — 저장된 시각 → `2026-10-07 15:06` (멕시코)
- `mxDia(v)`  — 저장된 시각 → `2026-10-07` (멕시코 날짜)
- `mxHoy()`   — 오늘 날짜 (멕시코 기준)

날짜만 들어 있는 값(`2026-10-07`)과 빈 값·이상한 값은 건드리지 않는다.

## 교체 파일 (27개 · 프런트만)

catalog-api · commission · finance · finder · funnel · import · importcost · integrations ·
mktspend · pipeline · portal · pricemaster · process-kpi · products · purchase · quote ·
quotelist · recost · relocate · sales · settlement · shortage · stock · stock-test ·
vehicleparts · viofinder · warehouse

가장 많이 바뀐 곳: products 12곳, finance 9곳, shortage 4곳, import·pipeline·sales 각 3곳.

## 배포
1. zip 을 repo 최상위에 풀어 덮어쓰기 → Commit → Push
2. **Ctrl+Shift+R** (하드 리프레시)

백엔드는 손대지 않았으므로 Railway 재배포·마이그레이션 불필요.

## 검증
- 27개 파일의 인라인 스크립트 **전부 문법 통과**, 공용 함수 누락 0
- `21:06(UTC) → 2026-10-07 15:06`, 날짜만 있는 값·빈 값·이상한 값은 그대로 통과 확인
- `mxHoy()` 가 멕시코 날짜를 돌려주는지 확인

## 봐 주실 곳
- 카탈로그 조회 API: 동기화·호출 이력 시각 (머리글에 (MX) 표시)
- 자금: 거래 입력 화면의 날짜 기본값이 오늘로 들어오는지 (특히 저녁 6시 이후)
- 제품: 상태 변경일·최근 저장일, 엑셀 파일 이름의 날짜
