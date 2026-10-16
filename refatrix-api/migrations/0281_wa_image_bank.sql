-- =====================================================================
-- Refatrix ERP · 0281_wa_image_bank — WhatsApp 마케팅 이미지 뱅크 (2026-10-16 디렉터 지시)
--   「이미지를 작업해서 저장하는 이미지 뱅크 — 대량 저장 · 파일이름 + 썸네일 목록(크게/작게) · 광고 이력을 날짜로」
--   · wa_images : 원본(JPG/PNG · 5MB 이하) + 썸네일(화면이 만든 JPEG) · 폴더 · 같은 파일(md5)은 한 번만
--   · wa_campaigns.image_id : 어느 뱅크 이미지로 보냈는지 → 이미지별 광고 이력
--     (발송은 지금처럼 자기 이미지 사본을 갖는다 — 뱅크에서 지워도 예약 · 이력은 그대로)
--   · 기존 발송 이미지는 뱅크로 옮겨 담고(md5 로 묶음) 발송과 이어 준다.
--   멱등(IF NOT EXISTS · ON CONFLICT) — 재실행 안전.
-- =====================================================================
CREATE TABLE IF NOT EXISTS wa_images (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/png')),
  bytes       BYTEA NOT NULL,
  size        INT  NOT NULL,
  hash        TEXT NOT NULL,                 -- md5(bytes) — 같은 파일 중복 저장 방지
  width       INT,
  height      INT,
  thumb       BYTEA,                         -- 화면이 만든 작은 JPEG(없으면 원본으로 보여줌)
  folder      TEXT,
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_images_hash ON wa_images (hash) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wa_images_live ON wa_images (created_at DESC) WHERE deleted_at IS NULL;

ALTER TABLE wa_campaigns ADD COLUMN IF NOT EXISTS image_id BIGINT REFERENCES wa_images(id);
CREATE INDEX IF NOT EXISTS idx_wa_campaigns_image ON wa_campaigns (image_id);

-- 기존 발송 이미지 → 뱅크(같은 파일은 하나로, 가장 처음 쓴 발송의 이름 · 작성자 · 시각)
INSERT INTO wa_images (name, mime, bytes, size, hash, created_by, created_at, folder)
SELECT DISTINCT ON (md5(c.image))
       COALESCE(NULLIF(c.image_name, ''), 'campaign_' || c.id || CASE WHEN c.image_mime = 'image/png' THEN '.png' ELSE '.jpg' END),
       c.image_mime, c.image, octet_length(c.image), md5(c.image), c.created_by, c.created_at, '지난 발송'
  FROM wa_campaigns c
 WHERE c.image IS NOT NULL AND c.image_mime IN ('image/jpeg','image/png')
 ORDER BY md5(c.image), c.created_at, c.id
ON CONFLICT (hash) WHERE deleted_at IS NULL DO NOTHING;

UPDATE wa_campaigns c SET image_id = i.id
  FROM wa_images i
 WHERE c.image_id IS NULL AND i.deleted_at IS NULL AND i.hash = md5(c.image);
