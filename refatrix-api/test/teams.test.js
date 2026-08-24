import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleTeamIds, canViewTeam, canEditTeam, canRequestCrossTeam } from '../src/teams.js';

test('director sees all teams', () => {
  const p = { role: 'director', teamId: null, teamAccess: [] };
  assert.equal(visibleTeamIds(p), null);
  assert.equal(canViewTeam(p, 2), true);
  assert.equal(canEditTeam(p, 2), true);
});

test('sales sees only own team by default', () => {
  const p = { role: 'sales', teamId: 1, teamAccess: [] };
  assert.deepEqual(visibleTeamIds(p), [1]);
  assert.equal(canViewTeam(p, 1), true);
  assert.equal(canViewTeam(p, 2), false);
  assert.equal(canEditTeam(p, 1), true);
  assert.equal(canEditTeam(p, 2), false);
});

test('granted cross-team view (read-only)', () => {
  const p = { role: 'sales', teamId: 1, teamAccess: [{ teamId: 2, canEdit: false }] };
  assert.deepEqual(visibleTeamIds(p).sort(), [1, 2]);
  assert.equal(canViewTeam(p, 2), true);
  assert.equal(canEditTeam(p, 2), false); // 열람만
});

test('granted cross-team edit', () => {
  const p = { role: 'sales', teamId: 1, teamAccess: [{ teamId: 2, canEdit: true }] };
  assert.equal(canEditTeam(p, 2), true);
});

test('user without team sees nothing', () => {
  const p = { role: 'sales', teamId: null, teamAccess: [] };
  assert.deepEqual(visibleTeamIds(p), []);
  assert.equal(canViewTeam(p, 1), false);
});

// ===== 타팀 고객 수정요청 권한 (0181) =====
// 이 권한은 "수정 요청"만 연다. 열람 범위(visibleTeamIds)는 절대 넓히지 않는다.
test('cross-team request: 기본은 꺼져 있다', () => {
  const p = { role: 'sales', teamId: 1, teamAccess: [] };
  assert.equal(canRequestCrossTeam(p), false);
  assert.equal(canRequestCrossTeam({ ...p, crossTeamRequest: false }), false);
});

test('cross-team request: 켜도 열람 범위는 그대로', () => {
  const p = { role: 'sales', teamId: 1, teamAccess: [], crossTeamRequest: true };
  assert.equal(canRequestCrossTeam(p), true);
  assert.deepEqual(visibleTeamIds(p), [1]);   // <- 타팀이 보이면 안 됨
  assert.equal(canViewTeam(p, 2), false);
  assert.equal(canEditTeam(p, 2), false);     // 즉시 편집도 여전히 불가(요청만 가능)
});

test('cross-team request: 디렉터는 요청 경로를 쓰지 않는다(즉시 수정)', () => {
  const p = { role: 'director', teamId: null, teamAccess: [], crossTeamRequest: true };
  assert.equal(canRequestCrossTeam(p), false);
  assert.equal(canEditTeam(p, 2), true);
});

test('cross-team request: perm 없음/비정상 값 방어', () => {
  assert.equal(canRequestCrossTeam(null), false);
  assert.equal(canRequestCrossTeam(undefined), false);
  assert.equal(canRequestCrossTeam({ role: 'sales', crossTeamRequest: 'true' }), false); // 문자열은 불가
});
