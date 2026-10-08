# REFATRIX 핫픽스 — 신규 견적 알림: 템플릿 승인 후에도 못 받음 → 템플릿 우선 발송 (2026-10-08d)

**마이그레이션 없음** · 화면 build `ql-1008tp` · 산출물 `refatrix_quote_wa_tplfix.zip` (6파일) · 기준 커밋 `9c079d1`

## ① 설명 (원인)

디렉터 보고: `nueva_cotizacion` 템플릿이 승인됐는데, 견적을 입력하면 「전송」은 되지만 받지 못한다(24시간 규칙으로 보임).

**원인 — 템플릿이 아니라 자유 텍스트가 먼저 나가고 있었다.** 견적 알림은 공용 `sendWaTo`를 썼는데, 그 규칙은 이랬다.
- 24시간 창이 **「닫힘」으로 확실할 때만** 템플릿을 먼저 쓴다.
- 창 상태를 모르거나(웹훅 미설정·기록 없음), 템플릿 이름이 비어 있거나(`QUOTE_WA_TEMPLATE` 미입력 → `WHATSAPP_TEMPLATE`로 대체), 템플릿 호출이 실패하면(이름·언어 불일치 #132001 등) → **자유 텍스트**로 보낸다.
- Meta는 창 밖 자유 텍스트도 API에서는 「접수」로 응답하고, 나중에 131047로 버린다. 그래서 원장에는 「접수」로 찍히지만 휴대폰에는 오지 않는다.
- 템플릿이 실패한 사유도 버려졌다. 그래서 화면에서 원인을 볼 수 없었다.

## 수정

- **견적 알림 전용 발송 규칙(`deliverQuote`)**:
  - 창이 **「열림」으로 확실할 때만** 자유 텍스트(무료 · 수주현황·당월 요약까지 상세)
  - 그 밖에는 **항상 템플릿**
  - 템플릿이 실패하면 사유를 `템플릿 nueva_cotizacion(es_MX) 실패 #코드: …`로 남긴다.
  - 창이 「닫힘」이면 텍스트를 보내지 않는다(어차피 안 감 → 실패로 두고 재시도).
  - 창 상태를 모를 때만 마지막 수단으로 텍스트를 보내고, 템플릿 실패 사유도 함께 남긴다.
- **템플릿 이름 기본값 = `nueva_cotizacion`**. 이름 칸을 비워 둬도 승인 템플릿으로 간다(전에는 다른 기본 템플릿으로 갔음).
- **템플릿 언어 칸 신설**: 외부 서비스 키 › WhatsApp › 「신규견적 템플릿 언어」(`QUOTE_WA_TEMPLATE_LANG`). 비우면 `es_MX`. Meta에서 **Spanish**(es)로 승인했다면 `es`를 넣어야 한다.
- **견적 화면 알림 패널**:
  - 상태 칩에 「창 밖 템플릿: nueva_cotizacion (es_MX) · 기본값」 표시
  - 원장이 「접수(템플릿)」 / 「접수(텍스트)」로 구분됨
  - 템플릿이 실패해 텍스트로 나간 건은 ⚠ 사유를 그대로 표시

공용 `sendWaTo`(오퍼시트·브리핑)는 바꾸지 않았다.

## ② 배포단계

1. zip 풀기 → Fetch/Pull → Commit → Push → Railway **Success** (migrate 불필요)
2. 견적·매출 추적 Ctrl+Shift+R → 탭 제목이 `ql-1008tp`인지 확인
3. **Meta에서 승인 언어 확인**: WhatsApp Manager › 메시지 템플릿 › `nueva_cotizacion` 행의 언어
   - **Spanish (MEX)** → 할 일 없음(기본 es_MX)
   - **Spanish** → 외부 서비스 키 › WhatsApp › 「신규견적 템플릿 언어」에 `es` 입력
4. 「📲 신규견적 알림」 › 받는 사람 행의 **시험 발송** → 원장 「접수(템플릿)」 · ✓✓ 도착 확인

## ③ 테스트방법

- 휴대폰에서 회사 번호로 24시간 넘게 메시지를 보내지 않은 상태에서 새 견적 → 템플릿 메시지 도착
- 원장에 ⚠가 보이면 그 문구(#132001 = 이름/언어 불일치, #132000 = 변수 개수, #131042 = 결제 수단)를 보고 조치

## ④ 변경파일

| repo 경로 | 변경 |
|---|---|
| `refatrix-api/src/quoteWaNotify.js` | `deliverQuote`(템플릿 우선) · 기본 템플릿 `nueva_cotizacion` · `quoteWaTemplateLang` |
| `refatrix-api/src/routes/quoteWaRoutes.js` | 상태에 `template_lang` · `template_set` |
| `refatrix-api/src/secrets.js` | `QUOTE_WA_TEMPLATE_LANG` 칸 · 템플릿명 안내 문구 |
| `refatrix-quotelist.html` (루트) | 상태 칩 · 원장 「접수(텍스트)」+⚠ 사유 · build `ql-1008tp` |
| `refatrix-api/test/quote_wa_notify.test.mjs` | A5 · B11 추가 |
| `refatrix-api/test/quote_wa_front.test.mjs` | 빌드 토큰 |

## ⑤ 검증결과

- `quote_wa_notify` **17/17**(실 PostgreSQL 16).
  - A5(발송 규칙 7가지): 모름 → 템플릿 · 닫힘 → 템플릿 · 열림 → 텍스트 · 텍스트 실패 → 템플릿 · 닫힘 + 템플릿 실패 → 텍스트 안 보냄 · 모름 + 템플릿 실패 → 텍스트 + 사유 · 이름 비움 → nueva_cotizacion
  - B11(**Meta 호출을 가로채 실제 본문 확인**):
    - 웹훅 없이 새 견적 → `type: template`, `name: nueva_cotizacion`, `language: es_MX`, 변수 = 견적번호가 든 한 줄
    - #132001 실패 → 템플릿 → 텍스트 순으로 보내고 원장에 #132001이 남음
    - 상태 API · 원장 API에서도 사유가 보임
    - 창이 닫힌 걸 알면 텍스트를 보내지 않고 실패로 남김
- 회귀: quote_wa_front 5 · wa_webhook 12 · wa_promo 10 · integration_nav 4 · quote_summary_front 20 통과
- service_secrets 23/24 — C3(메뉴 등록)는 변경 전부터 실패하던 기존 건

## ⑥ 결정사항

- 업무 알림(견적)은 템플릿을 기본으로 한다. 자유 텍스트는 창이 열린 게 확실할 때만 쓴다.

## ⑦ 오픈이슈

- 템플릿 메시지는 한 줄 요약만 담긴다(수주현황 3분류·당월 요약 상세는 창이 열린 사람만 받음). 받는 사람이 하루 한 번 회사 번호로 메시지를 보내 두면 상세를 받는다.
- 같은 위험이 공용 `sendWaTo`(오퍼시트·아침 브리핑)에도 있다. 웹훅이 창 상태를 아는 경우에는 문제없다.

## ⑧ 다음액션

- 배포 → 승인 언어 확인 → 시험 발송
