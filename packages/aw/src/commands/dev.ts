import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { command, isOn, type LocalCommand, type LocalCommandContext } from '../command.js';
import { nonBlank } from '../config.js';
import { startDevApp, type RunningApp } from '../dev/app.js';
import { type DevIssuer } from '../dev/issuer.js';
import { tryPage } from '../dev/format.js';
import { createDevSyncClient, startDevSync, type DevSync } from '../dev/sync.js';
import { CommandRefusedError } from '../io.js';
import { applyProjectResources, plannedProject } from '../local-runtime/project-resources.js';
import {
  localProjectUrl,
  processAlive,
  removeRuntimeRecord,
  runningRuntime,
  writeRuntimeRecord,
} from '../local-runtime/project.js';
import { superviseLocalRuntime } from '../local-runtime/supervisor.js';
import { startToolHost, type ToolHost } from '../tools/host.js';
import { announceReady, offerChat } from './dev-presentation.js';
import {
  appOidcClient,
  existingAppBackend,
  withIssuerStarted,
  appAudience,
  settleDevApp,
  closeIssuer,
} from './dev-identity.js';
import { prepareDev } from './dev-preflight.js';

async function runDev(context: LocalCommandContext): Promise<void> {
  const { signal } = context;
  const prepared = await prepareDev(context);
  const {
    cwd,
    io,
    read,
    quiet,
    verbose,
    detected,
    defaultEngine,
    models,
    identity,
    anthropic,
    runtime,
    withheld,
    oidcMode,
    loaded,
    start: preparedStart,
  } = prepared;
  let start = preparedStart;

  // Aborted by a fatal sync error, which stops the runtime, and when `aw dev` returns.
  const lifetime = new AbortController();
  const running = AbortSignal.any([signal, lifetime.signal]);
  let fatal: Error | undefined;
  let sync: DevSync | undefined;
  let toolHost: ToolHost | undefined;
  let app: RunningApp | undefined;
  let devIssuer: DevIssuer | undefined;
  let readyDatabaseUrl: string | undefined;
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
    // It stops with aw dev, below.
    const issued = await withIssuerStarted(oidcMode, start, identity, io, cwd);
    devIssuer = issued.issuer;
    start = issued.start;
    await superviseLocalRuntime({
      launchPath: runtime.launchPath,
      cwd,
      io,
      signal: running,
      start,
      logFile,
      verbose,
      hooks: {
        onReady: ({ url, databaseUrl }) => {
          readyDatabaseUrl = databaseUrl;
          readyOrigin = new URL(url).origin;
          readySeconds = (Date.now() - startedAt) / 1000;
        },
        onSignedIn: async (session) => {
          // Issue #730: other `aw` commands in this project reach the port actually bound. The
          // supervisor stored its key before this hook, so the record never names a keyless port.
          await writeRuntimeRecord(cwd, start.environment.port);
          recorded = true;
          const client = createDevSyncClient({
            baseUrl: session.baseUrl,
            apiKey: session.apiKey,
            fetch: io.fetch,
          });
          // Issue #1506: the app's connector joins this one plan, in memory only.
          let planned = read;
          if (detected !== null) {
            const started = await startDevApp({
              client,
              cwd,
              appName: detected.name,
              read,
              session,
              webPort: start.environment.port,
              databaseUrl: nonBlank(io.env['DATABASE_URL']) ?? readyDatabaseUrl,
              env: io.env,
              stderr: io.stderr,
              signal: running,
              oidcClient: appOidcClient(devIssuer, detected.name),
              appBackend: () => existingAppBackend(client, detected.name, io.stderr, running),
            });
            app = started.app;
            planned = started.read;
          }
          const check = await applyProjectResources({
            io,
            session,
            read: planned,
            start,
            root: cwd,
            anthropicBaseUrl: anthropic.baseUrl,
            signal,
            deferModelCheck: !quiet,
          });
          const beginSync = (): DevSync =>
            startDevSync({
              client,
              root: cwd,
              io,
              // The screen shows the first surface's try URL and embed tag; any other prints its own.
              announcedSurfaces: quiet ? [] : surfaces.slice(0, 1),
              signal: running,
              origin: readyOrigin ?? session.baseUrl,
              defaultEngine,
              models,
              forkWithheld: withheld,
              project: plannedProject(read, start),
              liveProject: { read, start, session, anthropicBaseUrl: anthropic.baseUrl },
              toolHost,
              onFatal: (error) => {
                fatal ??= error;
                lifetime.abort();
              },
            });
          if (app !== undefined && detected !== null) {
            // DI10: the first sync runs before the screen, so the app's pair is settled first.
            sync = await settleDevApp({
              client,
              app,
              appName: detected.name,
              beginSync,
              oidcAudience: appAudience(devIssuer, detected.name, io.env),
              agentNames: agents.map(({ name }) => name),
              stderr: io.stderr,
              signal: running,
            });
          }
          const origin = await announceReady({
            prepared,
            session,
            check,
            ready: { origin: readyOrigin, seconds: readySeconds, logFile },
            app,
            surfaces,
          });
          const syncing = sync ?? beginSync();
          sync = syncing;
          const firstSurface = surfaces[0];
          if (firstSurface !== undefined) {
            // Not awaited: the supervisor waits for this hook before it reports a runtime exit, so a
            // question left unanswered must not hold it. `running` cancels the prompt when aw dev
            // ends; Ctrl-C at it is an interrupt that stops aw dev.
            // After the first sync's lines, so its output never lands on the question's line.
            void syncing.firstSync
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
    await app?.stop();
    await closeIssuer(devIssuer);
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
