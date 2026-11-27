# REFATRIX handover 2026-11-27f · Mauricio 계정 정리 · 인사·총무·재무(hr_admin) 역할 · 전자결재 검토·승인 단계

## ① 설명
- **원인**: 복제 계정(id 30, 아이디 `mauricio`, 이름 `christopher (복제)`)이 Christopher 의 역할 `treasury` 를 그대로 받았음.
  `refatrix-nav.js` 의 `ROLE_ONLY_GROUPS.treasury = ['finance','purchase']` 때문에 **재무·구매 그룹 외 화면은 권한을 줘도 메뉴에서 숨고,
  주소로 들어가도 재무로 되돌려짐**(enforceRoleAccess). 반제(finPay)·예산(budget)도 역할로 숨김. → 페이지 권한을 고쳐도 안 보였던 이유.
- **해결**: 새 역할 `hr_admin`(인사·총무·재무)
  - 그룹 잠금 없음 → **사용자·권한에서 고른 화면이 그대로 열림**(디렉터 선택).
  - **항상 차단(디렉터가 켜도 안 열림, 서버에서 차단)**: 제품·마케팅 › 가격 마스터 / 구매단가·원가·마진(unit_cost·unit_margin·margin_rate) /
    금고·불공제 계좌(잔액·거래·현금흐름 전부 — permLoader 가 계좌권한에서 제거).
  - 재무 업무는 기존 재무담당과 동일: 커미션 전체 열람·지급, 입금통지 등록, 정산차액, 마케팅 지출 집행, 전자결재 집행.
  - 고객·견적·매출 팀 필터 = 전체(영업지원과 동일).
- **계정 정리(0344 마이그레이션, 조건 일치 시 1회)**: 이름 `Mauricio`, 역할 `hr_admin`, 부서 `인사·총무·재무`.
- **전자결재 순서**: 직원 기안 → **검토·승인(Mauricio)** → 디렉터 결재 → (기준액 이상) 대표이사 사전 → 집행 → 대표이사 사후.
  설정 › 결재 담당 계정에 「검토·승인자」 선택 추가. 디렉터 기안 문서는 그대로(검토 단계 없음). Mauricio 본인 기안은 검토 칸 자동 생략.
  재무 집행 담당이 삭제된 계정(id 9)으로 남아 있어 Mauricio 로 교체.
- **사용자·권한 화면**: 각 사용자 행에 「수정」 버튼(이름·아이디·역할·부서). 역할 표시 한글화. hr_admin 행은 가격 마스터·금고·불공제가 🔒 차단으로 표시.

## ② 배포단계
1. GitHub Desktop **Fetch/Pull** 먼저.
2. `..._BACKEND.zip` → 레포 루트에 풀기(refatrix-api/…) → Push → Railway **Success** 확인.
3. Railway 콘솔 `npm run migrate` (0344).
4. `..._FRONTEND.zip` → 레포 루트에 풀기(HTML 64개 + refatrix-nav.js, nav `?v=20261127hr`) → Push.
5. 브라우저 `Ctrl+Shift+R`. **Mauricio 는 로그아웃 후 다시 로그인**(메뉴 갱신).

## ③ 테스트방법
- 탭 제목: 사용자·권한 `build u18hr`, 전자결재 `b20261127rv`, 커미션 `b1127hr`. 콘솔 `[refatrix-nav] v20261127hr`.
- 사용자·권한: Mauricio 행 = 역할 「인사·총무·재무」, 가격 마스터·금고·불공제 🔒.
- Mauricio 로그인: 부여한 그룹(영업·창고·제품·마케팅 등)이 메뉴에 보임 / 가격 마스터 없음 / 재무 계좌에 금고·불공제 없음 / 구매 화면 단가 공란.
- 전자결재 설정: 검토·승인자 = Mauricio, 재무 담당 = Mauricio. 직원 계정으로 새 기안 → 결재선 미리보기 「중간결재 Mauricio › 디렉터 결재」.

## ④ 변경파일
| 레포 경로 | 내용 |
|---|---|
| `refatrix-api/migrations/0344_hr_admin_role_reviewer.sql` | 역할 추가 · reviewer_user_id · Mauricio 데이터 정리 |
| `refatrix-api/src/permissions.js` | ROLE_DENY(hr_admin) · FINANCE_ROLES · isSecretAccount |
| `refatrix-api/src/permLoader.js` | hr_admin 금고·불공제 계좌 제거 |
| `refatrix-api/src/teams.js` | hr_admin 전체 가시 |
| `refatrix-api/src/roleDefaults.js` | hr_admin 기본 권한 |
| `refatrix-api/src/approval.js` | 검토·승인 단계 · isFinance |
| `refatrix-api/src/routes/approvalRoutes.js` | 설정 reviewer_user_id · 집행 알림 |
| `refatrix-api/src/routes/userRoutes.js` | PATCH /api/users/:id/profile · 계좌 secret 표시 |
| `refatrix-api/src/routes/commissionRoutes.js` / `commissionBonus.js` / `commissionAgreementRoutes.js` / `commissionReferralRoutes.js` | 재무 역할 포함 |
| `refatrix-api/src/routes/financeRoutes.js` / `settlementVarianceRoutes.js` / `marketingSpendRoutes.js` | 재무 역할 포함 |
| `refatrix-nav.js` (루트) | hr_admin 가격 마스터 숨김 · 모바일 탭 · v20261127hr |
| `refatrix-users.html` / `refatrix-approval.html` / `refatrix-commission.html` (루트) | 위 UI |
| 그 외 루트 HTML 61개 | nav 캐시 토큰만 `?v=20261127hr` |

## ⑤ 검증결과
- `node --check` 전 JS 통과, HTML 인라인 스크립트 문법 통과.
- 단위: pageAllowed/fieldVisible(hr_admin 차단·다른 역할 회귀 없음), isSecretAccount(실제 계좌 6개 → 금고·불공제만), buildLines 7케이스(검토 삽입·본인 생략·디렉터 기안 무영향·사전승인 순서·중복 제거·미지정 시 기존 동일·advance 순차).
- 실제 PostgreSQL 16: 0344 두 번 실행(멱등) — 이름/역할/부서, 금고 권한 행 삭제, reviewer=30, finance 9(삭제)→30.
- jsdom: 사용자·권한 화면 🔒 3개·다른 역할 무영향·수정 버튼 PATCH 본문, 전자결재 미리보기 3케이스.
- 라이브 기준(오늘 27b~e 패키지 반영본) 위에서 작업 — products 등 덮어쓰기 손실 없음 확인.

## ⑥ 결정사항
- Mauricio = 인사·총무·재무, 은행계좌 중 금고·불공제 불가, 구매단가 불가, 가격 마스터 불가, 나머지 선택 (디렉터 2026-11-27).
- 전자결재: 각 담당자 기안 → Mauricio 검토·승인 → 디렉터 결재.

## ⑦ 오픈이슈
- 검토 단계는 결재선에 「중간결재」로 표시(새 step_type 미도입 — 기존 문서 호환).
- 이미 진행 중인 문서는 상신 시점 결재선 유지(검토 단계 없음).
- Mauricio 화면 언어: 커미션 등은 역할 기준 스페인어 기본(상단 ES|한 전환 가능).
- Christopher 원본(id 9)은 삭제 상태 — 전자결재 집행 담당만 교체.

## ⑧ 다음액션
- 인사 모듈(출퇴근·휴가·nomina 계산·증빙) — 페이지 키 `hr` 신설, hr_admin 기본 부여 예정. 목업 승인 후 제작.
