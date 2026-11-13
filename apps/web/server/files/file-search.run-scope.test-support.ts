import { describe, expect, it } from 'vitest';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { buildRunRequestFor } from '../compose/run-request';
import { recordRunFileGrants } from '../composition/wiring/run-launcher';
import type { RunTokenIssuer } from '../gateway/issuer';
import { InMemoryRunStore } from '../runs/memory-store';
import { EMPTY_SHA256, file, createSearchFixture } from './file-search.index.test-support';
import { searchFiles } from './search';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';

const OWNER = {
  principalId: '77777777-7777-4777-8777-777777777777',
  userId: '66666666-6666-4666-8666-666666666666',
};

const ALL_ON = {
  readFiles: true,
  writeFiles: true,
  runCommands: true,
  unrestrictedNetwork: true,
};

const gateway: RunTokenIssuer = {
  baseUrl: 'http://gateway:4000',
  issue: () => Promise.resolve('run-token'),
};

const grantedFile = (path: string) => ({
  kind: 'file' as const,
  path,
  access: 'read' as const,
  size: 0,
  sha256: EMPTY_SHA256,
});

async function searchAsRun(fileScope: readonly string[] | undefined) {
  const agents = createInMemoryAgentStoreProvider();
  const created = await agents.forWorkspace(WORKSPACE).create(
    {
      name: 'General',
      instructions: '',
      modelConnectionId: '77777777-7777-4777-8777-777777777777',
      model: null,
      permissions: ALL_ON,
    },
    OWNER,
  );
  if (created.kind !== 'created') throw new Error(created.kind);
  const run = await new InMemoryRunStore().create({
    engine: 'claude-agent-sdk',
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: WORKSPACE,
    agentId: created.agent.id,
    sessionId: '44444444-4444-4444-8444-444444444444',
  });
  const request = await buildRunRequestFor({
    context: {
      run,
      agent: { id: created.agent.id, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' },
      session: { id: run.sessionId, agentId: created.agent.id, engine: null },
      principal: {
        principalId: OWNER.principalId,
        ownerPrincipalId: OWNER.principalId,
        userId: OWNER.userId,
        workspaceId: WORKSPACE,
        scope: null,
      },
      prompt: 'find the pump',
      ...(fileScope === undefined ? {} : { fileScope }),
    },
    runAgent: {
      agent: created.agent,
      assignments: { files: [], skillIds: [], connectorIds: [], storageGrants: [] },
      toolBundles: [],
      subagents: [],
    },
    settings: { runnerUrl: 'http://runner:8080', workspaceRoot: '/workspace' },
    gateway,
    permissionOverride: ALL_ON,
    resourceLoader: {
      load: () =>
        Promise.resolve({
          files: [
            { kind: 'directory' as const, path: 'docs', access: 'read' as const },
            grantedFile('docs/alice/a.md'),
            grantedFile('docs/bob/b.md'),
          ],
          skills: [],
          mcpServers: {},
        }),
    },
  });

  let snapshot: readonly string[] = [];
  await recordRunFileGrants(
    {
      snapshotFileGrants: (_runId, paths) => {
        snapshot = paths;
        return Promise.resolve(true);
      },
    },
    run.id,
    request.resources?.files ?? [],
  );

  const files = [
    file('docs/alice/a.md', 'pump seal for alice'),
    file('docs/bob/b.md', 'pump seal for bob'),
  ];
  const { open, texts, put, catalog } = await createSearchFixture(files);
  await put();
  const result = await searchFiles(
    { open, texts, catalog },
    { query: 'pump', limit: 10, grants: snapshot },
  );
  return { snapshot, hits: result?.hits ?? [] };
}

describe('a run started with a fileScope (issue #1539)', () => {
  /** Compose the run, record its snapshot as the launcher does, and search under that snapshot. */

  it(
    'searches only the narrowed set: no path and no snippet comes from outside it',
    searchesOnlyNarrowedSetNoPathNoSnippet,
  );

  it('searches every granted file when the run has no scope', searchesEveryGrantedFileWhenRunHasNo);
});

async function searchesOnlyNarrowedSetNoPathNoSnippet() {
  const { snapshot, hits } = await searchAsRun(['docs/alice']);
  expect(snapshot).toEqual(['docs/alice/a.md']);
  expect(hits.map((hit) => hit.path)).toEqual(['docs/alice/a.md']);
  expect(JSON.stringify(hits)).not.toMatch(/bob/u);
}

async function searchesEveryGrantedFileWhenRunHasNo() {
  const { snapshot, hits } = await searchAsRun(undefined);
  expect(snapshot).toEqual(['docs']);
  expect(hits.map((hit) => hit.path).sort()).toEqual(['docs/alice/a.md', 'docs/bob/b.md']);
}
