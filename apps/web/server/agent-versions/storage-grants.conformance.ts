/**
 * What storing a storage grant must do, run against the in-memory version store and the
 * PostgreSQL repository alike (`storage-grants.memory.test.ts`, `storage-grants.postgres.test.ts`),
 * so the two cannot drift apart: the resolved connection id is stored, `read-write` survives only
 * while the agent may write files, a `storage-grant-changed` row is written once per version whose
 * grants differ from the previous version's, and the delete guard sees a granted connection.
 */
import { describe, expect, it } from 'vitest';

import type { AgentPermissions } from '@indx-workspace/contracts/agents';

import { FIXTURE_PERMISSIONS } from './fixtures';
import type { StorageGrantRef, WorkspaceAgentVersionStore } from './store';

export interface StorageGrantHarness {
  readonly store: WorkspaceAgentVersionStore;
  /** An authenticated principal of the workspace. */
  readonly principalId: string;
  /** Two connections of the workspace, as the deploy's lookup would have resolved them. */
  readonly connections: { readonly first: string; readonly second: string };
  /** The grants the agent's assignments hold now. */
  grantsOf(agentId: string): Promise<readonly StorageGrantRef[]>;
  /** The subject labels of the agent's `storage-grant-changed` audit rows, oldest first. */
  grantAuditsOf(agentId: string): Promise<readonly string[]>;
}

let sequence = 0;

export function describeStorageGrantStore(
  label: string,
  open: () => Promise<StorageGrantHarness>,
): void {
  async function createAgent(
    harness: StorageGrantHarness,
    grants: readonly StorageGrantRef[],
    permissions: AgentPermissions = FIXTURE_PERMISSIONS,
  ): Promise<{ readonly agentId: string; readonly name: string; readonly versionId: string }> {
    sequence += 1;
    const name = `Grants agent ${String(sequence)}`;
    const outcome = await harness.store.createAgentWithFirstVersion({
      agent: {
        name,
        instructions: 'Read the reports.',
        model: null,
        permissions,
        policy: null,
        references: {
          modelConnectionId: null,
          runtimeProfileId: null,
          skillIds: [],
          connectorIds: [],
          files: [],
          storageGrants: grants,
        },
        ownerPrincipalId: harness.principalId,
        createdBy: null,
      },
      version: {
        summary: 'first',
        via: 'api',
        body: { surfaces: [] },
        createdByPrincipalId: harness.principalId,
      },
      environment: 'local',
      audit: {
        subjectLabel: name,
        actorPrincipalId: harness.principalId,
        actorUserId: null,
        actorLabel: 'conformance',
      },
    });
    if (outcome.kind !== 'created') throw new Error(`the agent was not created: ${outcome.kind}`);
    return { agentId: outcome.agent.id, name, versionId: outcome.version.id };
  }

  async function redeploy(
    harness: StorageGrantHarness,
    agentId: string,
    name: string,
    grants: readonly StorageGrantRef[],
    permissions: AgentPermissions = FIXTURE_PERMISSIONS,
  ): Promise<string> {
    const saved = await harness.store.create(agentId, {
      summary: 'again',
      via: 'api',
      body: { surfaces: [] },
      createdByPrincipalId: harness.principalId,
      storageGrants: grants,
    });
    if (saved.kind !== 'created') throw new Error(`the version was not saved: ${saved.kind}`);
    const moved = await harness.store.applyAndPoint(agentId, {
      environment: 'local',
      number: saved.version.number,
      reason: 'set',
      agent: {
        name,
        instructions: 'Read the reports.',
        model: null,
        permissions,
        policy: null,
        references: {
          modelConnectionId: null,
          runtimeProfileId: null,
          skillIds: [],
          connectorIds: [],
          files: [],
          storageGrants: grants,
        },
      },
      audit: {
        subjectLabel: name,
        actorPrincipalId: harness.principalId,
        actorUserId: null,
        actorLabel: 'conformance',
      },
    });
    if (moved.kind !== 'applied') throw new Error(`the version was not applied: ${moved.kind}`);
    return saved.version.id;
  }

  describe(`storage grants on ${label}`, () => {
    // @story US-STO-12
    it('[US-STO-12][contract][sdk] stores the connection id the deploy resolved', async () => {
      const harness = await open();
      const { agentId } = await createAgent(harness, [
        { connectionId: harness.connections.first, prefix: 'reports/2026', access: 'read' },
      ]);
      expect(await harness.grantsOf(agentId)).toEqual([
        { connectionId: harness.connections.first, prefix: 'reports/2026', access: 'read' },
      ]);
    });

    // @story US-STO-12
    it('[US-STO-12][contract][sdk] keeps read-write only while the agent may write files', async () => {
      const harness = await open();
      const grant = (connectionId: string): StorageGrantRef => ({
        connectionId,
        prefix: 'reports',
        access: 'read-write',
      });
      const writer = await createAgent(harness, [grant(harness.connections.first)], {
        ...FIXTURE_PERMISSIONS,
        writeFiles: true,
      });
      const reader = await createAgent(harness, [grant(harness.connections.first)], {
        ...FIXTURE_PERMISSIONS,
        writeFiles: false,
      });
      expect(await harness.grantsOf(writer.agentId)).toEqual([grant(harness.connections.first)]);
      expect(await harness.grantsOf(reader.agentId)).toEqual([
        { connectionId: harness.connections.first, prefix: 'reports', access: 'read' },
      ]);
    });

    // @story US-STO-12
    it('[US-STO-12][contract][sdk] audits a version whose grants differ, once, and an unchanged redeploy never', async () => {
      const harness = await open();
      const first: StorageGrantRef = {
        connectionId: harness.connections.first,
        prefix: 'reports',
        access: 'read',
      };
      const { agentId, name } = await createAgent(harness, [first]);
      expect(await harness.grantAuditsOf(agentId)).toEqual([
        `${name}: ${harness.connections.first} read reports`,
      ]);

      await redeploy(harness, agentId, name, [first]);
      expect(await harness.grantAuditsOf(agentId)).toHaveLength(1);

      const second: StorageGrantRef = {
        connectionId: harness.connections.second,
        prefix: 'archive',
        access: 'read',
      };
      await redeploy(harness, agentId, name, [first, second]);
      const audits = await harness.grantAuditsOf(agentId);
      expect(audits).toHaveLength(2);
      const both = [
        `${harness.connections.first} read reports`,
        `${harness.connections.second} read archive`,
      ].sort();
      expect(audits[1]).toBe(`${name}: ${both.join('; ')}`);

      await redeploy(harness, agentId, name, []);
      expect((await harness.grantAuditsOf(agentId)).at(-1)).toBe(`${name}: no storage grants`);
      expect(await harness.grantsOf(agentId)).toEqual([]);
    });

    // @story US-STO-12
    it('[US-STO-12][contract][sdk] reports a connection as granted while a version grants it', async () => {
      const harness = await open();
      expect(await harness.store.isConnectionGranted(harness.connections.second)).toBe(false);
      const { agentId, name } = await createAgent(harness, [
        { connectionId: harness.connections.second, prefix: 'reports', access: 'read' },
      ]);
      expect(await harness.store.isConnectionGranted(harness.connections.second)).toBe(true);
      expect(await harness.store.isConnectionGranted(crypto.randomUUID())).toBe(false);
      await redeploy(harness, agentId, name, []);
      expect(await harness.store.isConnectionGranted(harness.connections.second)).toBe(false);
    });

    // @story US-STO-12
    it('[US-STO-12][contract][sdk] each version keeps the grants it was deployed with', async () => {
      const harness = await open();
      const reports: StorageGrantRef = {
        connectionId: harness.connections.first,
        prefix: 'reports',
        access: 'read',
      };
      const archive: StorageGrantRef = {
        connectionId: harness.connections.first,
        prefix: 'archive',
        access: 'read',
      };
      const { agentId, name, versionId: v1 } = await createAgent(harness, [reports]);
      const v2 = await redeploy(harness, agentId, name, [archive]);

      expect(await harness.store.storageGrantsOf(v1)).toEqual([reports]);
      expect(await harness.store.storageGrantsOf(v2)).toEqual([archive]);
      // The agent's current grants follow `local`; v1's rows do not.
      expect(await harness.grantsOf(agentId)).toEqual([archive]);
      expect(await harness.store.storageGrantsOf(crypto.randomUUID())).toEqual([]);
    });

    // @story US-STO-12
    it('[US-STO-12][contract][sdk] a version saved without grants stores none', async () => {
      const harness = await open();
      const { agentId } = await createAgent(harness, [
        { connectionId: harness.connections.first, prefix: 'reports', access: 'read' },
      ]);
      const saved = await harness.store.create(agentId, {
        summary: 'plain',
        via: 'api',
        body: { surfaces: [] },
        createdByPrincipalId: harness.principalId,
      });
      if (saved.kind !== 'created') throw new Error(`the version was not saved: ${saved.kind}`);
      expect(await harness.store.storageGrantsOf(saved.version.id)).toEqual([]);
    });

    // @story US-STO-12
    it('[US-STO-12][contract][sdk] deleting is judged on the current grants, not on an older version’s', async () => {
      const harness = await open();
      const {
        agentId,
        name,
        versionId: v1,
      } = await createAgent(harness, [
        { connectionId: harness.connections.second, prefix: 'reports', access: 'read' },
      ]);
      await redeploy(harness, agentId, name, []);

      expect(await harness.store.storageGrantsOf(v1)).toHaveLength(1);
      expect(await harness.store.isConnectionGranted(harness.connections.second)).toBe(false);
    });
  });
}
