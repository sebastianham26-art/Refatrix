# 카탈로그 변경분 자동 전송 — 묶인 대기 건이 더는 막지 않는다 · 2026-10-23

## 고친 것

### ① 대기 1건이 전체를 멈추던 문제
종전 규칙은 **「대기(pending)가 0건일 때만 변경분을 보낸다」** 였다.
그런데 연동이 꺼져 있거나 주소가 비어 있으면 그 건은 **시도 횟수도 쓰지 않고 pending 으로 남는다.**
→ 그 한 건이 **이후 모든 변경분 자동 전송을 영원히 막았다.**

이제 **「지금 나가는 중인 전송」만** 겹침으로 본다.

- 최근 **15분 안에** 적재된 대기 건이 있으면 → 종전처럼 쉰다(전체 전송과 겹치지 않게).
- 그보다 오래 묶인 대기 건은 → **무시하고 변경분을 보낸다.** 서버 로그에 한 줄 남긴다.

### ② 화면에 경고
연동 관리 › 제품 전송 카드에 묶인 건이 있으면 노란 띠가 뜬다.

```
⚠ 대기함에 3건이 약 820분째 묶여 있습니다 (예: DLT-20261022…).
변경분 자동 전송은 그대로 돌지만, 이 건들은 CRM 에 가지 않았습니다 —
연동 주소·켜짐을 확인한 뒤 「전체 보내기」나 「고른 제품만 보내기」로 다시 보내세요.
```

`GET /api/product-sync/status` 에 `pending_stale {total, fresh, stale, oldest_min, example}` 추가.

## 파일 (3 + 시험 2) — 마이그레이션 없음
refatrix-api/src/productSync.js — `pendingProductStats()` · `PENDING_FRESH_MIN=15` · `deltaDue(pendingFresh)`
refatrix-api/src/routes/productSyncRoutes.js — status 에 `pending_stale`
refatrix-integrations.html — 경고 띠
refatrix-api/test/product_sync_delta.test.mjs · product_sync.test.mjs

배포: 백엔드 → 프런트 → Ctrl+Shift+R

## 시험 (실 PostgreSQL 16, 빈 DB 에 마이그레이션 적용)
`product_sync_delta` + `product_sync` → **32 통과 / 0 실패 / 1 생략**

- 순수 함수: 오래 묶인 대기 3건 → 돈다 · 방금 적재된 9건 → 쉰다 · 주기 전이면 쉰다 · 기준 없으면 안 돎
- 실 DB: 20분 전 적재된 대기 건을 넣고 틱 → **변경분이 나간다**(`ran: 'delta'`) ·
  방금 적재된 건을 넣으면 → 쉰다(`delta_not_due`)
- `pendingProductStats()` 가 묶인 건수와 나이(분)를 정확히 센다

### 덤 — 낡은 시험 1곳
`product_sync.test.mjs` 의 「인라인 스크립트 2블록」 검사가 화면이 3블록으로 늘어난 뒤로 깨져 있었다.
3 으로 맞췄다(운영 코드 변경 아님).

## 같이 든 점검 명령 (읽기 전용)
- `railway_자동전송점검_한줄.txt` — 설정·대기·회차·지금 보낼 것 + 마지막 판정
- `railway_실패건확인_한줄.txt` — 실패로 끝난 건이 재시도 대상인지

## 남은 권고
**전체 자동 전송이 꺼져 있다.** 변경분만으로도 평소에는 충분하지만, CRM 과 어긋났을 때 바로잡는
안전장치가 없다. 주 1회(예: 일요일 06시) 켜 두기를 권한다 — 연동 관리의 「전체 자동 전송」.
