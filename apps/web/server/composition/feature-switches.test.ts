import {
  createInMemoryWorkspaceScopeResolver,
  type WorkspaceFeatureRepositoryProvider,
} from '@agent-workspace/core/db';
import type { FeatureId } from '@indx-workspace/contracts/features';
import { describe, expect, it } from 'vitest';

import { workspaceFeaturesRuntime, workspaceFeatureSwitches } from './feature-switches';
import type { WorkspaceFeaturesAuditEvent } from '../workspaces/features-runtime';

const scopes = createInMemoryWorkspaceScopeResolver([
  { id: 'ws-1', slug: 'one' },
  { id: 'ws-2', slug: 'two' },
]);

function switchedOff(
  disabled: Readonly<Record<string, readonly FeatureId[]>>,
): WorkspaceFeatureRepositoryProvider {
  return {
    forScope: (scope) => ({
      listDisabled: () => Promise.resolve(disabled[scope.workspaceId] ?? []),
      replaceDisabled: () => Promise.reject(new Error('the switches never write')),
    }),
  };
}

describe('workspaceFeatureSwitches (ADR-0160 D6)', () => {
  const deployment: readonly FeatureId[] = ['chat', 'files', 'runs', 'triggers'];

  it('answers nothing enabled for a workspace with no scope', async () => {
    const switches = workspaceFeatureSwitches(
      { scopes, workspaceFeatures: switchedOff({}) },
      deployment,
    );
    expect(await switches.enabledFor('ws-unknown')).toEqual([]);
  });

  it('filters the workspace’s switched-off rows out of the deployment set, and nothing else', async () => {
    const switches = workspaceFeatureSwitches(
      { scopes, workspaceFeatures: switchedOff({ 'ws-1': ['files', 'triggers'] }) },
      deployment,
    );
    expect(await switches.enabledFor('ws-1')).toEqual(['chat', 'runs']);
    expect(await switches.enabledFor('ws-2')).toEqual(deployment);
  });

  it('never enables a switched-on feature the deployment does not install', async () => {
    const switches = workspaceFeatureSwitches({ scopes, workspaceFeatures: switchedOff({}) }, [
      'chat',
    ]);
    expect(await switches.enabledFor('ws-1')).toEqual(['chat']);
  });

  it('carries the deployment set, so a switched-off page can say the feature is not installed', () => {
    const switches = workspaceFeatureSwitches(
      { scopes, workspaceFeatures: switchedOff({}) },
      deployment,
    );
    expect(switches.deployment).toEqual(deployment);
  });
});

describe('workspaceFeaturesRuntime (ADR-0160 D6–D8)', () => {
  const deployment: readonly FeatureId[] = ['chat', 'files'];
  const event: WorkspaceFeaturesAuditEvent = {
    workspaceId: 'ws-1',
    actorPrincipalId: 'principal-1',
    actorUserId: 'user-1',
    actorLabel: 'owner@example.com',
    action: 'workspace-features-changed',
    subjectId: null,
    subjectLabel: 'Features: all on',
  };

  it('opens the switches of the workspace the id names, and none for an unknown id', async () => {
    const runtime = workspaceFeaturesRuntime(
      {
        scopes,
        workspaceFeatures: switchedOff({ 'ws-1': ['files'] }),
        recordAuditEvent: () => Promise.resolve(),
      },
      deployment,
      () => Promise.resolve(),
    );
    expect(runtime.deployment).toEqual(deployment);
    expect(await (await runtime.repositoryFor('ws-1'))?.listDisabled()).toEqual(['files']);
    expect(await (await runtime.repositoryFor('ws-2'))?.listDisabled()).toEqual([]);
    expect(await runtime.repositoryFor('ws-unknown')).toBeNull();
  });

  it('hands the audit event to the root unchanged', async () => {
    const written: WorkspaceFeaturesAuditEvent[] = [];
    const runtime = workspaceFeaturesRuntime(
      {
        scopes,
        workspaceFeatures: switchedOff({}),
        recordAuditEvent: (row) => {
          written.push(row);
          return Promise.resolve();
        },
      },
      deployment,
      () => Promise.resolve(),
    );
    await runtime.recordAuditEvent(event);
    expect(written).toEqual([event]);
  });
});
