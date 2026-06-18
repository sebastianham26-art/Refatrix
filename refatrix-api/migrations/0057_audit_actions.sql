-- audit_log action 제약에 코드가 실제 사용하는 액션 추가
-- (delete_request/approve/reject, change_request, approve_change, period_close 등)
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN (
    'page_view','export','print','create','update','delete',
    'login','login_fail','device_request','device_approve','device_revoke',
    'pin_reset','permission_change','price_change',
    'delete_request','delete_approve','delete_reject',
    'change_request','approve_change','period_close'
  ));
