-- =====================================================================
-- 0236 · 제품 카탈로그 「변경분만」 자동 전송 (2026-09-29)
--
--   디렉터: 「14,000개가 넘는 SKU 를 매번 보낼 수 없다. 변경된 것만 자동으로 보내자.」
--   결정: 변경분 5분마다 자동 · 전체 전송은 주 1회 자동 + 수동 버튼.
--
--   ① product_sync_state — 제품별로 「CRM 에 마지막으로 실어 보낸 본문의 지문(hash)」.
--      5분마다 지금 값의 지문과 비교해 달라진 제품만 보낸다.
--      제품을 고친 경로(화면 수정·엑셀 업로드·가격 마스터·재고 변동)와 무관하게 잡힌다.
--   ② product_sync_runs.mode 에 'delta' 추가 — 변경분 전송은 **마감 신호를 보내지 않는다**
--      (마감하면 CRM 이 이번에 안 온 제품 = 나머지 전부를 감춘다).
--   ③ integration_endpoints 설정 3칸 — 변경분 자동 켜기 · 주기(분) · 전체 전송 요일.
--
--   멱등 — 재실행 안전.
-- =====================================================================

CREATE TABLE IF NOT EXISTS product_sync_state (
  code        TEXT PRIMARY KEY,                 -- 제품코드(보낸 본문의 codigo)
  hash        TEXT NOT NULL,                    -- 마지막으로 실어 보낸 본문의 지문
  run_id      BIGINT,                           -- 그 전송 회차(product_sync_runs.id)
  outbox_id   BIGINT,                           -- 그 본문이 들어간 아웃박스 행 — 실패면 다음 변경분에 다시 싣는다
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pss_outbox ON product_sync_state (outbox_id);

-- ② mode 에 delta 추가 (0218 의 CHECK 이름은 PostgreSQL 기본 이름)
ALTER TABLE product_sync_runs DROP CONSTRAINT IF EXISTS product_sync_runs_mode_check;
ALTER TABLE product_sync_runs
  ADD CONSTRAINT product_sync_runs_mode_check CHECK (mode IN ('full','test','delta','baseline'));

-- ③ 설정
--   delta_auto      : 변경분 자동 전송 켜기(기본 켬 — 연동 자체가 꺼져 있으면 아무것도 나가지 않는다)
--   delta_every_min : 변경분 확인 주기(분, 5~1440)
--   full_weekday    : 전체 자동 전송 요일(0=일 … 6=토, NULL=매일). auto_send 가 켜져 있을 때만.
ALTER TABLE integration_endpoints ADD COLUMN IF NOT EXISTS delta_auto      BOOLEAN  NOT NULL DEFAULT true;
ALTER TABLE integration_endpoints ADD COLUMN IF NOT EXISTS delta_every_min INT      NOT NULL DEFAULT 5;
ALTER TABLE integration_endpoints ADD COLUMN IF NOT EXISTS full_weekday    SMALLINT;

-- 디렉터 결정: 전체 자동은 **주 1회(일요일)** + 수동. 제품 창구만, 아직 요일을 안 정한 경우에만.
UPDATE integration_endpoints SET full_weekday = 0
 WHERE key = 'product' AND full_weekday IS NULL;
