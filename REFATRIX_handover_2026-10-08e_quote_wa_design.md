# REFATRIX 인수인계 — 신규 견적 알림: 템플릿 디자인으로 보내기 + 헤더 이미지 (2026-10-08e)

**마이그레이션 0264 (`npm run migrate` 필수)** · 화면 build `ql-1008hd` · 산출물 `refatrix_quote_wa_design.zip` (7파일) · 기준 커밋 `e71139c`(템플릿 우선 핫픽스 배포본)

## ① 설명

디렉터 보고: WhatsApp은 오는데, 승인받은 템플릿 디자인이 아니라 텍스트로 온다.

**원인 두 가지**
1. **24시간 창이 열려 있었다**: 시험하면서 회사 번호와 메시지를 주고받으면 창이 열린다. 직전 핫픽스의 규칙은 「창이 열려 있으면 무료 상세 텍스트」였기 때문에 디자인 없이 텍스트로 갔다.
2. **템플릿 헤더가 이미지인 경우**: Meta 규칙상 이미지 헤더 템플릿은 보낼 때마다 이미지를 함께 넣어야 한다. ERP에는 그 기능이 없었다. 그래서 템플릿이 #132012로 실패하고, 창이 열려 있으면 텍스트로 대신 나갔다.

**수정**
- **발송 형식 설정(기본 = 항상 디자인)**:
  - 「항상 디자인(승인 템플릿)으로」(기본): 창 상태와 상관없이 템플릿으로 보낸다(헤더·버튼 등 Meta에서 만든 모양 그대로, 내용은 한 줄 요약).
    - ☑ 「창이 열려 있으면 상세(수주현황 · 당월 요약)도 이어서 보내기」(기본 켬, 무료) — 템플릿 바로 뒤에 상세 텍스트가 한 통 더 간다.
  - 「창이 열려 있으면 상세 텍스트만」: 직전 방식.
- **템플릿 헤더 이미지**: 알림 패널에서 이미지를 올리면 템플릿을 이미지 헤더와 함께 보낸다.
  - 이미지는 Meta에 한 번 올리고 25일 동안 다시 쓴다.
  - 새 이미지를 올리면 다음 발송 때 다시 올린다. 「지우기」도 가능하다.
- 이미지 헤더 템플릿인데 이미지 없이 보내서 #132012가 나면, 원장에 「알림 패널에 헤더 이미지를 올리세요」라는 안내가 붙는다.

## ② 배포단계

1. zip 풀기 → Fetch/Pull → Commit → Push → Railway **Success**
2. `npm run migrate` → `apply 0264_quote_wa_settings.sql`
3. 견적·매출 추적 Ctrl+Shift+R → 탭 제목이 `ql-1008hd`인지 확인
4. 「📲 신규견적 알림」 › **발송 형식 · 템플릿 디자인**:
   - 「항상 디자인(승인 템플릿)으로」가 선택돼 있는지 확인
   - **Meta 템플릿 `nueva_cotizacion`의 헤더가 이미지라면** 「🖼 이미지 올리기」로 이미지를 올린다. Meta에 샘플로 올린 것과 같은 이미지(예: `ctr_header_web_1600x836.jpg`)를 쓰면 된다.
5. 받는 사람 행의 **시험 발송** → 휴대폰에 템플릿 디자인(헤더 이미지 + 본문 + 버튼)이 오는지, 이어서 상세 텍스트가 오는지 확인

## ③ 테스트방법

- 원장 「접수(템플릿)」 확인. ⚠ #132012가 보이면 헤더 이미지를 올리지 않은 것이다.
- 상세를 받기 싫으면 「이어서 보내기」를 끈다.

## ④ 변경파일

| repo 경로 | 변경 |
|---|---|
| `refatrix-api/migrations/0264_quote_wa_settings.sql` | **신규** — `quote_wa_settings`(발송 형식 · 상세 이어서 · 헤더 이미지 · Meta media id) |
| `refatrix-api/src/quoteWaNotify.js` | `deliverQuote`에 `mode` · `followDetail` · `headerMediaId` · `loadQuoteWaSettings` · `ensureHeaderMedia`(25일 재사용) · #132012 안내 |
| `refatrix-api/src/routes/quoteWaRoutes.js` | `GET/PUT /api/quote-wa/settings` · `GET /api/quote-wa/settings/image` · 상태에 settings |
| `refatrix-quotelist.html` (루트) | 「발송 형식 · 템플릿 디자인」 칸(형식 선택 · 이어 보내기 · 헤더 이미지 올리기/지우기) · build `ql-1008hd` |
| `refatrix-api/test/quote_wa_notify.test.mjs` | A5 갱신 · B12 추가 |
| `refatrix-api/test/quote_wa_front.test.mjs` | ②-2 추가 · 빌드 토큰 |

## ⑤ 검증결과

- `quote_wa_notify` **18/18**(실 PostgreSQL 16). **B12는 Meta 호출을 가로채 실제 본문을 확인했다.** 확인한 항목:
  - 기본값(항상 디자인 · 이어 보내기 켬), 잘못된 값 400, 영업 역할 403
  - 이미지를 올리면 → 창이 닫혀 있을 때 `template` + `header.image.id = MEDIA1` + 본문(견적번호)
  - 업로드는 1회만, 창이 열려 있으면 `template` 뒤에 상세 `text`(수주현황 포함)
  - 이어 보내기 끔 → 템플릿만, 예전 방식 → 텍스트만
  - 이미지 지우기 → 헤더 없이 본문만
  - A5: 발송 규칙 11가지
- `quote_wa_front` **6/6**(jsdom): 기본 선택, 형식 변경 PUT, 이어 보내기 잠김/해제, 이미지 올리기(PUT 본문), 지우기
- 회귀: wa_webhook 12 · wa_promo 10 · integration_nav 4 · quote_summary_front 20 · treasury_daily 17 통과
- 0264 빈 DB 적용 + 재실행 멱등 · pglast · node --check · 화면 인라인 JS

## ⑥ 결정사항

- 견적 알림은 기본적으로 항상 템플릿 디자인으로 보낸다. 창이 열려 있으면 상세를 무료로 이어서 보낸다.

## ⑦ 오픈이슈

- ERP는 Meta 템플릿 헤더가 이미지인지 스스로 알 수 없다(WABA 조회 권한이 필요). 그래서 패널에서 이미지를 올렸는지로 판단한다.
- 상세 이어 보내기는 창이 열린 사람만 받는다(Meta 규칙).

## ⑧ 다음액션

- 배포 → (헤더가 이미지면) 이미지 올리기 → 시험 발송
