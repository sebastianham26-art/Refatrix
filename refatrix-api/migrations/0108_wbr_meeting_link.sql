-- =====================================================================
-- Refatrix ERP · 0108_wbr_meeting_link
-- WBR 조회월 카드의 화상회의 링크(싱글톤). 디렉터/편집권한자가 수시로 변경, 소시오는 클릭.
--  - 단일 행(id=1). url 은 비어있을 수 있음(미설정).
-- =====================================================================

CREATE TABLE IF NOT EXISTS wbr_meeting (
  id         SMALLINT PRIMARY KEY DEFAULT 1,
  url        TEXT,
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wbr_meeting_singleton CHECK (id = 1)
);

INSERT INTO wbr_meeting (id, url) VALUES (1, NULL) ON CONFLICT (id) DO NOTHING;
