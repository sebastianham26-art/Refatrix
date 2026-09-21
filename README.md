# 카탈로그 조회 API — 테스트 키 동기화도 회차에 남기기 · 2026-09-21

## 원인
동기화 회차(catalog_api_runs)는 **운영 키**로 받을 때만 기록되도록 만들어져 있었습니다.
테스트 키는 「주 1회 제한을 걸지 않는다」는 뜻으로 회차 자체를 만들지 않았고,
그래서 고객이 테스트 키로 받아 가면 **호출 이력에는 남지만 동기화 회차·마지막 동기화는 비어** 보였습니다.
(확인: check_catalog_sync.sql ① 에서 env = test 인지 보십시오.)

## 고친 것
- 테스트 키도 받을 때마다 회차 한 줄을 남깁니다 (env = 테스트). **막지는 않습니다** — 몇 번이든 다시 받을 수 있음.
- 운영 키 규칙은 그대로 (토요일 05–09시, 주 1회).
- 목록의 「마지막 동기화」: 운영 기준. 운영이 없으면 「테스트 · 날짜」로 표시.
- 동기화 회차 표에 운영/테스트 꼬리표.
- 계약서·고객 쪽 응답 모양은 **바뀌지 않습니다**.

## 교체 파일 (4) — DB 마이그레이션 없음
refatrix-api/src/catalogPull.js
refatrix-api/src/routes/catalogApiRoutes.js
refatrix-api/test/catalog_pull.test.mjs
refatrix-catalog-api.html

server.js · refatrix-nav.js 는 손대지 않습니다. 순서: 백엔드 → 프런트. 푸시는 디렉터님이.

## 시험
node --test test/catalog_pull.test.mjs → 42 통과 / 0 실패 (실 PostgreSQL 16)
  36 ★ 테스트 키로 다 받아 가도 동기화 회차에 남는다 — 그리고 몇 번이든 다시 받을 수 있다

## 주의
오늘 이전에 테스트 키로 받아 간 기록은 회차로 소급되지 않습니다 — 호출 이력(아래 표)에만 있습니다.
