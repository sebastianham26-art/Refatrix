# REFATRIX 인수인계 — 커미션 조건 합의 페이지 (본인 PIN = 합의 증명)

- 작업일: 2026-10-05
- 마이그레이션: **0251** (신규 · `0251_commission_agreements.sql`)
- 신규 화면: **`refatrix-acuerdo-comision.html`** (빌드 `b1005acu`)
- **nav.js 변경 없음** → 다른 HTML 의 nav 토큰 일괄 변경 불필요. 진입은 커미션 화면 배너·버튼과 안내서 바로가기로.
- **누적 패키지**: 직전 핫픽스(완납 기준 0.5페소 통일 · 10-05c, 아직 main 미반영)가 함께 들어 있다 → 이 패키지 하나만 배포하면 된다.
- 검증: 신규 11 + 기존 커미션 90 = **101건 통과**(실 PG16 · 0001~0251, 합의 e2e 2회 연속 실행) · `npm test` 24 · pglast 11 · 0251 미적용 DB 에서 조회 200 / 합의는 503 안내 · jsdom(디렉터·커미셔너·직원·비대상) JS 오류 0

---

## ① 무엇을 만들었나

### 본인 화면 (스페인어) — 커미셔너·직원 공통
ERP 설정에서 **본인 조건 문서**를 자동으로 만든다 (목업 승인안 그대로).
1. **Tu comisión** — 기간·기준(매출 / 수금·발행일 / 수금·수금일)·율 표 + 계산 방식 설명, 고객 예외율
2. **Tu bono mensual** — 성과급이 있을 때만: 구간표(미달 = Sin bono), 월별 목표표
3. **Cuándo y cómo se paga** — 익월 15일 · 커미셔너만 「커미션 CFDI 필요」 · 성과급 확정 방식
4. **Ajustes y clientes** — 고객 담당 귀속, 지급 후 매출 감소분 차감, 독점 규칙

하단에 **동의 체크 + 본인 PIN + [Acepto con mi PIN]**. PIN 이 맞으면 합의 기록이 남고 화면이 「✓ Aceptado — 일시 · 버전 · 기기」로 바뀐다. 아래 **Historial de aceptaciones** 에 모든 합의가 쌓이고 「Ver documento」로 당시 원문을 연다(인쇄/PDF 가능).

### 조건이 바뀌면
조건(기간·율·판정·예외율·성과급 구간·목표)이나 공통 규칙 문구가 바뀌면 **버전 해시**가 달라져 상태가 「Condiciones nuevas — acepta de nuevo」로 바뀐다. 이전 합의는 이력에 「Reemplazada」로 남는다. **지급은 막지 않는다** — PIN 입력이 합의의 증명이고, 미합의는 표시만 한다(디렉터 결정).

### 디렉터·재무·소시오 화면 (한국어 현황판)
같은 주소로 들어오면 **합의 현황판**: 합의 완료 / 미합의 / 재합의 필요 집계, 대상자별 현재 조건 요약·상태·최근 합의, [합의 문서](당시 스냅샷 + IP) · [현재 조건](본인이 보게 될 문서 미리보기 + 이력) · [링크 복사](WhatsApp 으로 보낼 주소).

### 진입 경로
- 커미션 화면: 본인이 미합의/재합의 필요이면 상단 **노란 배너** 「Revisar y aceptar ›」. 디렉터·재무·소시오는 상단 **[조건 합의 현황]** 버튼.
- 커미셔너 안내서 「Accesos rápidos」에 **Aceptar mis condiciones ↗**.

### 대상·유형
- 대상 = 커미션 대상(활성 + 기간 1개 이상) **전원**.
- **커미셔너** = 안내서(guiacom) 권한이 있는 사용자(CFDI 문구 포함) / 그 외 = **직원**.

---

## ② 배포 — ⚠ 순서 준수

| 파일 | 레포 경로 | 구분 |
|---|---|---|
| `0251_commission_agreements.sql` | `refatrix-api/migrations/0251_commission_agreements.sql` | **신규** |
| `commissionAgreementRoutes.js` | `refatrix-api/src/routes/commissionAgreementRoutes.js` | **신규** |
| `server.js` | `refatrix-api/src/server.js` | 덮어쓰기 (import 1줄 + register 1줄) |
| `commissionRoutes.js` | `refatrix-api/src/routes/commissionRoutes.js` | 덮어쓰기 (10-05c 완납 기준 포함) |
| `commissionBonus.js` | `refatrix-api/src/routes/commissionBonus.js` | 덮어쓰기 (10-05c 완납 기준 포함) |
| `refatrix-acuerdo-comision.html` | `refatrix-acuerdo-comision.html` (루트) | **신규** |
| `refatrix-commission.html` | `refatrix-commission.html` (루트) | 덮어쓰기 (배너·버튼 · `b1005acu`) |
| `refatrix-guia-comisionista.html` | `refatrix-guia-comisionista.html` (루트) | 덮어쓰기 (바로가기 1개) |
| `commission_agreement_e2e.test.mjs` · `commission_paydate.test.js` | `refatrix-api/test/` | (선택) 검증용 |

1. GitHub Desktop **Fetch/Pull** → zip 을 레포 루트에서 풀기.
2. **백엔드 push** → Railway **Success**.
3. Railway 콘솔 **`npm run migrate`** → `apply 0251_commission_agreements.sql`.
   - 0251 전에도 500 없음: 문서·현황판은 보이고, PIN 합의만 "migrate(0251) 먼저" 안내.
4. **프런트 push** → 커미션 화면 **Ctrl+Shift+R** → 탭 제목 `build b1005acu`.

```bash
R=https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main; N="?nc=$(date +%s)"
curl -s -o /dev/null -w "%{http_code}\n" "$R/refatrix-api/migrations/0251_commission_agreements.sql$N"      # 200
curl -s "$R/refatrix-api/src/server.js$N" | grep -c "commissionAgreementRoutes"                              # 2
curl -s "$R/refatrix-api/src/routes/commissionRoutes.js$N" | grep -c "AR_PAID_EPS"                           # >0
curl -s -o /dev/null -w "%{http_code}\n" "$R/refatrix-acuerdo-comision.html$N"                               # 200
curl -s "$R/refatrix-commission.html$N" | grep -c "b1005acu"                                                 # >0
```

---

## ③ 테스트 방법 (5분)

1. 디렉터로 커미션 화면 → **[조건 합의 현황]** → 대상자 전원 「미합의」, 조건 요약이 [커미션 설정]과 맞는지.
2. 한 사람 **[현재 조건]** → 스페인어 문서가 그 사람 조건(율·기간·성과급·CFDI 여부)과 맞는지.
3. **[링크 복사]** → Oscar 등에게 전달. 본인 로그인 → 커미션 화면 노란 배너 → 문서 → 체크 + 본인 PIN → 「✓ Aceptado」.
4. 틀린 PIN → "PIN incorrecto." (15분에 5회 넘으면 잠시 차단).
5. [커미션 설정]에서 그 사람 율을 바꿨다가 되돌려 보기 → 현황판 「재합의 필요」, 본인 화면 재합의 요청 → (원래대로 되돌리면 같은 버전이라 다시 「합의 완료」).
6. 현황판 **[합의 문서]** → 합의 당시 원문·일시·기기·IP.

---

## ④ 변경 요약 (기술)

**스키마 (0251)** — `commission_agreements`(user_id · version_hash · agent_type · terms JSONB · doc JSONB · summary · agreed_at · ip · user_agent). **UPDATE/DELETE 트리거로 차단**(합의 증빙). 인덱스 (user_id, agreed_at DESC).

**`commissionAgreementRoutes.js`** (authGuard 만 — 대상 여부는 서버가 판정)
- `GET /api/commission/agreement/me` — 본인 문서·버전·상태(agreed/changed/pending)·이력
- `POST /api/commission/agreement/me` `{pin, version, agree:true}` — 본인 `pin_hash` 로 검증(남의 PIN 불가), 화면의 버전 ≠ 현재 조건이면 409(읽는 사이 조건 변경), 오입력 15분 5회 → 429, 성공 시 조건·문서 스냅샷 + IP(X-Forwarded-For) + 기기 저장, 감사로그 `agree` / `agree_fail`
- `GET /board` · `GET /preview/:uid` — 디렉터·재무·소시오
- `GET /doc/:id` — 본인 또는 전체열람자(IP 는 전체열람자에게만)
- 순수 함수: `buildTerms`(정규화) · `termsHash`(sha256 앞 12자) · `buildDoc`(스페인어) · `summaryKo` · `statusOf` · `deviceLabel`. 공통 규칙 문구를 고치면 `RULES_VERSION` 을 올린다 → 전원 재합의 대상.

**`server.js`** — import·register 각 1줄. **화면** — 신규 페이지, 커미션 화면 배너·버튼, 안내서 바로가기. PIN 입력칸은 `type=password` 라 nav.js 초안 자동저장 대상이 아님(확인).

---

## ⑤ 검증 결과

| 항목 | 결과 |
|---|---|
| `commission_agreement_e2e.test.mjs` (순수 3 + 실 PG 8) | 11/11 — 2회 연속 실행 |
| 기존 커미션 테스트(paydate 11·paydate_e2e 12·periods 13·bonus 18·bonus_e2e 12·owner 9·nc_adjust 15) | 90/90 |
| `npm test` | 24/24 |
| `node --check` 백엔드 4 + 화면 스크립트 3 | 통과 |
| pglast — 신규 SQL 11건 | 전부 파싱 |
| 0251 미적용 DB | 조회 3종 200 · 합의 POST 503 안내 |
| jsdom — 디렉터(현황판·스냅샷·미리보기·Esc) / 직원(틀린 PIN → 정상 PIN → Aceptado·이력) / 비대상 / 커미션 화면 배너(합의 시 숨김 · 조건 변경 시 「acéptalas de nuevo」) | JS 오류 0 |

e2e 핵심: 틀린 PIN·남의 PIN 403 · 체크 없음 400 · 옛 버전 409 · 정상 200(IP·기기 저장) · 조건 변경 → changed → 재합의 → 이력 2건 · 스냅샷은 바뀐 조건과 무관하게 당시 5% 유지 · 수정/삭제 시 DB 오류 · 오입력 5회 → 429.

---

## ⑥ 결정사항 (2026-10-05)
- 커미션 조건 설명 + 합의 페이지. **본인 PIN 입력 = 합의 증명**, 기록이 페이지에 남아 보인다.
- 대상: 커미션 대상 전원(커미셔너 + 직원). 조건 변경 후 미합의는 「재합의 필요」 표시만, 지급은 막지 않음.

## ⑦ 오픈 이슈
1. 현황판의 BONOTEST·PAYDTEST 같은 테스트 사용자는 운영 DB 에 없으므로 무관.
2. 조건 문서의 공통 규칙(독점·차감 등) 문구 수정이 필요하면 `buildDoc` 문구 수정 + `RULES_VERSION` 변경 → 전원 재합의.
3. Maria 처럼 sales_support 역할도 커미션 대상이면 본인 화면에 문서가 뜬다(현황판은 디렉터·재무·소시오만).

## ⑧ 다음 액션
1. 배포 후 현황판에서 대상자별 조건 확인 → [링크 복사]로 각자에게 전달.
2. 합의 완료율 확인. 필요하면 WhatsApp 자동 알림(미합의자 리마인드) 추가.
