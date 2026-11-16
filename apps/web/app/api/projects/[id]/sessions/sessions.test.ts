import { afterEach, describe, expect, it } from 'vitest';
import { clearApplicationContext } from '../../../../../server/application-context';
import { POST } from './route';
import {
  BUILDER_B_PRINCIPAL_ID,
  agentRecord,
  existingProject,
  idContext,
  projectRecord,
  request,
  sessionRecord,
  useMemoryRuntime,
} from './sessions.test-support';
describe('POST /api/projects/:id/sessions (issue #125)', () => {
  afterEach(() => {
    clearApplicationContext();
  });

  it("starts a session, resolving and persisting the project's default agent in the same write", async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('agent-1', agentRecord('agent-1'));
    fixture.projects.set('project-1', projectRecord({ id: 'project-1' }));

    const response = await POST(
      request('/api/projects/project-1/sessions', {}),
      idContext('project-1'),
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const body = (await response.json()) as { id: string; projectId: string; agentId: string };
    expect(body.projectId).toBe('project-1');
    expect(body.agentId).toBe('agent-1');

    const persisted = fixture.sessions.get(body.id);
    expect(persisted?.agentId).toBe('agent-1');
    expect(persisted?.projectId).toBe('project-1');
  });

  it('pins the version local points at, and keeps a legacy agent with no pointer unpinned (issue #612)', async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('versioned', agentRecord('versioned'));
    fixture.agents.set('legacy', agentRecord('legacy'));
    const pointer = (environment: 'local' | 'production', versionId: string, number: number) => ({
      agentId: 'versioned',
      environment,
      versionId,
      number,
      updatedAt: new Date(0),
    });
    fixture.pointers.set('versioned', [
      pointer('production', 'version-1', 1),
      pointer('local', 'version-2', 2),
    ]);
    fixture.projects.set('project-1', projectRecord({ id: 'project-1', defaultAgentId: 'legacy' }));
    const start = async (agentId: string) => {
      const response = await POST(
        request('/api/projects/project-1/sessions', { agentId }),
        idContext('project-1'),
      );
      expect(response.status, await response.clone().text()).toBe(201);
      const { id } = (await response.json()) as { id: string };
      return fixture.sessions.get(id)?.agentVersionId;
    };

    expect(await start('versioned')).toBe('version-2');
    // `no_pointer` in the release model; the server keeps the legacy session and runs the row.
    expect(await start('legacy')).toBeNull();
  });

  it('starts the session with the composer-selected agent when agentId is supplied', async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('default-agent', agentRecord('default-agent'));
    fixture.agents.set('selected-agent', agentRecord('selected-agent'));
    fixture.projects.set(
      'project-1',
      projectRecord({ id: 'project-1', defaultAgentId: 'default-agent' }),
    );

    const response = await POST(
      request('/api/projects/project-1/sessions', { agentId: 'selected-agent' }),
      idContext('project-1'),
    );

    expect(response.status, await response.clone().text()).toBe(201);
    const body = (await response.json()) as { id: string; projectId: string; agentId: string };
    expect(body).toMatchObject({ projectId: 'project-1', agentId: 'selected-agent' });
    expect(fixture.sessions.get(body.id)?.agentId).toBe('selected-agent');
  });

  it('names an unresolvable composer-selected agent separately from a broken project default', async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('default-agent', agentRecord('default-agent'));
    fixture.projects.set(
      'project-1',
      projectRecord({ id: 'project-1', defaultAgentId: 'default-agent' }),
    );

    const response = await POST(
      request('/api/projects/project-1/sessions', { agentId: 'deleted-agent' }),
      idContext('project-1'),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'project_session_agent_not_found' },
    });
  });

  it('refuses to start a session when defaultAgentId is unresolvable — missing or deleted', async () => {
    const fixture = useMemoryRuntime();
    fixture.projects.set('no-default', projectRecord({ id: 'no-default', defaultAgentId: null }));
    const noDefault = await POST(
      request('/api/projects/no-default/sessions', {}),
      idContext('no-default'),
    );
    expect(noDefault.status).toBe(422);

    fixture.projects.set(
      'ghost-agent',
      projectRecord({ id: 'ghost-agent', defaultAgentId: 'does-not-exist' }),
    );
    const ghostAgent = await POST(
      request('/api/projects/ghost-agent/sessions', {}),
      idContext('ghost-agent'),
    );
    expect(ghostAgent.status).toBe(422);
    expect(fixture.sessions.size).toBe(0);
  });

  it("changing the project's defaultAgentId after a session started does not rewrite that session's agent", async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('agent-1', agentRecord('agent-1'));
    fixture.agents.set('agent-2', agentRecord('agent-2'));
    fixture.projects.set('project-1', projectRecord({ id: 'project-1' }));

    const first = await POST(
      request('/api/projects/project-1/sessions', {}),
      idContext('project-1'),
    );
    const { id: sessionId } = (await first.json()) as { id: string };

    // The project's default agent changes; nothing in this route (or in `sessions.update`, which
    // carries no `agentId` field at all) can reach back and rewrite the already-started session.
    fixture.projects.set('project-1', {
      ...existingProject(fixture, 'project-1'),
      defaultAgentId: 'agent-2',
    });
    expect(fixture.sessions.get(sessionId)?.agentId).toBe('agent-1');
  });

  it('moving a session requires authorisation on both the destination and the source project', async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('agent-1', agentRecord('agent-1'));
    fixture.projects.set('mine', projectRecord({ id: 'mine', name: 'Mine' }));
    fixture.projects.set(
      'theirs',
      projectRecord({
        id: 'theirs',
        name: 'Theirs',
        createdBy: 'builder-b@example.test',
        ownerPrincipalId: BUILDER_B_PRINCIPAL_ID,
      }),
    );
    fixture.sessions.set(
      'session-in-theirs',
      sessionRecord({
        id: 'session-in-theirs',
        userId: 'builder-b@example.test',
        ownerPrincipalId: BUILDER_B_PRINCIPAL_ID,
        projectId: 'theirs',
      }),
    );

    // Builder A owns "mine" (the destination) but not "theirs" (the session's current project).
    const denied = await POST(
      request('/api/projects/mine/sessions', { sessionId: 'session-in-theirs' }),
      idContext('mine'),
    );
    expect(denied.status).toBe(403);
    expect(fixture.sessions.get('session-in-theirs')?.projectId).toBe('theirs');
  });

  // Verification round 1, Finding 1 (issue #125's own Verifier attack #3): "move the session to a
  // second project and assert the earlier run's attribution still points at the first [project]".
  // `sessions.project_id` has no snapshot column to preserve that assertion once a move happens
  // (unlike `sessions.agent_id`, which simply has no update path — see the ADR), so the only way
  // to keep it true is to refuse the move outright once the session has a run.
  it("refuses to move a session that already has a run, so a run's project attribution can never be rewritten", async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('agent-1', agentRecord('agent-1'));
    fixture.projects.set('origin', projectRecord({ id: 'origin', name: 'Origin' }));
    fixture.projects.set('destination', projectRecord({ id: 'destination', name: 'Destination' }));
    fixture.sessions.set('ran-already', sessionRecord({ id: 'ran-already', projectId: 'origin' }));
    fixture.sessionsWithRuns.add('ran-already');

    const response = await POST(
      request('/api/projects/destination/sessions', { sessionId: 'ran-already' }),
      idContext('destination'),
    );
    expect(response.status, await response.clone().text()).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('project_session_has_runs');
    // The assertion the card's Verifier attack #3 asks for: the run's project attribution (only
    // reachable via the session it belongs to) still points at "origin".
    expect(fixture.sessions.get('ran-already')?.projectId).toBe('origin');
  });

  it('still moves a session that has no runs at all', async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('agent-1', agentRecord('agent-1'));
    fixture.projects.set('origin', projectRecord({ id: 'origin', name: 'Origin' }));
    fixture.projects.set('destination', projectRecord({ id: 'destination', name: 'Destination' }));
    fixture.sessions.set('never-run', sessionRecord({ id: 'never-run', projectId: 'origin' }));

    const response = await POST(
      request('/api/projects/destination/sessions', { sessionId: 'never-run' }),
      idContext('destination'),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(fixture.sessions.get('never-run')?.projectId).toBe('destination');
  });

  // Issue #183: "Archived projects reject every new-session and new-run entry point." Both
  // branches of this route are such an entry point, so both are asserted — and both are asserted
  // to write nothing, because a refusal that arrives after the row exists is not a refusal.
  it('refuses to start a session in an archived project, and starts one again once it is restored', async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('agent-1', agentRecord('agent-1'));
    fixture.projects.set(
      'retired',
      projectRecord({
        id: 'retired',
        name: 'Retired',
        archivedAt: new Date('2026-09-13T00:00:00.000Z'),
      }),
    );

    const refused = await POST(request('/api/projects/retired/sessions', {}), idContext('retired'));
    expect(refused.status, await refused.clone().text()).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'project_archived',
    );
    expect(fixture.sessions.size).toBe(0);

    // The positive control: the refusal above was the archived state and nothing else.
    fixture.projects.set('retired', {
      ...existingProject(fixture, 'retired'),
      archivedAt: null,
    });
    const allowed = await POST(request('/api/projects/retired/sessions', {}), idContext('retired'));
    expect(allowed.status, await allowed.clone().text()).toBe(201);
    expect(fixture.sessions.size).toBe(1);
  });

  it('refuses to move a session into an archived project, while moving one OUT of it still works', async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('agent-1', agentRecord('agent-1'));
    fixture.projects.set(
      'retired',
      projectRecord({
        id: 'retired',
        name: 'Retired',
        archivedAt: new Date('2026-09-13T00:00:00.000Z'),
      }),
    );
    fixture.projects.set('live', projectRecord({ id: 'live', name: 'Live' }));
    fixture.sessions.set('stranded', sessionRecord({ id: 'stranded', projectId: 'retired' }));
    fixture.sessions.set('elsewhere', sessionRecord({ id: 'elsewhere', projectId: 'live' }));

    const intoArchived = await POST(
      request('/api/projects/retired/sessions', { sessionId: 'elsewhere' }),
      idContext('retired'),
    );
    expect(intoArchived.status, await intoArchived.clone().text()).toBe(409);
    expect(((await intoArchived.json()) as { error: { code: string } }).error.code).toBe(
      'project_archived',
    );
    expect(fixture.sessions.get('elsewhere')?.projectId).toBe('live');

    // Out of an archived project is allowed: the destination is what the gate reads, so live work
    // can leave a retired project instead of being stranded in it.
    const outOfArchived = await POST(
      request('/api/projects/live/sessions', { sessionId: 'stranded' }),
      idContext('live'),
    );
    expect(outOfArchived.status, await outOfArchived.clone().text()).toBe(200);
    expect(fixture.sessions.get('stranded')?.projectId).toBe('live');
  });

  it('starting a session in a project the caller does not own is refused before any session is written', async () => {
    const fixture = useMemoryRuntime();
    fixture.agents.set('agent-1', agentRecord('agent-1'));
    fixture.projects.set(
      'theirs',
      projectRecord({
        id: 'theirs',
        name: 'Theirs',
        createdBy: 'builder-b@example.test',
        ownerPrincipalId: BUILDER_B_PRINCIPAL_ID,
      }),
    );

    const response = await POST(
      request('/api/projects/theirs/sessions', {}, 'builder-a@example.test'),
      idContext('theirs'),
    );
    expect(response.status).toBe(403);
    expect(fixture.sessions.size).toBe(0);
  });
});
