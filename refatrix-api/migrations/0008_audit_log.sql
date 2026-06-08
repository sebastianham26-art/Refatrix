-- =====================================================================
-- Refatrix ERP · 0008_audit_log
-- 감사 로그 (서버 기록, 사용자 수정·삭제 불가, 디렉터 열람, 보관 1년)
-- =====================================================================

CREATE TABLE audit_log (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id       BIGINT REFERENCES users(id),          -- 이름·부서·역할은 조인
  device_id     BIGINT REFERENCES devices(id),
  action        TEXT NOT NULL
                CHECK (action IN ('page_view','export','print','create','update',
                                  'delete','login','login_fail','device_request',
                                  'device_approve','device_revoke','pin_reset',
                                  'permission_change','price_change')),
  target        TEXT,                                  -- 메뉴/테이블/레코드
  detail        JSONB,                                 -- 범위·건수 등 상세
  result        TEXT NOT NULL DEFAULT 'success'
                CHECK (result IN ('success','denied'))
);
CREATE INDEX idx_audit_time ON audit_log (occurred_at);
CREATE INDEX idx_audit_user ON audit_log (user_id, occurred_at);
CREATE INDEX idx_audit_act  ON audit_log (action);

-- 기록 방식(혼합):
--   page_view = 유저별·날짜별 요약(가볍게)
--   export/print/create/update/delete/login_fail/permission_change/price_change = 건별 상세
--   외부 사용자(투자자)는 열람도 건별 상세 가능
-- 보관: 1년 (운영 단계에서 1년 경과분 정리 작업 또는 파티션으로 관리)
-- 무결성: 애플리케이션 권한상 INSERT만 허용, UPDATE/DELETE 차단(디렉터 열람 전용)
