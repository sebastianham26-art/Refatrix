# 카탈로그 조회 API — 테스트 키 429 (ERR_RATE_LIMIT) 수정 · 2026-10-07

## 증상
CIOSA 테스트 키로 16:44 에 전체 카탈로그를 다 받은 뒤(1000·1000·1000·1000·917),
17:40 과 19:31 호출이 **429 ERR_RATE_LIMIT** 로 막혔다.

## 원인
호출 한도(`max_calls`, 기본 60)를 **환경 구분 없이 한 통으로** 세고 있었다.
테스트 키로 받은 호출이 운영 몫까지 같이 깎아 먹는 구조다. 게다가 한도에 걸려 돌려보낸 429 자체도
이력에 남아 다음 계산에 다시 포함돼, 한 번 걸리면 그날은 계속 걸리는 눈덩이가 됐다.

## 수정 (마이그레이션 없음)
- **환경별로 따로 센다.** 테스트 호출은 운영 한도를 건드리지 않는다. 그 반대도 마찬가지.
- **테스트 키 한도**: 하루(멕시코 0시 기준) `max(500, max_calls × 5)`.
  전체 카탈로그 한 번이 5~6 호출이므로 하루 수십 번을 받아도 걸리지 않는다.
- **운영 키**: 종전대로 접속창 시작 시각부터 `max_calls`. 토요일 05:00–09:00 규칙 그대로.
- **429 는 세지 않는다.** 한도를 올리면 그 즉시 풀린다.

## 교체 파일 (2 + 시험 1)
refatrix-api/src/catalogPull.js
refatrix-api/src/routes/catalogApiRoutes.js
refatrix-api/test/catalog_pull.test.mjs

프런트 변경 없음. 순서: 백엔드만 푸시 → Railway Success.

## 시험
node --test test/catalog_pull.test.mjs → **44 통과 / 0 실패** (실 PostgreSQL 16)
  42 ★ 테스트 호출은 운영 한도를 먹지 않는다 — 환경별로 따로 센다

## 지금 당장 풀어 주려면 (배포 전 임시)
카탈로그 조회 API 화면 → CIOSA → 설정 → **「한 접속창 호출 한도」를 500** 으로 올리고 저장.
배포 뒤에는 60 으로 되돌려도 된다(테스트는 따로 세므로 영향 없음).

## 오늘 몇 번 불렸는지 보려면 (Railway 백엔드 콘솔)
cd /app && node -e "const p=require('pg');const d=new p.Pool({connectionString:process.env.DATABASE_URL});d.query(\"SELECT env, count(*) n, count(*) FILTER (WHERE codigo_error='ERR_RATE_LIMIT') bloqueadas FROM catalog_api_calls WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'America/Mexico_City') GROUP BY 1\").then(r=>{console.table(r.rows);d.end()})"
