import type { ProjectProblem } from '../project/problems.js';
import type { LocalRuntimeStartMessage } from '@indx-workspace/contracts/local-runtime';
import {
  PROJECT_API_VERSION,
  PROJECT_KIND,
  type ProjectDocument,
  type ProjectRead,
} from '@indx-workspace/contracts/project-file';
import { createClient, type AgentWorkspaceClient } from '@indx-workspace/sdk';
import { planProjectResources, type PlanProjectResourcesInput } from '@indx-workspace/sdk/project';
import path from 'node:path';
import type { CliIo } from '../io.js';
import { missingKeyLines, type KeyShell } from './environment.js';
import { isServerRefusal, sendActions } from './project-resources-actions.js';
import {
  FINGERPRINTS_FILE,
  readFingerprints,
  recordFingerprints,
  secretInputs,
} from './project-resources-fingerprints.js';
import {
  DEFAULT_MODEL_SECRET,
  modelSecretNames,
  modelSecretOf,
  projectSecretNames,
} from './project.js';
import type { LocalRuntimeSession } from './supervisor.js';

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
  const { sentSecrets, failedSecrets, created, baseUrlTaken } = await sendActions({
    client,
    actions: [...plan.creates, ...plan.updates],
    values,
    io,
    signal,
    // The default takes this start's base URL unless its create or patch fails.
    defaultTakesBaseUrl: project.models === undefined && secrets.has(DEFAULT_MODEL_SECRET),
  });
  await recordFingerprints(
    { file: fingerprintsFile, recorded },
    secrets,
    { sentSecrets, failedSecrets },
    baseUrlTaken ? (options.anthropicBaseUrl ?? null) : undefined,
  );
  return reportModelCheck({
    options,
    client,
    project,
    existing,
    unsetSecrets,
    created,
    notices: plan.notices,
  });
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

interface ReportModelCheckOptions {
  readonly options: ApplyProjectResourcesOptions;
  readonly client: AgentWorkspaceClient;
  readonly project: ProjectDocument;
  readonly existing: PlanProjectResourcesInput['existing'];
  readonly unsetSecrets: readonly string[];
  readonly created: readonly string[];
  readonly notices: readonly { readonly path: string; readonly message: string }[];
}

async function reportModelCheck(input: ReportModelCheckOptions): Promise<ModelCheck> {
  const { options, client, project, existing, unsetSecrets, created, notices } = input;
  const { io, signal } = options;
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
  for (const notice of notices) {
    if (!listed(notice))
      io.stderr(`notice: ${notice.message}
`);
  }
  return reported(io, options, { checked: held, problems });
}
export { applyProjectTools } from './project-resources-tools.js';

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
