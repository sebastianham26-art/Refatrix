# REFATRIX 핸드오버 · 2026-10-16e · 관리자 계정 독점권 해제 + 담당자 변경 시 독점 이전

## ① 설명
- 증상: C-0142 고객으로 Oscar 가 견적을 저장하면 「관리자 님의 독점 고객」이라며 차단(`exclusive_other`).
- 원인:
  1. 관리자 계정으로 RFC 가 있는 고객을 등록하면 RFC 독점 30일의 독점권자 = `COALESCE(rfc_claimed_by, owner_id)` = 관리자.
  2. 담당자를 영업사원으로 바꿔도 `rfc_excl_agent_id` 는 비어 있을 때만 채워져 그대로 관리자.
  3. 6시간마다 도는 재계산(`recomputeCustomer`)이 담당자를 독점권자(관리자)로 되돌림.
- 수정:
  - **관리자·디렉터·소시오(`director`, `socio`) 계정은 독점권자가 될 수 없다.**
    - 이들이 RFC 를 등록한 고객 → 담당자가 영업사원이면 담당자가 독점권자, 아니면 독점 없음(개방).
    - 개방 고객에서 이들 이름의 인보이스는 1년 독점을 시작하지 않는다(커미션 귀속 기록은 그대로).
  - **디렉터가 고객 담당자를 바꾸면**(직접 수정 · 수정요청 승인 모두)
    - RFC 독점 30일 중 → 새 담당자에게 독점 이전, 이전한 날부터 30일 새로 시작, 이력 `excl_transfer` 기록.
    - 판매 독점 1년 중 → 담당자 변경 차단(`excl_sale_locked`, 독점권자·만료일 안내).
    - 독점 고객의 담당자를 관리자·디렉터로 지정 → 차단(`excl_owner_ineligible`).
    - 개방·기존 거래 고객 → 변화 없음(RFC 기산은 트리거가 처리).

## ② 배포단계
1. GitHub Desktop **Fetch/Pull** → 아래 4개 파일 덮어쓰기 → push
2. Railway 배포 **Success** 확인
3. Railway 콘솔 `npm run migrate` (0280 적용)
4. 프론트 변경 없음 — 새로고침만

> 백엔드만 먼저 올라가도(마이그레이션 전) C-0142 는 개방으로 판정돼 Oscar 견적 저장이 바로 됩니다.

## ③ 테스트방법
1. Oscar 계정 → 견적 → 고객 C-0142 → 저장 → 성공, 판매 영업사원 = Oscar.
2. 디렉터 → 고객 C-0142 상세 → 독점 상태 = Oscar RFC 독점(첫 인보이스 시 1년 독점).
   - 마이그레이션 직후 C-0142 의 담당자가 아직 관리자이면 개방으로 보입니다. 디렉터가 담당자를 Oscar 로 저장하면 그날부터 Oscar RFC 30일이 붙습니다.
3. 판매 독점 중인 다른 고객의 담당자를 바꿔 보기 → 「판매 독점 기간에는 담당자를 바꿀 수 없습니다」 메시지.
4. (선택) 디렉터 `POST /api/exclusivity/recompute` → 목록 배지 즉시 갱신(안 해도 6시간 내 갱신).

## ④ 변경파일
| 저장소 경로 | 구분 |
|---|---|
| `refatrix-api/src/exclusivity.js` | 수정 |
| `refatrix-api/src/routes/customerRoutes.js` | 수정 |
| `refatrix-api/migrations/0280_excl_holder_no_admin.sql` | 신규 |
| `refatrix-api/test/customer_exclusivity.test.mjs` | 수정(테스트 X20–X23 추가) |

## ⑤ 검증결과
- `node --check` 2개 파일 OK
- 순수 계산 테스트 `customer_exclusivity.test.mjs` 15/15 (신규 4건 포함)
- 실 PostgreSQL 16: 0001~0280 전체 마이그레이션 순차 적용 OK, 0280 재실행 멱등 OK
- 실 PG 트리거 시나리오: 관리자 등록 고객 → 개방 / 담당자 Oscar 로 바꾼 고객 → Oscar / 영업사원 고객 영향 없음 / 신규 등록·소시오 등록 판정 OK
- 실 PG JS e2e: 마이그레이션 전 데이터에서도 Oscar 견적 허용, RFC 독점 이전·이력, 판매 독점 차단, 관리자 담당자 차단 OK
- 기존 테스트: customer_exclusivity_e2e 14/14, customer_registration 76/76, customer_post_approval 15/15, customer_monthly_summary 16/16, customer_exclusivity_front 6/6, crm_inbound 23/23, crm_web_lead 18/18, npm test 24/24

## ⑥ 결정사항
- 독점권자 제외 역할: `director`, `socio`.
- 담당자 변경으로 RFC 독점을 이전하면 30일은 이전일부터 새로 시작.
- 판매 독점 1년 중에는 담당자 변경 불가(독점은 첫 인보이스로 확정되는 정책 유지).
- 관리자 이름 인보이스의 커미션 귀속 기록(`commission_agent_id`)은 그대로 둠.

## ⑦ 오픈이슈
- 관리자 이름으로 이미 인보이스가 나간 고객은 이제 개방이므로, 다음 인보이스를 낸 영업사원이 1년 독점을 가져갑니다.
- 판매 독점 고객을 다른 영업사원에게 넘겨야 할 예외 상황용 「디렉터 강제 이전」 기능은 없음.

## ⑧ 다음액션
- 배포 후 Oscar 의 C-0142 견적 저장 확인.
- 필요하면 디렉터가 C-0142 담당자를 Oscar 로 지정해 RFC 독점 30일 부여.
