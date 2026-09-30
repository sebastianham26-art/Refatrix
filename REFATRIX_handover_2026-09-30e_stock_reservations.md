# REFATRIX 인수인계 · 2026-09-30e · 재고 예약 현황 화면 + 예약 자동충당 + 수주흐름 추이 가용 오류 수정

기준 커밋: live main `d814359` (APAR) 위에 작업 — 작업 중 main 이 `cc6c7c8 → d814359` 로 바뀌어(재무 일일자금·설문 로그인, 마이그레이션 0239·0240 선점) **새 main 위에서 다시 적용**했다.

## ① 설명

### A. 재고 예약 현황 화면 (`refatrix-reservations.html`, 영업 · 영업지원 메뉴 › 「재고 예약 현황」)
견적 접수 때 잡힌 재고 예약을 **누가 · 언제 · 어떤 제품을 · 몇 개 · 어떤 견적번호로 · 언제 풀리는지** 한 화면에서 본다.

- **KPI**: 예약 중 견적 · 예약 SKU · 예약 수량 · 예약 금액(IVA 제외) · ⏰ 2시간 내 해제 견적 · 📦 포장지시(시간 무관). 마지막 두 카드는 누르면 필터.
- **견적별 보기**(기본, 곧 풀리는 순): 남은 시간 배지(2h 이내 빨강 / 6h 이내 노랑 / 그 외 초록 / 포장지시 회색 「출고까지 유지」) · 해제 예정 시각 · 견적번호(누르면 견적 목록에서 그 번호로 바로 검색) · 고객 · 예약자 · 예약(접수) 시각 · 근무시간 외 접수면 「기산」 시각 · 줄별 제품/예약 수량(요청보다 적으면 「/ 요청 N」) · 금액.
- **제품별 보기**: 제품 · 현재고 · **회사 전체 예약** · 가용 · 이 목록 예약(건수) · 다음 해제. 행을 누르면 그 제품을 잡은 견적들이 펼쳐진다.
- **예약자**: 내부 견적 = 작성자 이름(로그인ID). 웹카달록 견적 = 「웹카달록 · 담당 ○○」(지정 담당자, 없으면 담당 미지정).
- **필터**: 검색(제품코드·제품명·견적번호·고객·예약자) · 예약자 · 해제(전체/2h/6h/포장지시) · 출처(내부/웹카달록). **최근 풀린 예약**(24h/48h/7일) 선택 시 만료로 풀린 예약이 아래 카드에 따로 나온다.
- 30초마다 남은 시간 갱신, 누가 풀리면 즉시 다시 받아옴, 2분마다 자동 새로고침. 엑셀 다운로드.
- 가시성은 견적 목록과 동일(디렉터·영업지원 = 전체, 영업 = 자기 팀 고객 + 본인 불특정 견적). 제품별 현재고/전체 예약/가용은 팀과 무관한 회사 전체 숫자.

### B. Q-2026-0280 원인과 수정 (디렉터 보고 09:54)
증상: 「4개 중 2개만 가능」인데 가용재고 4로 보임 · 수주흐름 추이에는 100% 가용.

1. **예약이 자동으로 채워지지 않았다.** 즉시/부족 판정은 저장 순간 잡힌 `reserved_qty` 스냅샷, 가용 칸은 지금의 「현재고 − 타 견적 예약」. 앞 견적이 만료·전환·삭제되거나 입고·실사로 재고가 늘어도 「재고 재검증」을 누르기 전까지 예약은 그대로였다.
   → **1분 스위퍼(`topUpReservations`)** 가 만료 처리 직후, 남는 재고를 부족한 미결 견적에 **접수 순서대로** 채운다. 늘리기만 하고 줄이지 않는다. 만료시각은 그대로. 포장지시 출력·만료·삭제 견적은 제외. 제품 행 `FOR UPDATE` 잠금으로 견적 저장과 직렬화(같은 재고 이중 배정 없음).
2. **추이의 가용 판정이 다른 견적 예약을 빼지 않았다.** `stock_flag`/`avail_stock` 이 저장 시 buildLines 에서 **물리 재고만** 보고 매겨졌다.
   → `assignReservations` 가 **실제 배분 결과**로 `stock_flag`(예약 ≥ 요청 ? ok : low_stock) 와 `avail_stock`(그 순간 쓸 수 있던 가용)을 적는다. 수동 「재고 재검증」은 `stamp:false` — 추이의 「요청 시점」 기록은 기존 원칙대로 보존.
   → 마이그레이션 **0241** 이 과거의 모순 줄(stock_flag=ok 인데 예약<요청)을 low_stock 으로 정정. 예약 제도(0064) 이전 견적은 제외.

## ② 배포단계
1. GitHub Desktop **Fetch/Pull** (live main `d814359` 이후 변경이 없는지 확인)
2. **백엔드 먼저 커밋·푸시**: `refatrix-api/src/reservations.js`, `refatrix-api/src/routes/reservationRoutes.js`, `refatrix-api/src/server.js`, `refatrix-api/src/quoteBuild.js`, `refatrix-api/src/routes/quoteRoutes.js`, `refatrix-api/migrations/0241_quote_stock_flag_restate.sql`, 테스트 6개
3. Railway 배포 **Success** 확인
4. Railway 콘솔 `npm run migrate` → `apply 0241_quote_stock_flag_restate.sql` 확인
5. **프런트 커밋·푸시**: `refatrix-reservations.html`, `refatrix-nav.js`, `refatrix-quotelist.html`, 나머지 HTML 55개(nav 토큰 `20260930td → 20260930ur`)
6. `Ctrl+Shift+R`, 탭 제목 확인: 재고 예약 현황 `rsv-0930a`, 견적 목록 `ql-0930rsv`

## ③ 테스트방법
- 영업 › 재고 예약 현황: 지금 예약 중인 견적이 곧 풀리는 순으로 보이는지, 남은 시간이 줄어드는지.
- 견적번호 클릭 → 견적 목록이 그 번호 검색 상태로 열리는지.
- 제품별 보기에서 가용 = 현재고 − 전체 예약인지.
- **Q-2026-0280**: 배포 후 1분 안에 견적 상세 즉시 확보가 4/4 로 바뀌는지(아직 미결·미만료·포장지시 전이라면). 수주흐름 추이에서 그 견적이 100% 로 나오지 않는지(0241 적용 후).
- 최근 풀린 예약 48시간 선택 → 만료된 견적이 아래 카드에 나오는지.
- 영업 계정으로 다른 팀 견적이 안 보이는지.

## ④ 변경파일

| 저장소 경로 | 구분 | 내용 |
|---|---|---|
| `refatrix-api/src/reservations.js` | 신규 | 예약 상태·예약자·기산·제품별 묶음·요약(순수 함수) |
| `refatrix-api/src/routes/reservationRoutes.js` | 신규 | `GET /api/reservations[?released=N]` 읽기 전용 |
| `refatrix-api/src/server.js` | 수정 | reservationRoutes import·register |
| `refatrix-api/src/quoteBuild.js` | 수정 | assignReservations `stamp` 옵션(stock_flag·avail_stock 실제 배분) + `topUpReservations` 신규 |
| `refatrix-api/src/routes/quoteRoutes.js` | 수정 | 1분 스위퍼에 자동충당 연결 · 재검증은 `stamp:false` |
| `refatrix-api/migrations/0241_quote_stock_flag_restate.sql` | 신규 | 모순 stock_flag 정정 |
| `refatrix-api/test/reservations.test.mjs` | 신규 | 순수 로직 · pg-mem · jsdom |
| `refatrix-api/test/reservations_e2e.test.mjs` | 신규 | 실 PostgreSQL 종단 |
| `refatrix-api/test/reservation_topup_e2e.test.mjs` | 신규 | 자동충당·stamp·0241 실 PostgreSQL |
| `refatrix-api/test/quote_revalidate_sql.test.mjs` | 수정 | 새 시그니처 추출 · 임시 스키마에 stamp 칸 |
| `refatrix-api/test/approval_front.test.mjs` | 수정 | nav 토큰 `20260930ur` |
| `refatrix-api/test/treasury_daily_front.test.mjs` | 수정 | nav 토큰 `20260930ur` |
| `refatrix-reservations.html` (저장소 루트) | 신규 | 재고 예약 현황 화면 |
| `refatrix-nav.js` (저장소 루트) | 수정 | 화면 `reservations` 추가(영업·영업지원, 권한 quote/sales) · v20260930ur |
| `refatrix-quotelist.html` (저장소 루트) | 수정 | `?q=` 로 들어오면 그 번호 검색 · 빌드 `ql-0930rsv` |
| 그 외 `refatrix-*.html` 55개 (저장소 루트) | 수정 | nav 캐시 토큰 `20260930ur` 만 |

## ⑤ 검증결과
- `node --check`: src 전체 + nav.js + 페이지 인라인 스크립트 통과
- pglast: 라우트 SQL 5건 + 자동충당/배분 SQL + 0241 통과
- pg-mem: 라우트 실행 통과(한계 2가지는 시험에서만 우회 — `= ANY($n)` 숫자배열, 상관 서브쿼리 바깥 별칭. 운영 SQL 은 그대로)
- jsdom: 화면 견적별/제품별·필터·KPI 클릭·검색·펼치기·최근 해제 요청 통과, 인라인 onclick 없음
- **실 PostgreSQL 16**(마이그레이션 0001~0241 전부 적용한 새 DB): reservations_e2e 9/9, reservation_topup_e2e 7/7, 서버 기동 시 스위퍼 자동충당 스모크(0→3) 확인
- 회귀: quote_revalidate_sql 12/12, crm_quote_inbound 35/35, crm_order_status 18/18, quote_customer_po 3종, customer_exclusivity_e2e 12/12, treasury_daily 2종, survey_public 7/7 등 통과
- 기존부터 실패(이번 변경 전 main 에서도 동일): approval_front F1, quote_devreq_on_save 실DB, customer_registration E8, packing_rack_sql, product_status, quote_list_gp

## ⑥ 결정사항
- 예약 규칙 자체(선착순·24h·근무시간 기산·포장지시 유지)는 바꾸지 않았다. 화면은 가용재고 계산과 **같은 SQL 조건**으로 읽는다(시험으로 고정).
- 풀린 재고는 **접수 순서(created_at)** 로 자동 배분. 이미 잡힌 예약은 줄이지 않는다.
- 자동충당·수동 재검증은 추이 스냅샷(stock_flag)을 바꾸지 않는다 — 추이는 「요청 시점에 즉시 가능했나」를 뜻한다.
- 0241 은 과거 수주흐름 추이의 즉시가용 %를 **아래로 정정**한다(부풀려진 기록 제거).

## ⑦ 오픈이슈
- 0241 적용 후 수주흐름 추이 과거 월 수치가 내려간다 — 원치 않으면 0241 을 빼고 배포(신규 저장분만 정확해짐).
- 견적 작성 화면 미리보기의 재고 표시는 아직 물리 재고 기준(저장 후 상세/목록은 정확).
- 매출전환·취소로 풀린 예약은 「최근 풀린 예약」에 넣지 않았다(만료만). 필요하면 추가.

## ⑧ 다음액션
- 배포 후 Q-2026-0280 이 4/4 로 채워졌는지 확인.
- 창고 역할(warehouse)에도 이 화면이 필요하면 권한 키 추가 결정.
