-- 0152: WBR 저장본(스냅샷) 여러 건을 AI로 요약한 MBR(월간 비즈니스 리뷰) 요약 보관함.
--  생성/삭제 = 디렉터 전용, 열람 = 'wbr' 페이지 권한자. content_md 는 마크다운 텍스트.
CREATE TABLE IF NOT EXISTS wbr_mbr_summaries (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  snapshot_ids BIGINT[] NOT NULL DEFAULT '{}',
  snapshot_labels TEXT[] NOT NULL DEFAULT '{}',
  model TEXT,
  content_md TEXT NOT NULL,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wbr_mbr_summaries_created
  ON wbr_mbr_summaries (created_at DESC);
