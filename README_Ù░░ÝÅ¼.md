# 카탈로그 조회 API (0221) — 배포 안내

고객사가 **우리 카탈로그를 가져가는** 창구다. 계약서 `Contrato_API_Catalogo_Multimarca_v1.0` 의 내용을
그대로 구현한 것이다.

---

## 1. 이 묶음에 든 것

### 새 파일 — 그대로 복사한다 (기존 파일과 겹치지 않는다)

```
refatrix-api/migrations/0221_catalog_pull_api.sql
refatrix-api/src/catalogPull.js
refatrix-api/src/routes/catalogApiRoutes.js
refatrix-api/test/catalog_pull.test.mjs
refatrix-catalog-api.html                 ← 관리 화면(신규)
```

### 고쳐 넣는 것 — **덮어쓰지 않는다**

```
refatrix-api/src/server.js     (2줄 추가)
refatrix-nav.js                (3군데 추가)
```

이 두 파일은 「견적요청 (수신)」 같은 다른 작업도 함께 고치는 파일이다.
통째로 덮으면 그 기능이 **조용히 사라진다.** 그래서 필요한 줄만 끼워 넣는 스크립트를 같이 넣었다.

---

## 2. 배포 순서

**① 새 파일 복사 + 스크립트 실행** (레포 최상위 = `refatrix-api` 폴더가 보이는 곳)

```bash
node apply_catalog_api.mjs
```

스크립트가 하는 일 세 가지:

1. `server.js` 에 라우트 등록 2줄
2. `refatrix-nav.js` 에 메뉴·권한 3군데
3. **모든 화면의 메뉴 캐시 토큰**을 `20260917catalog` 로 올린다
   (토큰을 안 올리면 직원 브라우저가 **예전 메뉴를 계속 써서** 새 메뉴가 안 보인다)

- 무엇을 넣었는지 화면에 찍는다. **두 번 실행해도 안전하다**(이미 있으면 건너뛴다).
- 자리를 못 찾으면 손으로 넣을 줄을 그대로 알려 준다.

> **견적요청 수신(0220)과 충돌하지 않는다.** 배포된 `origin/main`(견적수신_04) 의 실제 파일로
> 시험해서 확인했다: `crmQuoteRoutes` 등록과 견적 팝업이 그대로 살아남고, 마이그레이션도
> `0220_crm_quote_inbound.sql` / `0221_catalog_pull_api.sql` 로 번호가 겹치지 않는다.

**② 커밋 · 푸시** → Railway 자동 배포

**③ 마이그레이션**

```bash
npm run migrate        # 0221_catalog_pull_api 적용
```

**④ 프론트 배포** (`refatrix-catalog-api.html`, `refatrix-nav.js`) → **Ctrl+Shift+R**

포털 → 관리 그룹에 **「카탈로그 조회 API」** 가 보이면 성공이다.
탭 제목 끝에 `build 20260915catalogpull` 이 찍힌다.

> 순서를 바꾸면(프론트 먼저) 화면은 뜨는데 표가 없어 비어 보인다. 백엔드 → 마이그레이션 → 프론트다.

---

## 3. 배포 직후 화면에서 할 일

「카탈로그 조회 API」 → **「+ 고객사 추가」**

| 칸 | 넣을 값 |
|---|---|
| 이름 | 예: `Comparador Multimarca` |
| **연결 고객** | 그 고객사의 ERP 고객 마스터 — 옆에 뜨는 **할인율이 맞는지 확인**. 이 값으로 구매단가가 계산된다 |
| 접속창 | 요일 `토요일` · 시작 `5` · 종료 `9` (종료는 **미만**) |
| **사진 주소 규칙** | 아래 값을 **반드시** 넣는다 |

```
https://pub-d34920cb200c42ce91c5cbda135f16d6.r2.dev/products/{code}/{code}_1.webp
```

> ⚠ 이 칸을 비워 두면 제품전송 연동의 설정을 물려받는다. 그건 `.jpg` 규칙이라
> **계약서에 적은 주소와 다른 값이 고객에게 나간다.** 이번 배포에서 유일하게 조용히 틀릴 수 있는 지점이다.

그다음:

1. **「미리보기 — 고객이 받을 값」** → `imagenUrl` 과 `precioCompra` 가 계약서대로 나오는지 눈으로 확인
2. **테스트 키 발급** → 개발자에게 전달 (테스트 키는 접속창을 받지 않아 평일에도 붙어 볼 수 있다)
3. 검수 끝나면 **운영 키 발급** → 전달. 키는 **발급 직후 한 번만** 보인다

---

## 4. 가격이 어떻게 나가는가 (확인용)

```
precioCompra = 반올림2( products.list_price × (1 − customers.discount / 100) )
```

조회가 들어온 **그 순간** 계산한다. 고객 마스터의 할인율을 바꾸면 **다음 호출부터** 바뀐 가격이
나간다 — 재배포도 재적재도 필요 없다. 공식은 청구서가 단가를 만드는 공식과 같다.

할인율이 비어 있거나 0이면 0% 로 보고 **정가가 그대로** 나간다.
고객을 연결하지 않은 고객사는 목록에 「정가만 나갑니다」로 붉게 표시된다.

---

## 5. 시험

```bash
# 순수 로직만 (DB 없이)
node --test --test-concurrency=1 test/catalog_pull.test.mjs

# 실 DB 까지 (32개 전부)
TEST_PG_URL=postgres://... node --test --test-concurrency=1 test/catalog_pull.test.mjs
```

이 저장소의 HTTP 스위트는 끝난 뒤 프로세스가 스스로 종료되지 않는다(서버 백그라운드 감시자 때문).
결과는 다 나오므로 `timeout 100 node --test …` 로 감싸면 된다. 기존부터 그랬다.

---

## 6. 되돌리려면

- 화면에서 그 고객사를 **「중지」**로 바꾸거나 **키를 폐기**하면 즉시 막힌다(배포 되돌릴 필요 없음).
- 표를 지울 필요는 없다. 0221 은 **새 표 3개만 만들고 기존 표는 건드리지 않는다.**
