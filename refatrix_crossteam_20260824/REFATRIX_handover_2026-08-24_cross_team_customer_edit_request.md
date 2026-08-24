# REFATRIX 인수인계 — 타팀 고객 수정요청(디렉터 승인) 신설 (2026-08-24)

**마이그레이션: 0181 (있음)** · 백엔드 4파일 · 프런트 2파일 · 테스트 2파일
산출물 zip: `refatrix_crossteam_request_20260824.zip`
베이스: GitHub `main` 라이브 (clone 시점 2026-08-24)

---

## ① 배경 / 요청

> "palomino가 다른 팀의 고객정보를 수정하는 게 불가능한 상태다.
>  본인 담당으로 바꾸려면 직접 수정해야 하고 내가(디렉터) 승인해야 한다."

현재 구조에서 막히던 지점은 **세 곳**이었습니다.

| 지점 | 기존 동작 |
|---|---|
| `GET /api/customers` (목록) | `visibleTeamIds` 팀 스코프 → 타팀 고객은 **목록에 아예 안 뜸** |
| `GET /api/customers/:id` (상세) | `canViewTeam` 실패 → `403 forbidden_team` |
| `PATCH /api/customers/:id` (수정) | `canEditTeam` 실패 → `403 forbidden_team` |

즉 "찾을 수도, 열 수도, 고칠 수도" 없었습니다. 승인 워크플로(`customer_change_requests`)는
**이미 있었지만** 자기 팀 고객에게만 닿았습니다.

### 결정된 방침 (디렉터 확정)

1. **열람 범위는 넓히지 않는다.** 고객 목록·상세·매출·미수·증빙서류·방문이력은 **종전대로 팀 스코프 유지**
   (2026-06-27 권한누수 수정 원칙 그대로).
2. **수정 "요청"만 연다.** 타팀 고객은 상호·코드·RFC로 찾아 **수정 요청**을 넣을 수 있고,
   실제 반영은 **디렉터 승인 시에만**.
3. **디렉터가 사용자별로 켜는 권한.** 전 영업 일괄 허용이 아니라 스위치로 부여/회수.
4. **수정 가능 항목은 자기 팀 고객과 동일하게 전 항목** (담당자·팀 이관 포함).

---

## ② 무엇을 만들었나

### 새 권한 스위치 — `users.cross_team_request`

- 마이그레이션 `0181_customer_cross_team_request.sql` (`BOOLEAN NOT NULL DEFAULT false`).
- **기본값 false = 지금까지와 완전히 동일한 동작.** 켜야만 새 경로가 열립니다.
- 화면: **고객관리 → 「팀 권한 관리」 탭**에 「**타팀 수정요청**」 열 신설 → 체크박스 즉시 저장.
- API: `PATCH /api/team-admin/users/:id/cross-team-request  { enabled: true|false }` (디렉터 전용).
- **재로그인 불필요** — perm은 요청마다 새로 읽으므로 부여·회수 즉시 반영됩니다.

### 새 화면 — 「🔁 다른 팀 고객 수정 요청」 (고객 목록 탭)

권한이 켜진 **비디렉터에게만** 보이는 카드입니다.

1. 상호·고객코드·RFC로 **찾기** (2글자 이상, 최대 30건)
2. 결과에 **소속 팀 / 담당자**가 보임 → 「수정 요청」 버튼
3. 기존 고객 수정 폼이 **타팀 모드**로 열림 (파란 안내 배너, 버튼 문구 「타팀 고객 수정 요청(디렉터 승인)」)
4. 담당자·팀을 본인 것으로 바꿔 저장 → **승인 대기**로 전송

### 디렉터 승인 화면

기존 「수정 승인 대기」 탭 그대로 쓰되, 요청자 소속팀과 고객 소속팀이 다르면
**`타팀 요청 · 현재 02_Merida`** 주황 배지가 붙습니다. diff·승인·반려 동작은 종전과 동일.

---

## ③ 변경 파일

| 구분 | 파일 | 변경 |
|---|---|---|
| 마이그레이션 | `refatrix-api/migrations/0181_customer_cross_team_request.sql` | **신규** · `users.cross_team_request` 추가 |
| 백엔드 | `refatrix-api/src/teams.js` | `canRequestCrossTeam(perm)` 순수함수 추가 (디렉터는 항상 false — 즉시 수정 경로를 쓰므로) |
| 백엔드 | `refatrix-api/src/permLoader.js` | `crossTeamRequest` 로드 (0181 이전 DB면 undefined → false) |
| 백엔드 | `refatrix-api/src/routes/dashboardRoutes.js` | `/api/me/access` 응답에 `cross_team_request` 추가 (화면 노출 판단용) |
| 백엔드 | `refatrix-api/src/routes/customerRoutes.js` | `GET /api/customers/lookup` 신규 · `GET /api/customers/:id/edit-basic` 신규 · `PATCH /api/customers/:id` 팀 가드 완화(요청 경로 강제) · `PATCH /api/team-admin/users/:id/cross-team-request` 신규 · `team-admin/users` 응답에 플래그 · 승인목록에 `cross_team`·요청자팀·고객팀 |
| 프런트 | `refatrix-customers.html` | 「다른 팀 고객 수정 요청」 카드 · 팀권한 탭 「타팀 수정요청」 열 · 승인화면 「타팀 요청」 배지 · custform 캐시버스터 `?v=20260824ct` |
| 프런트 | `refatrix-custform.js` | `crossTeam` 모드(배너·버튼문구·배송지 잠금·현재담당자 옵션 보존) · 버전 `v20260824` |
| 테스트 | `refatrix-api/test/teams.test.js` | 권한 순수함수 4건 추가 |
| 테스트 | `refatrix-api/test/cross_team_request_front.test.mjs` | **신규** · jsdom 프런트 5건 |

> `refatrix-nav.js` 변경 없음 → **다른 화면 31개의 `?v=` bump 불필요**.

---

## ④ 보안 경계 — 무엇이 열리고 무엇이 안 열리나

**열린 것 (권한 ON인 사용자만)**

- `GET /api/customers/lookup?q=` → **신원정보만**: 고객코드·상호·RFC·소속팀·담당자·승인대기 여부.
- `GET /api/customers/:id/edit-basic` → **수정폼 기본항목만**: 이름·RFC·이메일·전화·구매결정권자·
  할인·외상일·지점수·회사종류·메모·세무등록·팀·단계·담당자.
- `PATCH /api/customers/:id` → **승인 대기 요청 생성만**.

**여전히 막힌 것 (권한을 켜도)**

- 고객 목록(`/api/customers`) — 자기 팀만. 타팀 고객은 목록에 안 뜸.
- 고객 상세(`/api/customers/:id`) — 매출·미수·인보이스 포함 → **403 유지**.
- 증빙서류·방문이력·단계요약·할인·외상일 변경이력 → **403 유지**.
- 배송지 즉시저장(`/ship-address`) → **403 유지** (승인 없이 쓰기가 되면 우회 구멍이 되므로 잠금).
- 고객 삭제 → 디렉터 전용 유지.
- 권한 스위치 조작 → 디렉터 전용(`director_only`).

**즉시 반영 경로는 디렉터에게만 존재합니다.** 코드상 `crossTeam`이 true인 요청은
`perm.role === 'director' && !crossTeam` 조건 때문에 즉시 반영 분기에 절대 들어갈 수 없습니다.

---

## ⑤ 배포 단계 (순서 엄수: 백엔드 → 마이그레이션 → 프런트)

1. zip 압축 해제 → 로컬 repo에 **같은 경로로 덮어쓰기**.
2. GitHub Desktop **Commit → Push** → Railway 자동 재배포 → Deployments **Success** 확인.
3. **`npm run migrate` 실행 (필수)** — 0181이 적용되어야 합니다.
   - ⚠ 마이그레이션 전에 백엔드가 먼저 뜨면 `/api/team-admin/users`와 로그인(permLoader)이
     `cross_team_request` 컬럼을 찾지 못해 500이 납니다. **푸시 후 바로 migrate 하세요.**
     (Railway 배포 파이프라인에 migrate가 붙어 있으면 자동입니다.)
4. GitHub Pages 반영 1~2분 후 화면에서 **Ctrl+Shift+R** (하드 리프레시).

---

## ⑥ 사용 순서 (palomino 케이스)

**디렉터**
1. 고객관리 → **팀 권한 관리** 탭 → Palomino 줄의 「**타팀 수정요청**」 체크 → 「저장됨 ✓」 확인.

**palomino**
2. 고객관리 화면 새로고침 → 「🔁 **다른 팀 고객 수정 요청**」 카드가 보임.
3. 상호(예: `FRENOS`)로 **찾기** → 대상 고객 줄의 「**수정 요청**」.
4. **담당자 → 본인**, **팀 → 본인 팀**으로 바꾸고 저장 → *"타팀 고객 수정 요청을 보냈습니다"*.

**디렉터**
5. 고객관리 → **수정 승인 대기** 탭 → 「**타팀 요청 · 현재 02_Merida**」 배지 확인 →
   diff(`영업팀 02_Merida → 01_Monterrey_01`, `담당자 Oscar → Palomino`) 확인 → **승인**.
6. 승인 즉시 그 고객은 palomino 목록에 뜨고, 이전 담당자 목록에서는 빠집니다.

> 같은 고객에 이미 대기중인 요청이 있으면 **덮어쓰기**되며(중복 안 생김), 수정폼 배너에
> "이미 승인 대기중인 요청이 있습니다(요청자명)"로 알려줍니다.
> 할인·외상일을 바꾸는 요청은 종전대로 **수정이유 + 제공조건이 필수**입니다.

---

## ⑦ 검증 결과 (이 세션에서 전수 수행)

**로컬 PostgreSQL 16 + 마이그레이션 181개 전부 적용 + 실서버 기동 → HTTP E2E 25/25 PASS**

- 권한 OFF: 타팀 상세 403 · lookup 403 · PATCH 403 · `me/access` false
- 권한 부여: 디렉터만 가능(영업 시도 → `director_only`), **재로그인 없이 즉시 반영**
- **열람 범위 불변 검증(핵심)**: 목록 건수 그대로 · 상세/증빙서류/방문이력 **여전히 403**
- lookup 응답에 금액 필드(`outstanding`·`sales_total`) **없음**, 2글자 미만 거부
- `edit-basic`: `cross_team=true`, 배송지 `null`(비공개), 현재 담당자 이름 노출
- 수정 요청 → **DB 미변경 확인**(`team_id/owner_id` 그대로) → 승인 → 이관 완료 → 목록 이동 확인
- 승인화면 `cross_team=true` + 요청자팀/고객팀 + diff 2건 정확
- 회귀: 권한 없는 다른 영업(oscar)은 lookup·edit-basic·PATCH 전부 차단
- 권한 회수 → 즉시 다시 차단
- 우회 시도: 배송지 즉시저장 403 · 할인 변경 시 이유/조건 없으면 400 · 고객 삭제 `director_only`

**단위/프런트 테스트**
- `teams.test.js` 9/9 PASS (신규 4건: 기본 OFF · 켜도 열람 불변 · 디렉터 예외 · 비정상값 방어)
- `cross_team_request_front.test.mjs` 5/5 PASS (배너·버튼문구·배송지 잠금·담당자 옵션 보존·
  ship-address 미호출·자기팀 모드 회귀·신규등록 시 모드 해제)

**회귀 스위트**
- 변경 전 baseline **248 pass / 21 fail**, 변경 후 **257 pass / 21 fail** →
  **실패 건수 동일(21건은 기존부터 실패하던 항목)**, 신규 9건만 증가. **회귀 0**.

**문법 검사**: `node --check` (백엔드 4 · custform) OK, `refatrix-customers.html` 인라인 스크립트 추출 검사 OK.

---

## ⑧ 의도적 판단 / 나중에 바꾸고 싶을 때

- **팀 이동 목적지 검증을 타팀 요청에서는 하지 않음.** 요청은 제안일 뿐이고 디렉터가 최종 판단하므로,
  `forbidden_team_move` 체크를 타팀 요청 경로에서만 건너뜁니다(자기 팀 수정은 종전대로 검증).
- **담당자 드롭다운은 `/api/sales-users`(팀 스코프) 그대로.** 타팀 고객의 현재 담당자가 목록에 없어
  "담당자 → 미지정"을 실수로 요청하는 걸 막으려고, 현재 담당자를 `(타팀)` 표기로 옵션에 끼워 넣습니다.
- **배송지는 타팀 요청에서 제외.** 즉시저장 경로라 승인 우회가 되기 때문. 필요해지면
  `ship_address`를 `proposed` 화이트리스트 + `applyCustomerUpdate` + 승인화면 `LABELS`에
  **세 곳 모두** 추가해야 합니다(2026-08-18 buyer_phone 누락 사고와 같은 계열).
- **`proposed` 화이트리스트는 여전히 수기 관리.** 근본 해결(LABELS에서 파생)은 아직 미적용 — 후속 후보.
- **모든 영업에게 일괄 허용하고 싶으면**: `canRequestCrossTeam`에서
  `return perm.crossTeamRequest === true;` → `return perm.role === 'sales';` 로 바꾸면 됩니다(권장하지 않음).
- **타팀 고객도 전부 열람시키고 싶어지면**: 이번 변경과 별개 작업입니다
  (`visibleTeamIds` 자체를 손대야 하고, 2026-06-27 권한누수 수정과 정면으로 충돌하니 신중히).

---

## ⑨ 검증 명령 (배포 후)

```bash
# 0181 적용 확인
psql "$DATABASE_URL" -c "\d users" | grep cross_team_request

# 라이브 소스 확인
curl -s "https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main/refatrix-api/src/teams.js" | grep -c canRequestCrossTeam   # 1
curl -s "https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main/refatrix-custform.js" | grep -c "v20260824"            # 1
```
