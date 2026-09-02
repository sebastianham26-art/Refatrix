# REFATRIX 인수인계 — 완납 판정 허용치 통일(AR_PAID_EPS) + RECAR folio 31 반제 복구

- 작업일: **2026-09-02**
- **마이그레이션 없음** (`npm run migrate` 불필요)
- 변경 파일: 백엔드 **11** · 프런트 **3** · 테스트 **1 신규**
- **nav 캐시 마커**: `v20260902eps` (직전 `v20260831bd` / salesperf·customers 는 `v20260824ph`)
- 검증: `node --check` 전 파일 · 인라인 `<script>` 문법 0 errors · **신규 순수 테스트 7건 전부 통과** · 기존 순수 테스트 회귀 0건

---

## ① 신고 2건은 **서로 다른 문제**였다

디렉터 신고(2026-09-02):
> "Recar(folio 31)은 이미 수금반제처리됐는데 연체·잔액 24,005 로 나오고, 미배분 입금 인박스에 `ryo_recar` 가 배분 대기로 떠 있다.
>  LUEMI folio 13 은 정상인데 folio 25 는 잔액이 0인데 수금완료 표시가 안 된다."

화면 확인 결과 **두 건의 원인이 완전히 다르다.**

| 건 | 화면 | 정체 |
|---|---|---|
| RECAR folio 31 | 청구 24,005 · **입금 0** · 잔액 24,005 · 연체 3일 · 통지 `ryo_recar` 가 「배분됨 —, 잔여 24,005」로 인박스 복귀 | **화면 오류가 아니라 반제가 실제로 취소된 것.** 데이터가 정확히 미수 상태를 그리고 있다 |
| LUEMI folio 25 | 청구 6,799 · 입금 6,799 · **잔액 0** 인데 「연체 19일」 | **완납 판정 임계값 불일치.** 2026-08-27 `ar_paid_eps` 패키지가 끝내 main 에 반영되지 않았다 |

> 참고: RECAR 의 「완납 2건」은 버그가 아니다. 같은 고객의 **청구액 0 짜리 인보이스 2건**
> (`material de promocion` · `promocional de evento`)이 잔액 0 이라 완납으로 잡힌 것이다.

## ② RECAR folio 31 — 무엇이 일어났나

2026-09-01 세션의 운영 DB 조회에서 folio 31(인보이스 #28)은 **완납·잔액 0**, 통지 #11 은 `allocated` 로 정상이었다.
지금은 배분이 0건이고 통지가 `pending`·`allocated_amount=0` 으로 돌아와 있다 —
이는 **입금건(반제 헤더)이 통째로 삭제**됐을 때만 나오는 그림이다(`DELETE /api/ar/payments/:id` → `bdReleaseAmount`).

디렉터가 거래목록에서 「매출 입금예정 24,004.53」을 지우려다 막히자(`sales_linked`),
수금/정산의 **선수금(과입금) 카드에서 [입금 취소]** 를 눌렀을 가능성이 가장 높다.
그 카드에 RECAR 가 올라와 있던 이유는 **선수금이 0.47 페소** 였기 때문이다(목록 조건이 `advance_amount > 0.005` 였다).

**즉 24,005 짜리 반제가 0.47 페소짜리 센타보 먼지 때문에 지워졌다.**

### 조치 ⑴ 데이터 복구 — 코드 수정 아님, 재반제

돈은 사라지지 않았다. 인박스의 24,005 통지가 그대로 있다.

1. 수금/정산 → 미배분 입금 인박스 → `2026-08-26 · BBVA · 24,005 · ryo_recar` 행의 **[이 입금으로 반제]**
2. 아래 미수 목록에서 **folio 31 [반제]** → 배분 카트에 담기 → **[저장 · 통지 닫기]**
3. 결과: folio 31 완납 · 통지 인박스에서 사라짐 · 잔여 0.47 은 선수금으로 확정(원장에 남는 게 맞다)

### 조치 ⑵ 재발 방지 — 센타보 먼지는 「선수금」이 아니다

`GET /api/ar/advances` 목록 조건을 `advance_amount > 0.005` → **`>= 0.5`(AR_PAID_EPS)** 로 올렸다.
0.47 같은 반올림 잔여는 이제 선수금 카드에 **뜨지 않는다** → 그 옆의 파괴적 [입금 취소] 버튼에 노출되지 않는다.
원장의 0.47 은 그대로 남는다(정직성 유지). 이 화면에서 지워지지만 않을 뿐이다.

## ③ LUEMI folio 25 — 완납 판정 임계값

화면 금액은 `toLocaleString(maximumFractionDigits:0)` 으로 **정수 페소 반올림**해 보여준다.
그런데 서버 완납 판정은 `잔액 <= 0.005`, 미수 목록 필터·연체 판정은 `> 0.01` 이었다.
IVA 16% 때문에 인보이스 총액은 센타보 단위인데 은행 입금은 페소 단위로 들어오므로,
100% 반제해도 **0.01 ~ 0.5 페소가 남는 건**이 생긴다. 그 건은:

- 화면엔 **잔액 0** 으로 보이고 (반올림)
- 서버는 **미수** 로 판정해 → 완납 배지가 안 붙고, 만기가 지났으면 **「연체 19일」**
- 오픈 인보이스 **건수·그룹 표에도 계속 포함**된다 (LUEMI 건수 4건에 folio 25 가 끼어 있던 이유)

folio 13(482)은 잔여가 0.005 미만이라 우연히 정상으로 보였을 뿐, folio 25 와 같은 문제였다.

**해결 = 판정 눈금을 화면 눈금에 맞춘다.** `refatrix-api/src/ar.js` 에 전 시스템 공통 상수를 두고 전부 이 기준으로 통일:

```js
export const AR_PAID_EPS = 0.5;                 // 잔액 0.5 페소 미만 = 완납(= 화면 표시상 0)
export function arIsPaid(outstanding) { return Number(outstanding||0) < AR_PAID_EPS; }
export function arIsOpen(outstanding) { return !arIsPaid(outstanding); }
```

> **왜 0.5인가**: 화면이 정수 페소로 반올림하므로 **"화면에 0으로 보이면 완납"** 이 되도록 맞춘 값(≈ 2.5 US 센트).
> 0.5 이상 남으면 지금까지처럼 미수·연체로 표시된다.

## ④ 변경 내용 (마이그레이션 없음)

### 백엔드 11개 파일

| 파일 | 변경 |
|---|---|
| `src/ar.js` | **`AR_PAID_EPS`·`arIsPaid`·`arIsOpen` 신설.** `arInvoiceStatus` 의 `open` 판정을 `arIsOpen()` 으로 |
| `src/routes/financeRoutes.js` | `BD_REMAIN_EPS`·`AR_PLAN_EPS` 를 **하드코딩 0.5 → `AR_PAID_EPS` 상수 참조**로 묶음. open-list/search 의 `is_overdue`·미수 필터·`ORDER BY`·`paid_full`(3곳), 드릴다운 `paid_full`, 고객별 미수 요약(HAVING)·고객 미반제 인보이스, 재무 열람 요약(`/api/ar/view/summary`), 현금흐름 수금예정 보정(`adjustArPlansToOutstanding`), **선수금 목록 조건(`>= 0.5`)** |
| `src/quoteStage.js` | 견적 단계 `collected`(수금완료)·`overdue` 판정 |
| `src/routes/notaCreditoRoutes.js` | NC 적용 후 `paid_full` |
| `src/pendingItems.js` · `src/productStatus.js` · `src/stageCohorts.js` · `src/routes/dailyBriefingRoutes.js` | "수금 미완/미수" SQL 조건 (`< total - 0.005` → `- 0.5`) |
| `src/routes/dashboardRoutes.js` · `src/routes/portalRoutes.js` · `src/routes/meetingRoutes.js` | 연체 고객수·연체 금액·고객 미수 집계 |

### 프런트 3개 파일

- **`refatrix-settlement.html`** — 판정을 **수신 지점 한 곳**으로 모았다.
  ```js
  const AR_PAID_EPS=0.5;
  function arNorm(list){                      // open-list / search 응답을 받자마자 1회
    (list||[]).forEach(it=>{
      const pf = !!it.paid_full || Number(it.outstanding||0) < AR_PAID_EPS;
      it.paid_full = pf;
      if(pf) it.overdue = false;              // 완납은 만기가 지났어도 연체가 아니다
    });
    return list||[];
  }
  ```
  - 서버 플래그(`paid_full`)를 **우선**하되 화면에서도 방어 → **백엔드 배포 전에 화면만 올라가도 배지·색상이 모순되지 않는다.**
  - 기존 15곳의 `it.paid_full` 사용처(상태 칩·행 배경·반제/NC 버튼·통계·그룹 표·정렬·인쇄·명세서)는 **손대지 않았다** — 정규화된 값을 그대로 쓴다. 변경 표면이 작아 회귀 위험이 낮다.
  - 완납 칩 **툴팁**: 반올림 잔여가 있으면 `반제 완료 · 반올림 잔여 MX$0.32` 로 실제 남은 센타보를 숨기지 않고 보여준다.
- **`refatrix-salesperf.html`** — 영업실적 AR 배지: `open===false` 또는 잔액 < 0.5 → 「완납」.
- **`refatrix-customers.html`** — 고객 상세 인보이스 표: 잔액 < 0.5 면 **「완납」 pill 을 연체 pill 보다 먼저** 판정.

### 테스트 1개 신규

`refatrix-api/test/ar_paid_eps.test.mjs` — **DB 불필요(순수) 7건**. 실행: `node --test test/ar_paid_eps.test.mjs`

## ⑤ 배포

1. 변경 파일을 repo 에 반영 → GitHub Desktop **Commit → Push**.
2. **Railway** 자동 재배포 → Deployments **Success**. **`npm run migrate` 불필요**(마이그레이션 없음).
3. GitHub Pages 1~2분 → 수금/정산·영업실적·고객 화면에서 **Ctrl+Shift+R**. nav 마커 `[refatrix-nav] … v20260902eps`.

> 순서 주의: 화면만 먼저 올려도 **배지·연체색은 즉시 정상화**된다. 다만 그 건이 미수 목록에서 빠지고
> 총 잔액·연체·오픈 건수 집계에서 제외되는 것은 **백엔드 배포 후**부터다.

검증(운영 반영 확인):
```
curl -s ".../main/refatrix-api/src/ar.js?nc=$(date +%s)" | grep -c "AR_PAID_EPS"          # 2+
curl -s ".../main/refatrix-settlement.html?nc=$(date +%s)" | grep -c "function arNorm"    # 1+
```

## ⑥ 테스트 (운영 스모크)

1. **LUEMI folio 25** 가 「완납」으로 바뀌고 미수 목록에서 빠지는지. LUEMI 그룹 **건수 4 → 3**, 총 잔액 15,220 유지.
2. 「완납(closing) 포함: 켬」 → folio 25 가 회녹색 배경 + 초록 「완납」 칩. 칩에 마우스를 올리면 `반올림 잔여 MX$0.xx`.
3. **진짜 미수(folio 29·30·34)는 그대로** `연체 6일`·`연체 5일`·`D-23` 인지 (회귀).
4. **RECAR folio 31**: 인박스의 24,005 통지로 **재반제** → 완납·통지 사라짐. (코드가 아니라 조작으로 복구되는 건이다.)
5. 선수금(과입금) 카드에 **0.5 미만 센타보 건이 더 이상 뜨지 않는지**.
6. 영업실적 AR 팝업·고객 상세 인보이스 표에서도 같은 건이 「완납」인지.
7. 대시보드·포털의 연체 고객수·연체 금액이 그 건을 빼고 계산되는지.

## ⑦ 검증 (이번 세션)

- `node --check` — 변경 백엔드 11개 전부 통과. 변경 HTML 3개 인라인 `<script>` `new Function` 문법 **0 errors**.
- **신규 `test/ar_paid_eps.test.mjs` 7/7 통과** — 경계값(0.49 완납 / 0.5 미수 / 과입금) · **LUEMI folio 25 재현**(만기 지난 0.32 잔여 → open=false·overdue=false) · **RECAR folio 31 회귀**(진짜 미수는 연체 3일 유지) · 견적 단계 `collected` / `await_collect(overdue)` · 프런트 `arNorm` 을 **HTML 에서 추출해 vm 실행**(테스트–코드 드리프트 방지, 툴팁 잔여 노출 포함) · **하드코딩 옛 임계값 잔존 여부 회귀 가드**.
- 기존 순수 테스트 회귀: `test/ar.test.js` 8/8 · `test/stageLabel.test.js` 8/8 · `test/logic.test.js` 24/24 — **새로 깨진 것 0건**.
  (`arDetail`·`stageAuto` 등은 이 PC 에 `node_modules`(pg) 가 없어 원래 실행 불가 — 이번 변경과 무관.)
- 운영 DB **쓰기 작업은 하지 않았다.**

## ⑧ 핵심 학습 / 원칙

- **표시 반올림과 판정 기준은 반드시 맞춘다.** 금액을 정수로 반올림해 보여주면서 판정은 `0.005` 로 하면 "화면엔 0인데 연체"라는 설명 불가능한 상태가 생긴다. 사용자는 그걸 **버그가 아니라 돈 문제로** 읽는다.
- **먼지에 파괴적 버튼을 달지 말 것.** 0.47 페소가 「선수금」으로 목록에 오르고 그 옆에 [입금 취소]가 있었다는 것 하나로 24,005 반제가 지워졌다. **판정 임계값은 목록에 무엇을 올릴지도 결정한다** — 표시 기준과 액션 기준을 따로 두면 이런 사고가 난다.
- **거부에는 짝이 되는 정상 경로가 있어야 한다.** 거래목록이 매출 예정 삭제를 막았을 때 "그럼 어디서 해결하나"의 답이 화면에 없으면, 사용자는 **가장 가까운 삭제 버튼**을 누른다. (2026-09-01 문서의 같은 교훈이 반대 방향에서 재현됐다.)
- **프런트는 서버 플래그를 우선하되 스스로도 방어.** 수신 지점 한 곳(`arNorm`)에서 정규화하면 15개 사용처를 건드리지 않고도 배포 순서에 무관해진다 — 08-27 안(사용처마다 `arPaid(it)` 호출)보다 변경 표면이 작다.
- **미반영 경고는 세 번 적으면 끝나지 않는다.** `ar_paid_eps` 는 08-27·08-31·08-31c·09-01 문서에 연속으로 "미반영" 경고가 달렸지만 반영되지 않았고, 그 사이 신고가 두 번 더 올라왔다. **경고를 쌓지 말고 그 자리에서 다시 만들어 올린다.**

## ⑨ 열린 메모 / 다음에 할 일

- **소액 잔액 정리(write-off)** 는 여전히 미구현. 센타보 선수금이 쌓이면 NC 자동 발행 방식으로 터는 기능이 필요하다(08-27 문서에서 예고된 항목 — 이번에도 미룸).
- **LUEMI 통지 2건에 잔여 7,281 이 남아 있다**(배분됨 482/6,799). 미수 folio 29(6,958)·30(1,278)·34(6,984) 에 [잔여로 이어서 반제] 로 배분하면 된다.
- 허용치 0.5 를 바꿔야 할 실제 사례가 나오면 `src/ar.js` 의 `AR_PAID_EPS` 와 `refatrix-settlement.html` 의 동명 상수 **두 곳만** 고치면 된다(프런트는 인라인 스크립트라 값 공유 불가).
- 선수금 → 인보이스 배분을 되돌리면 선수금으로 환원되지 않는 문제(08-31c ⑧)는 **여전히 미해결**.
- 거래목록 `LIMIT 200` 고정(09-01 ⑦) 여전히 유효.

---
*이 문서는 인수인계용 스냅샷입니다. 큰 변경이 생기면 갱신해서 다시 올려주세요.*
