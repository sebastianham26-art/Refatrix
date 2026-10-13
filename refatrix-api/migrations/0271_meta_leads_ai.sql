-- 0271 · Meta 광고 문의 — AI(Claude)가 대화 전체를 읽고 고객 유형 · 지역 · 차종+연식 · 부품 · 요약을 뽑는다 (2026-10-13 디렉터 지시)
--   「대화에 차종 · 연식 · 요청 부품 · particular/flotilla 같은 유형 · 지역이 있다 — 이걸 감지해서 보여줘야 한다」
--   규칙 추출(a_*)은 철자 · 문맥을 놓친다(예: 우리 직원이 「Nissan Sentra 2015 맞으세요?」로 확인한 차종).
--   우선순위: 사람이 고친 값(m_*) > AI(ai_*) > 규칙(a_*).
-- 재실행 안전.
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS ai_tipo      TEXT;
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS ai_tipo_src  TEXT;          -- dicho(본인이 말함) / boton(광고 버튼만) / inferido(문맥 추정)
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS ai_state     TEXT;
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS ai_city      TEXT;
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS ai_vehicles  TEXT;          -- 「Nissan Versa 2017; Chevrolet Aveo 2018」
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS ai_parts     TEXT;          -- 「Horquilla (brazo de control); Amortiguador」
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS ai_demand    JSONB;         -- [{marca, modelo, anio, piezas:[…], cantidad}]
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS ai_phone     TEXT;
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS ai_intent    TEXT;
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS ai_summary   TEXT;          -- 한 줄 요약(스페인어)
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS ai_hash      TEXT;          -- 분석한 대화 내용의 지문 — 바뀐 대화만 다시 분석
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS ai_at        TIMESTAMPTZ;
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS ai_model     TEXT;
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS ai_error     TEXT;

-- WhatsApp 문의도 같은 목록에(2026-10-13 디렉터 지시: 「WhatsApp 으로 온 내용이 중요하다 — 연락처가 있다」)
--   ERP 의 WhatsApp Cloud API 번호로 받은 대화(wa_messages)를 platform='whatsapp' 행으로 합친다.
ALTER TABLE meta_threads DROP CONSTRAINT IF EXISTS meta_threads_platform_check;
ALTER TABLE meta_threads ADD CONSTRAINT meta_threads_platform_check CHECK (platform IN ('messenger','instagram','whatsapp'));
-- WhatsApp 프로필 이름(웹훅 contacts[].profile.name) — 연락처 등록 전에도 이름을 보여 준다
ALTER TABLE wa_inbound ADD COLUMN IF NOT EXISTS profile_name TEXT;
