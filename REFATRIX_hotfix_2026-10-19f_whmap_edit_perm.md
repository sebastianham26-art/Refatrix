# REFATRIX 핫픽스 · 2026-10-19f · 창고 도면 수정 권한(whmap) — 관리 › 사용자·권한에서 부여

빌드: 백엔드 `whMapRoutes 20261019wm2` · 프런트 창고 도면 `wm-1019b` · 사용자·권한 화면 · nav.js
기준 커밋: live main `6938978` (2026-10-19 11:36 「도면」) 위에 작성 — 배포 직전 다시 Fetch/Pull. **마이그레이션 없음.**

---

## ① 설명

**요청.** 창고 도면 수정(구역 이동 · 크기 · 랙 배치 저장)을 디렉터만이 아니라 일부 직원에게도 줄 수 있게, 관리 페이지의 권한 항목으로.

**구현.**

- 관리 › 사용자·권한 › **창고** 그룹에 새 항목 **「창고 도면 수정」**(권한 키 `whmap`).
  - **수정** = 도면 보기 + 설정(편집·저장).
  - **열람** = 도면 보기만(창고 권한이 없는 사람에게 도면만 보여 줄 때).
  - 디렉터는 항상 수정 가능.
- 서버(`PUT /api/wh-map`)가 판단한다: 디렉터 또는 whmap 「수정」이 아니면 403.
- 도면 화면의 [운영 / 설정] 토글은 서버가 준 `can_edit` 로만 보인다.
- 기기 조건(등록기기 전용)도 다른 권한과 똑같이 적용된다.

## ② 배포단계

1. GitHub Desktop **Fetch → Pull**.
2. 백엔드 `refatrix-api/src/routes/whMapRoutes.js` 푸시 → Railway **Success** · 로그 `[whMapRoutes] loaded 20261019wm2`. 마이그레이션 없음.
3. 프런트 `refatrix-whmap.html` · `refatrix-users.html` · `refatrix-nav.js` 푸시(**users · nav 는 자주 바뀌니 해당 줄만 병합**) → `Ctrl+Shift+R`.
   - 탭 제목 `build wm-1019b`.

## ③ 테스트방법

1. (디렉터) 관리 › 사용자·권한 → 창고 직원 한 명 → 창고 그룹 「창고 도면 수정」 = **수정** → 저장.
2. 그 직원으로 창고 › 창고 도면 → 상단 [Operar / Configurar] 토글이 보이고, 구역을 옮겨 저장된다.
3. 권한이 없는 다른 창고 직원 → 토글이 안 보인다(보기만).
4. 「열람」만 준 사람 → 도면은 보이고 토글은 없다.

## ④ 변경파일

| repo 경로 | 구분 |
|---|---|
| `refatrix-api/src/routes/whMapRoutes.js` | 수정 (canEditMap · 저장 가드 · can_edit · 읽기 키에 whmap 추가 · wm2) |
| `refatrix-whmap.html` | 수정 (설정 토글 = can_edit · 403 안내 · wm-1019b) |
| `refatrix-users.html` | 수정 (창고 그룹에 「창고 도면 수정」) |
| `refatrix-nav.js` | 수정 (whmap 메뉴 권한에 whmap 추가) |
| `refatrix-api/test/whmap_e2e.test.mjs` | 수정 (권한 판정 · 가드 테스트) |
| `test/whmap_ui.test.mjs` | 수정 (권한 직원 · 403 · can_edit) |

## ⑤ 검증결과

- **문법:** `node --check` 백엔드 · nav · 사용자 화면 인라인 스크립트 3개 통과.
- **실 PostgreSQL 16 `whmap_e2e` 34/34** — 권한 판정 6종(디렉터 · 수정 · 열람 · 창고만 · 등록기기 · 소시오) · 저장 가드 403/통과 · can_edit · 기존 24건.
- **jsdom `whmap_ui` 29/29** — 권한 직원 토글 · 설정 문구 · 403 안내 · can_edit false 숨김 + 기존 25건.
- **회귀:** `users_wa_phone_card` 8/8 · `wa_promo_front` 13/13 · `team_admin_front` — 수정 전과 동일.

## ⑥ 결정사항

- 디렉터 요청(2026-10-19): 창고 도면 수정 권한을 관리 페이지에서 직원별로 부여.
- (구현 규칙) 「수정」 = 편집·저장, 「열람」 = 보기만, 디렉터는 항상. 소시오도 별도 부여 필요.

## ⑦ 오픈이슈

- 도면 저장 이력은 감사로그(target `warehouse_map`)에만 남는다 — 이전 도면으로 되돌리는 기능은 없다(요청 시 추가).

## ⑧ 다음액션

1. 배포 후 도면 담당 직원에게 권한 부여 → AB/AC/메자닌 번호 정리.
