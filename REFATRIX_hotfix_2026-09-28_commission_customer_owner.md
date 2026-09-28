# REFATRIX 핫픽스 — 커미션 수혜자 = 고객마스터 담당자

- 작업일: 2026-09-28
- 마이그레이션: **없음** · nav.js·HTML 변경: **없음** (백엔드 3파일만)
- 산출물: `refatrix_commission_owner_0928.zip` (레포 구조 그대로 → 루트에서 풀면 제자리)
- 검증: 신규 종단 8 + 기존 커미션·성과급 종단 12 + 순수 31 + 매출총이익 9 = **전부 통과**. 신규 테스트는 **수정 전 코드에서 6건 실패**(버그 재현 확인).

---

## ① 증상과 원인

**증상**: 재무 > 커미션에서 palomino 실적이 0건.

**원인**: 커미션이 `sales_invoices.owner_id` 로 귀속되고 있었는데, 이 값은 **매출을 등록한 사람**이다.
매출 등록은 대부분 영업지원(Maria)이 하므로 영업사원 고객의 매출이 Maria 앞으로 잡혔고,
Maria는 커미션 대상이 아니라 **어느 영업사원에게도 잡히지 않고 빠졌다.**

운영 데이터 점검(2026-09-28, 최근 매출 목록 49건):

| 고객마스터 담당자 | 인보이스 owner | 건수 | 매출(ex-IVA) | 영향 |
|---|---|---|---|---|
| palomino | Maria | 4 | $24,413 | **누락** (매출 3% ≈ $732) |
| Armando | Maria | 2 | $46,571 | **누락** |
| oscar | Maria / 디렉터 | 32 | $166,384 | 커미션 시작일 10-01이라 아직 영향 없음 → 10월부터 누락될 예정이었음 |
| dante · jaime | Maria | 4 | $0 | — |

## ② 규칙 (디렉터 확정)

1. **커미션 수혜자 = 고객마스터 담당자** (`customers.owner_id`). 인보이스 등록자는 무관.
2. **이미 지급(반제)된 라인은 지급받은 사람으로 동결** (`commission_payouts.agent_id`).
   고객 담당을 이관해도 지급분은 그대로, **미지급분만 새 담당자**에게 넘어간다 → 이중지급 없음.
3. 고객마스터에 담당자가 없거나, 담당자가 커미션 대상이 아니면 제외.
4. 요율·기간·고객별 예외율도 모두 수혜자(고객 담당자) 기준으로 조회.

## ③ 변경 파일

| 파일 | 내용 |
|---|---|
| `refatrix-api/src/routes/commissionRoutes.js` | `BENEFICIARY_LATERAL` 신설, 내역·지급대상·월확정·레거시 지급 4개 쿼리 전환 |
| `refatrix-api/src/routes/commissionBonus.js` | 실적 조회·진척·성과급의 인보이스/수금 집계 전환 |
| `refatrix-api/src/routes/grossProfitRoutes.js` | 매출총이익의 커미션 비용도 같은 기준 |
| `refatrix-api/test/commission_customer_owner_e2e.test.mjs` | (신규·선택) 종단 검증 |
| `refatrix-api/test/commission_bonus_e2e.test.mjs` | (선택) 픽스처를 "고객 담당자 = 영업, 등록자 = 디렉터"로 갱신 |

`sales_invoices.owner_id` 는 **건드리지 않는다**(등록자 기록으로 유지). 데이터 보정 불필요 — 조회 시점에 고객마스터를 따라간다.

## ④ 배포

1. zip 을 레포 루트에서 풀어 덮어쓰기.
2. GitHub Desktop → **Fetch/Pull → Commit → Push** → Railway 재배포 **Success** 확인.
3. `npm run migrate` **불필요**. 화면 파일 변경 없음(하드 리프레시만).

```bash
R=https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main
curl -s "$R/refatrix-api/src/routes/commissionRoutes.js?nc=$(date +%s)" | grep -c "BENEFICIARY_LATERAL"   # 5
curl -s "$R/refatrix-api/src/routes/commissionBonus.js?nc=$(date +%s)"  | grep -c "BENEFICIARY_LATERAL"   # 4
curl -s "$R/refatrix-api/src/routes/grossProfitRoutes.js?nc=$(date +%s)" | grep -c "ben.uid"             # 3
```

## ⑤ 운영 확인 (5분)

1. 커미션 → 영업사원 **palomino** 선택 → 9월 인보이스 4건(C-0063 · P-0005 ×3), 매출 기준 3% **확정**으로 보이는지. 합계 ≈ $732.
2. **Armando** → Maria가 등록한 2건이 추가되어 보이는지(수금 5% · 완납 전이면 `기대`).
3. **전체(영업사원별 요약)** → Maria 줄이 없는지.
4. palomino 로그인 → 본인 4건만 보이는지.

## ⑥ 참고

- 고객 담당 이관 시 **미지급 커미션이 새 담당자로 이동**한다(규칙 2). 과거 매출을 전 담당자에게 남기려면 이관 전에 그 달 커미션을 지급 처리할 것.
- 커미션 시작일 이전 발행분은 종전대로 제외(기간 규칙 불변). oscar 는 10-01 부터.
