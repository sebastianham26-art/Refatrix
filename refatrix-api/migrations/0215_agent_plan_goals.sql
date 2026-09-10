-- 0215 · 영업사원/커미셔너별 「계획 총목표」
--
--   커미셔너 계약 조건: 본인 고객 전체를 합쳐 **2027-12 까지 IVA 제외 300만 페소**.
--   이 숫자를 어디에 둘지가 문제였다.
--
--   화면에 상수로 박으면 사람마다 다른 조건을 줄 수 없고(디렉터는 이미 사람마다
--   다른 보상 조건을 쓰고 있다), 바꾸려면 매번 재배포해야 한다. 그래서 한 줄짜리
--   등록부를 둔다. 행이 없으면 기본값(300만 / 2027-12)으로 동작하므로
--   **이 마이그레이션을 적용한 직후에도 아무 설정 없이 바로 쓸 수 있다.**
--
--   월별 목표 자체는 새 테이블을 만들지 않는다 — 기존 `target_customer_months`
--   (0004) 에 그대로 쌓인다. 그래야 영업 대시보드의 "팀목표 → 없으면 고객목표 합"
--   계산에 커미셔너 계획이 자동으로 얹힌다. 저장소를 따로 파면 두 숫자가 갈라진다.

CREATE TABLE IF NOT EXISTS agent_plan_goals (
  user_id      BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  goal_amount  NUMERIC(14,2) NOT NULL DEFAULT 3000000,   -- IVA 제외 MXN
  horizon_end  DATE          NOT NULL DEFAULT DATE '2027-12-01',  -- 그 달 포함
  note         TEXT,
  updated_by   BIGINT REFERENCES users(id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 곁가지 수정: 고객 삭제·병합이 목표 때문에 막히는 문제 ──────────────
--
--   `target_customer_months.customer_id` 의 외래키는 NO ACTION 이라,
--   월목표가 한 줄이라도 있는 고객은 **삭제도 병합도 실패한다**
--   (`violates foreign key constraint ... on table "target_customer_months"`).
--
--   지금까지는 목표를 디렉터만 넣었고 그 고객은 지울 일이 없어서 드러나지 않았다.
--   그런데 이제 커미셔너가 **자기가 등록한 고객 전부에 목표를 넣는다.** 잘못 등록한
--   고객을 지우거나 중복을 병합하는 순간 이 제약에 걸린다 — 흔한 일이 된다.
--
--   고객이 사라지면 그 고객의 월목표는 의미가 없다. 붙잡아 둘 이유가 없으므로
--   함께 지운다.
ALTER TABLE target_customer_months
  DROP CONSTRAINT IF EXISTS target_customer_months_customer_id_fkey;
ALTER TABLE target_customer_months
  ADD  CONSTRAINT target_customer_months_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
