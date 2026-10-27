/**
 * Pipeline step 4a: a `storage://<connection>/<folder>` grant is checked against the connection of
 * the deploying workspace (the storage design, §05 and §06 Phase 5). Grants are refused here, and
 * an accepted grant leaves the step as a resolved `{ connectionId, prefix, access }`.
 */
import { describe, expect, it } from 'vitest';

import {
  AGENT_VERSION_PROBLEM_CODES,
  CreateAgentVersionRequestSchema,
} from '@indx-workspace/contracts/agent-versions';
import {
  createInMemoryStorageConnectionRepositoryProvider,
  createInMemoryWorkspaceScopeResolver,
} from '@agent-workspace/core/db';

import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { versionRequest } from './fixtures';
import { createInMemoryAgentVersionStoreProvider } from './memory-store';
import { parseVersionRequest, validateAgentVersion, type AgentVersionContext } from './pipeline';
import {
  storageConnectionLookup,
  resolveStorageGrants,
  type StorageConnectionLookup,
} from './storage-grants';

const WORKSPACE_A = '66666666-6666-4666-8666-666666666666';
const WORKSPACE_B = '77777777-7777-4777-8777-777777777777';
const REGISTERED = ['claude-agent-sdk'];

interface Seed {
  readonly name: string;
  readonly allowedPrefixes: readonly string[];
  readonly writeAllowed?: boolean;
}

/** One in-memory connection repository for both workspaces, so isolation is the repository's. */
function connections() {
  const scopes = createInMemoryWorkspaceScopeResolver([
    { id: WORKSPACE_A, slug: 'a' },
    { id: WORKSPACE_B, slug: 'b' },
  ]);
  const provider = createInMemoryStorageConnectionRepositoryProvider();
  const repositoryOf = async (workspaceId: string) => {
    const scope = await scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('fixture workspace did not resolve');
    return provider.forScope(scope);
  };
  return {
    async seed(workspaceId: string, held: readonly Seed[]) {
      const repository = await repositoryOf(workspaceId);
      const ids = new Map<string, string>();
      for (const connection of held) {
        const id = crypto.randomUUID();
        ids.set(connection.name, id);
        await repository.create({
          id,
          name: connection.name,
          provider: 's3',
          url: 's3://acme-bucket',
          allowedPrefixes: connection.allowedPrefixes,
          writeAllowed: connection.writeAllowed ?? false,
        });
      }
      return ids;
    },
    async lookup(workspaceId: string) {
      return storageConnectionLookup(await repositoryOf(workspaceId));
    },
  };
}

async function validate(
  paths: readonly { readonly path: string; readonly access?: 'read' | 'read-write' }[],
  dependencies: Pick<AgentVersionContext, 'storageConnections'>,
  dryRun = false,
) {
  const request = versionRequest({
    resources: { files: paths.map(({ path, access }) => ({ path, access: access ?? 'read' })) },
  });
  const parsed = parseVersionRequest(CreateAgentVersionRequestSchema, request, 'body', REGISTERED);
  if (!parsed.ok) return parsed.result;
  const provider = createInMemoryAgentVersionStoreProvider({
    agents: createInMemoryAgentStoreProvider(),
    references: { [WORKSPACE_A]: {} },
  });
  const store = await provider.forWorkspace(WORKSPACE_A);
  if (store === null) throw new Error('the memory store answers every workspace');
  const validated = await validateAgentVersion(parsed.request.body, {
    ...dependencies,
    store,
    registered: REGISTERED,
    subject: { kind: 'new' },
    bodyPath: 'body',
    dryRun,
  });
  return validated.ok
    ? { status: 200, body: null, references: validated.references }
    : validated.result;
}

const ACME = { name: 'acme-data', allowedPrefixes: ['reports'] } as const;

describe('pipeline step 4a: storage grants', () => {
  // @story US-STO-12
  it('[US-STO-12][api][sdk] a folder outside the allowed list is refused', async () => {
    const held = connections();
    await held.seed(WORKSPACE_A, [ACME]);
    const result = await validate([{ path: 'storage://acme-data/secrets/2026' }], {
      storageConnections: await held.lookup(WORKSPACE_A),
    });
    expect(result).toMatchObject({
      status: 403,
      body: {
        error: {
          code: 'storage_connection_prefix_not_allowed',
          details: ['storage://acme-data/secrets/2026'],
        },
      },
    });
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] an agent is granted one folder, stored by the resolved connection id', async () => {
    const held = connections();
    const ids = await held.seed(WORKSPACE_A, [ACME]);
    const lookup = await held.lookup(WORKSPACE_A);
    const result = await validate([{ path: 'storage://acme-data/reports/2026' }], {
      storageConnections: lookup,
    });
    expect(result).toMatchObject({
      status: 200,
      references: {
        files: [],
        storageGrants: [
          { connectionId: ids.get('acme-data'), prefix: 'reports/2026', access: 'read' },
        ],
      },
    });
  });

  // @story US-STO-12
  // A letter-led id also matches the name grammar, so both shapes are pinned rather than left to
  // whichever crypto.randomUUID() happens to return.
  it.each([
    ['a letter', 'abcdef12-3456-4789-8abc-def012345678'],
    ['a digit', '12345678-9abc-4def-8012-3456789abcde'],
  ])(
    '[US-STO-12][api][sdk] a connection id that starts with %s never reaches the lookup',
    async (_label, id) => {
      const guarded: StorageConnectionLookup = (names) => {
        throw new Error(`the lookup must not run for ${names.join(', ')}`);
      };
      expect(
        await validate([{ path: `storage://${id}/reports` }], { storageConnections: guarded }),
      ).toMatchObject({ status: 400, body: { error: { code: 'invalid_agent_version' } } });
    },
  );

  // @story US-STO-12
  it('[US-STO-12][api][sdk] writing needs an explicit grant', async () => {
    const held = connections();
    await held.seed(WORKSPACE_A, [ACME, { ...ACME, name: 'acme-rw', writeAllowed: true }]);
    const lookup = await held.lookup(WORKSPACE_A);
    const readOnly = await validate(
      [{ path: 'storage://acme-data/reports/2026', access: 'read-write' }],
      { storageConnections: lookup },
    );
    expect(readOnly).toMatchObject({
      status: 403,
      body: { error: { code: 'storage_connection_write_not_allowed' } },
    });
    expect(
      await validate([{ path: 'storage://acme-rw/reports/2026', access: 'read-write' }], {
        storageConnections: lookup,
      }),
    ).toMatchObject({
      status: 200,
      references: { storageGrants: [{ prefix: 'reports/2026', access: 'read-write' }] },
    });
  });

  // @story US-STO-12
  it.each([
    ['a sibling folder that starts the same', 'storage://acme-data/reports-old/x'],
    ['an encoded dot segment, which is never decoded', 'storage://acme-data/%2e%2e/reports'],
    ['a folder above the allowed one', 'storage://acme-data/other'],
  ])('[US-STO-12][api][sdk] %s is refused', async (_label, path) => {
    const held = connections();
    await held.seed(WORKSPACE_A, [ACME]);
    expect(
      await validate([{ path }], { storageConnections: await held.lookup(WORKSPACE_A) }),
    ).toMatchObject({
      status: 403,
      body: { error: { code: 'storage_connection_prefix_not_allowed', details: [path] } },
    });
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] an encoded dot segment under the allowed folder stays literal', async () => {
    const held = connections();
    await held.seed(WORKSPACE_A, [ACME]);
    const lookup = await held.lookup(WORKSPACE_A);
    expect(
      await resolveStorageGrants(
        [{ path: 'storage://acme-data/reports/%2e%2e', access: 'read' }],
        lookup,
      ),
    ).toMatchObject({ grants: [{ prefix: 'reports/%2e%2e' }] });
  });

  // @story US-STO-12
  it.each([
    ['a .. segment', 'storage://acme-data/reports/../secrets'],
    ['a trailing slash', 'storage://acme-data/reports/'],
  ])('[US-STO-12][api][sdk] %s never reaches the lookup', async (_label, path) => {
    const held = connections();
    await held.seed(WORKSPACE_A, [ACME]);
    expect(
      await validate([{ path }], { storageConnections: await held.lookup(WORKSPACE_A) }),
    ).toMatchObject({
      status: 400,
      body: { error: { code: 'invalid_agent_version' } },
    });
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] a connection of another workspace is missing, not a grant', async () => {
    const held = connections();
    await held.seed(WORKSPACE_B, [ACME]);
    const result = await validate([{ path: 'storage://acme-data/reports/2026' }], {
      storageConnections: await held.lookup(WORKSPACE_A),
    });
    expect(result).toMatchObject({
      status: AGENT_VERSION_PROBLEM_CODES.agent_definition_references_missing,
      body: {
        error: {
          code: 'agent_definition_references_missing',
          details: ['file:storage://acme-data/reports/2026'],
        },
      },
    });
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] without a lookup the grant is refused as a missing file', async () => {
    expect(await validate([{ path: 'storage://acme-data/reports/2026' }], {})).toMatchObject({
      status: 422,
      body: { error: { details: ['file:storage://acme-data/reports/2026'] } },
    });
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] a dry run answers what the save answers', async () => {
    const held = connections();
    await held.seed(WORKSPACE_A, [ACME]);
    const storageConnections = await held.lookup(WORKSPACE_A);
    const paths = [{ path: 'storage://acme-data/secrets' }];
    expect(await validate(paths, { storageConnections }, true)).toEqual(
      await validate(paths, { storageConnections }, false),
    );
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] a body without a storage grant never reads the connections', async () => {
    const lookup: StorageConnectionLookup = () => {
      throw new Error('the lookup must not run');
    };
    expect(await validate([], { storageConnections: lookup })).toMatchObject({
      status: 200,
      references: { storageGrants: [] },
    });
  });
});
