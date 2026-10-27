import { describe, expect, it } from 'vitest';

import {
  AgentVersionBodySchema,
  AgentVersionResourceSchema,
} from '@indx-workspace/contracts/agent-versions';

import type { AgentResourceAssignments } from '../../contracts/agents';
import type { AgentRecord } from '../agents/contract';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { FIXTURE_PERMISSIONS, fixtureSurface, versionRequest, type FixtureEdits } from './fixtures';
import { createAgentVersion } from './handlers';
import { createInMemoryAgentVersionStoreProvider } from './memory-store';
import { setAgentPointer, type PointerActor } from './pointers';
import type { StorageConnectionLookup } from './storage-grants';
import { saveUiEdit, uiEditBody, type UiEdit } from './ui-edit';

/**
 * `saveUiEdit` (issue #616) on the memory stores: a console edit adds exactly one `ui` version,
 * points `local` at it and lands on the right base — the materialised `local` body, or the row.
 */
const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const OWNER = '36377a6a-7a0b-4610-8efc-d31547dcc38a';
const ACTOR: PointerActor = { principalId: OWNER, userId: null, actor: 'console' };
const CONNECTION = '11111111-1111-4111-8111-111111111111';
const SKILL = '22222222-2222-4222-8222-222222222222';
const DIGEST = 'a'.repeat(64);

/** A workspace that holds every bundle a version pins. */
const everyBundleStored = (): Promise<readonly string[]> => Promise.resolve([]);

const STORAGE_CONNECTION = '33333333-3333-4333-8333-333333333333';
/** A workspace that holds the `acme-data` storage connection, which allows `reports`. */
const acmeData: StorageConnectionLookup = (names) =>
  Promise.resolve(
    new Map(
      names
        .filter((name) => name === 'acme-data')
        .map((name) => [
          name,
          { id: STORAGE_CONNECTION, allowedPrefixes: ['reports'], writeAllowed: false },
        ]),
    ),
  );

async function harness() {
  // A ticking clock, so every row write moves `updatedAt` and the memory store sees the edit.
  let tick = 0;
  const now = (): Date => new Date(Date.UTC(2026, 9, 4) + (tick += 1));
  const agentProvider = createInMemoryAgentStoreProvider({ now });
  const agents = agentProvider.forWorkspace(WORKSPACE);
  const assignments = new Map<string, AgentResourceAssignments>();
  const provider = createInMemoryAgentVersionStoreProvider({
    agents: agentProvider,
    now,
    references: {
      [WORKSPACE]: {
        'model-connection': [{ id: CONNECTION, name: 'Claude' }],
        skill: [{ id: SKILL, name: 'triage' }],
      },
    },
  });
  const store = await provider.forWorkspace(WORKSPACE);
  if (store === null) throw new Error('the memory store answers every workspace');
  const current = async (agentId: string): Promise<AgentRecord> => {
    const row = await agents.get(agentId);
    if (row === null) throw new Error(`agent ${agentId} exists`);
    return row;
  };
  const created = await agents.create(
    {
      name: 'Support triage',
      instructions: 'Before any version.',
      modelConnectionId: null,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
    },
    { principalId: OWNER, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the agent');
  const agent = created.agent;

  return {
    agents,
    provider,
    store,
    agent,
    /** Save and point a version the way `aw push` does. */
    async push(edits: FixtureEdits = {}): Promise<void> {
      const saved = await createAgentVersion(
        versionRequest({ name: agent.name, ...edits }),
        await current(agent.id),
        OWNER,
        { store, toolBundles: everyBundleStored, storageConnections: acmeData },
      );
      const { number } = AgentVersionResourceSchema.parse(saved.body);
      await setAgentPointer({ environment: 'local', version: number }, agent, ACTOR, {
        store,
        toolBundles: everyBundleStored,
        storageConnections: acmeData,
      });
    },
    edit(edit: UiEdit) {
      return current(agent.id).then((row) =>
        saveUiEdit(row, edit, ACTOR, {
          store,
          toolBundles: everyBundleStored,
          storageConnections: acmeData,
          assignments: () =>
            Promise.resolve(
              assignments.get(agent.id) ?? {
                files: [],
                skillIds: [],
                connectorIds: [],
                storageGrants: [],
              },
            ),
        }),
      );
    },
    setAssignments(next: AgentResourceAssignments): void {
      assignments.set(agent.id, next);
    },
    async listing() {
      const listing = await store.list(agent.id);
      if (listing === null) throw new Error('the agent has a listing');
      return listing;
    },
  };
}

describe('saveUiEdit', () => {
  it('saves a console edit of an agent that holds a storage grant and keeps the grant', async () => {
    const h = await harness();
    await h.push({
      resources: { files: [{ path: 'storage://acme-data/reports', access: 'read' }] },
    });

    const refused = await h.edit({ kind: 'patch', patch: { instructions: 'From the console.' } });

    expect(refused).toBeNull();
    expect(h.provider.assignmentsOf(h.agent.id)?.storageGrants).toEqual([
      { connectionId: STORAGE_CONNECTION, prefix: 'reports', access: 'read' },
    ]);
    const listing = await h.listing();
    expect(listing.pointers).toMatchObject([{ environment: 'local', number: 2 }]);
  });

  it('adds exactly one ui version on the local body, moves local and keeps the surfaces', async () => {
    const h = await harness();
    await h.push({ instructions: 'From code.', surfaces: [fixtureSurface('help')] });

    const refused = await h.edit({ kind: 'patch', patch: { instructions: 'From the console.' } });

    expect(refused).toBeNull();
    const listing = await h.listing();
    expect(listing.versions.map((version) => [version.number, version.via])).toEqual([
      [1, 'api'],
      [2, 'ui'],
    ]);
    expect(listing.versions[1]?.summary).toBe('Console edit: settings');
    expect(listing.pointers).toMatchObject([{ environment: 'local', number: 2 }]);
    expect(listing.materialisedVersionId).toBe(listing.versions[1]?.id);
    const body = AgentVersionBodySchema.parse(listing.versions[1]?.body);
    const pushed = AgentVersionBodySchema.parse(listing.versions[0]?.body);
    expect(body).toEqual({
      ...pushed,
      definition: {
        ...pushed.definition,
        agent: { ...pushed.definition.agent, instructions: 'From the console.' },
      },
    });
    expect((await h.agents.get(h.agent.id))?.instructions).toBe('From the console.');
  });

  it('keeps the tool bundles the local version pins (issue #790)', async () => {
    const h = await harness();
    await h.push({ toolBundles: [{ tool: 'lookup', digest: DIGEST }] });

    expect(
      await h.edit({ kind: 'patch', patch: { instructions: 'From the console.' } }),
    ).toBeNull();

    const body = AgentVersionBodySchema.parse((await h.listing()).versions[1]?.body);
    expect(body.toolBundles).toEqual([{ tool: 'lookup', digest: DIGEST }]);
  });

  it('carries the surfaces along when the console renames the agent', async () => {
    const h = await harness();
    await h.push({ surfaces: [fixtureSurface('help')] });

    expect(await h.edit({ kind: 'patch', patch: { name: 'Renamed' } })).toBeNull();

    const body = AgentVersionBodySchema.parse((await h.listing()).versions[1]?.body);
    expect(body.surfaces).toMatchObject([{ name: 'help', agent: 'Renamed' }]);
  });

  it('recompiles a compiled policy from the edited permissions', async () => {
    const h = await harness();
    await h.push({ policySource: 'compiled' });

    const permissions = { ...FIXTURE_PERMISSIONS, runCommands: true };
    expect(await h.edit({ kind: 'patch', patch: { permissions } })).toBeNull();

    const before = AgentVersionBodySchema.parse((await h.listing()).versions[0]?.body);
    const after = AgentVersionBodySchema.parse((await h.listing()).versions[1]?.body);
    expect(after.definition.policySource).toBe('compiled');
    expect(after.definition.policy).not.toEqual(before.definition.policy);
    expect(after.definition.agent.permissions).toEqual(permissions);
  });

  it('builds version 1 from the row and its assignments for an agent with no version', async () => {
    const h = await harness();
    h.setAssignments({ files: [], skillIds: [SKILL], connectorIds: [], storageGrants: [] });

    expect(
      await h.edit({ kind: 'patch', patch: { modelConnectionId: CONNECTION, model: 'opus' } }),
    ).toBeNull();

    const listing = await h.listing();
    expect(listing.versions).toHaveLength(1);
    expect(AgentVersionBodySchema.parse(listing.versions[0]?.body).definition).toMatchObject({
      agent: {
        instructions: 'Before any version.',
        model: 'opus',
        modelConnectionName: 'Claude',
      },
      policySource: 'compiled',
      policy: { skills: { mode: 'allowlist', names: ['triage'] } },
      resources: { skills: ['triage'] },
    });
    expect(listing.pointers).toMatchObject([{ environment: 'local', number: 1 }]);
  });

  it('keeps a skill revision pin through later edits, drops it with its skill (SDK-19, N-1)', async () => {
    const h = await harness();
    await h.push();
    const pinned = {
      files: [],
      skillIds: [SKILL],
      skillRevisions: { [SKILL]: 2 },
      connectorIds: [],
      storageGrants: [],
    };

    expect(await h.edit({ kind: 'resources', assignments: pinned })).toBeNull();
    expect(h.provider.assignmentsOf(h.agent.id)?.skillRevisions).toEqual({ [SKILL]: 2 });

    expect(await h.edit({ kind: 'patch', patch: { instructions: 'Later.' } })).toBeNull();
    const versions = (await h.listing()).versions.map((version) =>
      AgentVersionBodySchema.parse(version.body),
    );
    expect(versions[1]?.definition.resources.skillRevisions).toEqual({ triage: 2 });
    expect(versions[2]?.definition.resources.skillRevisions).toEqual({ triage: 2 });

    expect(
      await h.edit({
        kind: 'resources',
        assignments: {
          files: [],
          skillIds: [],
          skillRevisions: { [SKILL]: 2 },
          connectorIds: [],
          storageGrants: [],
        },
      }),
    ).toBeNull();
    const last = AgentVersionBodySchema.parse((await h.listing()).versions[3]?.body);
    expect(last.definition.resources.skillRevisions).toBeUndefined();
    expect(last.definition.resources.skills).toEqual([]);
  });

  it('carries a row pin into the body built from the row (SDK-19, N-1)', async () => {
    const h = await harness();
    h.setAssignments({
      files: [],
      skillIds: [SKILL],
      skillRevisions: { [SKILL]: 3 },
      connectorIds: [],
      storageGrants: [],
    });

    expect(await h.edit({ kind: 'patch', patch: { instructions: 'Edited.' } })).toBeNull();

    const body = AgentVersionBodySchema.parse((await h.listing()).versions[0]?.body);
    expect(body.definition.resources).toMatchObject({
      skills: ['triage'],
      skillRevisions: { triage: 3 },
    });
  });

  it('keeps an earlier edit to an un-materialised row', async () => {
    const h = await harness();
    await h.push({ instructions: 'From code.', surfaces: [fixtureSurface('help')] });
    // A write outside versions (the setup reconciliation, an old release) edits the row.
    await h.agents.update(h.agent.id, { instructions: 'Edited outside versions.' });
    expect((await h.listing()).materialisedVersionId).toBeNull();

    expect(await h.edit({ kind: 'patch', patch: { name: 'Renamed' } })).toBeNull();

    const body = AgentVersionBodySchema.parse((await h.listing()).versions[1]?.body);
    expect(body.definition.agent).toMatchObject({
      name: 'Renamed',
      instructions: 'Edited outside versions.',
    });
    // Surfaces live only in version bodies; the row-built base keeps `local`'s (review of #646).
    expect(body.surfaces).toMatchObject([{ name: 'help', agent: 'Renamed' }]);
  });

  it('answers 409 pointer_moved, not an overwrite, when a concurrent save moved local after the edit read it (#1847)', async () => {
    const h = await harness();
    await h.push({ instructions: 'From code.' });
    let raced = false;
    const racing = {
      ...h.store,
      async list(agentId: string) {
        const listing = await h.store.list(agentId);
        if (!raced) {
          raced = true;
          await h.push({ instructions: 'From a second tab.' });
        }
        return listing;
      },
    };

    const refused = await saveUiEdit(
      await h.agents.get(h.agent.id).then((row) => row ?? h.agent),
      { kind: 'patch', patch: { instructions: 'From the console.' } },
      ACTOR,
      {
        store: racing,
        toolBundles: everyBundleStored,
        storageConnections: acmeData,
        assignments: () =>
          Promise.resolve({ files: [], skillIds: [], connectorIds: [], storageGrants: [] }),
      },
    );

    expect(refused).toMatchObject({
      status: 409,
      body: { error: { code: 'pointer_moved', details: ['environment:local', 'current:2'] } },
    });
    const listing = await h.listing();
    expect(listing.pointers).toMatchObject([{ environment: 'local', number: 2 }]);
    // The edit's own version stays saved and unpointed (builder design §08 Data rule 2).
    expect(listing.versions.map((version) => [version.number, version.via])).toEqual([
      [1, 'api'],
      [2, 'api'],
      [3, 'ui'],
    ]);
    expect((await h.agents.get(h.agent.id))?.instructions).toBe('From a second tab.');
  });

  it('answers the legacy code for an id the workspace does not have, and saves nothing', async () => {
    const h = await harness();
    await h.push();

    const refused = await h.edit({
      kind: 'patch',
      patch: { modelConnectionId: '99999999-9999-4999-8999-999999999999' },
    });

    expect(refused).toMatchObject({
      status: 400,
      body: { error: { code: 'unknown_model_connection' } },
    });
    expect(h.provider.versionCount()).toBe(1);
  });

  it('passes a pipeline refusal through unchanged, and saves nothing', async () => {
    const h = await harness();
    await h.push();

    const refused = await h.edit({ kind: 'patch', patch: { name: '   ' } });

    expect(refused).toMatchObject({
      status: 400,
      body: { error: { code: 'invalid_agent_version' } },
    });
    expect(h.provider.versionCount()).toBe(1);
  });
});

describe('uiEditBody keeps storage folder grants', () => {
  // @story US-STO-12
  it('[US-STO-12][api][sdk] a resources edit replaces file ids and leaves the storage:// grants alone', () => {
    const base = AgentVersionBodySchema.parse(
      versionRequest({
        resources: {
          files: [
            { path: 'docs/a.md', access: 'read' },
            { path: 'storage://acme-data/reports/2026', access: 'read' },
          ],
        },
      }).body,
    );
    const edited = uiEditBody(
      base,
      {
        kind: 'resources',
        assignments: { files: [], skillIds: [], connectorIds: [], storageGrants: [] },
      },
      () => 'unused',
    );
    expect(edited.definition.resources.files).toEqual([
      { path: 'storage://acme-data/reports/2026', access: 'read' },
    ]);
  });
});
