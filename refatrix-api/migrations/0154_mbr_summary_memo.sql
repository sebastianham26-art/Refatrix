-- 0154: MBR AI 요약별 메모 공간.
--  memo = 디렉터가 요약에 덧붙이는 자유 메모(열람자는 읽기만).
ALTER TABLE wbr_mbr_summaries ADD COLUMN IF NOT EXISTS memo TEXT;
