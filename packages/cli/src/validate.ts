/**
 * Level 2 of "validated": the connectivity probes.
 *
 * Level 1 — the schema, the accepted schemes, the cross-field rules — runs on every path that
 * touches a profile and needs neither network nor credential (`profile.ts`). Level 2 runs only
 * when an operator asks for it, and then only against a store whose credential is actually
 * present: making `create` require a live account would contradict the generator being the
 * first-run path. Nothing here runs during `pnpm test` — every probe is injected, and the suite
 * injects doubles.
 *
 * A probe failure is a typed refusal naming the store. The driver's own message is kept as the
 * error's `cause` for an operator reading a stack trace, and never becomes the text the CLI
 * prints: a PostgreSQL or S3 error routinely quotes the connection string it was given.
 *
 * Nothing here writes. Every probe is a read — `select 1`, a bucket head, a discovery fetch — so
 * `validate` cannot change the account it is pointed at, and a store the deployment has not
 * created yet is reported rather than created.
 */
import { readFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import path from 'node:path';

import {
  configuredPath,
  resolveStorageSettings,
  STORAGE_URL_ENV,
} from '@indx-workspace/contracts/storage-settings';

import { assertServerServesContracts } from './contracts-skew.ts';
import { assertComposeProjectName, parseEnvironment } from './deployment.ts';
import { parseProfileDocument, type DeploymentProfile } from './profile.ts';

export type ProbeStore = 'relational' | 'objects' | 'identity';

/**
 * `missing` is the object store's alone: the bucket answered 404. That is not a refusal when
 * `AW_STORAGE_CREATE_BUCKET=true`, because the platform then creates the bucket on first boot — but
 * it is not a pass either. Any other missing bucket is operator-owned and refuses validation.
 */
type ProbeOutcome = 'passed' | 'missing' | 'skipped';

export interface ProbeResult {
  readonly store: ProbeStore;
  readonly outcome: ProbeOutcome;
  /** What the probe proved, or why it could not run. Never carries provider text. */
  readonly detail: string;
}

/** A store the profile names that did not answer. Its `cause` holds the driver's own failure. */
export class ProbeRefusedError extends Error {
  readonly store: ProbeStore;

  constructor(store: ProbeStore, detail: string, cause: unknown) {
    super(`agent-workspace.yaml: the ${store} store did not answer — ${detail}`, { cause });
    this.name = 'ProbeRefusedError';
    this.store = store;
  }
}

/** The object store answered, but the operator-owned bucket it names is not there. */
export class BucketAbsentError extends ProbeRefusedError {
  constructor() {
    super(
      'objects',
      'the operator-owned bucket does not exist',
      new Error('object-store probe returned absent'),
    );
    this.name = 'BucketAbsentError';
  }
}

interface S3ObjectStoreProbeInput {
  readonly backend: 's3';
  readonly bucket: string;
  readonly region: string;
  readonly endpoint?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

interface GcsObjectStoreProbeInput {
  readonly backend: 'gcs';
  readonly bucket: string;
  readonly projectId?: string;
}

export type ObjectStoreProbeInput = S3ObjectStoreProbeInput | GcsObjectStoreProbeInput;

/** Whether the bucket the profile names is already there. `validate` never creates it. */
export type ObjectStorePresence = 'present' | 'absent';

/**
 * Storage settings the server would refuse to start with: the URL and the old variables name
 * different places, or the endpoint is on the app's origin. The reason names variables, never values.
 */
export class StorageSettingsRefusedError extends Error {
  constructor(reason: string) {
    super(`the storage setting is refused — ${reason}`);
    this.name = 'StorageSettingsRefusedError';
  }
}

/**
 * `AW_STORAGE_CREATE_BUCKET`, read as the server reads it at start-up for an `s3://` URL: unset,
 * blank or `false` is `false`, `true` is `true`, and anything else is refused. The message names
 * the variable and never echoes the value.
 */
function createsBucket(environment: Readonly<Record<string, string | undefined>>): boolean {
  const raw = configuredPath('AW_STORAGE_CREATE_BUCKET', environment);
  if (raw === null || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new StorageSettingsRefusedError('AW_STORAGE_CREATE_BUCKET must be true or false.');
}

/** The three I/O seams, injected so the suite proves the decisions without touching a network. */
export interface ProfileProbes {
  readonly relational: (url: string, signal: AbortSignal) => Promise<void>;
  /** Resolves with what the bucket answered; rejects only when the store could not be reached. */
  readonly objects: (
    input: ObjectStoreProbeInput,
    signal: AbortSignal,
  ) => Promise<ObjectStorePresence>;
  readonly identity: (issuer: string, signal: AbortSignal) => Promise<void>;
}

/**
 * The signal's reason as an `Error`. `AbortSignal.timeout` raises a `TimeoutError` and a caller
 * normally aborts with an `Error` too, but a caller may abort with anything, and this becomes a
 * refusal's `cause` — which has to be readable.
 */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('the probe was aborted');
}

/** Rejects with the signal's reason, so a probe ends when the run's deadline does. */
function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abandon = () => reject(abortReason(signal));
    if (signal.aborted) {
      abandon();
      return;
    }
    signal.addEventListener('abort', abandon, { once: true });
  });
}

/**
 * `select 1` against the store, on a pool this probe owns.
 *
 * The pool is the probe's own rather than `openDatabaseRoot`'s because a probe must be
 * cancellable, and `pg` offers no way to cancel a connection it is still negotiating: `max: 1`
 * and `connectionTimeoutMillis` bound what it may hold, the race against the signal is what ends
 * the wait, and the socket the probe hands the driver is the one it closes itself. A host that
 * accepts a connection and then says nothing is the case that makes all three necessary.
 *
 * `end()` is deliberately not awaited: the sockets are already gone by then, and the caller's
 * refusal must not queue behind the pool's own teardown.
 */
async function probeRelational(
  url: string,
  signal: AbortSignal,
  connectionTimeoutMillis: number,
): Promise<void> {
  const { default: pg } = await import('pg');
  const sockets = new Set<Socket>();
  const pool = new pg.Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis,
    stream: () => {
      const socket = new Socket();
      sockets.add(socket);
      return socket;
    },
  });
  // A pool whose client fails after the probe has already reported becomes an uncaught exception
  // without a listener. The failure the operator needs is the one the race below raises.
  pool.on('error', () => undefined);
  try {
    await Promise.race([pool.query('select 1'), rejectWhenAborted(signal)]);
  } finally {
    for (const socket of sockets) socket.destroy();
    void pool.end();
  }
}

/** S3 answers a missing bucket with 404; anything else is a real failure to report. */
function isMissingBucket(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return value.name === 'NotFound' || value.$metadata?.httpStatusCode === 404;
}

/**
 * `load()`, the `import()` of the optional peer `name`, refused with the line that installs it when
 * the project has not: the bucket clients are peers so a project that never probes a bucket does
 * not download them.
 */
async function importOptionalPeer<T>(name: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' && String(error).includes(`'${name}'`)) {
      throw new Error(`${name} is not installed; run: npm install -D ${name}`, { cause: error });
    }
    throw error;
  }
}

/**
 * Whether a native GCS bucket exists, asked with the deployment's own Application Default
 * Credentials. The same question `createGcsObjectStoreProviderFromConfig` in `packages/core` asks
 * at readiness, asked here directly because the published CLI must not import that private
 * package (ADR-0082's amendment for #364). Like the S3 path it never creates the bucket.
 */
async function probeGcsBucket(
  input: GcsObjectStoreProbeInput,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ObjectStorePresence> {
  const { Storage } = await importOptionalPeer(
    '@google-cloud/storage',
    () => import('@google-cloud/storage'),
  );
  const storage = new Storage({
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    retryOptions: { totalTimeout: Math.max(1, timeoutMs / 1_000) },
  });
  const [exists] = await Promise.race([
    storage.bucket(input.bucket).exists(),
    rejectWhenAborted(signal),
  ]);
  return exists ? 'present' : 'absent';
}

/**
 * Head the bucket, on a client this probe owns so that every request carries the run's
 * `AbortSignal`.
 *
 * **`validate` never writes.** Creating the bucket here would make a read-only command mutate the
 * account it was pointed at, and would hide the mistake it most needs to surface: a mistyped
 * bucket name would be silently created rather than reported. A 404 is therefore an answer, not a
 * failure for the platform-owned bundled-store path. Native buckets must already exist.
 */
async function probeObjects(
  input: ObjectStoreProbeInput,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ObjectStorePresence> {
  if (input.backend === 'gcs') return probeGcsBucket(input, signal, timeoutMs);

  const { HeadBucketCommand, S3Client } = await importOptionalPeer(
    '@aws-sdk/client-s3',
    () => import('@aws-sdk/client-s3'),
  );
  const client = new S3Client({
    region: input.region,
    forcePathStyle: input.forcePathStyle,
    credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
    ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: input.bucket }), { abortSignal: signal });
    return 'present';
  } catch (error) {
    if (!isMissingBucket(error)) throw error;
    return 'absent';
  } finally {
    client.destroy();
  }
}

/**
 * The listing seam of doctor's storage-layout check: how many objects sit under `prefix`, at most
 * `cap`. It lives here because this is the one file the CLI may import the bucket clients in (the
 * storage design, §07 rule 1).
 */
export interface LegacyObjectCounter {
  readonly bucket: (
    input: ObjectStoreProbeInput,
    prefix: string,
    cap: number,
    signal: AbortSignal,
  ) => Promise<number>;
}

const PAGE_SIZE = 1_000;

async function countS3(
  input: Extract<ObjectStoreProbeInput, { backend: 's3' }>,
  prefix: string,
  cap: number,
  signal: AbortSignal,
): Promise<number> {
  const { ListObjectsV2Command, S3Client } = await importOptionalPeer(
    '@aws-sdk/client-s3',
    () => import('@aws-sdk/client-s3'),
  );
  const client = new S3Client({
    region: input.region,
    forcePathStyle: input.forcePathStyle,
    credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
    ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
  });
  try {
    let counted = 0;
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: input.bucket,
          Prefix: prefix,
          MaxKeys: Math.min(PAGE_SIZE, cap - counted),
          ContinuationToken: token,
        }),
        { abortSignal: signal },
      );
      counted += page.KeyCount ?? 0;
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined && counted < cap);
    return Math.min(counted, cap);
  } finally {
    client.destroy();
  }
}

async function countGcs(
  input: Extract<ObjectStoreProbeInput, { backend: 'gcs' }>,
  prefix: string,
  cap: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<number> {
  const { Storage } = await importOptionalPeer(
    '@google-cloud/storage',
    () => import('@google-cloud/storage'),
  );
  const bucket = new Storage({
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    retryOptions: { totalTimeout: Math.max(1, timeoutMs / 1_000) },
  }).bucket(input.bucket);
  let counted = 0;
  let pageToken: string | undefined;
  do {
    signal.throwIfAborted();
    const [files, next] = await Promise.race([
      bucket.getFiles({
        prefix,
        autoPaginate: false,
        maxResults: Math.min(PAGE_SIZE, cap - counted),
        ...(pageToken === undefined ? {} : { pageToken }),
      }),
      rejectWhenAborted(signal),
    ]);
    counted += files.length;
    const token: unknown = (next as { pageToken?: unknown } | null | undefined)?.pageToken;
    pageToken = typeof token === 'string' ? token : undefined;
  } while (pageToken !== undefined && counted < cap);
  return Math.min(counted, cap);
}

export function liveLegacyObjectCounter(timeoutMs: number): LegacyObjectCounter {
  return {
    bucket: (input, prefix, cap, signal) =>
      input.backend === 's3'
        ? countS3(input, prefix, cap, signal)
        : countGcs(input, prefix, cap, signal, timeoutMs),
  };
}

async function probeIdentity(issuer: string, signal: AbortSignal): Promise<void> {
  const discovery = `${issuer.replace(/\/+$/u, '')}/.well-known/openid-configuration`;
  const response = await fetch(discovery, { signal, redirect: 'follow' });
  if (!response.ok) throw new Error(`discovery document answered ${response.status}`);
  const document: unknown = await response.json();
  if (typeof document !== 'object' || document === null || !('issuer' in document)) {
    throw new Error('discovery document has no issuer field');
  }
}

/**
 * The probes that reach real services, bounded by the same deadline the run is bounded by: the
 * relational pool cannot spend longer than `timeoutMs` connecting, and every S3 request carries
 * the run's signal.
 */
export function liveProfileProbes(timeoutMs: number): ProfileProbes {
  return {
    relational: async (url, signal) => probeRelational(url, signal, timeoutMs),
    objects: async (input, signal) => probeObjects(input, signal, timeoutMs),
    identity: probeIdentity,
  };
}

/** How long a probe waits for a store that has not been told to hurry. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export interface RunProfileProbesOptions {
  readonly probes?: ProfileProbes;
  /** Where a credential the profile deliberately does not hold is read from. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** The `fetch` the contracts-version check uses; tests stub it. */
  readonly fetch?: typeof fetch;
}

function skipped(store: ProbeStore, detail: string): ProbeResult {
  return { store, outcome: 'skipped', detail };
}

function passed(store: ProbeStore, detail: string): ProbeResult {
  return { store, outcome: 'passed', detail };
}

async function attempt(
  store: ProbeStore,
  detail: string,
  run: () => Promise<void>,
): Promise<ProbeResult> {
  try {
    await run();
  } catch (cause) {
    throw new ProbeRefusedError(store, detail, cause);
  }
  return passed(store, detail);
}

/**
 * The object store's three answers. A bucket that is not there is its own outcome rather than a
 * pass, so a mistyped name in `storage.objects` is visible in the output. This non-refusal applies
 * only to the ordinary first-run case where the platform owns the bundled store's bucket.
 */
async function attemptObjects(
  bucket: string,
  platformOwnsBucket: boolean,
  run: () => Promise<ObjectStorePresence>,
): Promise<ProbeResult> {
  let presence: ObjectStorePresence;
  try {
    presence = await run();
  } catch (cause) {
    throw new ProbeRefusedError('objects', 'the bucket could not be reached', cause);
  }
  if (presence === 'present') return passed('objects', `bucket ${bucket} answered`);
  if (!platformOwnsBucket) throw new BucketAbsentError();
  return {
    store: 'objects',
    outcome: 'missing',
    detail: `bucket ${bucket} does not exist yet — the platform creates it on first boot`,
  };
}

function relationalTarget(
  profile: DeploymentProfile,
  environment: Readonly<Record<string, string | undefined>>,
): string | null {
  if (profile.storage.relational.includes('://')) return profile.storage.relational;
  // A managed store's URL is a credential, so the profile never holds it; the deployment's
  // environment does, which is what the rendered `.env` and the cloud's secret service carry.
  const fromEnvironment = environment['DATABASE_URL'];
  return fromEnvironment === undefined || fromEnvironment.trim() === '' ? null : fromEnvironment;
}

/**
 * The bucket to probe: the one `AW_STORAGE_URL` names, read by the resolver the server starts up
 * with, or `null`. The old variables and the profile's `storage.objects` never name one, because
 * the server reads nothing from them.
 */
// @story US-STO-10
export function objectStoreTarget(
  environment: Readonly<Record<string, string | undefined>>,
): ObjectStoreProbeInput | null {
  const settings = resolveStorageSettings(environment);
  if (settings.kind !== 'url') return null;
  const { location } = settings;
  if (location.kind === 'gcs') {
    const projectId = location.projectId ?? environment['GCP_PROJECT']?.trim();
    return {
      backend: 'gcs',
      bucket: location.bucket,
      ...(projectId === undefined || projectId === '' ? {} : { projectId }),
    };
  }
  if (location.kind !== 's3') return null;
  const accessKeyId = environment['OBJECT_STORAGE_ACCESS_KEY_ID'] ?? '';
  const secretAccessKey = environment['OBJECT_STORAGE_SECRET_ACCESS_KEY'] ?? '';
  if (accessKeyId.trim() === '' || secretAccessKey.trim() === '') return null;
  return {
    backend: 's3',
    bucket: location.bucket,
    region: location.region ?? 'us-east-1',
    accessKeyId,
    secretAccessKey,
    forcePathStyle: location.forcePathStyle,
    ...(location.endpoint === undefined ? {} : { endpoint: location.endpoint }),
  };
}

/**
 * The Compose services `templates/compose.yaml` puts on the `control` network, and the command
 * that does reach each one.
 *
 * Whether these answer is not a question the host can ask. `control` is `internal: true` and
 * neither service publishes a host port — `web` is the only service with a `ports:` entry — so
 * these hostnames resolve inside the project and nowhere else, started or not. The skip is
 * therefore a property of the store rather than of the caller: probing a store placed here could
 * only ever produce a refusal that reports the deployment broken when it is not, which is what
 * made `agent-workspace validate <project>` unable to pass on a `--cloud local` project at all.
 *
 * `minio` stays for projects generated before ADR-0067 made the bundled store SeaweedFS: such a
 * project keeps its own MinIO-era `compose.yaml`, and validating it must not turn into a refusal.
 */
const GENERATED_COMPOSE_SERVICES = new Map<string, string>([
  ['postgres', 'docker compose exec postgres pg_isready -U agent_workspace'],
  ['seaweedfs', 'docker compose exec seaweedfs wget -q -O /dev/null http://127.0.0.1:8333/healthz'],
  ['minio', 'docker compose exec minio curl -fsS http://127.0.0.1:9000/minio/health/live'],
]);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** The skip a store on one of those services gets, naming the command that reaches it. */
function composeServiceSkip(store: ProbeStore, url: string): ProbeResult | null {
  const host = hostOf(url);
  const reach = host === null ? undefined : GENERATED_COMPOSE_SERVICES.get(host);
  if (host === null || reach === undefined) return null;
  return skipped(
    store,
    `${host} is on the Compose project's internal network, which publishes no host port — ` +
      `check it from inside the project with \`${reach}\``,
  );
}

/**
 * Probe every store the profile names and a credential exists for.
 *
 * The caller's signal and the per-run timeout are combined, so a caller that aborts is honoured
 * immediately and a store that never answers still ends.
 */
export async function runProfileProbes(
  profile: DeploymentProfile,
  options: RunProfileProbesOptions = {},
): Promise<readonly ProbeResult[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probes = options.probes ?? liveProfileProbes(timeoutMs);
  const environment = options.environment ?? {};
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);

  const results: ProbeResult[] = [];

  const relational = relationalTarget(profile, environment);
  if (relational === null) {
    results.push(
      skipped('relational', `${profile.storage.relational} has no connection string to probe`),
    );
  } else {
    results.push(
      composeServiceSkip('relational', relational) ??
        (await attempt('relational', 'the connection was refused or timed out', () =>
          probes.relational(relational, signal),
        )),
    );
  }

  const objects = objectStoreTarget(environment);
  if (objects === null) {
    results.push(
      skipped(
        'objects',
        resolveStorageSettings(environment).kind !== 'url'
          ? `${STORAGE_URL_ENV} is not configured, so there is no bucket to probe`
          : profile.storage.objects.startsWith('azblob://')
            ? `${profile.storage.objects} is reached through managed identity, which this host cannot assume`
            : `${profile.storage.objects} has no credential to probe with`,
      ),
    );
  } else {
    // The server creates the bucket on first boot only when this says so.
    const platformOwnsBucket = objects.backend === 's3' && createsBucket(environment);
    results.push(
      composeServiceSkip('objects', objects.backend === 's3' ? (objects.endpoint ?? '') : '') ??
        (await attemptObjects(objects.bucket, platformOwnsBucket, () =>
          probes.objects(objects, signal),
        )),
    );
  }

  const issuer = profile.identity.oidc;
  results.push(
    issuer === undefined
      ? skipped('identity', 'the profile names no OIDC issuer')
      : await attempt('identity', 'the discovery document could not be read', () =>
          probes.identity(issuer, signal),
        ),
  );

  return results;
}

/** One line per store, for the CLI. */
export function describeProbeResults(results: readonly ProbeResult[]): string {
  return results.map(({ store, outcome, detail }) => `${outcome}  ${store}: ${detail}\n`).join('');
}

/**
 * A project `.env` that is not an environment. It names the file and never quotes the line, which
 * is a value the operator keeps secret; the parser's own message is kept as `cause`.
 */
export class ProjectEnvironmentError extends Error {
  constructor(file: string, cause: unknown) {
    super(`${file} could not be read: every line must be a comment or NAME=value`, { cause });
    this.name = 'ProjectEnvironmentError';
  }
}

/**
 * Where level 2 reads the credentials the profile deliberately does not hold.
 *
 * The generator writes `.env` next to `agent-workspace.yaml`, so the project itself is the answer
 * for an operator running `agent-workspace validate` in it; an ambient export still wins nothing
 * over the project's own file, but supplies what the file omits. A missing `.env` is not an error
 * — it only means level 2 has fewer credentials, which `runProfileProbes` reports as skips. A
 * malformed one is: an operator who edited it by hand must be told which file to look at.
 */
export async function projectEnvironment(
  directory: string,
): Promise<Readonly<Record<string, string | undefined>>> {
  const file = path.join(directory, '.env');
  const contents = await readFile(file, 'utf8').catch(() => '');
  try {
    // A variable the renderer left empty names something only the deployment target can supply,
    // so it must not mask an ambient export of the same name — that export is exactly how the
    // value arrives before the target's own secret store has been wired up.
    const stated = Object.entries(parseEnvironment(contents)).filter(
      ([, value]) => value.trim() !== '',
    );
    return { ...process.env, ...Object.fromEntries(stated) };
  } catch (cause) {
    throw new ProjectEnvironmentError(file, cause);
  }
}

/** `agent-workspace validate [directory]` — level 1 always, level 2 where a credential exists. */
export async function runValidateCommand(
  argv: readonly string[] = [],
  options: RunProfileProbesOptions = {},
): Promise<void> {
  const directory = path.resolve(argv[0] ?? process.cwd());
  const document = await readFile(path.join(directory, 'agent-workspace.yaml'), 'utf8');
  const profile = parseProfileDocument(document, {
    onWarning: (message) => void process.stderr.write(`${message}\n`),
  });
  process.stdout.write(`agent-workspace.yaml is valid for cloud ${profile.cloud}\n`);
  const environment = options.environment ?? (await projectEnvironment(directory));
  // A Compose project's name also scopes its session cookie and its sandboxes (issue #394); a
  // hand-edited one is refused here rather than at the first sign-in or `stop`. Only the `local`
  // profile is a Compose project: elsewhere the name means nothing, and a shell export of it must
  // not fail a cloud profile. `environment` is what Compose runs with, `.env` over the shell, as
  // `start` composes it.
  const composeProject = environment['COMPOSE_PROJECT_NAME'];
  if (profile.cloud === 'local' && composeProject !== undefined && composeProject.trim() !== '') {
    assertComposeProjectName(composeProject);
  }
  // The server refuses to start with these settings, so validate refuses them before any probe.
  const storage = resolveStorageSettings(environment);
  if (storage.kind === 'refused') throw new StorageSettingsRefusedError(storage.reason);
  process.stdout.write(
    describeProbeResults(await runProfileProbes(profile, { ...options, environment })),
  );
  // The profile names no URL; a deployment's is `AGENT_WORKSPACE_URL`, as for `aw`. Without one
  // there is no server to ask, which is the offline case `validate` has always served.
  const serverUrl = environment['AGENT_WORKSPACE_URL']?.trim();
  if (serverUrl !== undefined && serverUrl !== '') {
    await assertServerServesContracts(serverUrl, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }
}
