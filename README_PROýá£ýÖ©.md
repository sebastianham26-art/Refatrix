# PRO 제품 제외 + 재고 구간 (0222 · 0223) — 2026-09-17

**`PRO` 로 시작하는 제품코드는 고객에게 나가지 않는다.** 목록에서도, 단건 조회에서도 빠진다
(목록에만 없고 직접 조회는 되면 구멍이므로 양쪽 다 막았다).

접두어는 **화면에서 바꾼다** — 코드에 박아 두지 않았다. 「응답 내용 → 제외할 코드 접두어」,
기본값 `PRO`, 콤마로 여러 개(`PRO,KIT`), 대소문자 구분 없음. 비우면 전부 나간다.

재고 구간(0222)도 같이 들어 있다. 이미 반영했다면 그 마이그레이션은 건너뛴다.

## 파일 — 그대로 덮어쓴다

```
refatrix-api/src/catalogPull.js
refatrix-api/src/routes/catalogApiRoutes.js
refatrix-api/migrations/0222_catalog_stock_range.sql      (재고 구간 · 이미 했으면 그대로 둬도 됨)
refatrix-api/migrations/0223_catalog_exclude_prefixes.sql (PRO 제외)
refatrix-api/test/catalog_pull.test.mjs
refatrix-catalog-api.html
```

## 순서

1. 덮어쓰기 → 커밋 · 푸시
2. Railway 에서 **`npm run migrate`**
3. Ctrl+Shift+R → 「카탈로그 조회 API」 → 고객사 설정에 **「제외할 코드 접두어」** 칸 확인

## 확인

**「미리보기 — 고객이 받을 값」** 을 누르고 `codigo` 에 `PRO` 가 없는지 본다.
`총 제품 수(total)` 도 PRO 를 뺀 수로 줄어든다 — 고객이 받는 건수와 화면의 건수가 같아야 한다.

## 시험

36개 전부 통과(실 PostgreSQL 포함). 새로 넣은 것:

```
PRO 제품은 목록에 안 나온다                    ✅
PRO 제품은 단건 조회로도 404                   ✅
접두어를 비우면 다시 나온다(설정으로 되돌림)    ✅
접두어 파서 — 대소문자·공백·여러 개            ✅
```

## 알아 둘 것

- **제품전송(CRM 웹카달록) 연동에는 적용하지 않았다.** 그쪽은 이미 운영 중인 별개 계약이고,
  건드리면 웹카달록에 올라간 제품 목록이 조용히 바뀐다. 거기서도 PRO 를 빼야 하면 말씀해 달라 —
  같은 방식(설정 가능한 접두어)으로 넣겠다.
- 0223 마이그레이션 전이어도 서버는 죽지 않는다. 칼럼이 없으면 **안전한 쪽(PRO 차단)** 으로 동작한다.
