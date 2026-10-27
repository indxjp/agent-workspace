/**
 * `@agent-workspace/runner` — the process entry point.
 *
 * This is a composition root and nothing else (§53): it reads the environment contract, calls
 * {@link startRunnerServer}, and arranges for the process to stop. There is no container, no
 * registry and no bootstrapper here, because a composition root is a file that calls
 * constructors.
 *
 * ## Why the bootstrap is behind a main-module check
 *
 * `package.json`'s `start` script is `node dist/index.js`, so this file is the module Node was
 * asked to run and {@link isMainModule} is true. It is also the package's public module — the
 * name `@agent-workspace/runner` resolves here, `index.test.ts` imports {@link PACKAGE_NAME} from
 * it, and a future consumer may import {@link main}. An unconditional `await startRunnerServer()`
 * at module scope would bind port 8080 inside the test runner. The guard is the difference
 * between "this file can start the service" and "importing this file starts a service".
 *
 * `process.argv[1]` is compared against this module's own resolved path rather than tested for a
 * substring: `require.main` does not exist in an ES module, and a substring test would call
 * `/app/dist/index.js.bak` the main module. `realpathSync` is applied to both sides because pnpm
 * installs workspace packages as symlinks and Node resolves `argv[1]` through them, so the two
 * spellings of the same file would otherwise differ. A comparison that cannot be made — an
 * `argv[1]` that does not exist on disk — answers *false*, i.e. does not start a server, because
 * the failure mode of guessing wrong in the other direction is a server nobody asked for.
 *
 * ## What it reads
 *
 * `PORT` and `HOST`, through `startRunnerServer`, which owns both defaults (§14.3's 8080, and
 * `0.0.0.0` because a runtime container exists to be reached from outside itself). Every
 * *per-run* value — `cwd`, the tenant session scope, the tenant's own environment — travels in
 * the `POST /run` body, which is what makes one runtime container serve any tenant that reaches
 * it. See the trust note at the top of `server.ts` for what that implies and why the socket is
 * driver-private.
 *
 * The two things this file adds to `startLocalAgent` are the two the *container*, not the
 * caller, has to supply. Both are documented at {@link runnerBaseEnvironment} and
 * {@link startAgentInThisContainer}, and both were established by running the thing:
 * a `POST /run` whose body validated and whose `env` was `{}` reached the SDK and came back
 * `run-failed`, because a subprocess with no `PATH` cannot spawn.
 */
import { mkdirSync, realpathSync } from 'node:fs';
import type { Server } from 'node:http';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createJsonLogger } from '@agent-workspace/core/telemetry';
import { startTracing } from '@agent-workspace/core/tracing';
import type { EngineRunRequest, EngineStartContext } from '@agent-workspace/engine';

import { loadEngine, toEngineRunRequest } from './engines.js';
import { runnerBaseEnvironment, runnerEnvironmentFor } from './environment.js';
import { startEngineAgent, type EngineStartOutcome } from './runtime.js';
import { materializeRunResources, type ResolvedRunRequest } from './resources.js';
import { startRunnerServer } from './server.js';
import { createHttpEngineSessionStore } from './session-state.js';
import { MIRROR_TOKEN_ENV, readMirrorConfig } from './session.js';

const log = createJsonLogger({ service: 'runner' });

/** The workspace name, kept from the Wave-0 placeholder because `index.test.ts` asserts it. */
export const PACKAGE_NAME = '@agent-workspace/runner';
export { runnerBaseEnvironment } from './environment.js';

/** The signals a container runtime uses to ask a process to stop. */
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * How long a shutdown waits for in-flight sockets before the process leaves anyway.
 *
 * `server.close()` stops accepting and then waits for every open connection to end. A `POST /run`
 * response is a deliberately long-lived SSE stream (`server.ts`), so "every connection ended" can
 * be minutes away, and a container runtime's own patience is finite — Docker sends `SIGKILL` ten
 * seconds after `SIGTERM` by default. Waiting forever would turn every stop into that `SIGKILL`,
 * which is the same outcome with none of the logging. So the wait is bounded and the bound is
 * shorter than Docker's, and what happens at the bound is stated rather than left to a signal.
 */
const SHUTDOWN_GRACE_MS = 8_000;

/** Exit code for a start-up that could not proceed — an unusable `PORT`, or a bind failure. */
const EXIT_STARTUP_FAILED = 1;

/** Exit code for a shutdown that gave up on a connection that would not close. */
const EXIT_SHUTDOWN_TIMED_OUT = 2;

/**
 * Is this module the one Node was asked to run?
 *
 * Answers `false` for anything it cannot establish, which is the direction that fails closed:
 * the consequence of a wrong `true` is a listening socket opened by an import.
 */
export function isMainModule(entry: string | undefined, moduleUrl: string): boolean {
  if (entry === undefined || entry.length === 0) return false;
  let resolvedEntry: string;
  let resolvedSelf: string;
  try {
    resolvedEntry = realpathSync(entry);
    resolvedSelf = realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
  return resolvedEntry === resolvedSelf;
}

/**
 * Close the server, and say which of the two ways it finished.
 *
 * `'closed'` is a positive assertion that `close()`'s callback ran, not the absence of an error
 * (ADR-0015). `'timed-out'` is the honest name for the other outcome: connections were still
 * open when the grace period expired and this process is leaving without them.
 */
export function closeServer(
  server: Server,
  graceMs: number = SHUTDOWN_GRACE_MS,
): Promise<'closed' | 'timed-out'> {
  return new Promise<'closed' | 'timed-out'>((resolve) => {
    const timer = setTimeout(() => {
      resolve('timed-out');
    }, graceMs);
    // Node keeps the process alive for a pending timer, and this one must never be the reason a
    // shutdown hangs — the timer exists to end a wait, not to extend one.
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve('closed');
    });
  });
}

/**
 * Start one run in this container: materialise the workspace root, then delegate.
 *
 * **The `cwd` is created here because nothing else can.** §14.3's body chooses the run's `cwd`,
 * and in every deployment except `local` the control plane that chose it has no filesystem in
 * common with the container that must chdir into it. The SDK spawns with that directory as its
 * working directory and fails if it does not exist. `recursive: true` makes it idempotent, which
 * is what a second run in the same workspace needs. The engine's **own** configuration directory is
 * created for the same reason, by `./resources.ts`, from the name the adapter declares: for Claude
 * it is `CLAUDE_CONFIG_DIR`, and R-01 §7 records that the SDK silently ignores the project-key
 * override when it cannot use it — a silent fallback to the sanitised `cwd` is the cross-tenant
 * collision the tenant session scope exists to prevent, so it is not a directory to leave to
 * chance. Which directory it is, this file no longer knows (ENG-04b).
 *
 * A caller of this socket can therefore create a directory anywhere the runner's user can write.
 * That is not a new capability: `local` declares `isolation: 'none'` and `execCommands`, so the
 * same caller can already run a command as that user. The bound is the network, and it is the
 * one `server.ts` states.
 *
 * The request's own `env` wins over the container's. A tenant value and a container value for
 * one name is a conflict the run's own request should decide.
 */
export async function startAgentInThisContainer(
  request: ResolvedRunRequest,
  base: Record<string, string> = runnerBaseEnvironment(),
  context: EngineStartContext = {},
): Promise<EngineStartOutcome> {
  const lookup = await loadEngine(request.engine);
  if (!lookup.ok) return { ok: false, code: lookup.code, reason: lookup.reason };
  const engineRequest: EngineRunRequest = {
    ...toEngineRunRequest(request),
    env: runnerEnvironmentFor(request.env, base),
  };
  // Compiled **before** the sandbox is touched, so a refusal leaves nothing behind (ENG-09, #308).
  // `startEngineAgent` states the invariant — a run whose options could not be compiled has not
  // written to the sandbox — and materialising first broke it: the run's directories, files and
  // skills were written and only then refused. For an engine that declares `skills: false` it was
  // worse, because an adapter that places nothing has its granted skill refused as unplaced by
  // `skillPlacementVerdict`, an untyped throw in place of the adapter's
  // `engine_capability_unsupported`. `compile` is pure, so `startEngineAgent` compiling the same
  // request again is the same answer.
  const compiled = lookup.engine.compile(engineRequest);
  if (!compiled.ok) return { ok: false, code: compiled.code, reason: compiled.reason };
  mkdirSync(request.cwd, { recursive: true });
  // ENG-04b: the engine says where its own configuration and its skills live, and this application
  // does the writing. `materializeRunResources` creates the configuration directory too, because
  // which directory that is is now the adapter's answer rather than this file's.
  materializeRunResources(request, engineRequest, lookup.engine);
  return startEngineAgent(lookup.engine, engineRequest, context);
}

/**
 * The `SessionStore` every run in this container mirrors its transcript to, or none — decided
 * once, at start-up, and refusing to start on a half-configured mirror.
 *
 * `docs/adr/W2-CP-07-the-two-wiring-lines-this-task-does-not-own.md` wrote this call out and
 * declined to make it: `apps/runner/src/index.ts` is W1-COMP-01's file, and W2-CP-07 could not
 * promise disjointness on it. It is made here because deciding what a process installs is
 * composition, and ADR-0038 puts composition at the integration level. This is the runner's
 * composition root exactly as `apps/web/instrumentation.ts` is the web application's.
 *
 * The three arms are `readMirrorConfig`'s, and each is answered rather than collapsed:
 *
 *   * `invalid` **throws**, so the process exits 1 with the reason named. An operator who set
 *     `AW_SESSION_MIRROR_URL` and forgot the cookie was turning durability *on*; starting anyway
 *     would hand them a runtime whose sessions cannot be resumed and no sentence saying so, which
 *     is ADR-0015's shape and the reason `readMirrorConfig` has an `invalid` arm at all.
 *   * `absent` installs nothing, and says so. The run is honestly not durable, `claude.ts`'s
 *     `sessionDurability()` reports that, and spec §14.9's release blocker is visible rather than
 *     hidden behind a store that silently kept nothing.
 *   * `configured` installs the HTTP store, whose target is the web application's
 *     `/api/sessions/:engineSessionId/state-*` — the routes the web composition root installs as
 *     `ApplicationContext.sessions`. The two halves of §14.9 only work together, which is why they land in the same task.
 *
 * `engine` is the run's own (`RunRequest.engine`), because a stream is engine-scoped: the control
 * plane refuses a write whose engine disagrees with the one the session is pinned to
 * (`409 session_engine_mismatch`), and a default chosen here rather than read from the request
 * would make that refusal fire on a correct run.
 */
export function sessionMirrorDeps(
  env: Readonly<Record<string, string | undefined>> = process.env,
  runToken?: string,
  engine = 'claude-agent-sdk',
): EngineStartContext {
  const config = readMirrorConfig(env);
  switch (config.kind) {
    case 'invalid':
      throw new Error(config.reason);
    case 'configured':
      if (typeof runToken !== 'string' || runToken.trim().length === 0) {
        throw new Error(
          `${MIRROR_TOKEN_ENV} is absent from this RunRequest. Transcript mirroring requires ` +
            'the signed per-run claim; a deployment-wide mirror bearer is not accepted.',
        );
      }
      log.info('session store installed (spec §14.9)', { engine });
      return {
        sessionStore: createHttpEngineSessionStore({ ...config, token: runToken, engine }),
        // The same control plane and per-run bearer carry the run's `search_files` calls (ADR-0147).
        fileSearch: { baseUrl: config.baseUrl, token: runToken },
      };
    case 'absent':
      log.warn('no session mirror', { reason: config.reason });
      return {};
    default: {
      // The rejecting `else`. `MirrorConfig` is a closed union today; a fourth arm added without
      // a decision here must stop the runner rather than be read as "no mirror".
      const unreachable: never = config;
      throw new Error(
        `unclassified mirror configuration ${JSON.stringify(unreachable)} — refusing to start`,
      );
    }
  }
}

/**
 * Start the §14.3 server and register the shutdown path. Resolves once the socket is bound.
 *
 * Exported so a caller — a test, or a supervisor that wants the address — can start the service
 * without going through `argv`. The signal handlers are registered here rather than at module
 * scope so that importing this module installs nothing.
 */
export async function main(): Promise<{ server: Server; url: string }> {
  // The container's environment is read once, at start-up, and closed over: a run must not see
  // a variable something mutated between requests.
  const base = runnerBaseEnvironment();
  // Read before the socket is bound: a half-configured mirror is a start-up failure, and a
  // start-up failure that happened after the port was published is one a health check calls
  // healthy. `sessionMirrorDeps` throws, and the caller below turns that into exit 1 by name.
  const mirrorConfig = readMirrorConfig(process.env);
  if (mirrorConfig.kind === 'invalid') throw new Error(mirrorConfig.reason);
  const tracing = await startTracing('agent-workspace-runner', process.env, log);
  const { server, address } = await startRunnerServer(process.env, {
    logger: log,
    startAgent: (request: ResolvedRunRequest): Promise<EngineStartOutcome> =>
      startAgentInThisContainer(
        request,
        base,
        sessionMirrorDeps(process.env, request.env[MIRROR_TOKEN_ENV], request.engine),
      ),
  });
  // An IPv6 bind reports `::`, whose URL form needs brackets; anything else is printed as given.
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const url = `http://${host}:${String(address.port)}`;

  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {
      // A second signal is an operator saying "stop waiting". Honour it rather than logging.
      log.error('second signal; leaving without waiting for in-flight runs', { signal });
      process.exit(EXIT_SHUTDOWN_TIMED_OUT);
    }
    stopping = true;
    log.info('signal received; closing and finishing in-flight runs', { signal });
    void closeServer(server).then(async (outcome) => {
      await tracing
        ?.shutdown()
        .catch((error: unknown) => log.error('spans were not flushed', { error }));
      for (const s of SHUTDOWN_SIGNALS) process.off(s, stop);
      if (outcome === 'closed') {
        log.info('closed cleanly');
        return;
      }
      log.error('connections were still open after the grace period; exiting anyway', {
        graceMs: SHUTDOWN_GRACE_MS,
      });
      process.exit(EXIT_SHUTDOWN_TIMED_OUT);
    });
  };
  for (const signal of SHUTDOWN_SIGNALS) process.on(signal, stop);

  log.info('serving the spec §14.3 runtime contract', {
    port: address.port,
    endpoints: 'GET /healthz · POST /run · POST /interrupt · POST/GET /files',
  });
  return { server, url };
}

if (isMainModule(process.argv[1], import.meta.url)) {
  try {
    await main();
  } catch (error) {
    // A start-up failure is fatal and is named. `parsePort` throws for a malformed `PORT`, and
    // `listen` rejects for a port already in use or a host that cannot be bound; neither has a
    // sensible fallback, and a runtime container that came up on a port nobody chose is worse
    // than one that did not come up.
    log.error('failed to start', { error });
    process.exit(EXIT_STARTUP_FAILED);
  }
}
