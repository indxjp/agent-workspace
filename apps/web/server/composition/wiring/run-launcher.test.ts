import {
  createInMemoryWorkspaceScopeResolver,
  type ModelConnectionRecord,
} from '@agent-workspace/core/db';
import { bytesToStream, createInMemoryObjectStoreProvider } from '@agent-workspace/core/storage';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { describe, expect, it, vi } from 'vitest';

import { buildRunRequestFor } from '../../compose/run-request';
import { awControlServerFor } from '../../compose/run-request-tool-connectors';
import type { RuntimeLaunchTarget } from '../../compose/runtime-profile';
import { writeBackStorage } from '../../compose/storage-writeback';
import { DomainError } from '../../errors';
import { createCatalogFilesWorld } from '../../files/catalog-runtime-fixtures';
import type { ResolvedModelConnection } from '../../models/store';
import { createInMemoryCatalogStore } from '../../resources/catalog-store.memory';
import { promptWithAttachments } from '../../runs/attachments';
import type { LaunchContext } from '../../runs/environment';
import { PreparationStepError } from '../../runs/failures';
import { createRunnerLauncher } from '../../runs/launcher';
import { InMemoryRunStore } from '../../runs/memory-store';
import {
  createCompositionRunLauncher,
  readAttachmentBytes,
  recordRunFileGrants,
  withTranscription,
} from './run-launcher';

// The wiring is real; only its far ends are seams: the launcher it builds, the request compose
// builds (which loads the run's resources through the loader it is handed), and the write-back.
vi.mock('../../runs/launcher', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createRunnerLauncher: vi.fn(() => () => undefined),
}));
vi.mock('../../compose/run-request', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildRunRequestFor: vi.fn(async (...args: unknown[]) => {
    const loader = args[7] as { load: (...load: unknown[]) => Promise<unknown> };
    await loader.load();
    return { resources: { files: [] } };
  }),
}));
vi.mock('../../compose/storage-writeback', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  writeBackStorage: vi.fn(() => Promise.resolve(new Map())),
}));

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const RECORDING = { fileId: 'f-1', path: 'meetings/a.m4a', kind: 'file' as const };

async function launchContext(): Promise<LaunchContext> {
  const run = await new InMemoryRunStore().create({
    engine: 'claude-agent-sdk',
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: WORKSPACE,
    agentId: AGENT,
    sessionId: SESSION,
  });
  return {
    run,
    agent: { id: AGENT, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' },
    session: { id: SESSION, agentId: AGENT, engine: null },
    principal: {
      principalId: '77777777-7777-4777-8777-777777777777',
      ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
      userId: '66666666-6666-4666-8666-666666666666',
      workspaceId: WORKSPACE,
      scope: null,
    },
    prompt: promptWithAttachments('minutes please', [RECORDING]),
    attachments: [RECORDING],
  };
}

function openai(): ResolvedModelConnection {
  const connection: ModelConnectionRecord = {
    id: 'conn-1',
    workspaceId: WORKSPACE,
    name: 'OpenAI',
    provider: 'openai',
    config: { baseUrl: 'http://127.0.0.1:9/v1' },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  return { connection, credential: 'sk-test' };
}

async function readBytesFromStore(): Promise<(path: string) => Promise<Uint8Array | null>> {
  const objects = createInMemoryObjectStoreProvider().forWorkspace(WORKSPACE);
  await objects.put(RECORDING.path, { body: new Uint8Array([7, 7]) });
  return async (path) => (await objects.get(path))?.body ?? null;
}

describe('withTranscription (the launcher transcription step, issue #1313)', () => {
  it('puts the transcript into the prompt the run request is built from', async () => {
    const request = vi.fn<typeof fetch>(() => Promise.resolve(new Response('we agreed on May')));
    const launched = await withTranscription({
      context: await launchContext(),
      provider: 'openai',
      resolveConnection: () => Promise.resolve(openai()),
      readBytes: await readBytesFromStore(),
      request,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(launched.prompt).toContain('Attached (read-only): meetings/a.m4a');
    expect(launched.prompt).toContain('Transcript of meetings/a.m4a:\nwe agreed on May');
  });

  it('refuses an audio attachment on a provider that cannot transcribe it', async () => {
    const request = vi.fn<typeof fetch>();
    const failure = await withTranscription({
      context: await launchContext(),
      provider: 'anthropic',
      resolveConnection: () => Promise.resolve(openai()),
      readBytes: await readBytesFromStore(),
      request,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DomainError);
    expect((failure as DomainError).code).toBe('run_attachments_untranscribable');
    expect(request).not.toHaveBeenCalled();
  });

  it('fails at the transcription step when the model connection cannot be read', async () => {
    const failure = await withTranscription({
      context: await launchContext(),
      provider: 'openai',
      resolveConnection: () => Promise.resolve(null),
      readBytes: await readBytesFromStore(),
      request: vi.fn<typeof fetch>(),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PreparationStepError);
    expect((failure as PreparationStepError).step).toBe('transcription');
  });

  it('transcribes the attached audio read through the catalog service', async () => {
    const world = createCatalogFilesWorld({
      catalogs: createInMemoryCatalogStore(),
      scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]),
      resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
    });
    const saved = await world.storage.save(
      { workspaceId: WORKSPACE, principalId: 'p-1', userId: 'u-1' },
      {
        area: 'files',
        path: RECORDING.path,
        maxBytes: 1024,
        replace: false,
        body: bytesToStream(new Uint8Array([5, 6, 7])),
      },
    );
    expect(saved.ok).toBe(true);
    const sent: Uint8Array[] = [];
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const file = (init?.body as FormData).get('file') as Blob;
      sent.push(new Uint8Array(await file.arrayBuffer()));
      return new Response('we agreed on May');
    });
    await withTranscription({
      context: await launchContext(),
      provider: 'openai',
      resolveConnection: () => Promise.resolve(openai()),
      readBytes: (path) => readAttachmentBytes(world.runtime, WORKSPACE, path),
      request,
    });
    expect(sent).toEqual([new Uint8Array([5, 6, 7])]);
    await expect(readAttachmentBytes(world.runtime, WORKSPACE, 'meetings')).resolves.toBeNull();
  });

  it('leaves a run without recordings untouched', async () => {
    const context = { ...(await launchContext()), attachments: [] };
    const resolveConnection = vi.fn(() => Promise.resolve(openai()));
    await expect(
      withTranscription({
        context,
        provider: 'anthropic',
        resolveConnection,
        readBytes: () => Promise.resolve(null),
      }),
    ).resolves.toBe(context);
    expect(resolveConnection).not.toHaveBeenCalled();
  });
});

describe('the storage write-back wiring', () => {
  it('[US-STO-12][unit][run] hands the write-back the folders compose delivered writable', async () => {
    const folder = { connectionId: '55555555-5555-4555-8555-555555555555', prefix: 'reports' };
    const scope = {};
    createCompositionRunLauncher({
      root: {
        recordAuditEvent: () => Promise.resolve(),
        runs: { forScope: () => ({ snapshotFileGrants: () => Promise.resolve(true) }) },
      },
      scopes: { forWorkspaceId: () => Promise.resolve(scope) },
      sessionRows: { forScope: () => ({ get: () => Promise.resolve(null) }) },
      recordRunTelemetry: () => undefined,
      secretsService: null,
      modelsApi: null,
      runnerManager: null,
      resolveProviderCredential: () => Promise.resolve(null),
      filesRuntime: null,
      runResources: {
        load: () =>
          Promise.resolve({ storageFolders: new Map([['storage/acme-data/reports', folder]]) }),
      },
      runAgentOf: () => Promise.resolve({ agent: {} }),
      readRunAgent: () => Promise.reject(new Error('unused')),
      runStorageConnections: {},
      wave5Repositories: () => Promise.reject(new Error('unused')),
      runs: { snapshotModel: () => Promise.resolve(), get: () => Promise.resolve(null) },
      runPreflight: {
        resolveModel: () =>
          Promise.resolve({
            ok: true,
            connectionId: 'conn-1',
            model: 'claude-sonnet-4-5',
            provider: 'anthropic',
            layer: 'agent',
            connectionName: 'Anthropic',
            validated: true,
          }),
      },
      gateway: {},
      gatewaySettings: { ok: false },
      hostLaunch: {},
      runtimeResolver: {},
      launchedModels: new Map(),
      revokeAllRunTokensFor: () => Promise.resolve(),
      policyCeiling: null,
    } as never);
    const options = vi.mocked(createRunnerLauncher).mock.calls.at(-1)?.[0];
    const context = { ...(await launchContext()), attachments: [] };

    await options?.buildRunRequest(context, {
      runnerUrl: 'http://runner.test',
      workspaceRoot: '/workspace',
    } as RuntimeLaunchTarget);
    await options?.storageWriteback?.({
      context,
      body: {},
      cwd: `${WORKSPACE}/${SESSION}`,
      collect: () => Promise.resolve(null),
      signal: new AbortController().signal,
    });

    expect(vi.mocked(writeBackStorage).mock.calls.at(-1)?.[0].folders).toEqual(
      new Map([['storage/acme-data/reports', folder]]),
    );
  });
});

describe("the policy ceiling a run is composed under (#1851: a project's policy never grants aw-control)", () => {
  const NAME = 'hr-onboarding-coordinator';
  const PROJECT = '88888888-8888-4888-8888-888888888888';
  // What a project file's `policy.builder.allow` would be if it were stored with the project.
  const projectPolicy: ProjectPolicy = { builder: { allow: [NAME] } };

  /** Launches a run in a project through the real wiring; returns what compose was handed. */
  async function composedUnder(deployment: ProjectPolicy | null) {
    const projectsGot: string[] = [];
    createCompositionRunLauncher({
      root: {
        recordAuditEvent: () => Promise.resolve(),
        runs: { forScope: () => ({ snapshotFileGrants: () => Promise.resolve(true) }) },
      },
      scopes: { forWorkspaceId: () => Promise.resolve({}) },
      sessionRows: { forScope: () => ({ get: () => Promise.resolve({ projectId: PROJECT }) }) },
      recordRunTelemetry: () => undefined,
      secretsService: null,
      modelsApi: null,
      runnerManager: null,
      resolveProviderCredential: () => Promise.resolve(null),
      filesRuntime: null,
      runResources: { load: () => Promise.resolve({}) },
      runAgentOf: () => Promise.resolve({ agent: { name: NAME } }),
      readRunAgent: () => Promise.reject(new Error('unused')),
      runStorageConnections: null,
      wave5Repositories: () =>
        Promise.resolve({
          projects: {
            get: (id: string) => {
              projectsGot.push(id);
              return Promise.resolve({ id, instructions: null, policy: projectPolicy });
            },
          },
        }),
      runs: { snapshotModel: () => Promise.resolve(), get: () => Promise.resolve(null) },
      runPreflight: {
        resolveModel: () =>
          Promise.resolve({
            ok: true,
            connectionId: 'conn-1',
            model: 'claude-sonnet-4-5',
            provider: 'anthropic',
            layer: 'agent',
            connectionName: 'Anthropic',
            validated: true,
          }),
      },
      gateway: {},
      gatewaySettings: { ok: false },
      hostLaunch: {},
      runtimeResolver: {},
      launchedModels: new Map(),
      revokeAllRunTokensFor: () => Promise.resolve(),
      policyCeiling: deployment,
    } as never);
    const options = vi.mocked(createRunnerLauncher).mock.calls.at(-1)?.[0];
    await options?.buildRunRequest({ ...(await launchContext()), attachments: [] }, {
      runnerUrl: 'http://runner.test',
      workspaceRoot: '/workspace',
    } as RuntimeLaunchTarget);
    const args = vi.mocked(buildRunRequestFor).mock.calls.at(-1) ?? [];
    return { projectsGot, projectId: args[9], ceiling: args[12] };
  }
  const doorFor = (ceiling: unknown) =>
    awControlServerFor({ name: NAME }, ceiling as ProjectPolicy | null, 'http://gateway:4000', 't');

  it('composes under the deployment policy only, however the run is in a project that lists the agent', async () => {
    const { projectsGot, projectId, ceiling } = await composedUnder(null);
    // The project was loaded and handed to compose, so the project is in play...
    expect(projectsGot).toEqual([PROJECT]);
    expect(projectId).toBe(PROJECT);
    // ...yet the ceiling compose was given is the deployment's (none), so the agent gets no door.
    expect(ceiling).toBeNull();
    expect(doorFor(ceiling)).toEqual({});
  });

  it('gives the door when the deployment policy lists the agent, with the same project', async () => {
    const deployment: ProjectPolicy = { builder: { allow: [NAME] } };
    const { projectId, ceiling } = await composedUnder(deployment);
    expect(projectId).toBe(PROJECT);
    expect(ceiling).toBe(deployment);
    expect(Object.keys(doorFor(ceiling))).toEqual(['aw-control']);
  });
});

describe('recordRunFileGrants', () => {
  const files = [
    { kind: 'directory' as const, path: 'manuals' },
    { kind: 'file' as const, path: 'manuals/a.pdf' },
    { kind: 'file' as const, path: 'solo.pdf' },
  ];

  it('snapshots the grant roots of the request, a file under a granted folder collapsing', async () => {
    const seen: [string, readonly string[]][] = [];
    const runs = {
      snapshotFileGrants: (runId: string, paths: readonly string[]) => {
        seen.push([runId, paths]);
        return Promise.resolve(true);
      },
    };
    await recordRunFileGrants(runs, 'run-1', files);
    expect(seen).toEqual([['run-1', ['manuals', 'solo.pdf']]]);
  });

  it('fails the launch when the snapshot is not recorded', async () => {
    const refused = { snapshotFileGrants: () => Promise.resolve(false) };
    await expect(recordRunFileGrants(refused, 'run-1', files)).rejects.toThrow(
      'the run file grants were not recorded',
    );
    await expect(recordRunFileGrants({}, 'run-1', files)).rejects.toThrow();
    await expect(recordRunFileGrants(null, 'run-1', files)).rejects.toThrow();
  });
});
