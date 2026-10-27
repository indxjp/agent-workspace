import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CONTRACTS_VERSION } from '@indx-workspace/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeploymentImages } from './deployment.js';
import { defaultProfile } from './profile-defaults.js';
import { renderProfileDocument, type DeploymentProfile } from './profile.js';
import { renderEnv, type EnvSecrets } from './render/env.js';
import {
  ProbeRefusedError,
  ProjectEnvironmentError,
  StorageSettingsRefusedError,
  describeProbeResults,
  liveProfileProbes,
  runProfileProbes,
  runValidateCommand,
  type ProfileProbes,
} from './validate.js';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true })));
  vi.restoreAllMocks();
});

const localProfile = defaultProfile({
  cloud: 'local',
  projectName: 'acme-ai',
  localObjectStore: 'seaweedfs',
});
const gcpProfile = defaultProfile({ cloud: 'gcp', projectName: 'acme-ai' });
const azureProfile = defaultProfile({ cloud: 'azure', projectName: 'acme-ai' });

const digest = (character: string) => `registry.example/image@sha256:${character.repeat(64)}`;
const images: DeploymentImages = {
  web: digest('1'),
  gateway: digest('2'),
  runner: digest('3'),
  runtime: digest('4'),
  postgres: digest('5'),
  seaweedfs: digest('6'),
};
const secrets: EnvSecrets = {
  adminPassword: 'admin-password',
  postgresPassword: 'pw',
  objectStoreSecretKey: 'object-store-secret',
  masterEncryptionKey: 'a'.repeat(64),
  gatewayTokenSecret: 'b'.repeat(64),
  runnerManagerToken: 'c'.repeat(64),
  sessionSecret: 'd'.repeat(64),
  cronSecret: 'e'.repeat(64),
};

/** Every probe is injected, so nothing in this file opens a socket. */
function recordingProbes(overrides: Partial<ProfileProbes> = {}) {
  const calls: string[] = [];
  const record = (entry: string) => {
    calls.push(entry);
    return Promise.resolve();
  };
  const probes: ProfileProbes = {
    relational: (url) => record(`relational:${url}`),
    // The default double answers for a bucket that is there; `missing` has its own test.
    objects: (input) => record(`objects:${input.bucket}`).then(() => 'present' as const),
    identity: (issuer) => record(`identity:${issuer}`),
    ...overrides,
  };
  return { calls, probes };
}

const outcomes = (results: Awaited<ReturnType<typeof runProfileProbes>>) =>
  Object.fromEntries(results.map(({ store, outcome }) => [store, outcome]));

/**
 * The local profile names `compose-postgres`, so its connection string is a credential the
 * environment carries — exactly as `rds` or `cloud-sql` do. This is what the rendered `.env`
 * holds, and the host it names is one of the Compose services, which is why a test about the
 * probe machinery itself uses the managed URL below instead.
 */
const COMPOSE_DATABASE_URL = 'postgres://agent_workspace:pw@postgres:5432/agent_workspace';

/**
 * A store the host can actually reach. Every test about what a probe does — that it runs, that it
 * is cancellable, that its failure becomes a typed refusal — uses this, because a store on a
 * Compose service is skipped before any probe is reached.
 */
const MANAGED_DATABASE_URL = 'postgres://ops:pw@10.0.0.2:5432/agent_workspace';
const GCS_STORAGE = { AW_STORAGE_URL: 'gcs://acme-ai-files' };
const MANAGED_STORE_ENVIRONMENT = { DATABASE_URL: MANAGED_DATABASE_URL, ...GCS_STORAGE };

describe('level 2: the connectivity probes', () => {
  it('probes a store whose credential is present', async () => {
    const { calls, probes } = recordingProbes();
    const results = await runProfileProbes(gcpProfile, {
      probes,
      environment: {
        ...MANAGED_STORE_ENVIRONMENT,
        GCP_PROJECT: 'acme-project',
      },
    });

    expect(calls).toEqual([`relational:${MANAGED_DATABASE_URL}`, 'objects:acme-ai-files']);
    expect(outcomes(results)).toEqual({
      relational: 'passed',
      objects: 'passed',
      identity: 'skipped',
    });
  });

  /**
   * `validate` never writes, so the object probe heads the bucket and stops there. Its three
   * answers are pinned together, because the distinction between them is the whole point: a
   * bucket that is not there yet is the ordinary first-run case and must not be a refusal, while
   * a store that cannot be reached at all still has to be one.
   */
  describe('the object store, which validate reads and never creates', () => {
    const composeEnvironment = {
      OBJECT_STORAGE_ACCESS_KEY_ID: 'agent_workspace',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: 'object-store-secret',
      AW_STORAGE_URL: 's3://agent-workspace?endpoint=https://s3.example&pathStyle=true',
      AW_STORAGE_CREATE_BUCKET: 'true',
    };
    const objectsResult = async (objects: ProfileProbes['objects'], timeoutMs = 10_000) =>
      (
        await runProfileProbes(localProfile, {
          probes: recordingProbes({ objects }).probes,
          environment: composeEnvironment,
          timeoutMs,
        })
      ).find((result) => result.store === 'objects');

    it('passes a bucket that answers', async () => {
      const result = await objectsResult(() => Promise.resolve('present'));
      expect(result?.outcome).toBe('passed');
      expect(describeProbeResults(result === undefined ? [] : [result])).toBe(
        'passed  objects: bucket agent-workspace answered\n',
      );
    });

    it('reports a bucket that is not there yet without creating it, and without refusing', async () => {
      const result = await objectsResult(() => Promise.resolve('absent'));
      expect(result?.outcome).toBe('missing');
      expect(describeProbeResults(result === undefined ? [] : [result])).toBe(
        'missing  objects: bucket agent-workspace does not exist yet — the platform creates it ' +
          'on first boot\n',
      );
    });

    it('refuses a missing bucket the platform does not create', async () => {
      const refusal = await runProfileProbes(localProfile, {
        probes: recordingProbes({ objects: () => Promise.resolve('absent') }).probes,
        environment: { ...composeEnvironment, AW_STORAGE_CREATE_BUCKET: 'false' },
      }).catch((thrown: unknown) => thrown);
      expect(refusal).toBeInstanceOf(ProbeRefusedError);
      expect((refusal as ProbeRefusedError).message).toContain('operator-owned bucket');
    });

    it('maps an absent native GCS bucket to missing instead of refusing the first run', async () => {
      vi.doMock('@google-cloud/storage', () => ({
        Storage: class {
          bucket() {
            return { exists: () => Promise.resolve([false]) };
          }
        },
      }));
      try {
        const result = await liveProfileProbes(10_000).objects(
          { backend: 'gcs', bucket: 'missing-gcs', projectId: 'test-project' },
          AbortSignal.timeout(10_000),
        );
        expect(result).toBe('absent');
      } finally {
        vi.doUnmock('@google-cloud/storage');
      }
    });

    it('refuses a store that could not be reached at all', async () => {
      const leak = 'AccessDenied: arn:aws:iam::123456789012:user/ops https://s3.example';
      const refusal = await objectsResult(() => Promise.reject(new Error(leak))).catch(
        (thrown: unknown) => thrown,
      );

      expect(refusal).toBeInstanceOf(ProbeRefusedError);
      const error = refusal as ProbeRefusedError;
      expect(error.store).toBe('objects');
      expect(error.message).toBe(
        'agent-workspace.yaml: the objects store did not answer — the bucket could not be reached',
      );
      expect((error.cause as Error).message).toBe(leak);
    });

    it('refuses a probe the run deadline ended', async () => {
      const refusal = await objectsResult(
        (_input, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
        10,
      ).catch((thrown: unknown) => thrown);
      expect(refusal).toBeInstanceOf(ProbeRefusedError);
      expect((refusal as ProbeRefusedError).store).toBe('objects');
    });
  });

  it('skips a store with no credential rather than failing it', async () => {
    const { calls, probes } = recordingProbes();
    // A managed relational store's URL is held by the cloud's secret service. Native GCS uses
    // ADC, so it can still be probed without an HMAC credential in the profile or environment.
    const results = await runProfileProbes(gcpProfile, { probes, environment: GCS_STORAGE });

    expect(calls).toEqual(['objects:acme-ai-files']);
    expect(outcomes(results)).toEqual({
      relational: 'skipped',
      objects: 'passed',
      identity: 'skipped',
    });
    expect(describeProbeResults(results)).toContain('skipped  relational: cloud-sql');
  });

  it('names managed identity, not a missing credential, when this host cannot probe Azure Blob', async () => {
    const { calls, probes } = recordingProbes();
    const results = await runProfileProbes(azureProfile, {
      probes,
      environment: { AW_STORAGE_URL: 'azblob://acme/acme-ai-files' },
    });

    expect(calls).toEqual([]);
    expect(describeProbeResults(results)).toContain(
      'skipped  objects: azblob://acme-ai-files is reached through managed identity, which this host cannot assume',
    );
    expect(describeProbeResults(results)).not.toContain('has no credential to probe with');
  });

  it('takes the managed store connection string from the environment when it is there', async () => {
    const { calls, probes } = recordingProbes();
    await runProfileProbes(gcpProfile, { probes, environment: MANAGED_STORE_ENVIRONMENT });
    expect(calls).toEqual([`relational:${MANAGED_DATABASE_URL}`, 'objects:acme-ai-files']);
  });

  it('probes the issuer whenever the profile names one', async () => {
    const { calls, probes } = recordingProbes();
    await runProfileProbes(
      { ...gcpProfile, identity: { ...gcpProfile.identity, oidc: 'https://id.example' } },
      { probes, environment: MANAGED_STORE_ENVIRONMENT },
    );
    // No credential is needed to read a discovery document, so the issuer is always probed;
    // the connection string the environment carries is one, so the store is probed too.
    expect(calls).toEqual([
      `relational:${MANAGED_DATABASE_URL}`,
      'objects:acme-ai-files',
      'identity:https://id.example',
    ]);
  });

  it('turns a failed probe into a typed refusal that leaks no provider text', async () => {
    const leak =
      'error: password authentication failed for user "agent_workspace" ' +
      'postgres://agent_workspace:s3cr3t@10.0.0.2:5432/agent_workspace';
    const { probes } = recordingProbes({
      relational: () => Promise.reject(new Error(leak)),
    });

    const refusal = await runProfileProbes(gcpProfile, {
      probes,
      environment: MANAGED_STORE_ENVIRONMENT,
    }).catch((thrown: unknown) => thrown);

    expect(refusal).toBeInstanceOf(ProbeRefusedError);
    const error = refusal as ProbeRefusedError;
    expect(error.store).toBe('relational');
    expect(error.message).not.toContain('s3cr3t');
    expect(error.message).not.toContain('password authentication failed');
    expect(error.message).toMatch(/the relational store did not answer/u);
    // The driver's own message is kept for an operator reading a stack trace, never printed.
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe(leak);
  });

  it('honours the caller abort signal and the per-run timeout', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const { probes } = recordingProbes({
      relational: (_url, signal) => {
        seen.push(signal);
        return Promise.resolve();
      },
    });
    const controller = new AbortController();
    await runProfileProbes(gcpProfile, {
      probes,
      environment: MANAGED_STORE_ENVIRONMENT,
      signal: controller.signal,
      timeoutMs: 60_000,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(false);
    controller.abort(new Error('caller gave up'));
    expect(seen[0]?.aborted).toBe(true);
  });

  it('aborts a probe that never answers, without waiting for the caller', async () => {
    const { probes } = recordingProbes({
      relational: (_url, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    });
    await expect(
      runProfileProbes(gcpProfile, {
        probes,
        environment: MANAGED_STORE_ENVIRONMENT,
        timeoutMs: 10,
      }),
    ).rejects.toBeInstanceOf(ProbeRefusedError);
  });
});

describe('agent-workspace validate', () => {
  const projectWith = async (profile: DeploymentProfile) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-validate-'));
    created.push(directory);
    await writeFile(
      path.join(directory, 'agent-workspace.yaml'),
      renderProfileDocument(profile),
      'utf8',
    );
    return directory;
  };

  it('refuses a hand-set COMPOSE_PROJECT_NAME too long to scope the session cookie (#394)', async () => {
    const directory = await projectWith(localProfile);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(
      runValidateCommand([directory], {
        probes: recordingProbes().probes,
        environment: { COMPOSE_PROJECT_NAME: 'x'.repeat(80) },
      }),
    ).rejects.toThrow(/COMPOSE_PROJECT_NAME is 80 characters long/u);
  });

  it('ignores a shell COMPOSE_PROJECT_NAME for a cloud profile, which is no Compose project', async () => {
    const directory = await projectWith(gcpProfile);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    for (const name of ['agent-workspace', 'x'.repeat(80), 'Not A Name']) {
      await expect(
        runValidateCommand([directory], {
          probes: recordingProbes().probes,
          environment: { COMPOSE_PROJECT_NAME: name },
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('runs level 1 on the written profile and reports each store', async () => {
    const directory = await projectWith(localProfile);
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    await runValidateCommand([directory], { probes: recordingProbes().probes, environment: {} });

    expect(written.join('')).toContain('agent-workspace.yaml is valid for cloud local');
    expect(written.join('')).toContain('skipped  identity:');
  });

  // The generator writes `.env` beside `agent-workspace.yaml`, so a caller that supplies no
  // environment must still reach level 2: with an empty one the object store has no credential
  // and could never be probed through the shipped command.
  it('reads the project .env when the caller supplies no environment', async () => {
    const directory = await projectWith(gcpProfile);
    const managed = 'postgres://ops:pw@10.0.0.2:5432/agent_workspace';
    await writeFile(
      path.join(directory, '.env'),
      `${renderEnv({ profile: gcpProfile, secrets, images, dockerGroupId: 999, projectName: 'acme-ai' })}` +
        `DATABASE_URL=${managed}\nGCP_PROJECT=acme-project\n`,
      'utf8',
    );
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const { calls, probes } = recordingProbes();

    await runValidateCommand([directory], { probes });

    // Nothing but the file could have supplied either value: the profile names the stores and
    // holds neither the managed store's URL nor the bucket's credential.
    expect(calls).toEqual([`relational:${managed}`, 'objects:acme-ai-files']);
    expect(written.join('')).toContain('passed  objects:');
    expect(written.join('')).toContain('passed  relational:');
  });

  /**
   * The regression this pins: `validate` used to probe `postgres` and the object store from the host,
   * which `templates/compose.yaml` makes unreachable by putting both on an `internal: true`
   * network with no published port. The command could therefore never pass on the project the
   * generator had just written — it refused a deployment that was not broken.
   */
  it('resolves on a generated local project instead of probing what the host cannot reach', async () => {
    const directory = await projectWith(localProfile);
    await writeFile(
      path.join(directory, '.env'),
      renderEnv({
        profile: localProfile,
        secrets,
        images,
        dockerGroupId: 999,
        projectName: 'acme-ai',
      }),
      'utf8',
    );
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    // Every probe refuses, so a run that reaches one cannot resolve.
    const unreachable = () => Promise.reject(new Error('getaddrinfo ENOTFOUND postgres'));
    const probes: ProfileProbes = {
      relational: unreachable,
      objects: unreachable,
      identity: unreachable,
    };

    await expect(runValidateCommand([directory], { probes })).resolves.toBeUndefined();

    expect(written.join('')).toContain('agent-workspace.yaml is valid for cloud local');
    expect(written.join('')).toContain('skipped  relational: postgres is on the Compose');
    expect(written.join('')).toContain('skipped  objects: seaweedfs is on the Compose');
  });

  // An operator who edited `.env` by hand needs the file named. The parser quotes the offending
  // line, which is a value they keep secret, so that message stays in `cause`.
  it('names the file when the project .env cannot be read as an environment', async () => {
    const directory = await projectWith(localProfile);
    await writeFile(path.join(directory, '.env'), 'DATABASE_URL=postgres://x\nnot an assignment\n');
    const { calls, probes } = recordingProbes();

    const refusal = await runValidateCommand([directory], { probes }).catch(
      (thrown: unknown) => thrown,
    );

    expect(refusal).toBeInstanceOf(ProjectEnvironmentError);
    const error = refusal as ProjectEnvironmentError;
    expect(error.message).toContain(path.join(directory, '.env'));
    expect(error.message).not.toContain('not an assignment');
    expect((error.cause as Error).message).toContain('not an assignment');
    expect(calls).toEqual([]);
  });

  it('refuses an invalid profile before any probe runs', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-validate-'));
    created.push(directory);
    await writeFile(
      path.join(directory, 'agent-workspace.yaml'),
      'cloud: gcp\nstorage:\n  relational: cloud-sql\n  objects: azblob://acme\n  secrets: local-key\nruntime:\n  default: docker\nidentity:\n  bootstrapAdmin: ops@acme.example\n',
      'utf8',
    );
    const { calls, probes } = recordingProbes();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(runValidateCommand([directory], { probes, environment: {} })).rejects.toThrow(
      /^agent-workspace\.yaml line 4, column 3: storage\.objects/u,
    );
    expect(calls).toEqual([]);
  });

  it('reads a profile written before apiVersion, and says on stderr how to add it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-validate-'));
    created.push(directory);
    const legacy = renderProfileDocument(localProfile).replace(
      'apiVersion: agentworkspace.dev/v1\nkind: Deployment\n',
      '',
    );
    expect(legacy).not.toContain('apiVersion');
    await writeFile(path.join(directory, 'agent-workspace.yaml'), legacy, 'utf8');
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });

    await runValidateCommand([directory], { probes: recordingProbes().probes, environment: {} });

    expect(out.join('')).toContain('agent-workspace.yaml is valid for cloud local');
    expect(err.join('')).toContain('agent-workspace.yaml has no apiVersion');
    expect(err.join('')).toContain('  apiVersion: agentworkspace.dev/v1\n  kind: Deployment\n');
  });

  it('refuses an unknown kind by line, and a duplicate key, before any probe runs', async () => {
    const generated = renderProfileDocument(localProfile);
    for (const [text, expected] of [
      [
        generated.replace('kind: Deployment', 'kind: Workspace'),
        /^agent-workspace\.yaml line 6, column 1: kind must be Deployment/u,
      ],
      [
        `${generated}cloud: aws\n`,
        /^agent-workspace\.yaml line 16, column 1: duplicate key "cloud"/u,
      ],
    ] as const) {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-validate-'));
      created.push(directory);
      await writeFile(path.join(directory, 'agent-workspace.yaml'), text, 'utf8');
      const { calls, probes } = recordingProbes();

      await expect(runValidateCommand([directory], { probes, environment: {} })).rejects.toThrow(
        expected,
      );
      expect(calls).toEqual([]);
    }
  });

  describe('contracts version check', () => {
    const okProbes = () => recordingProbes().probes;
    const responding =
      (headers: Record<string, string>): typeof fetch =>
      () =>
        Promise.resolve(new Response(null, { status: 401, headers }));

    it('refuses a server outside the supported range, naming both versions and the fix', async () => {
      const directory = await projectWith(localProfile);
      vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const fetch = responding({
        'x-agent-workspace-contracts': '99.1.0',
        'x-agent-workspace-contracts-minimum': '99.0.0',
      });

      await expect(
        runValidateCommand([directory], {
          probes: okProbes(),
          environment: { AGENT_WORKSPACE_URL: 'https://aw.example' },
          fetch,
        }),
      ).rejects.toThrow(
        new RegExp(
          `contracts ${CONTRACTS_VERSION.replaceAll('.', '\\.')}.*99\\.0\\.0 to 99\\.1\\.0.*@indx-workspace/cli@99\\.1`,
          'u',
        ),
      );
    });

    it('passes a server in range, and asks nothing when no URL is known', async () => {
      const directory = await projectWith(localProfile);
      vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const fetch = vi.fn(
        responding({
          'x-agent-workspace-contracts': CONTRACTS_VERSION,
          'x-agent-workspace-contracts-minimum': CONTRACTS_VERSION,
        }),
      );

      await runValidateCommand([directory], {
        probes: okProbes(),
        environment: { AGENT_WORKSPACE_URL: 'https://aw.example' },
        fetch,
      });
      await runValidateCommand([directory], { probes: okProbes(), environment: {}, fetch });

      expect(fetch).toHaveBeenCalledOnce();
      expect(err).not.toHaveBeenCalled();
    });

    it('warns and passes when the server is unreachable', async () => {
      const directory = await projectWith(localProfile);
      vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const fetch = (() =>
        Promise.reject(new TypeError('fetch failed'))) as typeof globalThis.fetch;

      await runValidateCommand([directory], {
        probes: okProbes(),
        environment: { AGENT_WORKSPACE_URL: 'https://aw.example' },
        fetch,
      });

      expect(err).toHaveBeenCalledWith(expect.stringContaining('could not check'));
    });

    it('bounds the contracts probe by the same timeoutMs as the store probes', async () => {
      const directory = await projectWith(localProfile);
      vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      // A server that never answers: only the abort signal ends the request.
      const fetch = ((_url: URL, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation timed out.', 'TimeoutError'));
          });
        })) as typeof globalThis.fetch;

      const started = Date.now();
      await runValidateCommand([directory], {
        probes: okProbes(),
        environment: { AGENT_WORKSPACE_URL: 'https://aw.example' },
        fetch,
        timeoutMs: 50,
      });

      expect(Date.now() - started).toBeLessThan(4000);
      expect(err).toHaveBeenCalledWith(expect.stringContaining('(TimeoutError)'));
    });
  });
});

describe('a store on the Compose project internal network', () => {
  const composeEnvironment = {
    DATABASE_URL: COMPOSE_DATABASE_URL,
    OBJECT_STORAGE_ACCESS_KEY_ID: 'agent_workspace',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'object-store-secret',
    AW_STORAGE_URL: 's3://agent-workspace?endpoint=http://seaweedfs:8333&pathStyle=true',
  };

  /**
   * `templates/compose.yaml` puts `postgres` and `seaweedfs` on `control`, which is `internal: true`
   * and publishes no host port, so the host can never reach either hostname — started or not.
   * The skip therefore belongs to the store and not to the caller: gating it on the caller is
   * what made `agent-workspace validate <project>` unable to pass on a `--cloud local` project.
   */
  it('reports each store instead of probing it, whoever the caller is', async () => {
    const { calls, probes } = recordingProbes();
    const results = await runProfileProbes(localProfile, {
      probes,
      environment: composeEnvironment,
    });

    expect(calls).toEqual([]);
    expect(outcomes(results)).toEqual({
      relational: 'skipped',
      objects: 'skipped',
      identity: 'skipped',
    });
    expect(describeProbeResults(results)).toContain(
      "skipped  relational: postgres is on the Compose project's internal network, which " +
        'publishes no host port — check it from inside the project with `docker compose exec ' +
        'postgres pg_isready -U agent_workspace`',
    );
    expect(describeProbeResults(results)).toContain(
      "skipped  objects: seaweedfs is on the Compose project's internal network, which " +
        'publishes no host port — check it from inside the project with `docker compose exec ' +
        'seaweedfs wget -q -O /dev/null http://127.0.0.1:8333/healthz`',
    );
  });

  // A project generated before ADR-0067 keeps its own MinIO-era compose.yaml and `.env`, so its
  // object store is still the `minio` service on the same internal network.
  it('still reports the bundled store of a project generated before the SeaweedFS switch', async () => {
    const { calls, probes } = recordingProbes();
    const results = await runProfileProbes(localProfile, {
      probes,
      environment: {
        ...composeEnvironment,
        AW_STORAGE_URL: 's3://agent-workspace?endpoint=http://minio:9000&pathStyle=true',
      },
    });

    expect(calls).toEqual([]);
    expect(describeProbeResults(results)).toContain(
      "skipped  objects: minio is on the Compose project's internal network, which publishes " +
        'no host port — check it from inside the project with `docker compose exec minio curl ' +
        '-fsS http://127.0.0.1:9000/minio/health/live`',
    );
  });

  it('still probes a store that is not one of those services', async () => {
    const managed = 'postgres://user:pw@10.0.0.2:5432/agent_workspace';
    const { calls, probes } = recordingProbes();
    await runProfileProbes(gcpProfile, {
      probes,
      environment: { DATABASE_URL: managed, ...GCS_STORAGE },
    });
    expect(calls).toEqual([`relational:${managed}`, 'objects:acme-ai-files']);
  });
});

/**
 * The only tests here that open a socket. They open it against a local server that accepts a
 * connection and then says nothing, which is the case a probe has to survive: without
 * cancellation the CLI would wait on it for as long as the driver's own default allows.
 */
describe('the live probes honour the run deadline', () => {
  it('abandons a relational probe that never answers, and releases its pool', async () => {
    const server = createServer();
    const accepted = new Promise<Socket>((resolve) => {
      server.once('connection', (socket) => {
        // Accept the driver's startup packet and answer nothing. Draining is what lets this side
        // notice the close; a paused socket with unread bytes never reports one.
        socket.resume();
        resolve(socket);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP port');

    const controller = new AbortController();
    // The pool's own bound is far away, so the signal is demonstrably what ends the wait.
    const probe = liveProfileProbes(30_000).relational(
      `postgres://agent_workspace:pw@127.0.0.1:${address.port}/agent_workspace`,
      controller.signal,
    );

    try {
      const socket = await accepted;
      controller.abort(new Error('the run deadline passed'));
      await expect(probe).rejects.toThrow(/the run deadline passed/u);
      // The probe returned, and the socket it opened does not outlive it.
      await new Promise<void>((resolve) => {
        if (socket.destroyed) {
          resolve();
          return;
        }
        socket.once('close', () => resolve());
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it('carries the run signal into every object-store request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('the run deadline passed'));
    await expect(
      liveProfileProbes(250).objects(
        {
          backend: 's3',
          bucket: 'agent-workspace',
          region: 'us-east-1',
          // Port 1 is never listening; the aborted signal is what must end this, not a timeout.
          endpoint: 'http://127.0.0.1:1',
          accessKeyId: 'agent_workspace',
          secretAccessKey: 'object-store-secret',
          forcePathStyle: true,
        },
        controller.signal,
      ),
      // Pinned to the abort, not to any rejection: port 1 refuses the connection on its own, so a
      // bare assertion would stay green if `abortSignal: signal` were dropped from the request.
    ).rejects.toThrow(/Request aborted/u);
  }, 10_000);
});

// @story US-STO-10
describe('validate reads AW_STORAGE_URL with the server resolver', () => {
  const credentials = {
    OBJECT_STORAGE_ACCESS_KEY_ID: 'agent_workspace',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'object-store-secret',
  };

  const validateIn = async (environment: Record<string, string>) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-validate-'));
    created.push(directory);
    await writeFile(
      path.join(directory, 'agent-workspace.yaml'),
      renderProfileDocument(gcpProfile),
      'utf8',
    );
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const inputs: unknown[] = [];
    const { probes } = recordingProbes({
      objects: (input) => {
        inputs.push(input);
        return Promise.resolve('present');
      },
    });
    const outcome = await runValidateCommand([directory], { probes, environment }).catch(
      (thrown: unknown) => thrown,
    );
    return { inputs, outcome, output: written.join('') };
  };

  it('[US-STO-10][api][cli] validate probes the bucket AW_STORAGE_URL names', async () => {
    const { inputs, outcome } = await validateIn({
      ...credentials,
      AW_STORAGE_URL: 's3://url-bucket?endpoint=https://objects.example&region=eu-west-1',
    });

    expect(outcome).toBeUndefined();
    expect(inputs).toEqual([
      {
        backend: 's3',
        bucket: 'url-bucket',
        region: 'eu-west-1',
        endpoint: 'https://objects.example',
        forcePathStyle: false,
        accessKeyId: 'agent_workspace',
        secretAccessKey: 'object-store-secret',
      },
    ]);
  });

  it('[US-STO-10][api][cli] validate never probes a bucket the old variables name, and says why', async () => {
    const { inputs, outcome, output } = await validateIn({
      ...credentials,
      OBJECT_STORAGE_BUCKET: 'old-bucket',
      OBJECT_STORAGE_ENDPOINT: 'https://objects.example',
      OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
    });

    expect(outcome).toBeUndefined();
    expect(inputs).toEqual([]);
    expect(output).toContain(
      'skipped  objects: AW_STORAGE_URL is not configured, so there is no bucket to probe',
    );
  });

  it('[US-STO-10][api][cli] validate ignores a legacy variable beside AW_STORAGE_URL', async () => {
    const { inputs, outcome } = await validateIn({
      AW_STORAGE_URL: 'file:///var/lib/agent-workspace',
      AW_FILE_STORAGE_ROOT: '/elsewhere/files',
    });

    expect(outcome).toBeUndefined();
    expect(inputs).toEqual([]);
  });

  it('[US-STO-10][api][cli] validate refuses an endpoint on the app origin, as the server does', async () => {
    const { outcome } = await validateIn({
      ...credentials,
      AW_PUBLIC_URL: 'https://app.example',
      AW_STORAGE_URL: 's3://url-bucket?endpoint=https://app.example',
    });

    expect(outcome).toBeInstanceOf(StorageSettingsRefusedError);
    expect((outcome as Error).message).toContain('storage_endpoint_same_origin');
  });

  it('[US-STO-10][api][cli] validate refuses a malformed AW_STORAGE_CREATE_BUCKET as start-up does', async () => {
    const { inputs, outcome, output } = await validateIn({
      ...credentials,
      AW_STORAGE_URL: 's3://url-bucket',
      AW_STORAGE_CREATE_BUCKET: 'yes-secret-value',
    });

    expect(outcome).toBeInstanceOf(StorageSettingsRefusedError);
    expect((outcome as Error).message).toBe(
      'the storage setting is refused — AW_STORAGE_CREATE_BUCKET must be true or false.',
    );
    expect(inputs).toEqual([]);
    expect(output).not.toContain('yes-secret-value');
  });

  it('[US-STO-10][api][cli] validate never prints a credential-shaped AW_STORAGE_URL', async () => {
    const generated = randomBytes(12).toString('hex');
    const { outcome, output } = await validateIn({
      AW_STORAGE_URL: `s3://url-bucket?X-Amz-Credential=${generated}`,
    });

    expect(outcome).toBeInstanceOf(StorageSettingsRefusedError);
    expect((outcome as Error).message).toMatch(
      /^the storage setting is refused — AW_STORAGE_URL is invalid/u,
    );
    expect((outcome as Error).message).not.toContain(generated);
    expect(output).not.toContain(generated);
  });
});
