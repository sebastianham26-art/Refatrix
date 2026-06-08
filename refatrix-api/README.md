# Refatrix ERP — 백엔드 골격 (Fastify + PostgreSQL)

권한·보안 설계 v0.2 / DB 스키마 v0.1 기준의 **백엔드 뼈대**입니다.
핵심 구조(로그인·권한 강제·데이터 최소 전송·기기 등록·감사 로그·이동평균 원가)를
실제 동작하는 형태로 담았고, 대표 메뉴(제품·수입·사용자·기기)를 예시로 구현했습니다.
나머지 메뉴는 같은 패턴으로 확장합니다.

## 기술 구성
- Node.js (>=18) + Fastify (서버 틀) + @fastify/jwt (로그인 토큰)
- PostgreSQL (pg) — 앞서 만든 마이그레이션과 연결
- 특정 호스팅에 종속되지 않음 (Railway / Render 등 어디서나 구동)

## 폴더
```
src/
  server.js          서버 시작 + 라우트 등록 + 감사 로그 조회
  config.js          환경설정(.env)
  db.js              DB 연결 풀 + 트랜잭션 헬퍼
  auth.js            PIN 해시/검증(scrypt), 기기 키 해시
  permissions.js     권한 판단 + 데이터 최소화(순수 함수)
  permLoader.js      DB에서 권한·기기 상태 로드
  audit.js           감사 로그(민감=건별 / 열람=일별 요약)
  cost.js            이동평균 원가 계산(수입 승인)
  middleware/authGuard.js  토큰검증·메뉴/기기/디렉터 가드
  routes/            auth · device · product · import · user
scripts/migrate.js   마이그레이션 적용 러너
test/logic.test.js   원가·권한 단위 테스트(DB 불필요)
```

## 로컬/호스팅 실행
1) 환경설정: `.env.example` 를 `.env` 로 복사 후 값 입력 (DATABASE_URL, JWT_SECRET 등).
   호스팅에서는 대시보드 환경변수에 동일 입력.
2) 설치: `npm install`
3) DB 마이그레이션 적용: `npm run migrate` (refatrix-db/migrations 를 순서대로 적용)
4) 서버 시작: `npm start` → `GET /health` 로 확인
5) 테스트: `npm test` (원가·권한 로직 검증, DB 없이 실행)

## 핵심 동작 요약
- **로그인**: `POST /api/login` { login_id, pin, device_key? } → 토큰 발급.
  새 기기면 자동으로 등록요청(pending) 생성.
- **권한 강제(서버)**: 메뉴 접근은 `requirePage`, 디렉터 전용은 `requireDirector`.
  민감 필드는 응답에서 제거(데이터 최소 전송) — 화면이 아니라 서버가 거른다.
- **기기 등록**: 미등록→pending→디렉터 승인(`/api/devices/:id/approve`).
  민감 메뉴는 `registered_only` 로 설정 시 등록기기+로그인 둘 다 충족해야 열림.
- **수입 이동평균**: 작성(pending) → `/api/imports/:id/preview` 로 예상 원가 확인 →
  디렉터 `/api/imports/:id/approve` 시점에만 재고·평균원가 갱신, 원장·스냅샷 기록.
  부대비용은 1/n 균등배분, 입고일 환율로 MXN 환산.
- **감사 로그**: 민감 행동은 건별, 페이지 열람은 일별 요약. `GET /api/audit`(디렉터 열람).
  운영 DB 계정에서 audit_log 는 INSERT만 허용(UPDATE/DELETE 차단) 권장.

## 보안 메모
- JWT_SECRET 은 길고 무작위한 값으로. 절대 공개 금지.
- PIN 은 평문 저장 안 함(scrypt 해시). 생성/재발급 시에만 평문을 1회 반환해 통보.
- 기기 등록 키 원본은 저장하지 않고 해시만 저장.
- 전 구간 HTTPS(호스팅 기본).

## 다음 단계
- 나머지 메뉴 라우트 확장(거래·매출목표·매출내역·고객·마케팅·일정·업무).
- 현 프로토타입 화면을 이 API에 연결(메모리 → 서버 통신).
- 호스팅 배포 + 자동 백업/HTTPS → 세팅 완료 후 실데이터 이관.
