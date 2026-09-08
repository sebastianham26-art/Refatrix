// 외부 서비스 키 관리(디렉터 전용) — 화면 refatrix-apikeys.html 의 백엔드.
//
//   · 값은 **내려가지 않는다**. 비밀값은 마스킹(앞4…뒤4)만, 설정값(전화번호 ID·템플릿명)은 그대로.
//   · 저장 규칙: 빈칸 = 그대로 둠 · '-' 한 글자 = 지움(Railway 환경변수 값으로 복귀).
//   · 연결 테스트는 저장된 값 그대로 쏜다 — 통과한 값이 곧 실제 호출에 쓰이는 값이다.
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import {
  SERVICES, secretsReady, masterKeyReady, publicServices, saveSecrets,
  listChanges, testService, hydrateSecrets, lastLoadedAt,
} from '../secrets.js';

const ERR_NOTE = {
  migration_required: '0209_service_secrets 마이그레이션이 필요합니다. Railway 콘솔에서 npm run migrate 를 실행하세요.',
  no_master_key: 'Railway 환경변수 APP_SECRET_KEY 를 먼저 설정해야 비밀키를 암호화해 저장할 수 있습니다.',
  nothing_to_save: '바뀐 값이 없습니다.',
  too_short: '키가 너무 짧습니다(8자 이상). 값을 다시 확인하세요.',
  newline_in_value: '값에 줄바꿈이 섞여 있습니다. 복사할 때 앞뒤 공백·줄바꿈을 빼고 붙여넣으세요.',
};

export default async function secretRoutes(app) {
  const guard = { preHandler: [authGuard, requireDirector] };

  // 상태 — 서비스별 키 보유 여부·출처(화면/환경변수)·마지막 변경자
  app.get('/api/secrets', guard, async () => {
    await hydrateSecrets();
    return {
      migrated: await secretsReady(),
      master_key: masterKeyReady(),
      loaded_at: lastLoadedAt(),
      services: publicServices(),
      changes: await listChanges(40),
    };
  });

  // 저장 — { values: { ANTHROPIC_API_KEY: '…', WHATSAPP_PHONE_ID: '-' } }
  app.put('/api/secrets', guard, async (req, reply) => {
    const r = await saveSecrets((req.body || {}).values, req.ctx.perm.userId);
    if (r.error) {
      const code = r.error === 'migration_required' ? 503 : 400;
      return reply.code(code).send({ error: r.error, field: r.field || null, note: ERR_NOTE[r.error] || null });
    }
    // 감사 로그: 무엇을 바꿨는지만. 값은 남기지 않는다.
    //   action 은 audit_log 의 허용 목록(update 등) 안에서 쓴다 — 새 값을 넣으면 체크 제약에 걸린다.
    await logEvent({
      userId: req.ctx.perm.userId, deviceId: req.ctx.deviceId,
      action: 'update', target: 'service_secret:' + r.changed.map((c) => c.name).join(','),
      detail: { changed: r.changed },
    });
    return { ok: true, changed: r.changed, services: publicServices() };
  });

  // 연결 테스트 — 실제 제공사에 한 번 물어본다(요금이 붙지 않는 조회 API).
  app.post('/api/secrets/:service/test', guard, async (req, reply) => {
    const key = String(req.params.service || '');
    if (!SERVICES.some((s) => s.key === key)) return reply.code(404).send({ error: 'unknown_service' });
    await hydrateSecrets();
    const r = await testService(key);
    await logEvent({
      userId: req.ctx.perm.userId, deviceId: req.ctx.deviceId,
      action: 'update', target: 'service_secret_test:' + key,
      detail: { ok: !!r.ok, status: r.status || null, reason: r.reason || null },
    });
    return r;
  });

  // 다른 인스턴스에서 바꾼 값을 지금 당장 읽어 온다.
  app.post('/api/secrets/refresh', guard, async () => {
    await hydrateSecrets();
    return { ok: true, loaded_at: lastLoadedAt(), services: publicServices() };
  });
}
