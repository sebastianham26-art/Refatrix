# 배포 안내 — 영업 > 고객상담 > 🎪 전시회 미팅 시간표 (v1, 2026-08-26)

**마이그레이션 있음(0184)** · **환경변수 추가 없음**(기존 `ANTHROPIC_API_KEY` 재사용)

## 순서대로 하시면 됩니다

1. `refatrix_전시회_v1.zip` 을 **repo 최상위**에 풀어 7개 파일을 덮어씁니다.
   (덮어쓰는 기존 파일은 `refatrix-consult.html` 과 `refatrix-api/src/server.js` 두 개뿐이고,
   server.js 는 **import 1줄 + register 1줄**만 늘어납니다.)
2. GitHub Desktop → **Commit → Push** → Railway 자동 재배포 **Success** 확인.
3. Railway **APP Console** 에서 `npm run migrate` 실행 → `0184_exhibitions.sql` 적용.
   (`CREATE TABLE IF NOT EXISTS` 라 여러 번 돌려도 안전합니다.)
4. 브라우저에서 **Ctrl+Shift+R**(폰은 브라우저 새로고침) → 영업 → 고객상담 →
   상단에 **[🧾 일반 고객상담] [🎪 전시회]** 두 버튼이 보이면 배포 완료입니다.

## 처음 한 번만 — RUJAC 등록

**디렉터 계정**으로 `🎪 전시회` → **⚙ 설정** → 이름 `RUJAC`, 장소, **1st day 날짜**,
일수 `3일`, 시작 `08:00`, 종료 `18:00`, 통화 `MXN`, 기본 전시회 `예` → **전시회 만들기**.
→ 바로 3일 × 10칸 시간표가 생깁니다. (전시회 등록·수정은 디렉터만, 미팅 등록·기록은 전 직원)

## 배포 확인 (raw URL)

```bash
B=https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main
curl -s "$B/refatrix-api/migrations/0184_exhibitions.sql?nc=$(date +%s)" | grep -c "exhibition_meetings"   # 1+
curl -s "$B/refatrix-api/src/routes/exhibitionRoutes.js?nc=$(date +%s)" | grep -c "meetings/:mid/evaluate" # 1+
curl -s "$B/refatrix-consult.html?nc=$(date +%s)"                       | grep -c "b20260826ex1"          # 1+
curl -s "$B/refatrix-api/src/server.js?nc=$(date +%s)"                  | grep -c "exhibitionRoutes"      # 2
```

## 문제가 생기면

| 증상 | 원인 / 조치 |
|---|---|
| 🎪 버튼을 눌러도 "전시회가 없습니다" | 정상입니다 — ⚙ 설정에서 전시회를 먼저 등록하세요 |
| 500 오류 / 보드가 안 뜸 | `npm run migrate` 를 안 돌린 경우입니다 |
| 화면이 예전 그대로 | HTML 은 캐시버스터가 없습니다 — **Ctrl+Shift+R** (폰은 브라우저 캐시 삭제) |
| 🤖 판단이 "AI 요약이 끝난 뒤에" 라고 함 | 녹음 → 업로드 → 요약(1~3분)이 끝나야 판단할 수 있습니다 |
| 되돌리고 싶을 때 | `refatrix-consult.html` 과 `server.js` 만 이전 커밋으로 되돌리면 됩니다. 0184 테이블은 그대로 둬도 다른 기능에 영향이 없습니다 |
