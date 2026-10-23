# 키트 사진 「R2 업로드 실패」 — 원인을 말해 주게 고침 · 2026-10-23

## 지금 문제
화면은 **「R2 업로드 실패」** 한 줄만 보여 준다. 실패에는 서로 다른 원인이 여럿인데
무엇을 고쳐야 하는지 알 수가 없다(키가 틀렸는지, 권한이 없는지, 버킷 이름이 틀렸는지).

## 고친 것 (마이그레이션 없음)

### ① 실패 사유를 사람 말로
`r2Why()` 를 새로 만들어 Cloudflare 가 돌려준 코드로 **무엇을 고쳐야 하는지**까지 적는다.

| Cloudflare 코드 | 화면에 나오는 말 |
|---|---|
| `SignatureDoesNotMatch` | 열쇠(R2_SECRET_ACCESS_KEY)가 맞지 않습니다 — 토큰을 다시 만들어 넣으세요 |
| `InvalidAccessKeyId` | R2_ACCESS_KEY_ID 가 이 계정의 것이 아닙니다 |
| `AccessDenied` | 토큰에 쓰기(Object Read & Write) 권한이 없습니다 |
| `NoSuchBucket` | 버킷 이름이 틀렸습니다(R2_BUCKET) |
| 닿지 못함 | 계정 주소(R2_ACCOUNT_ID)나 네트워크 |
| 키 없음 | 빠진 Railway 환경변수 이름을 그대로 적어 준다 |

실패는 서버 로그와 감사기록(`vio_kit_image_fail:K0008`)에도 남는다.

### ② 「🩺 R2 점검」 단추 (프로모션 목록 아래)
작은 파일 하나를 **올려 보고(쓰기)**, 그 **공개 주소로 다시 읽어 본다(읽기)**. 결과를 셋으로 나눠 보여 준다.

```
① 설정: 키 4개 모두 있음 · 공개 주소 https://pub-….r2.dev
② 올리기(쓰기): 실패 — HTTP 403 AccessDenied — 토큰에 쓰기 권한이 없습니다
③ 공개 주소로 읽기: …
```

점검 파일은 `products/_diag/r2_check.txt` 하나뿐이다. **키트 사진이나 제품 사진은 건드리지 않는다.**
디렉터(또는 「🧰 키트 등록」 권한)만 누를 수 있다.

## 쓰는 법
1. 백엔드 push → Railway Success → 프런트 push → **Ctrl+Shift+R**
2. 제품·마케팅 → VIO 제품찾기·프로모션 → **프로모션 목록** 탭 → 아래 **「🩺 R2 점검」**
3. 나온 문장을 그대로 알려 주시면 어디를 고쳐야 하는지 답해 드립니다.

## Railway 환경변수 (확인용)
`R2_ACCOUNT_ID` · `R2_ACCESS_KEY_ID` · `R2_SECRET_ACCESS_KEY` · `R2_BUCKET`
(선택) `R2_PUBLIC_BASE` — 기본값은 지금 쓰는 `https://pub-d34920cb200c42ce91c5cbda135f16d6.r2.dev`

Cloudflare → R2 → **Manage API Tokens** 에서 토큰을 만들 때
**Object Read & Write** 권한과 해당 버킷 범위를 반드시 주어야 한다. 읽기 전용 토큰이면 ②에서 막힌다.

## 파일 (3 + 시험 2)
refatrix-api/src/r2.js
refatrix-api/src/routes/vioPromoRoutes.js
refatrix-viofinder.html
refatrix-api/test/r2.test.mjs · test/vio_promos.test.mjs

## 시험 (실 PostgreSQL 16)
- `r2.test.mjs` 3/3 — 서명이 botocore 값과 같음 · 실패 사유 문장(서명·권한·버킷·키 없음·네트워크)
- `vio_promos.test.mjs` 3/3 — R2 점검은 디렉터만 · 점검 파일만 올림 · 403 이면 「쓰기 권한」이라고 알려 줌 ·
  키트 사진 실패 응답에 진짜 사유가 실림

## 덤 — 제품 전송 점검 명령
`railway_제품전송점검_한줄.txt` (K0008 이 CRM 으로 안 간 건 별개 문제).
Railway 콘솔에 `node` 가 PATH 에 없어 실패했으므로 **node 경로를 자동으로 찾도록** 고쳤다. 그대로 붙여넣기.
