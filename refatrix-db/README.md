# Refatrix ERP — 데이터베이스 마이그레이션 (PostgreSQL)

권한·보안 설계 v0.2 / DB 스키마 v0.1 기준의 **순수 SQL 마이그레이션**입니다.
번호 순서대로(0001 → 0009) 한 번씩만 적용하는 전진(forward-only) 방식입니다.

## 구성
- `0001_common.sql` — 확장, updated_at 자동 갱신 트리거 함수
- `0002_users_permissions_devices.sql` — 사용자, 메뉴/필드/항목 권한, 기기 등록
- `0003_accounts_categories_transactions.sql` — 계좌, 과목(P&L), 거래, 반복 고정비
- `0004_customers_stages_targets.sql` — 단계/고객/이력, 전사월목표, 고객별 매출목표
- `0005_products_imports_inventory_invoices.sql` — 제품, 수입 입고(이동평균), 입출고, 매출내역
- `0006_marketing.sql` — 마케팅 메뉴/활동
- `0007_calendar_tasks_checks.sql` — 일정, 업무(Tarea), 공지, 읽음확인
- `0008_audit_log.sql` — 감사 로그
- `0009_seed_reference.sql` — 기준(마스터)성 데이터만. **실데이터는 세팅 완료 후 별도 이관.**

## 적용 방법

### 한 번에 순서대로
```bash
for f in migrations/0*.sql; do
  echo ">> $f";
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" || break;
done
```

### 개별 적용
```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_common.sql
# ... 0009 까지
```

`DATABASE_URL` 예: `postgres://user:pass@host:5432/refatrix`

## 운영 메모
- **스테이징 먼저**: 새 마이그레이션은 시험 환경에 먼저 적용 → 확인 후 운영.
- **백업 우선**: 운영 적용 전 자동 백업이 도는지 확인.
- **새 변경은 새 파일**: 기존 파일을 수정하지 말고 `0010_...`처럼 새 번호로 추가(전진 방식).
- **관리자 부트스트랩**: `0009`의 `pin_hash` 자리표시자는 백엔드 해시값으로 교체해야 로그인 가능.
- **감사 로그**: 애플리케이션 DB 계정에 audit_log는 INSERT만 허용하고 UPDATE/DELETE는 차단(무결성).

## 다음 단계
백엔드 API 골격 — 로그인·권한 강제·데이터 최소 전송·기기 등록·감사 로그·이동평균 계산.
