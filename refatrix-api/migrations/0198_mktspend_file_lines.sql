-- 0198_mktspend_file_lines.sql
-- 증빙을 「지급 줄」 단위까지 내린다 — 선지급금·중도금·잔금마다 각각 견적서·영수증.
--
-- 배경(0197 후속): 한 집행 항목이 선지급/중도금/잔금으로 나뉘면 송금도 그 횟수만큼
--   일어나고 영수증도 그만큼 나온다. 항목 단위로만 붙이면 어느 송금의 영수증인지
--   다시 알 수 없어진다. 견적서도 줄마다 따로 받는 경우(분할 계약)가 있어 함께 허용한다.
--
-- 증빙의 3단계 (좁은 쪽이 우선해서 보인다):
--   line_id 있음            → 그 지급 줄의 증빙   (예: 잔금 영수증)
--   item_id 만 있음         → 그 집행 항목 공통   (예: 장소 대관 계약서)
--   둘 다 NULL              → 계획 공통           (예: 전체 기안 근거)
--
-- line_id 는 ON DELETE SET NULL — 줄이 없어져도 증빙은 사라지지 않고
-- 한 단계 위(항목 공통)로 내려앉는다. 증빙은 절대 유실시키지 않는다.
--
-- 멱등: IF NOT EXISTS. 여러 번 적용해도 안전. 기존 행은 line_id NULL 로 남는다
-- (0197 에서 붙인 항목 증빙은 그대로 항목 공통으로 유지).

ALTER TABLE marketing_spend_files
  ADD COLUMN IF NOT EXISTS line_id BIGINT REFERENCES marketing_spend_lines(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_msf_line ON marketing_spend_files (line_id);
