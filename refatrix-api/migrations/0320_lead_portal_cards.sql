-- =====================================================================
-- 0320 · 고객 포털 — 문의 카드 사이에 같은 모양의 「광고 카드」(2026-11-05 디렉터)
--   종류: producto(우리 제품) · anuncio(그 밖의 광고) · capacitacion(mecánico 교육 — refaccionaria 초대)
--   every_n = 문의 카드 몇 장마다 한 장. 기간(starts_on ~ ends_on) · 사용 여부.
--   lead_portal_card_clicks = 고객이 버튼을 누른 기록(click) · 「Quiero participar」(interest)
-- 재실행 안전.
-- =====================================================================
CREATE TABLE IF NOT EXISTS lead_portal_cards (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('producto','anuncio','capacitacion')),
  title       TEXT NOT NULL,
  body        TEXT,
  image_url   TEXT,
  cta_text    TEXT,
  cta_url     TEXT,
  every_n     INT  NOT NULL DEFAULT 6 CHECK (every_n BETWEEN 1 AND 50),
  sort        INT  NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT true,
  starts_on   DATE,
  ends_on     DATE,
  created_by  BIGINT REFERENCES users(id),
  updated_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS lead_portal_card_clicks (
  id          BIGSERIAL PRIMARY KEY,
  card_id     BIGINT NOT NULL REFERENCES lead_portal_cards(id),
  code_id     BIGINT REFERENCES lead_portal_codes(id),
  customer_id BIGINT REFERENCES customers(id),
  kind        TEXT NOT NULL CHECK (kind IN ('click','interest')),
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_portal_card_clicks_card ON lead_portal_card_clicks (card_id, at);

-- 첫 카드 — CTR Equipo Original (표가 비어 있을 때만)
INSERT INTO lead_portal_cards (kind, title, body, image_url, cta_text, cta_url, every_n, sort)
SELECT 'producto', 'CTR · Equipo Original',
       'CTR fabrica suspensión y dirección y es proveedor de equipo original (OE) de 37 fabricantes de automóviles en el mundo. La misma calidad que la pieza de agencia, para tus clientes.',
       'img/oe-badge.png', 'Ver catálogo CTR', 'https://www.refatrix.com.mx', 6, 0
 WHERE NOT EXISTS (SELECT 1 FROM lead_portal_cards);
