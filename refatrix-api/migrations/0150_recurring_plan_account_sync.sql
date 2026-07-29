-- 0150: 고정비 규칙-예정 회차 계좌 일괄 정렬 (일회성 데이터 정리, 멱등)
-- 배경: 규칙의 계좌를 변경해도 이미 [생성]된 예정(plan) 회차에는 생성 당시 계좌가 남아
--       거래목록·현금흐름·예산예측의 계좌 구분이 규칙과 어긋났음 (예: renta bodega → BBVA).
--       이후 변경분은 PATCH /api/recurring/:id 의 동기화 로직이 처리하고,
--       이 마이그레이션은 "과거에 이미 변경해 둔" 규칙들의 기존 회차를 한 번에 정렬한다.
-- 원칙: 미실행(plan)·미삭제 회차만 / 실적(actual)은 실제 출금 이력이므로 불변 /
--       규칙 계좌가 미지정(NULL)인 경우는 건드리지 않음 / 이미 일치하면 무변경(멱등).
UPDATE transactions
   SET account_id = r.account_id
  FROM recurring_rules r
 WHERE transactions.recurring_rule_id = r.id
   AND transactions.status = 'plan'
   AND transactions.deleted_at IS NULL
   AND r.deleted_at IS NULL
   AND r.account_id IS NOT NULL
   AND (transactions.account_id IS NULL OR transactions.account_id <> r.account_id);
