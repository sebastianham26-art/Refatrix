# REFATRIX 핫픽스 2026-11-03 — 고정비(SUA·임차료) 중복 예정

## ① 설명

**증상** — 현금흐름 11-03에 SUA 25,000 2건 + 11-15에 SUA 25,000 1건, 임차료 69,600 2건이 잡힘(한 달에 같은 고정비 2~3건).

**원인** — 중복 규칙·생성 버그가 아님. 9·10월 SUA와 10월 임차료를 **전자결재로 지급**했는데(EXP-2026-0007/0010/0014), 전자결재 실적이 고정비 회차와 연결되지 않아 고정비 예정 3건이 미처리로 남음 → 「지난 예정은 오늘로 이월」 규칙으로 11-03에 이번 달 회차와 겹쳐 표시.

| 거래 # | 내용 | 실제 지급 | 조치 |
|---|---|---|---|
| 2577 | SUA 2026-09-15 예정 25,000 | 10-13 EXP-2026-0010 13,046.48 | 2026-11-03 삭제 |
| 2578 | SUA 2026-10-15 예정 25,000 | 10-15 EXP-2026-0014 55,856.46 | 2026-11-03 삭제 |
| 2550 | renta bodega 2026-10-01 예정 69,600 | 10-07 EXP-2026-0007 69,600 | 2026-11-03 삭제 |
| 224 | renta bodega 2026-11-01 | — | 유지(11월분) |
| 1780 | SUA 2026-11-15 | — | 유지(11월 유일한 SUA) |

데이터 정리(소프트 삭제, 디렉터 확인 후 실행) → 11-03 유출 −119,600.

**재발 방지 (Sebastian 결정: 둘 다)**

1. **전자결재 ↔ 고정비 대체** — 전자결재 작성 화면에 「고정비 대체」 카드. 과목·지급월이 맞는 고정비 회차를 「추천」으로 보여주고, 체크하면 결재가 살아 있는 동안(승인완료 · 디렉터/커미션 문서는 임시저장부터) 그 고정비 예정을 숨김 → 같은 지출이 결재 한 건으로만 잡힘. 반려·삭제·선택 해제 시 이 문서가 숨긴 회차만 되살림. 상세 화면·이력에 「고정비 대체」 표시.
2. **안전장치(자동 숨김)** — 고정비 회차 예정의 유효월이 이번 달 이전이고, 그 고정비가 이번 달에도 돌고 있으면(활성 · 시작 ≤ 이번 달 · 종료월 없음/≥ 이번 달) 현금흐름·은행계좌별 필요자금·이번 달 달력·일일 자금에서 제외. 데이터 불변, 실적 불변. 종료된 고정비의 미처리분은 진짜 미지급일 수 있어 그대로 이월. 일일 자금 대사 줄에 「지난달 미처리 고정비 N건(이번 달 회차로 대체)」 표시.

## ② 배포단계

1. GitHub Desktop **Fetch/Pull** → 아래 백엔드 파일 복사 → push → Railway **Success** 확인
2. Railway 콘솔 `npm run migrate` → `apply 0313_approval_replaces_recurring.sql`
3. 프런트 2개 파일 push
4. 브라우저 `Ctrl+Shift+R` → 탭 제목 확인: 전자결재 `b20261103rep` · 일일 자금 `cashd-1103a`

## ③ 테스트방법

- 재무 › 현금흐름(BBVA, 11월): 11-03에 SUA 없음, 임차료 69,600 1건 · 11-15 SUA 25,000 1건
- 전자결재 › 새 품의: 카테고리 SUA 과목 선택 + 지급일 11월 → 「고정비 대체」에 SUA 11-15 「추천」 → 체크 → 승인 후 현금흐름에서 고정비 SUA가 빠지고 결재 금액만 잡힘
- 그 결재 반려/삭제 → 고정비 SUA 11-15 다시 보임

## ④ 변경파일

| 레포 경로 | 구분 | 내용 |
|---|---|---|
| `refatrix-api/migrations/0313_approval_replaces_recurring.sql` | 신규 | `approval_documents.replaces_txn_ids` · `transactions.replaced_by_doc` |
| `refatrix-api/src/recurring.js` | 수정 | `ruleRunsInMonth` · `isSupersededRecurringPlan` · `runningRuleIds` |
| `refatrix-api/src/approvalFinance.js` | 수정 | 대체 동기화·후보·저장·상세·재기안 복사 |
| `refatrix-api/src/routes/approvalRoutes.js` | 수정 | 저장 시 `replaces_txn_ids` · `GET /api/approvals/recurring-candidates` · 상세 `replaces` |
| `refatrix-api/src/routes/financeRoutes.js` | 수정 | `/api/cashflow` · `/funding` · `/month`(이번 달) 안전장치 |
| `refatrix-api/src/treasuryDaily.js` | 수정 | 일일 자금 예정에서 `superseded` 제외 + 대사 건수 |
| `refatrix-api/test/recurring_replace_1103.test.mjs` | 신규 | 서버 + jsdom 흐름 테스트 |
| `refatrix-api/test/treasury_daily.test.mjs` | 수정 | 빌드 토큰 |
| `refatrix-api/test/treasury_daily_front.test.mjs` | 수정 | 빌드 토큰 |
| `refatrix-api/test/commission_approval_front.test.mjs` | 수정 | 빌드 토큰 |
| `refatrix-approval.html` | 수정 | 「고정비 대체」 카드·상세 표시 · `b20261103rep` |
| `refatrix-cashdaily.html` | 수정 | 대사 줄 문구 · `cashd-1103a` |

기준: 라이브 main `38bde50` (2026-11-02 15:27) — 작업 직후 재확인, 변동 없음.

## ⑤ 검증결과

- `node --check` 백엔드 5개 + HTML 인라인 스크립트 2개 통과
- 실제 PostgreSQL 16 전체 마이그레이션(0001~0313) 적용 성공
- E2E(실 PostgreSQL) 31/31: 순수 규칙 9 · 일일 자금 3 · 전자결재 대체/반려/해제/직접삭제 보존/규칙 삭제/비공개 권한 16 · 상세·재기안 3
- 신규 `recurring_replace_1103.test.mjs`(서버 + jsdom) 2/2: 현금흐름 유출 = 이번 달 SUA 1건 · 추천 표시 · 체크 → 저장 본문 · 상세 표시 · 삭제 → 되살림 · 화면 JS 오류 0
- 기존 테스트 기준선 비교: recurring 14 · cashflow 13 · treasury_daily 11 · treasury_daily_front 1 · approval 21 · approval_finance 2 · commission_approval_e2e 3 · commission_approval_front 1 — 모두 통과(변경 전과 동일)
- 아키텍처 가드 유지: 전자결재 라우트는 `transactions`를 직접 다루지 않음(연동 모듈 경유)
- 사전 실패(변경과 무관, 기준선에서도 실패): `approval_front`·`approval_finance_front` — 옛 빌드 토큰 `b20261023va` 고정

## ⑥ 결정사항

- 9·10월 잔여 예정 3건 즉시 삭제 (Sebastian 2026-11-03)
- 재발 방지: 전자결재 ↔ 고정비 연결 + 지난달 미처리 자동 숨김 둘 다 (Sebastian 2026-11-03)
- 추천은 표시만, 자동 체크하지 않음(오판 방지)
- 과거 달 달력·계획대비실적은 이력 그대로(안전장치 미적용)

## ⑦ 오픈이슈

- 전자결재 실적 금액이 고정비 금액과 다를 때(SUA 13,046 vs 25,000) 고정비 금액 자체를 조정할지는 별도 판단 — 지금은 결재 금액이 우선
- `approval_front`·`approval_finance_front` 테스트의 옛 빌드 토큰 정리 필요

## ⑧ 다음액션

1. 배포 후 Christopher에게: SUA·임차료를 전자결재로 올릴 때 「고정비 대체」에서 해당 월을 체크하도록 안내
2. 11월 SUA를 전자결재로 지급하면 11-15 고정비 회차를 대체 체크
