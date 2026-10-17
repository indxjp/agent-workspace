import {
  createInMemoryWorkspaceScopeResolver,
  type AgentVersionListing,
  type AgentVersionRecord,
  type AgentVersionRepositoryProvider,
  type RuntimeProfileRecord,
  type RuntimeProfileRepositoryProvider,
  type WorkspaceScope,
} from '@agent-workspace/core/db';
import { createEndpointGrantCodec } from '@agent-workspace/gateway/tokens';
import type { ToolSandboxRequest } from '@indx-workspace/contracts/agent-versions';
import { describe, expect, it } from 'vitest';

import { versionRequest } from '../agent-versions/fixtures';
import { createToolEndpointSources, type ToolEndpointSourceDependencies } from './sources';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const OTHER_WORKSPACE = '55555555-5555-4555-8555-555555555555';
const CLIENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const AGENT = '33333333-3333-4333-8333-333333333333';
const SIGNING_SECRET = 'x'.repeat(48);
const ORIGIN = 'http://10.0.0.7:4000';
const DIGEST_LOCAL = 'a'.repeat(64);
const DIGEST_PRODUCTION = 'b'.repeat(64);

function version(id: string, digest: string): AgentVersionRecord {
  return {
    id,
    workspaceId: WORKSPACE,
    agentId: AGENT,
    number: id === 'v1' ? 1 : 2,
    summary: id,
    via: 'api',
    body: {
      ...versionRequest().body,
      toolBundles: [
        {
          tool: 'lookup',
          digest,
          description: 'Look a ticket up.',
          inputSchema: { type: 'object' },
          secrets: ['TICKETS_TOKEN'],
          allowedDomains: ['api.tickets.example'],
          timeoutMs: 12_000,
        },
      ],
    },
    createdByPrincipalId: AGENT,
    createdAt: new Date(0),
  };
}

const LISTING: AgentVersionListing = {
  versions: [version('v1', DIGEST_PRODUCTION), version('v2', DIGEST_LOCAL)],
  pointers: [
    {
      agentId: AGENT,
      environment: 'production',
      versionId: 'v1',
      number: 1,
      updatedAt: new Date(0),
    },
    { agentId: AGENT, environment: 'local', versionId: 'v2', number: 2, updatedAt: new Date(0) },
  ],
  materialisedVersionId: 'v2',
};

const PROFILE_ID = '66666666-6666-4666-8666-666666666666';
const CONNECTION_ID = '77777777-7777-4777-8777-777777777777';
const PROVIDER_KEY = 'e2b-provider-key';

const DEFAULT_PROFILE = {
  id: PROFILE_ID,
  workspaceId: WORKSPACE,
  driver: 'external',
  runtimeConnectionId: CONNECTION_ID,
} as RuntimeProfileRecord;

function harness(defaultProfile: RuntimeProfileRecord | null = DEFAULT_PROFILE) {
  const scopes = createInMemoryWorkspaceScopeResolver([
    { id: WORKSPACE, slug: 'acme' },
    { id: OTHER_WORKSPACE, slug: 'other' },
  ]);
  const secretReads: string[] = [];
  const bundleReads: string[] = [];
  const opened: Array<{ workspaceId: string; clientId: string; toolSandbox: ToolSandboxRequest }> =
    [];
  const credentials: Array<string | undefined> = [];
  const closed: Array<{ workspaceId: string; clientId: string; credential: string | undefined }> =
    [];
  const credentialSpecs: unknown[] = [];
  const agentVersions = {
    forScope: (scope: WorkspaceScope) => ({
      list: (agentId: string) =>
        Promise.resolve(scope.workspaceId === WORKSPACE && agentId === AGENT ? LISTING : null),
    }),
  } as unknown as AgentVersionRepositoryProvider;
  const runtimeProfiles = {
    forScope: (scope: WorkspaceScope) => ({
      findWorkspaceDefault: () =>
        Promise.resolve(scope.workspaceId === WORKSPACE ? defaultProfile : null),
    }),
  } as unknown as RuntimeProfileRepositoryProvider;
  const deps: ToolEndpointSourceDependencies = {
    scopes,
    agentVersions,
    runtimeProfiles,
    providerCredential: (_, spec) => {
      credentialSpecs.push(spec);
      return Promise.resolve(PROVIDER_KEY);
    },
    secrets: {
      resolveByName: (scope, name) => {
        secretReads.push(`${scope.workspaceId}/${name}`);
        return Promise.resolve({ name, value: Buffer.from('token-value') });
      },
    },
    bundle: (workspaceId, digest) => {
      bundleReads.push(`${workspaceId}/${digest}`);
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    },
    runnerManager: {
      openToolSandbox: (input, credential) => {
        opened.push(input);
        credentials.push(credential);
        return Promise.resolve(ORIGIN);
      },
      closeToolSandbox: (workspaceId, clientId, credential) => {
        closed.push({ workspaceId, clientId, credential });
        return Promise.resolve();
      },
    },
    gatewaySettings: {
      ok: true,
      settings: {
        baseUrl: 'https://gateway.example',
        signingSecret: SIGNING_SECRET,
        ttlSeconds: 60,
      },
    },
  };
  return {
    deps,
    sources: createToolEndpointSources(deps),
    secretReads,
    bundleReads,
    opened,
    credentials,
    closed,
    credentialSpecs,
  };
}

describe('createToolEndpointSources', () => {
  it("returns only the production pointer's bundles, and none for another workspace", async () => {
    const { sources } = harness();
    const bundles = await sources.productionToolBundles(WORKSPACE, [AGENT]);
    expect(bundles.map((bundle) => bundle.digest)).toEqual([DIGEST_PRODUCTION]);
    expect(await sources.productionToolBundles(OTHER_WORKSPACE, [AGENT])).toEqual([]);
  });

  it("opens the client's sandbox from the caller's workspace and grants the manager's origin", async () => {
    const { sources, secretReads, bundleReads, opened } = harness();
    const bundles = await sources.productionToolBundles(WORKSPACE, [AGENT]);
    const route = await sources.route({ workspaceId: WORKSPACE, clientId: CLIENT, bundles });

    expect(secretReads).toEqual([`${WORKSPACE}/TICKETS_TOKEN`]);
    expect(bundleReads).toEqual([`${WORKSPACE}/${DIGEST_PRODUCTION}`]);
    expect(opened).toHaveLength(1);
    const [open] = opened;
    expect(open?.workspaceId).toBe(WORKSPACE);
    expect(open?.clientId).toBe(CLIENT);
    expect(open?.toolSandbox.run.runId).toBe(`endpoint-${CLIENT}`);
    expect(open?.toolSandbox.manifest.tools.map((tool) => tool.digest)).toEqual([
      DIGEST_PRODUCTION,
    ]);
    expect(open?.toolSandbox.manifest.env).toEqual({ TICKETS_TOKEN: 'token-value' });
    expect(open?.toolSandbox.allowedDomains).toEqual(['api.tickets.example']);
    expect(open?.toolSandbox.manifest.tools.map((tool) => tool.timeoutMs)).toEqual([12_000]);

    expect(route.url).toBe('https://gateway.example/v1/tool-sandbox/endpoint/mcp');
    const verified = await createEndpointGrantCodec({ secret: SIGNING_SECRET }).verify(route.grant);
    expect(verified.ok && verified.claims).toMatchObject({
      workspaceId: WORKSPACE,
      clientId: CLIENT,
      origin: ORIGIN,
    });
  });

  it("opens the sandbox with the default runtime profile's provider credential", async () => {
    const { sources, opened, credentials, credentialSpecs } = harness();
    const bundles = await sources.productionToolBundles(WORKSPACE, [AGENT]);
    await sources.route({ workspaceId: WORKSPACE, clientId: CLIENT, bundles });

    expect(credentialSpecs).toEqual([
      { driver: 'external', runtimeProfileId: PROFILE_ID, runtimeConnectionId: CONNECTION_ID },
    ]);
    expect(credentials).toEqual([PROVIDER_KEY]);
    expect(JSON.stringify(opened)).not.toContain(PROVIDER_KEY);
  });

  it('refuses to route, forwarding nothing, when the workspace has no default runtime profile', async () => {
    const { sources, opened, secretReads, bundleReads } = harness(null);
    const bundles = await sources.productionToolBundles(WORKSPACE, [AGENT]);
    await expect(
      sources.route({ workspaceId: WORKSPACE, clientId: CLIENT, bundles }),
    ).rejects.toThrow('no default runtime profile');
    expect(opened).toEqual([]);
    expect(secretReads).toEqual([]);
    expect(bundleReads).toEqual([]);
  });

  it('refuses to route with no runner manager or no gateway settings', async () => {
    const { deps } = harness();
    const input = { workspaceId: WORKSPACE, clientId: CLIENT, bundles: [] };
    await expect(
      createToolEndpointSources({ ...deps, runnerManager: null }).route(input),
    ).rejects.toThrow('no runner manager');
    await expect(
      createToolEndpointSources({
        ...deps,
        gatewaySettings: { ok: false, reason: 'MODEL_GATEWAY_URL is not set.' },
      }).route(input),
    ).rejects.toThrow('MODEL_GATEWAY_URL');
  });

  it("closes the client's sandbox with the default profile's credential", async () => {
    const { sources, closed } = harness();
    await sources.closeSandbox(WORKSPACE, CLIENT);
    expect(closed).toEqual([
      { workspaceId: WORKSPACE, clientId: CLIENT, credential: PROVIDER_KEY },
    ]);
  });

  it('closes without a credential when the workspace has no default profile', async () => {
    const { sources, closed } = harness(null);
    await sources.closeSandbox(WORKSPACE, CLIENT);
    expect(closed).toEqual([{ workspaceId: WORKSPACE, clientId: CLIENT, credential: undefined }]);
  });

  it('closes nothing with no runner manager', async () => {
    const { deps } = harness();
    await expect(
      createToolEndpointSources({ ...deps, runnerManager: null }).closeSandbox(WORKSPACE, CLIENT),
    ).resolves.toBeUndefined();
  });
});
