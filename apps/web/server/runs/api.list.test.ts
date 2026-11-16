import { afterEach, describe, expect, it } from 'vitest';
import { resetTestRunApi } from '../application-context-fixtures';
import { listRuns, readRun } from './api';
import {
  errorCode,
  get,
  install,
  listBody,
  OTHER_PRINCIPAL,
  OTHER_USER,
  OTHER_WORKSPACE,
  PRINCIPAL,
  seedRun,
  WORKSPACE,
} from './api.test-support';

afterEach(() => {
  resetTestRunApi();
});

describe('GET /api/runs', () => {
  it('returns 401 unauthenticated and 503 when the run API is not configured', async () => {
    install();
    expect((await listRuns(get('http://web/api/runs', {}, false))).status).toBe(401);

    resetTestRunApi();
    expect((await listRuns(get('http://web/api/runs'))).status).toBe(503);
  });

  it('an Owner (any grant) sees every workspace run and may filter by user', async () => {
    const harness = install({ authenticate: () => Promise.resolve(PRINCIPAL) });
    const mine = await seedRun(harness.store);
    const theirs = await seedRun(harness.store, { initiatingUserId: OTHER_USER });
    await seedRun(harness.store, { workspaceId: OTHER_WORKSPACE });

    const all = await listBody(await listRuns(get('http://web/api/runs')));
    const ids = all.runs.map((run) => run['id']);
    expect(ids).toEqual(expect.arrayContaining([mine.id, theirs.id]));
    expect(ids).toHaveLength(2);

    const filtered = await listBody(await listRuns(get(`http://web/api/runs?user=${OTHER_USER}`)));
    expect(filtered.runs.map((run) => run['id'])).toEqual([theirs.id]);
  });

  it('a Builder (own grant) sees only their own runs and may not use the user filter', async () => {
    const harness = install({
      authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'builder' }),
    });
    const mine = await seedRun(harness.store);
    await seedRun(harness.store, { initiatingUserId: OTHER_USER });

    const response = await listRuns(get('http://web/api/runs'));
    const body = await listBody(response);
    expect(body.runs.map((run) => run['id'])).toEqual([mine.id]);

    const forbidden = await listRuns(get(`http://web/api/runs?user=${OTHER_USER}`));
    expect(forbidden.status).toBe(403);
    expect(await errorCode(forbidden)).toBe('user_filter_forbidden');

    // Even a Builder naming *themselves* is refused: the filter is not offered at all (issue
    // #135's "deliberately not built"), not merely narrowed to a no-op.
    const named = await listRuns(get(`http://web/api/runs?user=${PRINCIPAL.userId}`));
    expect(named.status).toBe(403);
  });
});

describe('GET /api/runs', () => {
  it('a Viewer sees only their own runs, exactly as a Builder does', async () => {
    const harness = install({
      authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'viewer' }),
    });
    const mine = await seedRun(harness.store);
    await seedRun(harness.store, { initiatingUserId: OTHER_USER });
    const body = await listBody(await listRuns(get('http://web/api/runs')));
    expect(body.runs.map((run) => run['id'])).toEqual([mine.id]);
  });

  it('a machine Builder sees runs owned by its exact principal and not another machine principal', async () => {
    const machinePrincipalId = '99999999-9999-4999-8999-999999999999';
    const harness = install({
      authenticate: () =>
        Promise.resolve({
          principalId: machinePrincipalId,
          ownerPrincipalId: machinePrincipalId,
          userId: null,
          workspaceId: WORKSPACE,
          role: 'builder',
          scope: null,
        }),
    });
    const mine = await seedRun(harness.store, {
      initiatingUserId: null,
      ownerPrincipalId: machinePrincipalId,
    });
    await seedRun(harness.store, {
      initiatingUserId: null,
      ownerPrincipalId: OTHER_PRINCIPAL,
    });

    const response = await listRuns(get('http://web/api/runs'));
    expect(response.status).toBe(200);
    const body = await listBody(response);
    expect(body.runs.map((run) => run['id'])).toEqual([mine.id]);
  });
});

describe('GET /api/runs', () => {
  it(
    'an Admin sees every run in the workspace and may filter by user — issue #165 widened ' +
      "`POLICY.admin.byResource.runs` to `read: 'any'`, so issue #135's \"Owner/Admin see " +
      'allowed workspace history" is now met for both roles; this is the collection route\'s ' +
      'width, which the authorisation matrix cannot state (see the comment on the matching test ' +
      'in apps/web/server/rbac/authorisation-matrix.test.ts) and ' +
      'docs/adr/W9-AUTH-165-admin-reads-workspace-run-history.md records',
    async () => {
      const harness = install({
        authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'admin' }),
      });
      const mine = await seedRun(harness.store);
      const theirs = await seedRun(harness.store, { initiatingUserId: OTHER_USER });
      // Still workspace-scoped: the widening is over §21's roles, never over §25's tenancy.
      await seedRun(harness.store, { workspaceId: OTHER_WORKSPACE });

      const all = await listBody(await listRuns(get('http://web/api/runs')));
      // Set-wise, exactly as the Owner case above: two runs seeded in the same millisecond tie on
      // `created_at` and are ordered by `id`, which is a fresh UUID per run.
      const ids = all.runs.map((run) => run['id']);
      expect(ids).toEqual(expect.arrayContaining([mine.id, theirs.id]));
      expect(ids).toHaveLength(2);

      const filtered = await listBody(
        await listRuns(get(`http://web/api/runs?user=${OTHER_USER}`)),
      );
      expect(filtered.runs.map((run) => run['id'])).toEqual([theirs.id]);

      // The filter is offered, not merely tolerated: an Admin naming themselves is a 200 that
      // narrows, where the same request from a Builder is a 403.
      const named = await listRuns(get(`http://web/api/runs?user=${PRINCIPAL.userId}`));
      expect(named.status).toBe(200);
      expect((await listBody(named)).runs.map((run) => run['id'])).toEqual([mine.id]);
    },
  );

  it('never returns another workspace’s run, and a random id 404s from the detail route the same way', async () => {
    const harness = install();
    await seedRun(harness.store, { workspaceId: OTHER_WORKSPACE });
    const body = await listBody(await listRuns(get('http://web/api/runs')));
    expect(body.runs).toHaveLength(0);

    const randomId = crypto.randomUUID();
    const detail = await readRun(get(`http://web/api/runs/${randomId}`), randomId);
    expect(detail.status).toBe(404);
  });
});
