import type { prepareDev } from './dev-preflight.js';
import type { LocalRuntimeSession } from '../local-runtime/supervisor.js';
import type { RunningApp } from '../dev/app.js';
import { readyScreen, type DevStatus } from '../dev/format.js';
import { WATCHED_DIRECTORIES } from '../dev/watch.js';
import { applyProjectResources, warningLine } from '../local-runtime/project-resources.js';
import { missingKeyLines } from '../local-runtime/environment.js';
import { modelSecretNames } from '../local-runtime/project.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { nonBlank } from '../config.js';
import { type CliIo } from '../io.js';
import { evalAgents, loadEvalCases } from '../project/index.js';

/** Eval cases across `evals/*.yaml`; undefined when there are none or a file cannot be read. */
async function countEvalCases(root: string): Promise<number | undefined> {
  try {
    let total = 0;
    for (const name of await evalAgents(root))
      total += (await loadEvalCases(root, name)).cases.length;
    return total;
  } catch {
    return undefined;
  }
}

/** Where the first-run console password is kept, relative to the project (never its content). */
const LOCAL_SECRETS_PATH = '.agent-workspace/secrets/local-secrets.json';

/**
 * Where the console password is, in the runtime's own precedence: the environment, then the
 * project's `.env`, then the generated secrets file. Only the place is returned, never the value.
 */
function passwordLocation(env: CliIo['env'], cwd: string): string {
  const name = 'BOOTSTRAP_ADMIN_PASSWORD';
  if (nonBlank(env[name]) !== undefined) return `your environment (${name})`;
  try {
    if (nonBlank(parseEnv(readFileSync(path.join(cwd, '.env'), 'utf8'))[name]) !== undefined)
      return `.env (${name})`;
  } catch {
    // No readable .env: the runtime refuses an unreadable one itself.
  }
  return LOCAL_SECRETS_PATH;
}

/**
 * UX-C: after the ready screen, take the person into the chat. `--open` opens the page; on a
 * terminal with a prompt, ask once (Enter = yes); `--quiet`, `--no-open` and no terminal never ask,
 * and `--no-open` never opens. `--open` is an explicit request, so it opens under `--quiet` too. A
 * browser that cannot start leaves the URL for the person to open.
 */
export async function offerChat(
  io: CliIo,
  url: string,
  mode: { readonly open: boolean; readonly never: boolean; readonly quiet: boolean },
  signal: AbortSignal,
): Promise<void> {
  if (mode.never) return;
  if (!mode.open) {
    if (mode.quiet || !io.isTty || io.prompt === undefined) return;
    const answer = (await io.prompt('  Open the chat in your browser? (Y/n) ', signal)).trim();
    if (/^n/iu.test(answer)) return;
  }
  if (!((await io.openUrl?.(url)) ?? false)) {
    io.stdout(`  no browser could be opened here: open ${url} yourself
`);
  }
}

export async function announceReady(options: {
  readonly prepared: Awaited<ReturnType<typeof prepareDev>>;
  readonly session: LocalRuntimeSession;
  readonly check: Awaited<ReturnType<typeof applyProjectResources>>;
  readonly ready: {
    readonly origin: string | undefined;
    readonly seconds: number;
    readonly logFile: string;
  };
  readonly app: RunningApp | undefined;
  readonly surfaces: readonly string[];
}) {
  const { prepared, session, check, ready, app, surfaces } = options;
  const { cwd, io, read, quiet, identity, scriptedIo, moved } = prepared;
  const agents = prepared.loaded?.agents ?? [];
  const origin = ready.origin ?? session.baseUrl;
  const firstAgent = agents[0]?.body.definition.agent;
  // The screen shows the first model problem; every other one is said on stderr with its own
  // fix (with --quiet there is no screen, and applyProjectResources printed them all).
  const [problem, ...later] = check.problems;
  // Issue #732: a model secret unset here that is not a problem runs on the key the runtime
  // stored at an earlier start; the screen says so instead of "key checked".
  const stored = modelSecretNames(read).filter(
    (name) =>
      nonBlank(io.env[name]) === undefined &&
      !check.problems.some((entry) => entry.secret === name),
  );
  for (const other of quiet ? [] : later) io.stderr(warningLine(other));
  const evalCases = await countEvalCases(cwd);
  const status: DevStatus = {
    project: read.lifted ? path.basename(cwd) : read.project.name,
    environment: 'local',
    runtime: {
      seconds: ready.seconds,
      logPath: path.relative(cwd, ready.logFile).replaceAll('\\', '/'),
    },
    identity: `${identity} (workspace ${session.workspaceSlug})`,
    model: [
      firstAgent?.modelConnectionName ?? 'anthropic',
      firstAgent?.model ?? 'workspace default model',
      scriptedIo !== undefined
        ? 'scripted, no key needed'
        : !check.checked
          ? 'key set'
          : stored.length === 0
            ? 'key checked'
            : 'stored key checked',
    ].join(' \u00b7 '),
    ...(scriptedIo === undefined && check.checked && stored.length > 0
      ? { modelNote: `(${stored.join(', ')} not set: using the key of an earlier start)` }
      : {}),
    ...(problem === undefined
      ? {}
      : {
          modelProblem:
            problem.secret === undefined
              ? [problem.problem, problem.fix]
              : missingKeyLines(problem.secret),
        }),
    agents: agents.map(({ name, file }) => ({ name, file })),
    surfaces,
    origin,
    ...(app === undefined ? {} : { app: app.origin }),
    console: { email: identity, password: passwordLocation(io.env, cwd) },
    ...(moved === null ? {} : { moved: { port: moved.port, wanted: moved.busy } }),
    ...(evalCases === undefined ? {} : { evalCases }),
    watching: WATCHED_DIRECTORIES.map((name) => `${name}/`),
  };
  if (!quiet) {
    const plain = !io.isTty || (io.env['NO_COLOR'] ?? '') !== '';
    io.stdout(readyScreen(status, { plain }));
  }

  return origin;
}
