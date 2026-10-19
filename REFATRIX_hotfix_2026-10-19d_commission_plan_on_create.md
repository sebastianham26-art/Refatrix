# REFATRIX 핫픽스 — 커미션 결재문서 생성 즉시 미래자금계획 반영 · 실적은 수동 (2026-10-19d)

**마이그레이션 없음** · 화면 build **커미션 `b1019cg`** · **전자결재 `b20261019cg`** · nav.js 변경 없음
**산출물** `refatrix_commission_plan_20261019d.zip` (repo 최상위에 풀기) + 개별 파일
> 직전에 전달한 `…cashflow_20261019c`(수령증 업로드 때 현금 계좌 실적 자동 등록)는 **폐기** — 이 패키지가 대신한다. 라이브(`d1cafed`) 기준으로 만들었다.

## ① 설명

디렉터 지시: 「결재문서를 생성하면 미래자금계획에 반영이 되도록 해주고, 실적은 수동으로 하게 해줘.」

| 시점 | 미래자금계획 / 거래등록 |
|---|---|
| **지급승인 문서 생성(임시저장)** | 지출 예정 1행 즉시 생성 — 일자 = 지급예정일(반제월 익월 15일) · 과목 6030 · 계좌 미지정 · 메모 `[전자결재] … 커미션 지급 승인` |
| 임시저장 수정 · 결재 중 내용 수정 | 예정 금액·일자 따라감(회차 교체 시 옛 예정은 정리 — 고아 없음) |
| 상신 · 회수 · 승인 | 같은 예정 행 유지(문서번호가 생기면 메모 갱신) |
| 반려 · 삭제 | 예정 빠짐 · 재기안(새 버전)·복구하면 다시 생김 |
| 서명 수령증 업로드 | 커미션 지급 전표 + 문서 집행(현금 · 「수령증」) → 사후승인 대기. **예정은 그대로 남는다**(지급일·실적 금액으로) |
| **실적(수동)** | 재무 › 거래등록에서 이 문서 회차를 골라 현금 계좌로 출금 등록 → 예정 행이 그 실적으로 바뀜(기존 0258 경로) |

- 커미션 패널에 「💰 현금흐름: 미래자금계획 지출 예정 YYYY-MM-DD · 금액」/「거래등록 실적 등록됨」 표시.
- 지급·마감 후 「💰 거래등록에서 실적 등록 ↗」 버튼 — 거래등록 신규 화면이 이 문서 회차를 고른 채로 열린다(`refatrix-finance.html#tab=new&apay=…`).
- 실적을 먼저 등록하고 나중에 수령증을 올려도 된다(이미 집행완료면 수령증만 증빙으로 붙음).
- 일반 비용 품의는 그대로(승인 후부터 예정). 커미션 지급승인 문서만 예외.

## ② 배포 단계

1. zip 풀기 → Fetch/Pull → Commit → Push → Railway **Success** (migrate 불필요)
2. Ctrl+Shift+R → 탭 제목 `b1019cg` / `b20261019cg`

```bash
R=https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main
curl -s "$R/refatrix-commission.html?nc=$(date +%s)" | grep -c "b1019cg"                          # 1
curl -s "$R/refatrix-api/src/approvalFinance.js?nc=$(date +%s)" | grep -c "isCommissionDoc"        # 2+
curl -s "$R/refatrix-api/src/routes/approvalRoutes.js?nc=$(date +%s)" | grep -c "detachPlans"      # 2+
```

> 이미 만들어 둔 커미션 임시저장·결재중 문서는 다음 저장·상신·결재 동작 때 예정이 생긴다.

## ③ 테스트 방법

1. 커미션 › 사원·확정 월 → 「전자문서 생성」 → 녹색 메시지 「미래자금계획에 지출 예정 반영」 · 패널에 「현금흐름: 미래자금계획 지출 예정 (익월 15일)」
2. 재무 › 미래자금계획에서 `[전자결재] … 커미션 지급 승인` 지출 예정 확인
3. 전자결재에서 임시저장 금액을 바꿔 저장 → 예정 금액 변경 · 반려하면 예정 사라짐
4. 승인 → 수령증 업로드 → 예정이 그대로 있는지 · 「거래등록에서 실적 등록 ↗」 → 현금 계좌로 등록 → 예정이 실적으로 바뀌고 패널에 「거래등록 실적 등록됨」

## ④ 변경 파일

| repo 경로 | 내용 |
|---|---|
| `refatrix-api/src/approvalFinance.js` | 커미션 문서는 임시저장·결재중에도 예정(`isCommissionDoc`) · `detachPlans`(회차 교체 전 예정 정리) |
| `refatrix-api/src/routes/approvalRoutes.js` | 회차 교체 전 `detachPlans` · 임시저장 수정/삭제·반려·회수·재기안·내용 수정 뒤 `syncApprovalDoc` |
| `refatrix-api/src/routes/commissionRoutes.js` | 문서 생성 직후 `syncApprovalDoc` · 상태 조회에 회차의 예정/실적 상태 |
| `refatrix-commission.html` | build `b1019cg` · 현금흐름 표시 · 거래등록 바로가기 |
| `refatrix-approval.html` | build `b20261019cg` · 안내 문구 |
| `refatrix-api/test/commission_approval_e2e.test.mjs` · `commission_approval_front.test.mjs` | 생성 즉시 예정 · 수정/반려 반영 · 업로드 후 예정 유지 · 거래등록 수동 실적 |
| `refatrix-api/test/approval_front.test.mjs` · `approval_finance_front.test.mjs` | 빌드 토큰 |

## ⑤ 검증

- 빈 DB(0001~0287) 실 PostgreSQL: commission_approval_e2e **11/11**(생성 즉시 예정 `2026-08-15 · 600 · 6030` → 상신·승인 후 같은 행 → 업로드 후에도 예정 → 거래등록(현금 계좌) 등록 시 **같은 행이 실적** · 반려 시 예정 0 · 임시저장 금액 120→100 따라감·고아 0) · commission_approval_front **2/2**
- 회귀: commission 104/104 · approval 24/24 · approval_front 2/2 · approval_finance 3/3(F2 「전자결재 라우트는 거래 테이블 직접 접근 안 함」 유지) · `approval_finance_front` G1 1건은 기존 코드와 같은 실패

## ⑦ 오픈 이슈

- 거래등록 실적을 등록하지 않으면 예정이 계속 남는다(지급일로). 미등록 건을 자금일보/미래자금계획에서 따로 표시할지는 요청 시.
