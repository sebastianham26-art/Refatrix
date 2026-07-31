-- 0153: MBR AI 요약에 형광펜 표시 저장용 컬럼.
--  content_html = 사용자가 형광 표시(<mark>)를 입힌 렌더 HTML. NULL 이면 content_md 를 그대로 렌더.
ALTER TABLE wbr_mbr_summaries ADD COLUMN IF NOT EXISTS content_html TEXT;
