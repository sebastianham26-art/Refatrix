import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleTeamIds, canViewTeam, canEditTeam } from '../src/teams.js';

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
