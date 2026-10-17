import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { LocalRuntimeStartMessage } from '@indx-workspace/contracts/local-runtime';
import {
  PROJECT_API_VERSION,
  PROJECT_KIND,
  type ProjectDocument,
  type ProjectRead,
} from '@indx-workspace/contracts/project-file';
import { SecretNameSchema } from '@indx-workspace/contracts/secret-reference';
import {
  ApiProblemError,
  ContractViolationError,
  createClient,
  TransportError,
  type AgentWorkspaceClient,
} from '@indx-workspace/sdk';
import {
  planProjectResources,
  type PlannedTool,
  type PlanProjectResourcesInput,
  type PlanSecret,
  type ProjectResourceCreate,
  type ProjectResourceUpdate,
} from '@indx-workspace/sdk/project';
import { z } from 'zod';

import { nonBlank } from '../config.js';
import { writeOwnerOnlyJsonFile } from '../credentials.js';
import type { CliIo } from '../io.js';
import type { LoadedTool } from '../project/load.js';
import { localProblem, problemsFromError, type ProjectProblem } from '../project/problems.js';
import { isProblem, plannedTool, withCredential } from '../project/tools.js';
import { missingKeyLines, type KeyShell } from './environment.js';
import {
  DEFAULT_MODEL_SECRET,
  modelSecretNames,
  modelSecretOf,
  projectSecretNames,
} from './project.js';
import type { LocalRuntimeSession } from './supervisor.js';

/** The runtime's own directory (gitignored by the runtime), where SD16's fingerprints are kept. */
const FINGERPRINTS_FILE = path.join('.agent-workspace', 'secret-fingerprints.json');

/** The plan path of a catalog tool: `tools.<name>`. */
const TOOL_PATH_PREFIX = 'tools.';

/** HTTP 409 on a create: another `aw dev` made the resource between the listing and the create. */
const CONFLICT_STATUS = 409;

const FingerprintsFileSchema = z
  .object({
    /** The HMAC key, 32 random bytes in base64: a fingerprint says nothing without it. */
    key: z.base64().length(44),
    fingerprints: z.record(SecretNameSchema, z.string().regex(/^[0-9a-f]{64}$/u)),
    /** Issue #732: the `ANTHROPIC_BASE_URL` the C6 `default` connection last took; `null`, unset. */
    anthropicBaseUrl: z.string().nullable().optional(),
  })
  .strict();

interface Fingerprints {
  readonly key: Buffer;
  readonly fingerprints: Record<string, string>;
  anthropicBaseUrl?: string | null;
}

/** The recorded fingerprints; a missing or malformed file is "nothing recorded", so all rotate. */
async function readFingerprints(file: string): Promise<Fingerprints> {
  try {
    const parsed = FingerprintsFileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    return {
      key: Buffer.from(parsed.key, 'base64'),
      fingerprints: parsed.fingerprints,
      ...(parsed.anthropicBaseUrl === undefined
        ? {}
        : { anthropicBaseUrl: parsed.anthropicBaseUrl }),
    };
  } catch {
    return { key: randomBytes(32), fingerprints: {} };
  }
}

function fingerprintOf(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

/** The value and SD16 state of each named secret `aw dev`'s environment sets; unset ones are absent. */
function secretInputs(
  names: readonly string[],
  env: CliIo['env'],
  recorded: Fingerprints,
): { readonly values: Map<string, string>; readonly secrets: Map<string, PlanSecret> } {
  const values = new Map<string, string>();
  const secrets = new Map<string, PlanSecret>();
  for (const name of names) {
    const value = nonBlank(env[name]);
    if (value === undefined) continue;
    values.set(name, value);
    const sentFingerprint = recorded.fingerprints[name];
    secrets.set(name, {
      fingerprint: fingerprintOf(recorded.key, value),
      ...(sentFingerprint === undefined ? {} : { sentFingerprint }),
    });
  }
  return { values, secrets };
}

/**
 * SD16: record a secret's fingerprint only when every action naming it succeeded, and forget it
 * when one failed, so a refused or interrupted send is retried next time. Writes only on a change.
 */
async function recordFingerprints(
  file: string,
  recorded: Fingerprints,
  secrets: ReadonlyMap<string, PlanSecret>,
  sentSecrets: ReadonlySet<string>,
  failedSecrets: ReadonlySet<string>,
  /** The `ANTHROPIC_BASE_URL` the `default` connection now holds; `undefined` leaves the record. */
  anthropicBaseUrl: string | null | undefined,
): Promise<void> {
  let changed = false;
  if (anthropicBaseUrl !== undefined && anthropicBaseUrl !== recorded.anthropicBaseUrl) {
    recorded.anthropicBaseUrl = anthropicBaseUrl;
    changed = true;
  }
  for (const secret of failedSecrets) {
    changed ||= secret in recorded.fingerprints;
    delete recorded.fingerprints[secret];
  }
  for (const secret of sentSecrets) {
    const sent = secrets.get(secret);
    if (failedSecrets.has(secret) || sent === undefined) continue;
    recorded.fingerprints[secret] = sent.fingerprint;
    changed = true;
  }
  if (changed) {
    await writeOwnerOnlyJsonFile(file, {
      key: recorded.key.toString('base64'),
      fingerprints: recorded.fingerprints,
      ...(recorded.anthropicBaseUrl === undefined
        ? {}
        : { anthropicBaseUrl: recorded.anthropicBaseUrl }),
    });
  }
}

/**
 * The plan reads only `models` and `connectors`. A lifted v1 profile declares neither, so it is
 * planned as a v2 file with none: the C6 `default` connection only.
 */
export function plannedProject(
  read: ProjectRead,
  start: LocalRuntimeStartMessage,
): ProjectDocument {
  if (!read.lifted) return read.project;
  return {
    apiVersion: PROJECT_API_VERSION,
    kind: PROJECT_KIND,
    name: 'v1-profile',
    environments: {
      local: { cloud: 'local', identity: { bootstrapAdmin: start.environment.bootstrapAdmin } },
    },
  };
}

type Action = ProjectResourceCreate | ProjectResourceUpdate;

/** The Demo's line for a connector applied live: `applied: connector github (new)`. */
function appliedLine(action: Action): string {
  return `applied: connector ${nameOf(action)} (${'id' in action ? 'updated' : 'new'})\n`;
}

/** The last segment of `models.<name>` or `connectors.<name>`. */
function nameOf(action: Action): string {
  return action.path.slice(action.path.indexOf('.') + 1);
}

function isModel(action: Action): boolean {
  return action.kind === 'model' || action.kind === 'model-credential';
}

/** Send one action of the plan, reading the value of the secret it names from `values`. */
async function send(
  client: AgentWorkspaceClient,
  action: Action,
  values: ReadonlyMap<string, string>,
  signal: AbortSignal,
): Promise<void> {
  const valueOf = (name: string): string => {
    const value = values.get(name);
    // The plan names only a set secret; anything else is a bug, said without a value.
    if (value === undefined) throw new Error(`the plan named ${name}, which is not set`);
    return value;
  };
  const secret = 'secret' in action ? action.secret : undefined;
  const credential = secret === undefined ? {} : { credential: valueOf(secret) };
  switch (action.kind) {
    case 'model':
      if ('id' in action) {
        await client.models.connections.update(
          action.id,
          { ...action.patch, apiKey: valueOf(action.secret) },
          { signal },
        );
      } else {
        await client.models.connections.create(
          { ...action.input, apiKey: valueOf(action.secret) },
          { signal },
        );
      }
      return;
    case 'model-credential':
      await client.models.connections.rotateCredential(action.id, valueOf(action.secret), {
        signal,
      });
      return;
    case 'connector': {
      // A catalog tool (C15) is sent whole, with its credential when it has one.
      const value = secret === undefined ? undefined : valueOf(secret);
      if ('id' in action) {
        const { patch } = action;
        const body = 'kind' in patch ? withCredential(patch, value) : { ...patch, ...credential };
        await client.connectors.update(action.id, body, { signal });
      } else {
        const { input } = action;
        const body = 'kind' in input ? withCredential(input, value) : { ...input, ...credential };
        await client.connectors.create(body, { signal });
      }
      return;
    }
    case 'connector-credential':
      await client.connectors.rotateCredential(action.id, valueOf(action.secret), { signal });
      return;
    default: {
      const unreachable: never = action;
      throw new Error(`unknown action ${String(unreachable)}`);
    }
  }
}

function isServerRefusal(error: unknown): error is Error {
  return (
    error instanceof ApiProblemError ||
    error instanceof TransportError ||
    error instanceof ContractViolationError
  );
}

export interface ApplyProjectResourcesOptions {
  readonly io: CliIo;
  readonly session: LocalRuntimeSession;
  readonly read: ProjectRead;
  readonly start: LocalRuntimeStartMessage;
  /** The project's directory, absolute: the fingerprints are kept under it. */
  readonly root: string;
  /** `ANTHROPIC_BASE_URL`, for the C6 `default` connection only. */
  readonly anthropicBaseUrl: string | undefined;
  readonly signal: AbortSignal;
  /** True when the caller shows the model check's problems itself instead of on stderr. */
  readonly deferModelCheck?: boolean;
}

/**
 * C6, C10, C11, SD4, SD16: make the local workspace hold what the project file's `models` and
 * `connectors` declare — or, with no `models`, a `default` connection — with credentials read from
 * `aw dev`'s own environment. `planProjectResources` decides every create, update, rotation,
 * refusal and notice; this sends them and prints. Each secret's HMAC fingerprint is recorded in
 * `.agent-workspace/secret-fingerprints.json` once every resource naming it received its value, so a changed value is sent
 * again on the next start. A secret value is only ever in a request body: never printed, never in
 * a file. A refusal from the server is a warning — the runtime keeps running and the next resource
 * is tried.
 */
export async function applyProjectResources(
  options: ApplyProjectResourcesOptions,
): Promise<ModelCheck> {
  const { io, session, read, root, signal } = options;
  const client = createClient({
    baseUrl: session.baseUrl,
    auth: { kind: 'api-key', apiKey: session.apiKey },
    fetch: io.fetch,
  });
  const project = plannedProject(read, options.start);
  const fingerprintsFile = path.join(root, FINGERPRINTS_FILE);
  const recorded = await readFingerprints(fingerprintsFile);
  const names = [
    ...projectSecretNames(read),
    ...(project.models === undefined ? [DEFAULT_MODEL_SECRET] : []),
  ];
  const { values, secrets } = secretInputs(names, io.env, recorded);
  const unsetSecrets = modelSecretNames(read).filter((name) => !secrets.has(name));

  let existing: PlanProjectResourcesInput['existing'];
  try {
    existing = {
      modelConnections: await client.models.connections.list({ signal }),
      // A project with no `connectors` reads none, as before this unit.
      connectors: project.connectors === undefined ? [] : await client.connectors.list({ signal }),
    };
  } catch (error) {
    if (signal.aborted || !isServerRefusal(error)) throw error;
    io.stderr(`warning: could not read the workspace's models and connectors: ${error.message}\n`);
    return reported(io, options, {
      checked: false,
      problems: unsetSecrets.map((secret) => unsetProblem(secret)),
    });
  }
  const plan = planProjectResources({
    project,
    tools: [],
    existing,
    secrets,
    ...(options.anthropicBaseUrl === undefined
      ? {}
      : { anthropicBaseUrl: options.anthropicBaseUrl }),
    ...(recorded.anthropicBaseUrl === undefined
      ? {}
      : { sentAnthropicBaseUrl: recorded.anthropicBaseUrl }),
  });

  // Notices are printed after the model check (below), so a model secret's notice can give way to
  // the same secret's entry in the problem list.
  for (const refusal of plan.refusals) io.stderr(`warning: ${refusal.path}: ${refusal.message}\n`);
  // SD16: a secret is recorded only after the loop, and only when every action naming it in this
  // apply succeeded, so a shared secret's refused or interrupted send is retried on the next start.
  const sentSecrets = new Set<string>();
  const failedSecrets = new Set<string>();
  const created: string[] = [];
  // Issue #732: the C6 `default` took this start's base URL unless its create or patch failed.
  let baseUrlTaken = project.models === undefined && secrets.has(DEFAULT_MODEL_SECRET);
  for (const action of [...plan.creates, ...plan.updates]) {
    const secret = 'secret' in action ? action.secret : undefined;
    const what = isModel(action)
      ? `the "${nameOf(action)}" model connection`
      : `the "${nameOf(action)}" connector`;
    try {
      await send(client, action, values, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      if (secret !== undefined) failedSecrets.add(secret);
      if (action.kind === 'model' && action.path === 'models.default') baseUrlTaken = false;
      const created = !('id' in action);
      if (created && error instanceof ApiProblemError && error.status === CONFLICT_STATUS) continue;
      if (!isServerRefusal(error)) throw error;
      io.stderr(`warning: could not set up ${what}: ${error.message}\n`);
      continue;
    }
    if (secret !== undefined) sentSecrets.add(secret);
    if (action.kind === 'model' && !('id' in action)) {
      created.push(`model connection: ${nameOf(action)} (${action.input.provider})\n`);
    }
    // SD4: every connector the project file declares is MCP; a tool (S2-09c) is `tools.<name>`.
    if (action.path.startsWith('connectors.')) {
      io.stdout(appliedLine(action));
      io.stdout(`${action.path}: MCP tools that write run without confirmation (ADR-0108)\n`);
    }
  }
  await recordFingerprints(
    fingerprintsFile,
    recorded,
    secrets,
    sentSecrets,
    failedSecrets,
    baseUrlTaken ? (options.anthropicBaseUrl ?? null) : undefined,
  );
  const used = usedModelConnections(project);
  const held =
    created.length > 0 || existing.modelConnections.some((connection) => used.has(connection.name));
  // The check runs before the lines print, so a refused key is said with the line it concerns.
  const checkProblems = held ? await modelProblems(client, project, used, signal) : [];
  for (const line of created) io.stdout(line);
  /*
   * Issue #690, the invariant: every model problem — each unset model secret and each failed
   * connection check — is reported exactly once: either as the ready screen's single `model` row,
   * or as a stderr line with its own fix. Nothing is reported twice, nothing is reported nowhere.
   *
   * So this is the one list of model problems. An unset secret is fine only when every connection
   * that uses it is held by the runtime and its check passed (it runs on the credential it stored);
   * otherwise it is a problem. The caller shows the first and prints the rest with `warningLine`
   * (or, not deferring, all are printed here), and a plan notice for a model secret is dropped only
   * when that same secret is in this list, which says it instead.
   */
  const passed = (connection: string): boolean =>
    held &&
    existing.modelConnections.some(({ name }) => name === connection) &&
    !checkProblems.some(
      (problem) => problem.connection === undefined || problem.connection === connection,
    );
  const unsetListed = unsetSecrets.filter(
    (secret) => ![...used].filter((name) => modelSecretOf(project, name) === secret).every(passed),
  );
  const problems = [...unsetListed.map((secret) => unsetProblem(secret)), ...checkProblems];
  const listed = (notice: { readonly path: string; readonly message: string }): boolean =>
    notice.path.startsWith('models.') &&
    unsetListed.some(
      (secret) =>
        notice.message.startsWith(`${secret} is not set:`) ||
        (secret === DEFAULT_MODEL_SECRET &&
          notice.message.startsWith('no "default" model connection yet;')),
    );
  for (const notice of plan.notices) {
    if (!listed(notice))
      io.stderr(`notice: ${notice.message}
`);
  }
  return reported(io, options, { checked: held, problems });
}

/** Print every problem of `check` unless the caller reports them itself; return `check`. */
function reported(io: CliIo, options: ApplyProjectResourcesOptions, check: ModelCheck): ModelCheck {
  if (options.deferModelCheck !== true) {
    for (const problem of check.problems) io.stderr(warningLine(problem));
  }
  return check;
}

/** A model secret unset in this shell; the ready screen says it with {@link missingKeyLines}. */
export function unsetProblem(secret: string, shell?: KeyShell): ModelProblem {
  return {
    secret,
    problem: `${missingKeyLines(secret, shell)[0] ?? ''}.`,
    fix: `Run: ${setKeyText(secret, shell)}, then restart aw dev.`,
  };
}

/** The line(s) that set `secret` in this shell, on one line (Windows: PowerShell or cmd). */
export function setKeyText(secret: string, shell?: KeyShell): string {
  return missingKeyLines(secret, shell)
    .slice(1)
    .map((line) => line.replace(/\s+/g, ' '))
    .join(' or ');
}

/** The connection names the project runs on: its `models`, or the C6 `default` connection. */
function usedModelConnections(project: ProjectDocument): ReadonlySet<string> {
  return new Set(project.models === undefined ? ['default'] : Object.keys(project.models));
}

/** One model connection `aw dev` could not use: what is wrong, and the exact fix. */
interface ModelProblem {
  /** Absent when the check itself could not run, so no one connection is at fault. */
  readonly connection?: string;
  /** Set when the problem is this model secret being unset in this shell. */
  readonly secret?: string;
  /** Set when the provider refused the key: a chat cannot answer until it is changed. */
  readonly rejected?: true;
  readonly problem: string;
  readonly fix: string;
}

/** What the start-up check found; `checked` is false when no connection could be asked. */
export interface ModelCheck {
  readonly checked: boolean;
  /** Every model problem, each once, in the order said: unset secrets first, then check failures. */
  readonly problems: readonly ModelProblem[];
}

export function warningLine({ connection, problem, fix }: ModelProblem): string {
  const of = connection === undefined ? '' : `model connection "${connection}": `;
  return `warning: ${of}${problem} ${fix}
`;
}

/**
 * Issue #661, #690: ask the workspace to discover each connection's models, which calls the provider
 * with the stored key, so a rejected key or an unreachable provider is said at start rather than on
 * the first message. The fix follows the failure's `kind`: only a rejected key says to change the
 * key; an unreachable provider says so and leaves the key alone. A secret is named, never its value.
 */
async function modelProblems(
  client: AgentWorkspaceClient,
  project: ProjectDocument,
  used: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<readonly ModelProblem[]> {
  let catalog;
  try {
    catalog = await client.models.discover({ signal });
  } catch (error) {
    if (signal.aborted || !isServerRefusal(error)) throw error;
    return [
      {
        problem: `could not check the model connections' keys: ${error.message}`,
        fix: 'Restart aw dev to check again.',
      },
    ];
  }
  return (catalog.unavailable ?? [])
    .filter((entry) => used.has(entry.connectionName))
    .map((entry) => {
      const secret = modelSecretOf(project, entry.connectionName);
      return entry.kind === 'credential-rejected'
        ? {
            connection: entry.connectionName,
            rejected: true as const,
            problem: `the key was rejected (${String(entry.status ?? 401)})`,
            fix: `Set ${secret} to a valid key and restart aw dev.`,
          }
        : {
            connection: entry.connectionName,
            problem: entry.reason,
            fix:
              entry.kind === undefined || entry.kind === 'unsupported-provider'
                ? 'Restart aw dev to check again.'
                : "The key was not rejected: check the base URL and this machine's network, then restart aw dev.",
          };
    });
}

/** The project file a tool plan reads when there is none: only its `connectors` matter to a tool. */
const NO_PROJECT_FILE: ProjectDocument = {
  apiVersion: PROJECT_API_VERSION,
  kind: PROJECT_KIND,
  name: 'no-project-file',
  environments: { local: { cloud: 'local', identity: { bootstrapAdmin: 'admin@localhost.test' } } },
};

export interface ApplyProjectToolsOptions {
  /** A client for the workspace the tools are applied to. */
  readonly client: AgentWorkspaceClient;
  readonly io: CliIo;
  /** The project's directory, absolute: documents are read and fingerprints kept under it. */
  readonly root: string;
  /** The project file, for the names its `connectors` take (SD1); left out, none are taken. */
  readonly project?: ProjectDocument | undefined;
  readonly signal: AbortSignal;
  /** Notice texts already printed this session; a notice prints only the first time. */
  readonly printedNotices?: Set<string>;
  /**
   * Send the creates and updates. `false` plans only: notices and refusals are reported, nothing
   * is sent and no fingerprint is recorded. Default `true`.
   */
  readonly yes?: boolean;
}

/** What applying one catalog tool did, or — without `yes` — would do. */
export interface AppliedTool {
  readonly file: string;
  readonly name: string;
  readonly action: 'create' | 'update' | 'unchanged';
}

export interface AppliedProjectTools {
  readonly problems: readonly ProjectProblem[];
  /** Each tool planned with no refusal, failed send or unset secret, in project order. */
  readonly tools: readonly AppliedTool[];
}

/**
 * C10, C15, SD16: the tool step `aw dev` runs on every sync and `aw push` runs once, before any
 * version is saved. Each catalog tool's document is read; `planProjectResources` decides which
 * tools to create or register again — a changed document, `allow`, auth or rotated secret — and
 * only its `tools.*` entries are kept, so the models and connectors applied at start are not
 * planned again. Notices go to stderr; a refusal is a `tool_refused` problem against the tool's
 * file, and a refused send that tool's server problem: either blocks the push. A secret's value is
 * read from the caller's own environment and only ever travels in a create or update body.
 */
export async function applyProjectTools(
  options: ApplyProjectToolsOptions,
  tools: readonly LoadedTool[],
): Promise<AppliedProjectTools> {
  const { client, io, root, signal } = options;
  const yes = options.yes ?? true;
  const problems: ProjectProblem[] = [];
  const planned: PlannedTool[] = [];
  const fileOf = new Map<string, string>();
  for (const tool of tools) {
    const read = await plannedTool(tool, { root, io, signal });
    if (isProblem(read)) {
      problems.push(read);
      continue;
    }
    planned.push(read);
    fileOf.set(`${TOOL_PATH_PREFIX}${tool.definition.name}`, tool.file);
  }
  if (planned.length === 0) return { problems, tools: [] };

  let connectors;
  try {
    connectors = await client.connectors.list({ signal });
  } catch (error) {
    for (const file of new Set(fileOf.values())) {
      problems.push(...problemsFromError(error, file, []));
    }
    return { problems, tools: [] };
  }
  const fingerprintsFile = path.join(root, FINGERPRINTS_FILE);
  const recorded = await readFingerprints(fingerprintsFile);
  const names = planned.flatMap((tool) =>
    tool.definition.credential === undefined ? [] : [tool.definition.credential.secret],
  );
  const { values, secrets } = secretInputs([...new Set(names)], io.env, recorded);
  const plan = planProjectResources({
    project: options.project ?? NO_PROJECT_FILE,
    tools: planned,
    existing: { modelConnections: [], connectors },
    secrets,
  });
  const isTool = (entry: { readonly path: string }): boolean =>
    entry.path.startsWith(TOOL_PATH_PREFIX);
  const fileFor = (entry: { readonly path: string }): string => fileOf.get(entry.path) ?? '.';

  for (const notice of plan.notices.filter(isTool)) {
    if (options.printedNotices?.has(notice.message)) continue;
    options.printedNotices?.add(notice.message);
    io.stderr(`notice: ${notice.message}\n`);
  }
  const refused = new Set<string>();
  for (const refusal of plan.refusals.filter(isTool)) {
    refused.add(refusal.path);
    problems.push(localProblem(fileFor(refusal), 'tool_refused', [refusal.message]));
  }
  const sentSecrets = new Set<string>();
  const failedSecrets = new Set<string>();
  const actions = new Map<string, 'create' | 'update'>();
  const failed = new Set<string>();
  try {
    for (const action of [...plan.creates, ...plan.updates].filter(isTool)) {
      actions.set(action.path, 'id' in action ? 'update' : 'create');
      if (!yes) continue;
      const secret = 'secret' in action ? action.secret : undefined;
      try {
        await send(client, action, values, signal);
      } catch (error) {
        if (secret !== undefined) failedSecrets.add(secret);
        if (signal.aborted) throw error;
        failed.add(action.path);
        problems.push(...problemsFromError(error, fileFor(action), []));
        continue;
      }
      if (secret !== undefined) sentSecrets.add(secret);
    }
  } finally {
    if (yes) {
      await recordFingerprints(
        fingerprintsFile,
        recorded,
        secrets,
        sentSecrets,
        failedSecrets,
        undefined,
      );
    }
  }
  const applied = planned.flatMap(({ definition }): AppliedTool[] => {
    const toolPath = `${TOOL_PATH_PREFIX}${definition.name}`;
    // A tool whose secret is unset was skipped; its notice says why.
    const unset = definition.credential !== undefined && !secrets.has(definition.credential.secret);
    if (refused.has(toolPath) || failed.has(toolPath) || unset) return [];
    const file = fileOf.get(toolPath) ?? '.';
    return [{ file, name: definition.name, action: actions.get(toolPath) ?? 'unchanged' }];
  });
  return { problems, tools: applied };
}
