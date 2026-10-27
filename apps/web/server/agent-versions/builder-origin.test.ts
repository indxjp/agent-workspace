import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CreateAgentFromVersionResponseSchema } from '@indx-workspace/contracts/agent-versions';
import { describe, expect, it } from 'vitest';

import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { createAgentFromVersion } from './create-from-version';
import { FIXTURE_PERMISSIONS, fromVersionRequest, versionRequest } from './fixtures';
import { BUILDER_ORIGIN, createAgentVersion } from './handlers';
import { createInMemoryAgentVersionStoreProvider } from './memory-store';

const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const PRINCIPAL = '36377a6a-7a0b-4610-8efc-d31547dcc38a';

async function setUp() {
  const agents = createInMemoryAgentStoreProvider();
  const provider = createInMemoryAgentVersionStoreProvider({ agents });
  const store = await provider.forWorkspace(WORKSPACE);
  if (store === null) throw new Error('the memory store answers every workspace');
  return { agents: agents.forWorkspace(WORKSPACE), store, provider };
}

describe('the in-process builder origin', () => {
  it("stores via 'builder' for a new version when the caller passes the origin", async () => {
    const { agents, store } = await setUp();
    const created = await agents.create(
      {
        name: 'Support triage',
        instructions: '',
        modelConnectionId: null,
        model: null,
        permissions: FIXTURE_PERMISSIONS,
      },
      { principalId: PRINCIPAL, userId: null },
    );
    if (created.kind !== 'created') throw new Error('the memory store creates the agent');
    const result = await createAgentVersion(
      versionRequest(),
      created.agent,
      PRINCIPAL,
      { store },
      undefined,
      BUILDER_ORIGIN,
    );
    expect(result.status).toBe(201);
    expect((await store.list(created.agent.id))?.versions[0]?.via).toBe('builder');
  });

  it("stores via 'builder' for the first version of a new agent when the caller passes the origin", async () => {
    const { agents, store } = await setUp();
    const result = await createAgentFromVersion(
      fromVersionRequest(),
      { principalId: PRINCIPAL, ownerPrincipalId: PRINCIPAL, userId: null, actorLabel: 'Ada' },
      { store, agents },
      BUILDER_ORIGIN,
    );
    expect(result.status).toBe(201);
    const { agent } = CreateAgentFromVersionResponseSchema.parse(result.body);
    expect((await store.list(agent.id))?.versions[0]?.via).toBe('builder');
  });

  it('writes the agent-created row with the new agent, version 1 and the run, when the origin names a run', async () => {
    const { agents, store, provider } = await setUp();
    const result = await createAgentFromVersion(
      fromVersionRequest(),
      {
        principalId: PRINCIPAL,
        ownerPrincipalId: PRINCIPAL,
        userId: null,
        actorLabel: 'Ada',
      },
      { store, agents },
      { ...BUILDER_ORIGIN, builderRunId: 'run-7' },
    );
    const { agent } = CreateAgentFromVersionResponseSchema.parse(result.body);
    expect(provider.audits()).toEqual([
      expect.objectContaining({
        action: 'agent-created',
        subjectId: agent.id,
        subjectLabel: agent.name,
        actorPrincipalId: PRINCIPAL,
        actorLabel: 'Ada',
        details: { agentId: agent.id, version: 1, via: 'builder', builderRunId: 'run-7' },
      }),
    ]);
  });

  it('writes no agent-created row when the origin names no run, as on the console path', async () => {
    const { agents, store, provider } = await setUp();
    await createAgentFromVersion(
      fromVersionRequest(),
      { principalId: PRINCIPAL, ownerPrincipalId: PRINCIPAL, userId: null, actorLabel: 'Ada' },
      { store, agents },
      BUILDER_ORIGIN,
    );
    expect(provider.audits()).toEqual([]);
  });
});

describe('what may name the in-process origin', () => {
  const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sources = (dir: string) =>
    readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.tsx?$/u.test(file) && !/\.test\.|\.contract\./u.test(file))
      .map((file) => ({ file, text: readFileSync(path.join(dir, file), 'utf8') }));

  it('keeps it out of every route', () => {
    const named = sources(path.resolve(server, '../app')).filter(({ text }) =>
      /BUILDER_ORIGIN|VersionOrigin/u.test(text),
    );
    expect(named.map(({ file }) => file)).toEqual([]);
  });

  it('names it only in the two handlers that take it and the Builder store that passes it', () => {
    const allowed = new Set([
      'agent-versions/handlers.ts',
      'agent-versions/create-from-version.ts',
      'builder/adapters/store/production.ts',
    ]);
    const named = sources(server).filter(
      ({ file, text }) =>
        !allowed.has(file.split(path.sep).join('/')) && /BUILDER_ORIGIN|VersionOrigin/u.test(text),
    );
    expect(named.map(({ file }) => file)).toEqual([]);
  });
});
