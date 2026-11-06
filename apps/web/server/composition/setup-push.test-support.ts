import { expect } from 'vitest';
import {
  adminUserId,
  complete,
  db,
  scope,
  setupInput,
  workspace,
} from './setup-fixture.test-support';
/**
 * Run setup, then create an agent the way `aw push` does (a version naming no runtime profile),
 * and answer a `push()` that saves and applies the next such version to `local`.
 */
export async function pushedAgentAfterSetup() {
  const setup = await complete(setupInput());
  if (!setup.ok) throw new Error(`setup refused: ${setup.code}`);
  const versions = db().agentVersions.forScope(scope());
  /** What an `aw push` whose version names no runtime profile materialises. */
  const pushed = async () => {
    const resolution = await versions.resolveDefinition({
      modelConnectionName: null,
      runtimeProfileName: null,
      skills: [],
      connectors: [],
      files: [],
    });
    if (resolution.kind !== 'resolved') throw new Error('the version did not resolve');
    return {
      name: 'Pushed',
      instructions: 'Answer briefly.',
      model: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      policy: null,
      references: resolution.references,
    };
  };
  const body = {
    definition: { agent: { name: 'Pushed', runtimeProfileName: null } },
    surfaces: [],
  };
  const created = await versions.createAgentWithFirstVersion({
    agent: {
      ...(await pushed()),
      ownerPrincipalId: workspace.principalId,
      createdBy: adminUserId,
    },
    version: {
      summary: 'first',
      via: 'aw-push',
      body,
      createdByPrincipalId: workspace.principalId,
    },
    environment: 'local',
  });
  if (created.kind !== 'created') throw new Error(`expected created, got ${created.kind}`);
  expect(created.agent.runtimeProfileId).toBe(setup.runtimeProfileId);
  const agentId = created.agent.id;

  const push = async () => {
    const next = await versions.create(agentId, {
      summary: 'next',
      via: 'aw-push',
      body,
      createdByPrincipalId: workspace.principalId,
    });
    if (next.kind !== 'created') throw new Error(`expected created, got ${next.kind}`);
    const applied = await versions.applyAndPoint(agentId, {
      environment: 'local',
      number: next.version.number,
      agent: await pushed(),
      reason: 'set',
      audit: {
        subjectLabel: `Pushed: local -> version ${String(next.version.number)}`,
        actorPrincipalId: workspace.principalId,
        actorUserId: adminUserId,
        actorLabel: 'Setup admin',
      },
    });
    if (applied.kind !== 'applied') throw new Error(`expected applied, got ${applied.kind}`);
    return applied.agent;
  };
  return { setup, agentId, push };
}
