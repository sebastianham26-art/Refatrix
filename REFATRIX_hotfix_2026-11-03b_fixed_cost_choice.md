# REFATRIX 핫픽스 2026-11-03b — 전자결재 「고정비 선택」 (SAT·SUA)

## ① 설명

**요청** — SAT·SUA를 고정비로 등록해 둔 상태에서 전자결재를 쓰면 자금계획에 둘 다 잡힌다. 결재 작성 때 세금과공과 → SAT/SUA를 고르게 하고, 자금계획에서는 고정비 금액을 지우고 결재 금액으로 반영.

**확인한 현황** — 전자결재에 「세금과공과」 카테고리가 없어 SAT 결재가 「기타」로 올라가고 있었음(EXP-2026-0023 SAT (sep) 27,949, 11-03). 같은 달 고정비 SAT(11-05 35,000)와 함께 잡혀 이중 계상. 세금과공과 과목의 고정비: SAT(매월 5일 35,000) · SUA(매월 15일 25,000) · utility(매월 5일 5,000).

**변경**
1. 전자결재 카테고리 **「세금과공과」 추가**(재무 과목 = 세금과공과, 0314 마이그레이션에서 없을 때만).
2. 작성 화면 **「고정비 선택」 (필수)** — 카테고리의 재무 과목에 고정비가 있으면 칩으로 표시: `SAT · 매월 5일 · 35,000` / `SUA …` / `utility …` / **고정비 아님** / 회차 직접 고르기. 고르지 않으면 상신이 막힘(화면 + 서버 둘 다).
3. 고르면 미리보기: `2026-11 SAT 고정비 11-05 35,000 → 이 결재 27,949`.
4. 서버가 결재 지급월(회차 예정일의 달)마다 그 고정비 회차를 찾아 대체 목록에 넣음. **아직 [생성] 안 한 달이면 회차를 만들어 바로 대체**(자동전개가 다시 띄우지 않음). 정기·분할 결재는 회차마다 그 달의 고정비를 대체.
5. 결재가 살아 있으면(직원 문서 = 승인완료, 디렉터·커미션 문서 = 임시저장부터) 자금계획의 고정비 금액은 빠지고 결재 금액만 남음. 반려·삭제·「고정비 아님」으로 바꾸면 고정비가 되살아남. 지급일을 바꾸면 대체 회차도 그 달로 옮겨감(결재 중 내용 수정 포함). 재기안은 선택을 이어받음.
6. 비공개 고정비는 디렉터에게만 보이고 디렉터만 고를 수 있음.

## ② 배포단계

1. GitHub Desktop **Fetch/Pull** → 백엔드 파일 push → Railway **Success**
2. Railway 콘솔 `npm run migrate` → `apply 0314_approval_fixed_cost_choice.sql` (전자결재 카테고리 「세금과공과」 생김)
3. `refatrix-approval.html` push → `Ctrl+Shift+R` → 탭 제목 `b20261103fc`
4. 전자결재 › 설정 › 카테고리에서 「세금과공과」의 중간결재·합의 단계를 필요하면 지정(기본: 디렉터 결재만)

## ③ 테스트방법

- 전자결재 › 새 품의 → 카테고리 「세금과공과」 → 「고정비 선택 *」에 SAT·SUA·utility 칩
- 칩을 안 고르고 상신 → 안내 문구로 막힘
- SAT 선택 + 지급일 11월 → 미리보기 「2026-11 SAT 고정비 11-05 35,000 → 이 결재 …」
- 승인 후 재무 › 현금흐름: 11-05 SAT 35,000 사라지고 결재 금액만

## ④ 변경파일 (기준: 라이브 main `5e153d3`, 2026-11-03 13:57 — 0313 배포본)

| 레포 경로 | 구분 | 내용 |
|---|---|---|
| `refatrix-api/migrations/0314_approval_fixed_cost_choice.sql` | 신규 | `replace_choice` · `replace_rule_id` · 카테고리 「세금과공과」 |
| `refatrix-api/src/approvalFinance.js` | 수정 | `fixedCostRules` · `applyRuleChoice`(회차 찾기/생성→대체) · `ruleChoiceMissing` · 재기안 복사 |
| `refatrix-api/src/routes/approvalRoutes.js` | 수정 | 저장·내용수정·상신 연결, 후보 API에 `rules`, 상세에 선택값 |
| `refatrix-api/test/recurring_replace_1103.test.mjs` | 수정 | 고정비 선택 화면·서버 흐름 테스트 |
| `refatrix-api/test/commission_approval_front.test.mjs` | 수정 | 빌드 토큰 |
| `refatrix-approval.html` | 수정 | 「고정비 선택」 칩·미리보기·상신 검사 · `b20261103fc` |

## ⑤ 검증결과

- `node --check` 백엔드 2개 + 페이지 인라인 스크립트 통과
- 실제 PostgreSQL 16: 0001~0314 전체 적용, 0314 재실행 시 카테고리 중복 없음(멱등)
- `recurring_replace_1103.test.mjs`(서버 + jsdom) 2/2 — 필수 표시 · 미선택 상신 차단 · SUA 선택 미리보기(25,000 → 27,840) · 저장 시 서버가 지급월 회차를 대체 · 편집 화면 선택 유지 · **미생성 달(두 달 뒤) 회차 생성 즉시 대체, 그 달 유출 = 결재 20,000만** · 지급월 변경 시 대체 이동 · 「고정비 아님」 → 되살림 · 서버 상신 검사(`fixed_cost_choice_required`) · 화면 JS 오류 0
- 기존: recurring 14 · cashflow 13 · treasury_daily 19 · treasury_daily_front 2 · commission_approval_e2e 13 통과
- 기준선과 동일한 사전 실패(변경과 무관): approval C·D·E, approval_finance F3 E2E — 라이브 main 그대로 돌려도 같은 4건 실패. commission_approval_front DB 모드는 이 환경에서 라이브 main도 멈춤

## ⑥ 결정사항

- 세금과공과처럼 고정비가 걸린 과목은 고정비 선택이 상신 필수 (Sebastian 2026-11-03)
- 대체 기준 = 결재 지급월의 그 고정비 회차, 자금계획에는 결재 금액 반영 (Sebastian 2026-11-03)

## ⑦ 오픈이슈

- 이미 올라간 EXP-2026-0023 SAT (sep) 27,949(카테고리 기타)는 새 칩이 적용되지 않음 → 11-05 고정비 SAT 35,000(#2583)이 여전히 같이 잡혀 있음. 지우거나, 문서의 「회차 직접 고르기」는 임시저장 문서에서만 가능
- approval·approval_finance 기존 E2E 4건 사전 실패 정리 필요

## ⑧ 다음액션

1. #2583(11-05 SAT 35,000) 정리 여부 결정
2. Christopher·재무 담당에게: SAT·SUA·utility 결재는 카테고리 「세금과공과」로 올리고 칩에서 해당 고정비 선택
