-- 🧭 고객개발 (디렉터 요청 2026-11-26) — DENUE 업로드 파일별 관리
--   prospect_import_batches : 업로드 1번(파일 1개)의 기록 — 파일 이름·판·주·행 수·새로 넣은 수·갱신 수
--   prospects.import_batch_id : 그 후보를 처음 넣은 업로드(이후 다른 파일로 갱신돼도 그대로)
--   → 「DENUE 데이터 삭제」에서 파일을 골라 그 파일로 들어온 후보만 지울 수 있다.
-- 멱등 — 재실행 안전.
CREATE TABLE IF NOT EXISTS prospect_import_batches (
  id          BIGSERIAL PRIMARY KEY,
  file_name   TEXT,
  edition     TEXT,
  cve_ents    TEXT[] NOT NULL DEFAULT '{}',
  rows_total  INT NOT NULL DEFAULT 0,
  created     INT NOT NULL DEFAULT 0,
  updated     INT NOT NULL DEFAULT 0,
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS import_batch_id BIGINT REFERENCES prospect_import_batches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_prospects_import_batch ON prospects(import_batch_id) WHERE import_batch_id IS NOT NULL;

-- 예전 업로드에서 UTF-8 파일이 Latin-1 로 읽혀 「GarcÃ­a」처럼 깨진 글자는 되살린다(되살릴 수 없는 값은 그대로 — 파일을 다시 올리면 고쳐짐)
DO $$
DECLARE r RECORD; c TEXT; v TEXT;
BEGIN
  FOREACH c IN ARRAY ARRAY['nom_estab','municipio','colonia','address','localidad','entidad'] LOOP
    FOR r IN EXECUTE format('SELECT id, %I AS v FROM prospects WHERE %I ~ ''[ÃÂ]''', c, c) LOOP
      BEGIN
        v := convert_from(convert_to(r.v, 'LATIN1'), 'UTF8');
        EXECUTE format('UPDATE prospects SET %I=$1 WHERE id=$2', c) USING v, r.id;
      EXCEPTION WHEN others THEN NULL;
      END;
    END LOOP;
  END LOOP;
END $$;
