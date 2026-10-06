# REFATRIX 인수인계 — 합의 문서에 고정급여 단계표 + 날짜 표기(일 월 연)

- 작업일: 2026-10-06
- 마이그레이션: **0254** (신규 · `0254_commission_salary_steps.sql`)
- 빌드: `b1006sal` (커미션 화면·합의 페이지) · **nav.js 변경 없음**
- 검증: 합의 테스트 13(신규 2) + 기존 커미션 90 = **103건 통과**(실 PG16 · 0001~0254, 2회 연속) · `npm test` 24 · pglast 15 · 0254 미적용 DB 에서 조회 200 / 저장 503 안내 · jsdom(디렉터 입력·저장·겹침 오류 / 직원 문서 / 현황판) JS 오류 0

## ① 무엇을 바꿨나

**고정급여 단계표** — [커미션 설정] 모달의 사람마다 「고정급여 단계」 표가 생겼다.
- 입력: 적용 **시작일**(날짜) · 종료일 · 월 고정급(MXN) · 비고(선택) → [고정급여 저장]
- 종료일을 비우면 **다음 단계 시작일 전날**로 자동으로 채운다(빈틈 없이 이어짐). 마지막 단계는 비우면 「그날부터 계속」.
- 단계가 겹치면 저장되지 않는다. 표를 모두 지우고 저장하면 문서에서 빠진다.

**합의 문서(스페인어)** — 단계표가 있는 사람은 제목이 *Acuerdo de sueldo fijo y comisión* 으로 바뀌고 첫 섹션에 표가 나온다.

| Vigencia | Sueldo fijo mensual |
|---|---|
| Del 1 oct 2026 al 15 nov 2026 | $45,000.00 |
| Del 16 nov 2026 al 28 feb 2027 | $40,000.00 |
| Desde 1 mar 2027 | $25,000.00 |
(예시 금액 — 실제 금액은 화면에서 입력)

- 설명: 금액은 표의 날짜대로 단계적으로 바뀌고, 커미션·성과급은 **별도로 추가** 지급.
- 서약문: "Acepto que **mi sueldo fijo, mi comisión y mi bono** se calculen y paguen así."

**날짜 표기 — 월 → 「일 월 연」** (예: `1 oct 2026`). 일/월 순서 혼동이 없게 월은 약어로 쓴다. 문서 전체에 적용:
- 커미션 기간: `Desde 1 oct 2026`
- 성과급 월별 목표: `Del 1 oct 2026 al 31 oct 2026` · 성과급 적용기간도 같은 형식

**합의 상태**
- 단계표를 넣거나 금액·날짜를 바꾸면 그 사람의 조건 버전이 바뀌어 「재합의 필요」 → 본인 화면·커미션 화면 배너에 재합의 요청.
- 단계표가 없는 사람은 버전이 **그대로**(날짜 표기만 바뀌고 이미 한 합의는 유지).
- 현황판 요약에 `· 고정급 N단계` 표시.

## ② 배포

| 파일 | 레포 경로 | 구분 |
|---|---|---|
| `0254_commission_salary_steps.sql` | `refatrix-api/migrations/0254_commission_salary_steps.sql` | **신규** |
| `commissionAgreementRoutes.js` | `refatrix-api/src/routes/commissionAgreementRoutes.js` | 덮어쓰기 |
| `refatrix-commission.html` | `refatrix-commission.html` (루트) | 덮어쓰기 |
| `refatrix-acuerdo-comision.html` | `refatrix-acuerdo-comision.html` (루트) | 덮어쓰기 (빌드 토큰만) |
| `commission_agreement_e2e.test.mjs` | `refatrix-api/test/` | (선택) |

백엔드 push → Railway Success → **`npm run migrate`(0254)** → 프런트 push → Ctrl+Shift+R → 탭 제목 `build b1006sal`.

## ③ 사용 방법 (Oscar)
1. 커미션 화면 → [커미션 설정] → oscar 블록 아래 「고정급여 단계」 → [+ 단계 추가]를 6번(10월~3월) 또는 필요한 만큼.
2. 각 줄에 적용 시작일(예: 2026-10-01, 2026-11-01 … 또는 16일 등 실제 날짜)과 월 고정급 입력 → [고정급여 저장].
3. [조건 합의 현황] → oscar [현재 조건]으로 문서 확인 → [링크 복사] 해서 Oscar 에게 전달 → 본인 PIN 으로 재합의.

## ④ 기술
- 0254 `commission_salary_steps`(user_id · start_date · end_date · amount · note, UNIQUE(user_id,start_date), CHECK end ≥ start, amount ≥ 0).
- API: `GET /api/commission/salary`(디렉터·재무·소시오) · `POST /api/commission/salary/:uid` `{steps:[…]}`(디렉터, 통째 교체, 감사로그).
- `validateSalarySteps`(정렬·자동 종료일·겹침), `fechaEs`/`rangoEs`(날짜 표기), `buildTerms` 에 `salary`(있을 때만 키 추가 → 다른 사람 해시 불변), `buildDoc` 에 salary 섹션.
- 0254 전: 조회는 빈 단계표로 정상, 저장만 503 「migrate(0254)」.

## ⑤ 오픈 이슈
- 월 중간 날짜로 단계가 바뀔 때 그 달 급여를 일할 계산할지는 문서에 쓰지 않았다(「각 금액은 시작일부터 종료일까지 적용」까지만). 일할 문구가 필요하면 알려 주시면 넣는다. 문구만 바꾸면 버전이 안 바뀌므로, 이미 합의한 사람에게 다시 받으려면 `RULES_VERSION` 도 올려야 한다(그 경우 전원 재합의).
