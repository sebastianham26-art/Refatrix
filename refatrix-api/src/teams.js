// 영업팀 가시성 규칙(순수 함수)
// 디렉터는 전체. 그 외는 소속팀 + 디렉터가 부여한 상대팀까지.

// 사용자가 볼 수 있는 팀 id 목록. null = 전체(제한 없음, 디렉터).
export function visibleTeamIds(perm) {
  if (!perm) return [];
  if (perm.role === 'director') return null;        // 전체
  const ids = new Set();
  if (perm.teamId != null) ids.add(perm.teamId);    // 소속팀
  for (const t of (perm.teamAccess || [])) ids.add(t.teamId); // 부여받은 상대팀
  return [...ids];
}

// 특정 팀을 볼 수 있나
export function canViewTeam(perm, teamId) {
  const vis = visibleTeamIds(perm);
  if (vis === null) return true;
  return teamId != null && vis.includes(Number(teamId));
}

// 특정 팀을 편집할 수 있나(소속팀은 편집 가능, 상대팀은 can_edit 부여 시)
export function canEditTeam(perm, teamId) {
  if (!perm) return false;
  if (perm.role === 'director') return true;
  if (teamId == null) return false;
  if (perm.teamId === Number(teamId)) return true;
  const g = (perm.teamAccess || []).find((t) => t.teamId === Number(teamId));
  return !!(g && g.canEdit);
}
