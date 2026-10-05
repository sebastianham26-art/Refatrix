# REFATRIX 인수인계 — 커미션 「수금일 기준」 + 박스 클릭 상세 팝업 (f/up 독려)

- 작업일: 2026-10-05
- 마이그레이션: **0250** (신규 · `0250_commission_match_on_payment.sql`)
- **nav.js 변경 없음** → 다른 HTML 의 nav 토큰 일괄 변경 **불필요**
- 화면 빌드 토큰: **`b1005pay`** (브라우저 탭 제목에 표시)
- 산출물: `refatrix_commission_paydate_v1.zip` (6파일 · 레포 구조 그대로 → 루트에서 풀면 제자리) + 개별 파일
- 검증: 커미션 관련 **88건 전부 통과**(신규 21 + 기존 67) · `npm test` 24 통과 · SQL 62건 pglast 파싱 · 0250 미적용 DB 에서 엔드포인트 7종 전부 200 · jsdom 화면 실동작(디렉터·영업사원) 박스 13종 클릭, JS 오류 0

---

## ① 무엇을 바꿨나

### (1) 커미션 = 수금일 기준 (디렉터 결정)

> 인보이스 발행기간은 중요하지 않고, **수금되는 기간**이 중요하다. 수금하면 4% 커미션이 붙고, 그 인보이스가 **미수 없이 완납**되면 지급된다.

| | 종전(발행일 판정) | **신규(수금일 판정)** |
|---|---|---|
| 대상 | 발행일이 기간 안인 인보이스 | 수금일이 기간 안인 **수금액** (발행일 무관) |
| 금액 | 인보이스 매출 × 율 | 기간 안 수금액(ex-IVA) × 율 — 수금할 때마다 **적립** |
| 지급 확정 | 완납 시 | 완납 시(적립분 전액) — 100 중 99 수금이면 미지급 |
| 지급일 | 완납월 익월 15일 | 동일 |

- 커미션 기간마다 **판정: 수금일 / 발행일** 을 고른다(수금 기준일 때만). 매출 기준 기간은 항상 발행일.
- **발행일이 매출 기준 기간에 속한 인보이스는 매출 커미션만** — 나중에 수금돼도 수금 커미션이 중복되지 않는다(예: palomino 10월 발행 → 11월 수금).
- 0250 이 **Oscar 의 수금 기간(2026-10-01~, 4%)만 수금일 판정으로** 바꾼다. 다른 사원은 종전(발행일) 그대로 — [커미션 설정]에서 사원별로 바꿀 수 있다.
- 이미 지급된 커미션은 지급 시점 금액으로 동결(불변).

**Oscar 예시** — 9월에 발행한 인보이스를 10월에 수금: 종전 0 → 이제 수금액(ex-IVA) × 4% 적립, 완납되는 달에 지급 확정. 현재 화면의 10월 수금 $3,694.44(ex-IVA, 완납분만 집계된 값) 기준으로도 적립 **$147.78 이상** — 부분수금이 있으면 그만큼 더 붙는다(배포 후 화면에서 확인).

### (2) 성과급 — 설정값 확인, 로직 변경 없음
Oscar: 매출목표 기준 · 100% 이상 **6,000** · 120% 이상 **10,000** · 미달 0 · 2026-10~2027-03 월별 목표(350k/385k/300k/400k/450k/550k). 이미 정확히 들어가 있었다. 테스트로 경계값(99.98% → 0 / 100% → 6,000 / 119% → 6,000 / 120% → 10,000)을 확인.

### (3) 박스·패널 클릭 → 상세 팝업 (수금·성과급 f/up 독려)

**이번 달 진척**
| 클릭 | 팝업 |
|---|---|
| 매출 패널 | 이번 달 매출 — 고객·발행일·인보이스번호·금액 + "매출 $X 더 하면 성과급 $6,000" |
| 수금 패널 | 수금목표 구성 — 당월 만기 / 연체 이월 인보이스, 이달 수금, **남은 금액(IVA 포함)** |
| 적립 커미션 | 이번 달 수금 건별 커미션, 인보이스 완납 여부 |
| 지급확정 커미션 | 완납된 인보이스와 커미션, 지급예정일 |
| 완납 대기 커미션 (신규 박스) | 적립됐지만 잔액이 남은 인보이스 — "잔액 $X 걷으면 커미션 $Y 지급" |
| 기대 성과급 | 월별 목표·실적·달성률·다음 구간까지 금액 |

**실적 조회 박스** — 기간 매출 / 기간 수금 / 미수잔액 / 연체 / 적립 커미션 / 지급확정 커미션 / 성과급, 각각 클릭 시 팝업. 실적 조회의 시작월·종료월·고객 필터를 그대로 따른다.

공통: **고객별 묶음 ↔ 전체 목록** 전환, 고객별 소계, 고객 전화가 있으면 **[WhatsApp 요청]** 버튼(스페인어 결제요청 문구가 채워진 WhatsApp 창만 열고, 전송은 사람이 직접). Esc·바깥 클릭으로 닫힘. 영업사원은 본인 것만 보인다.

### (4) 화면 문구·표
- 월별 표에 **적립 커미션 / 확정 커미션** 두 열, 고객별 표도 동일.
- 인보이스 보기: 기간 밖 발행분이라도 **미수가 남은 인보이스는 표시**(팔로업 대상).
- 커미션 내역: `수금일` 배지, "적립 $X · 완납 대기" 상태, "기간 내 수금 $X 기준" 표시.
- 내 커미션 조건(영업사원): "이 기간에 들어온 수금 × 율 적립 → 완납 시 지급(발행일 무관)".
- 덤: 커미션 내역의 `지급완료 Sun Nov 15` 날짜 깨짐 수정.

---

## ② 배포 — ⚠ 순서 준수

| 파일 | 레포 위치 | 구분 |
|---|---|---|
| `0250_commission_match_on_payment.sql` | `refatrix-api/migrations/0250_commission_match_on_payment.sql` | **신규** |
| `commissionRoutes.js` | `refatrix-api/src/routes/commissionRoutes.js` | 덮어쓰기 |
| `commissionBonus.js` | `refatrix-api/src/routes/commissionBonus.js` | 덮어쓰기 |
| `refatrix-commission.html` | `refatrix-commission.html` (레포 루트) | 덮어쓰기 |
| `commission_paydate.test.js` | `refatrix-api/test/commission_paydate.test.js` | (선택) 검증용 |
| `commission_paydate_e2e.test.mjs` | `refatrix-api/test/commission_paydate_e2e.test.mjs` | (선택) 검증용 |

1. GitHub Desktop **Fetch/Pull** → zip 을 레포 루트에서 풀어 반영.
2. **백엔드 push** → Railway **Success** 확인.
3. Railway 콘솔 **`npm run migrate`** → `apply 0250_commission_match_on_payment.sql` 확인.
   - 0250 전에도 500 없음(검증 완료). 다만 그 사이엔 모두 발행일 판정(종전)이고, 설정에서 「수금일」 저장 시 "migrate(0250) 먼저" 안내가 뜬다.
4. 커미션 화면 **Ctrl+Shift+R** → 탭 제목에 **`build b1005pay`**.

**배포 확인**
```bash
R=https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main
curl -s -o /dev/null -w "%{http_code}\n" "$R/refatrix-api/migrations/0250_commission_match_on_payment.sql?nc=$(date +%s)"   # 200
curl -s "$R/refatrix-api/src/routes/commissionRoutes.js?nc=$(date +%s)" | grep -c "PAYMODE_LATERAL"   # >0
curl -s "$R/refatrix-api/src/routes/commissionBonus.js?nc=$(date +%s)"  | grep -c "collection_targets" # >0
curl -s "$R/refatrix-commission.html?nc=$(date +%s)" | grep -c "b1005pay"                               # >0
```

---

## ③ 테스트 방법 (운영 · 5분)

1. 커미션 화면 → 영업사원 **oscar** 선택.
2. **이번 달 진척**: 「적립 커미션」이 10월 수금액 × 4%($147.78 이상)로 보이는지. 「완납 대기」 박스에 잔액 남은 인보이스가 잡히는지.
3. **수금 패널 클릭** → 10월 만기 + 연체 이월 인보이스 목록, 남은 금액(IVA 포함), WhatsApp 버튼.
4. **매출 패널 클릭** → 10월 매출 인보이스(고객·일자·번호·금액) + "매출 $X 더 → $6,000".
5. 실적 조회 박스 7개 각각 클릭 → 팝업 · 고객별/전체 목록 전환 · Esc 로 닫힘.
6. [커미션 설정] → oscar 기간이 **수금 · 수금일 기준 · 4%** 로 보이는지.
7. Oscar 로그인(영업사원) → 같은 팝업이 본인 데이터로만 열리는지.

---

## ④ 변경 요약 (기술)

**스키마 (0250)** — `commission_agent_periods.match_on TEXT NOT NULL DEFAULT 'invoice'` + CHECK(`invoice`/`payment`). 기존 기간은 `invoice`, Oscar 수금 기간만 `payment`. 재실행 안전(IF NOT EXISTS / DO 블록 / 조건부 UPDATE).

**`commissionRoutes.js`**
- `commissionMode()` 신규 · `computeLine()` 확장: `payment` 모드 = Σ(기간 내 수금 × 율) × subtotal/total 적립, 완납 시 확정. 반환에 `mode · accrued · collected_base · potential · relevant` 추가. `base` 는 그대로 인보이스 순매출(지급 후 차액 정산 기준 유지).
- `PERIOD_LATERAL` 에 `match_on`(to_jsonb — 0250 전 DB 에서도 동작), 신규 `PAYMODE_LATERAL`(기간 내 수금액·가중합, 지속 기간 율), `COMMISSION_SCOPE`(발행일 기간 없음 + 수금일 기간 있음도 대상).
- 기간 저장·조회에 `match_on` · `matchOnReady()` 60초 캐시 · 0250 전 `payment` 저장은 503 안내.
- overview `payout_paid_date` 를 `to_char` 로 고정(날짜 깨짐 수정).

**`commissionBonus.js`**
- 수금 내역 SQL 에 수금일별 `com_rate`(고객 예외율 우선), 인보이스 SQL 에 `match_on · po_rate · phone`(buyer_phone → phone).
- `buildPerf`: 월별 `commission_accrued`, 합계 `commission_accrued · commission_pending(+potential, open) · collection_cash`, 신규 목록 `payments`(수금 건별) · `collection_targets`(월별 수금목표 구성), 인보이스 행에 `open_total(IVA 포함) · open_end · late · due_gap · commission_total_accrued · commission_potential`, 성과급 `next_tier`.
- 수금 실적 표시는 실제 현금 기준. 「완납분만 인정」은 **성과급이 수금 기준일 때만** 적용(Oscar 처럼 매출 기준 성과급이면 무관).
- `/progress` 의 commission 에 `accrued · pending · pending_potential · pending_open · match_on`, `/performance` 에 `payments · collection_targets`.

**`refatrix-commission.html`** — 상세 팝업(공통 모달 · 이벤트 위임 · 키보드 Enter/Esc), 진척 KPI 6칸, 월별/고객별/인보이스 표 개편, 설정 모달 「판정」 열, 탭 제목 빌드 토큰.

---

## ⑤ 검증 결과

| 항목 | 결과 |
|---|---|
| 신규 순수 로직 `commission_paydate.test.js` | 9/9 |
| 신규 종단 `commission_paydate_e2e.test.mjs` (실 PG16 · 0001~0250) | 12/12 |
| 기존 커미션 회귀 (periods 13 · bonus 18 · bonus_e2e 12 · customer_owner 9 · nc_adjust 15) | 67/67 |
| `npm test` | 24/24 |
| `node --check` (백엔드 2 + 화면 스크립트) | 통과 |
| pglast — 두 파일의 SQL 62건 | 전부 파싱 |
| 0250 **미적용** DB — 엔드포인트 7종 | 전부 200, 기존 e2e 36건 통과 |
| 0250 두 번 실행 | 오류 없음 · Oscar 만 `payment`, Armando 등은 `invoice` 유지 |
| jsdom 화면(디렉터·영업사원) — 박스 13종 클릭·전환·Esc | JS 오류 0 |

종단 테스트 핵심 시나리오: 9/10 발행·9/20 절반·10/03 나머지 수금 → 10월분만 200 확정 / 9/15 발행·10/04 부분수금 → 적립 120·완납 대기·잔액 걷으면 +280 / 8월 완납분 → 목록 제외 / 매출 기간 발행 후 수금 → 매출 커미션만(중복 없음) / 종전 사원 동작 불변 / 지급 후 차액 정산 오탐 없음 / 성과급 경계값.

참고: 전체 테스트 스위트를 한 DB 로 돌리면 다른 테스트가 스키마를 바꿔(예: users.login_id) 커미션 e2e 가 boot 에서 실패한다 — 변경 전 코드도 동일. 깨끗한 DB 에서 커미션 테스트는 전부 통과.

---

## ⑥ 결정사항 (2026-10-05)

- 커미션 기간 판정은 **수금일**: 기간 안 수금액 × 율 적립, 인보이스 **미수 없이 완납 시** 지급 확정, 익월 15일 지급.
- Oscar: 2026-10 부터 수금 4%(수금일 기준) + 매출목표 성과급 100%↑ 6,000 / 120%↑ 10,000 / 미달 0.
- 수금·성과급 독려를 위해 진척·실적 박스 클릭 시 고객·일자·인보이스번호·금액 상세 팝업.

## ⑦ 오픈 이슈

1. **다른 사원도 수금일 기준으로 바꿀지** — 현재 Oscar 만. Armando(6/1~ 5%), dante, jaime, Maria 는 발행일 판정 그대로. 바꾸면 그 사원의 기간 시작 전 발행분도 기간 안 수금분만큼 커미션이 붙는다(9월 배치 미확정분이 늘 수 있음). [커미션 설정]에서 사원별 「판정」만 바꾸면 된다.
2. 고객 전화가 비어 있으면 WhatsApp 버튼이 안 보인다 — 고객마스터 `buyer_phone`/`phone` 점검 권장.
3. 「미수잔액」 박스는 기간 말 기준(ex-IVA), 팝업의 「지금 낼 금액」은 오늘 기준 IVA 포함 — 의도된 차이(팝업에 둘 다 표시).

## ⑧ 다음 액션

1. 배포 후 Oscar 10월 적립 커미션이 수금액 × 4% 로 보이는지 확인.
2. 다른 사원 판정 기준 결정(⑦-1).
3. 필요하면 영업사원용 주간 미수 f/up 리스트를 WhatsApp 으로 자동 발송(현재는 버튼으로 창만 엶).
