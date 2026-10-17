import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv, styleText } from 'node:util';

import { SCRIPTED_MODEL_PREFIX } from '@indx-workspace/contracts/models';
import { LocalPortSchema, type ProjectRead } from '@indx-workspace/contracts/project-file';
import { PROJECT_FILE_NAME } from '@indx-workspace/sdk/project';

import { command, isOn, type LocalCommand, type LocalCommandContext } from '../command.js';
import { nonBlank } from '../config.js';
import { readyScreen, tryPage, type DevStatus } from '../dev/format.js';
import { devSandbox, requireDocker, unsandboxedLine } from '../dev/sandbox.js';
import { createDevSyncClient, startDevSync, type DevSync } from '../dev/sync.js';
import { WATCHED_DIRECTORIES } from '../dev/watch.js';
import { CommandRefusedError, UsageError, type CliIo } from '../io.js';
import {
  anthropicSettings,
  freeWebPort,
  localStartMessage,
  missingKeyLines,
  signedInIdentity,
} from '../local-runtime/environment.js';
import { keyConsole } from '../local-runtime/open-url.js';
import {
  applyProjectResources,
  plannedProject,
  warningLine,
} from '../local-runtime/project-resources.js';
import {
  localProjectUrl,
  modelSecretNames,
  processAlive,
  projectSecretNames,
  readLocalProject,
  removeRuntimeRecord,
  runningRuntime,
  writeRuntimeRecord,
} from '../local-runtime/project.js';
import { requireEnginePackages } from '../local-runtime/engine-packages.js';
import { resolveLocalRuntime } from '../local-runtime/resolve.js';
import { superviseLocalRuntime } from '../local-runtime/supervisor.js';
import { evalAgents, loadEvalCases, loadProject } from '../project/index.js';
import { startToolHost, type ToolHost } from '../tools/host.js';

const SANDBOXES = ['local', 'docker'] as const;

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
async function offerChat(
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

/**
 * BH061-012: the web port asked for on the command line (`--port`), else by `PORT` in `aw dev`'s
 * environment; `undefined` when neither is given, and the project file's port applies. A port
 * asked for is pinned, as one in the project file is: a busy one is refused, never moved.
 */
function requestedWebPort(flag: string | undefined, env: CliIo['env']): number | undefined {
  const fromEnv = nonBlank(env['PORT']);
  const [raw, source] =
    flag !== undefined ? [flag, '--port'] : fromEnv !== undefined ? [fromEnv, 'PORT'] : [];
  if (raw === undefined || source === undefined) return undefined;
  const parsed = LocalPortSchema.safeParse(/^[0-9]{1,5}$/u.test(raw.trim()) ? Number(raw) : NaN);
  if (!parsed.success) {
    throw new UsageError(
      `${source} must be a port from 1 to 65535 that is not 4000 or 8080 (the gateway and runner ports)`,
    );
  }
  return parsed.data;
}

/**
 * The web port to start on and the environment to start it with: a requested port (and `PORT` set
 * to it, since the runtime refuses a `PORT` that differs), else the project's port, moved to the
 * next free set when it is unpinned and busy (`moved`).
 */
async function chooseWebPort(
  flag: string | undefined,
  io: CliIo,
  read: ProjectRead,
): Promise<{
  readonly io: CliIo;
  readonly port: number | undefined;
  readonly moved: Awaited<ReturnType<typeof freeWebPort>>;
}> {
  const requested = requestedWebPort(flag, io.env);
  if (requested !== undefined) {
    return {
      io: { ...io, env: { ...io.env, PORT: String(requested) } },
      port: requested,
      moved: null,
    };
  }
  const moved = await freeWebPort(read, io.env);
  return { io, port: moved?.port, moved };
}

/** The credential a scripted-only project's connections hold; never sent for a `scripted:` id. */
const SCRIPTED_PLACEHOLDER_KEY = 'scripted';

/**
 * Issue #798: with `AW_SCRIPTED_MODELS_DIR` set and every agent on a `scripted:` model, `aw dev`
 * needs no provider key. A connection still holds a credential, so each unset model secret gets a
 * placeholder the gateway never sends anywhere. `undefined` when the project is not scripted-only.
 */
function withScriptedKeys(
  io: CliIo,
  read: ProjectRead,
  models: readonly (string | null)[],
): CliIo | undefined {
  const scripted =
    nonBlank(io.env['AW_SCRIPTED_MODELS_DIR']) !== undefined &&
    models.length > 0 &&
    models.every((model) => model?.startsWith(SCRIPTED_MODEL_PREFIX) === true);
  if (!scripted) return undefined;
  const unset = modelSecretNames(read).filter((name) => nonBlank(io.env[name]) === undefined);
  return {
    ...io,
    env: {
      ...io.env,
      ...Object.fromEntries(unset.map((name) => [name, SCRIPTED_PLACEHOLDER_KEY])),
    },
  };
}

/**
 * Issue #690: on a terminal, when a model key is missing, offer a numbered choice (Enter takes the
 * first): open the provider's console to create a key and paste it, paste one, or skip. A pasted
 * key is read with nothing echoed and goes only into the environment this process hands on (`aw dev`
 * sends it to the runtime over the API, SD17); it is never written to a project file, but the
 * runtime keeps it in its own database and an `aw dev` without the variable runs on it
 * (BH061-051). Skipping, a blank paste, no terminal, or `--quiet` leaves the key missing, and the
 * ready screen says the line to run. Every line fits 80 columns (BH061-070).
 */
async function withSessionKey(io: CliIo, read: ProjectRead, quiet: boolean): Promise<CliIo> {
  const name = modelSecretNames(read).find((secret) => (io.env[secret] ?? '') === '');
  if (
    name === undefined ||
    quiet ||
    !io.isTty ||
    io.prompt === undefined ||
    io.promptSecret === undefined
  )
    return io;
  const [problem = '', ...fix] = missingKeyLines(name);
  const target = keyConsole(name);
  const plain = (io.env['NO_COLOR'] ?? '') !== '';
  const paint = (format: Parameters<typeof styleText>[0], text: string): string =>
    plain ? text : styleText(format, text, { validateStream: false });
  const options = [
    ...(target === undefined
      ? []
      : [
          {
            id: 'open',
            label: `Open the ${target.provider} console, create a key, then paste it`,
          },
        ]),
    { id: 'paste', label: 'Paste a key now (hidden)' },
    { id: 'skip', label: 'Skip for now' },
  ] as const;
  const indent = ' '.repeat(12);
  io.stdout(
    `  ${paint('red', '✗')} model   ${problem}
` +
      `${indent}the local runtime keeps a pasted key for later starts:
` +
      options
        .map(
          (option, index) => `${indent}  ${paint('bold', `[${String(index + 1)}]`)} ${option.label}
`,
        )
        .join('') +
      `${indent}or set it yourself and restart:
${fix
  .map(
    (line) => `${indent}  ${line}
`,
  )
  .join('')}`,
  );
  let choice: (typeof options)[number]['id'] | undefined;
  for (let attempt = 0; choice === undefined && attempt < 3; attempt += 1) {
    const answer = (await io.prompt(`  choose 1-${String(options.length)} (Enter = 1) › `)).trim();
    choice = answer === '' ? options[0].id : options[Number(answer) - 1]?.id;
    if (choice === undefined)
      io.stdout(`${indent}type 1${options.length > 2 ? ', 2 or 3' : ' or 2'}, or press Enter for 1
`);
  }
  if (choice === undefined)
    io.stdout(`${indent}no choice made: skipped
`);
  if (choice === undefined || choice === 'skip') return io;
  if (choice === 'open' && target !== undefined) {
    io.stdout(`${indent}opening ${target.url}
`);
    if (!((await io.openUrl?.(target.url)) ?? false))
      io.stdout(`${indent}no browser could be opened here: open that link yourself, then paste the key
`);
  }
  const key = (await io.promptSecret('  key › ')).trim();
  if (key === '')
    io.stdout(`${indent}no key pasted: skipped
`);
  return key === '' ? io : { ...io, env: { ...io.env, [name]: key } };
}

/**
 * `aw dev`: every check runs before anything is forked — the project, the environment it asks
 * for, the Anthropic settings, the installed runtime and its version — so a refusal never leaves a
 * half-started runtime behind.
 *
 * Every secret the project names — in `agent-workspace.yaml` and in its agents' `secret()` calls —
 * is withheld from the runtime and the loader (SD17): `start` lists them, and once signed in the
 * project's `models` and `connectors` are applied from `aw dev`'s own environment before the first
 * sync (C10, C11). Every sync applies the agents' catalog tools before it saves versions (C15).
 *
 * Once signed in, the sync (issue #453) starts and runs beside the runtime: the sign-in hook
 * returns at once, because the supervisor runs its hooks one after another and waits for them
 * before it reports the runtime's exit. A sync that fails beyond a refusal stops the runtime and
 * is the reason `aw dev` exits with; whatever ends `aw dev`, the sync's watchers and timers are
 * released before it returns, so no push runs after the runtime stopped.
 */
async function runDev(context: LocalCommandContext): Promise<void> {
  const { cwd, signal } = context;
  let { io } = context;
  const read = cwd === undefined ? null : await readLocalProject(cwd);
  if (cwd === undefined || read === null) {
    throw new CommandRefusedError(`no ${PROJECT_FILE_NAME} in this directory`, 'aw init --yes');
  }
  const quiet = isOn(context, 'quiet');
  const verbose = isOn(context, 'verbose');
  if (quiet && verbose) throw new UsageError('--quiet and --verbose cannot be used together');
  if (isOn(context, 'open') && isOn(context, 'no-open'))
    throw new UsageError('--open and --no-open cannot be used together');
  const given = context.args.values.get('sandbox');
  const flag = SANDBOXES.find((name) => name === given);
  if (given !== undefined && flag === undefined)
    throw new UsageError(`--sandbox must be one of ${SANDBOXES.join(', ')}`);
  const fileNames = projectSecretNames(read);
  // The flag wins over the project file; with neither, nothing is probed. Both refusals come
  // before the key prompt, so a bad value or a stopped daemon never asks for a key first.
  const sandbox = devSandbox(
    flag,
    localStartMessage(read, cwd, fileNames).environment.runtimeDriver,
  );
  await requireDocker(sandbox, io.env);
  const defaultEngine = read.lifted ? undefined : read.project.engine;
  // The `secret()` names of the agents' tools are withheld too (ADR-0109 slice-2 amendment). A
  // project with no agents yet names none; any other problem is the first sync's to report.
  // Loaded before the key prompt: a scripted-only project is never asked for a key (#798).
  let agentNames: readonly string[] = [];
  let loaded: Awaited<ReturnType<typeof loadProject>> | undefined;
  try {
    loaded = await loadProject({ root: cwd, io, signal, withheld: fileNames, defaultEngine });
    agentNames = loaded.secrets;
  } catch (error) {
    if (!(error instanceof CommandRefusedError)) throw error;
  }
  const scriptedIo = withScriptedKeys(
    io,
    read,
    (loaded?.agents ?? []).map(({ body }) => body.definition.agent.model),
  );
  io = scriptedIo ?? (await withSessionKey(io, read, quiet));
  // An unpinned port that is busy moves to the next free set; a pinned one is the runtime's refusal.
  const chosen = await chooseWebPort(context.args.values.get('port'), io, read);
  io = chosen.io;
  const { moved, port: portOverride } = chosen;
  let start = localStartMessage(read, cwd, fileNames, portOverride);
  const identity = signedInIdentity(io.env, start);
  const anthropic = anthropicSettings(io.env);
  const runtime = await resolveLocalRuntime(cwd);
  await requireEnginePackages(
    cwd,
    (loaded?.agents ?? []).map(({ body }) => body.definition.policy.engine),
  );
  const withheld = [...new Set([...fileNames, ...agentNames])].sort();
  if (withheld.length > fileNames.length)
    start = localStartMessage(read, cwd, withheld, portOverride);
  if (flag !== undefined)
    start = { ...start, environment: { ...start.environment, runtimeDriver: flag } };
  // Only docker runs a session in a container; `sandbox-runtime` runs on `local` too (#818).
  const unsandboxed =
    start.environment.runtimeDriver === 'docker'
      ? undefined
      : unsandboxedLine(
          (loaded?.agents ?? [])
            .filter(({ body }) => body.definition.agent.permissions.runCommands)
            .map(({ name }) => name),
        );
  if (unsandboxed !== undefined) io.stderr(unsandboxed);
  // Aborted by a fatal sync error, which stops the runtime, and when `aw dev` returns.
  const lifetime = new AbortController();
  const running = AbortSignal.any([signal, lifetime.signal]);
  let fatal: Error | undefined;
  let sync: DevSync | undefined;
  let toolHost: ToolHost | undefined;
  // The URL the runtime said it is ready on; the page, try and widget lines use the same one.
  let readyOrigin: string | undefined;
  let readySeconds = 0;
  let recorded = false;
  const startedAt = Date.now();
  const logFile = path.join(cwd, '.aw', 'logs', 'runtime.log');
  const agents = loaded?.agents ?? [];
  const surfaces = agents.flatMap((agent) => agent.body.surfaces.map(({ name }) => name));
  // BH061-072: stopping takes seconds (up to the 10 s grace); say so at once, on a line of its own
  // rather than after the terminal's `^C`.
  const onInterrupt = (): void => {
    io.stderr('\nstopping the local runtime…\n');
  };
  signal.addEventListener('abort', onInterrupt, { once: true });
  try {
    // The tool host for `defineTool` run files (issue #693); `lifetime` stops it.
    toolHost = await startToolHost({ root: cwd, io, signal: running });
    await superviseLocalRuntime({
      launchPath: runtime.launchPath,
      cwd,
      io,
      signal: running,
      start,
      logFile,
      verbose,
      hooks: {
        onReady: ({ url }) => {
          readyOrigin = new URL(url).origin;
          readySeconds = (Date.now() - startedAt) / 1000;
        },
        onSignedIn: async (session) => {
          // Issue #730: other `aw` commands in this project reach the port actually bound. The
          // supervisor stored its key before this hook, so the record never names a keyless port.
          await writeRuntimeRecord(cwd, start.environment.port);
          recorded = true;
          const check = await applyProjectResources({
            io,
            session,
            read,
            start,
            root: cwd,
            anthropicBaseUrl: anthropic.baseUrl,
            signal,
            deferModelCheck: !quiet,
          });
          const origin = readyOrigin ?? session.baseUrl;
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
              seconds: readySeconds,
              logPath: path.relative(cwd, logFile).replaceAll('\\', '/'),
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
            console: { email: identity, password: passwordLocation(io.env, cwd) },
            ...(moved === null ? {} : { moved: { port: moved.port, wanted: moved.busy } }),
            ...(evalCases === undefined ? {} : { evalCases }),
            watching: WATCHED_DIRECTORIES.map((name) => `${name}/`),
          };
          if (!quiet) {
            const plain = !io.isTty || (io.env['NO_COLOR'] ?? '') !== '';
            io.stdout(readyScreen(status, { plain }));
          }
          sync = startDevSync({
            client: createDevSyncClient({
              baseUrl: session.baseUrl,
              apiKey: session.apiKey,
              fetch: io.fetch,
            }),
            root: cwd,
            io,
            // The screen shows the first surface's try URL and embed tag; any other prints its own.
            announcedSurfaces: quiet ? [] : surfaces.slice(0, 1),
            signal: running,
            origin,
            defaultEngine,
            forkWithheld: withheld,
            project: plannedProject(read, start),
            liveProject: { read, start, session, anthropicBaseUrl: anthropic.baseUrl },
            toolHost,
            onFatal: (error) => {
              fatal ??= error;
              lifetime.abort();
            },
          });
          const firstSurface = surfaces[0];
          if (firstSurface !== undefined) {
            // Not awaited: the supervisor waits for this hook before it reports a runtime exit, so a
            // question left unanswered must not hold it. `running` cancels the prompt when aw dev
            // ends; Ctrl-C at it is an interrupt that stops aw dev.
            // After the first sync's lines, so its output never lands on the question's line.
            void sync.firstSync
              .then(() =>
                // A fatal first sync or Ctrl-C ends aw dev: neither asks nor opens then.
                running.aborted
                  ? undefined
                  : offerChat(
                      io,
                      tryPage(origin, firstSurface),
                      {
                        open: isOn(context, 'open'),
                        never: isOn(context, 'no-open'),
                        // A key the provider just refused cannot answer a chat, so the chat is
                        // not offered; `--open` still opens it (BH061-051).
                        quiet: quiet || check.problems.some((entry) => entry.rejected === true),
                      },
                      running,
                    ),
              )
              .catch((error: unknown) => {
                if (running.aborted) return;
                fatal ??= error instanceof Error ? error : new Error(String(error));
                lifetime.abort();
              });
          }
        },
      },
    });
  } catch (error) {
    throw fatal ?? error;
  } finally {
    signal.removeEventListener('abort', onInterrupt);
    lifetime.abort();
    await sync?.closed;
    await toolHost?.closed;
    // Only this run's record: a second `aw dev` that never got ready leaves the first one's.
    if (recorded) await removeRuntimeRecord(cwd);
  }
}

/** How long `aw dev stop` waits for `aw dev` to stop its runtime and exit. */
const STOP_WAIT_MS = 30_000;
const STOP_POLL_MS = 200;

/** The running `aw dev` of the project in `cwd`, refused when there is none (BH061-005). */
async function requireRunning(
  cwd: string | undefined,
): Promise<{ readonly port: number; readonly pid: number }> {
  const running = cwd === undefined ? undefined : await runningRuntime(cwd);
  if (running === undefined)
    throw new CommandRefusedError('aw dev is not running in this project', 'npm run dev');
  return running;
}

/**
 * `aw dev status` (BH061-005, BH061-045): exit 0 with the URL once the runtime is ready and signed
 * in (the moment `aw dev` writes `.aw/runtime.json`); refused while it is starting or stopped, so a
 * script can wait on it.
 */
async function runDevStatus(context: LocalCommandContext): Promise<void> {
  const { port, pid } = await requireRunning(context.cwd);
  const url = localProjectUrl(port);
  context.io.stdout(
    context.mode.json
      ? `${JSON.stringify({ running: true, url, port, pid })}\n`
      : `aw dev is running at ${url} (pid ${String(pid)})\n`,
  );
}

/**
 * `aw dev stop` (BH061-005): ask the project's running `aw dev` to stop, as Ctrl-C does, and wait
 * until it has stopped its runtime and the embedded PostgreSQL. On Windows the signal ends `aw dev`
 * outright, and the runtime stops itself when its channel to `aw dev` closes.
 */
async function runDevStop(context: LocalCommandContext): Promise<void> {
  const { pid } = await requireRunning(context.cwd);
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + STOP_WAIT_MS;
  while (processAlive(pid)) {
    if (Date.now() > deadline)
      throw new CommandRefusedError(
        `aw dev (pid ${String(pid)}) did not stop within ${String(STOP_WAIT_MS / 1000)} s`,
        `kill ${String(pid)}`,
      );
    await delay(STOP_POLL_MS);
  }
  context.io.stdout('aw dev stopped\n');
}

/**
 * Issue #451 (S1-13), ADR-0109: run the project in the current directory on the local runtime.
 *
 * Issue #453 (S1-15): it also keeps `agents/` and `surfaces/` in sync with `local`, pushing them on
 * start and on every save.
 *
 * `aw dev` takes no `--yes`. Like `aw login`, it writes its own credential file and the state of
 * the local runtime it starts; the versions it saves on every save are ADR-0101's decision for
 * `local`: `aw dev` reuses `aw push --yes` with `local` as the only target, and only ever writes to
 * the runtime it started, through the SDK. The read-only form of the same write is `aw push`
 * without `--yes`. It never edits the project's files.
 */
export const devCommands: readonly LocalCommand[] = [
  command(
    'dev',
    '[--quiet] [--verbose] [--open | --no-open] [--sandbox <local|docker>] [--port <n>]',
    'Run this project on a local runtime (on --port, else PORT, else environments.local.port), sign aw in, create the default model connection and push agents/ and surfaces/ to local on every save; --sandbox docker (or runtime.default: docker) needs a reachable Docker',
    { controlPlane: 'none', run: runDev },
  ),
  command(
    'dev status',
    '[--json]',
    "Say whether this project's aw dev is running and ready, and its URL; exits non-zero while it is starting or stopped",
    { controlPlane: 'none', run: runDevStatus },
  ),
  command(
    'dev stop',
    '',
    "Stop this project's running aw dev (a background start too), its runtime and its database",
    { controlPlane: 'none', run: runDevStop },
  ),
];
