/**
 * `tests/conformance/fixtures/common.ts` — the fixture request/event shapes and the one starter
 * factory every fixture driver in this directory builds on.
 *
 * None of this is production code. `RuntimeDriver<TRequest, TEvent>` (spec §14.2) is generic
 * exactly so that the concrete request and event shapes are the caller's choice — in production,
 * `apps/runner/src/runtime.ts` supplies `@agent-workspace/core`'s real `RunRequest` /
 * `ClassifiedSdkEvent`; here, `tests/conformance/**` supplies its own, small and self-contained,
 * so the harness can be proven against `local` (and against the two fixtures in this directory)
 * without a model, a container runtime, or real network infrastructure. See `types.ts`'s
 * `A12Probe` doc comment for why this seam exists rather than the suite guessing a concrete shape.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentStarter } from '@agent-workspace/runtime';
import type {
  A12AgentAction,
  A12AgentOutcome,
  A12AgentProbe,
  A12PathTarget,
  RuntimeHandle,
} from '../types.js';

export type FixtureEvent =
  | {
      readonly type: 'started';
      readonly sessionId: string;
      readonly claudeConfigDir: string;
      readonly settingSources: readonly string[];
    }
  | { readonly type: 'output'; readonly text: string }
  | {
      readonly type: 'network-result';
      readonly allowedReachable: boolean;
      readonly blockedReachable: boolean;
    }
  | { readonly type: 'read-path-result'; readonly succeeded: boolean; readonly content?: string }
  | { readonly type: 'write-path-result'; readonly succeeded: boolean }
  | { readonly type: 'interrupted' }
  | { readonly type: 'completed' };

export type FixtureRequest = {
  readonly action: A12AgentAction;
  readonly claudeConfigDir: string;
  readonly settingSources: readonly string[];
};

/**
 * The in-memory stand-in for spec §20's durable `SessionStore`.
 *
 * A real deployment persists Agent SDK session state in PostgreSQL and object storage
 * (§14.6: *"Session durability lives in PostgreSQL and object storage, never in a sandbox"*), so
 * that a fresh sandbox can resume a session the old one never knew about. This suite has neither,
 * and it is not this task's job to build one (§20 is W2-CP-07's, already on `main`) — this map
 * plays the same *role* for scenario 4 (`resume-after-sandbox-gone`) only: it is keyed by session
 * id, lives for the lifetime of the Node process, and is read by `'resume'` actions and written by
 * both `'trivial'` and `'resume'` ones. What it proves is narrower than the real thing: that the
 * *driver* contract does not stand in the way of resuming a session on a brand-new sandbox handle
 * (a fresh `create()`, a different `workspacePath`), because the driver never touches this map —
 * only the injected starter does, exactly as production's does through a real store instead.
 */
const sessionTranscripts = new Map<string, string[]>();

/** One request per `buildRequest` call, with a fresh config dir each time — see `types.ts`'s doc on `A12AgentOutcome.config` and scenario 10. */
export function buildFixtureRequest(action: A12AgentAction): FixtureRequest {
  return {
    action,
    claudeConfigDir: path.join(tmpdir(), 'a12-fixture-claude-config', randomUUID()),
    settingSources: [],
  };
}

/** Whether a network probe's `allowed`/`blocked` host is reachable. `true` for both is "open". */
export type FixtureNetworkPolicy = (hostKind: 'allowed' | 'blocked') => boolean;

/** Whether — and with what content — a `'read-path'` action can read `target`. */
export type FixtureFileAccess = (
  runtime: RuntimeHandle,
  target: A12PathTarget,
) => Promise<{ readonly succeeded: boolean; readonly content?: string }>;

/** Whether — and with what result — a `'write-path'` action can create `target` with `content`. */
export type FixtureFileWrite = (
  runtime: RuntimeHandle,
  target: A12PathTarget,
  content: string,
) => Promise<{ readonly succeeded: boolean }>;

/**
 * Resolves an `A12PathTarget` to a real filesystem path for a fixture that mounts a real host
 * directory (`local`, `container-fixture.ts`) — i.e. one where `handle.workspacePath` really is
 * where the sandbox's own workspace lives. This is a resolution choice ONE KIND of fixture makes,
 * never something `tests/conformance/scenarios.ts` assumes on a driver's behalf: a fixture whose
 * sandbox view differs from its host mount (or has none at all, `file-transfer-fixture.ts`) defines
 * its own `FixtureFileAccess`/`FixtureFileWrite` instead of calling this — see `types.ts`'s doc
 * comment on `A12PathTarget` for why the translation belongs here, not in the scenario.
 */
function resolveMountedTargetPath(target: A12PathTarget): string {
  return target.locus === 'host'
    ? target.absolutePath
    : path.join(target.handle.workspacePath, target.relativePath);
}

/** Reads whatever the host process running the test can read — `local`'s honest answer: everything. */
export const OPEN_NETWORK: FixtureNetworkPolicy = () => true;

/** Reachable only through the fixture's stated "gateway": what a real enforcing driver reports. */
export const ENFORCED_NETWORK: FixtureNetworkPolicy = (hostKind) => hostKind === 'allowed';

/**
 * No isolation: reads whatever host path is asked for, file or directory, and treats a
 * `'workspace'`-locus target as just another host path via `resolveMountedTargetPath` — `local`'s
 * honest answer, since it mounts every session's workspace straight onto a host directory with no
 * boundary at all. A directory target (scenario 10 asks about a host directory) is listed with
 * `readdir` rather than passed to `readFile` — `readFile` on a directory rejects with `EISDIR`,
 * which would report "unreachable" for the wrong reason (a node:fs API mismatch, not an isolation
 * boundary) regardless of whether the directory is actually visible. `succeeded: true` here means
 * only "something was observed at this path," which is exactly the question A.12 scenario 10 and
 * the adversarial half of scenario 9 ask — not that a specific file exists there.
 */
export const OPEN_FILE_ACCESS: FixtureFileAccess = async (_runtime, target) => {
  const targetPath = resolveMountedTargetPath(target);
  try {
    const info = await stat(targetPath);
    if (info.isDirectory()) {
      const entries = await readdir(targetPath);
      return { succeeded: true, content: entries.join(',') };
    }
    return { succeeded: true, content: await readFile(targetPath, 'utf8') };
  } catch {
    return { succeeded: false };
  }
};

/**
 * A real boundary for a fixture that mounts one session's workspace onto its own host directory:
 * refuses a `'workspace'`-locus target that names any handle OTHER than the one this sandbox is
 * actually running as — the adversarial case scenario 9 exercises — before ever resolving a path,
 * and refuses a `'host'`-locus (or same-handle `'workspace'`-locus) target outside that directory.
 * Both checks run before ever touching the filesystem.
 */
export const SANDBOXED_FILE_ACCESS: FixtureFileAccess = async (runtime, target) => {
  if (target.locus === 'workspace' && target.handle.id !== runtime.id) {
    return { succeeded: false };
  }
  const targetPath = resolveMountedTargetPath(target);
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(runtime.workspacePath);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    return { succeeded: false };
  }
  return await OPEN_FILE_ACCESS(runtime, target);
};

/** Writes wherever the host process running the test can write — `local`'s honest answer: everything. */
export const OPEN_FILE_WRITE: FixtureFileWrite = async (_runtime, target, content) => {
  const targetPath = resolveMountedTargetPath(target);
  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, 'utf8');
    return { succeeded: true };
  } catch {
    return { succeeded: false };
  }
};

/** Refuses to write to another session's workspace, or outside `runtime.workspacePath`. See {@link SANDBOXED_FILE_ACCESS}. */
export const SANDBOXED_FILE_WRITE: FixtureFileWrite = async (runtime, target, content) => {
  if (target.locus === 'workspace' && target.handle.id !== runtime.id) {
    return { succeeded: false };
  }
  const targetPath = resolveMountedTargetPath(target);
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(runtime.workspacePath);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    return { succeeded: false };
  }
  return await OPEN_FILE_WRITE(runtime, target, content);
};

/**
 * Builds an {@link AgentStarter} — the same injection point `packages/runtime/src/local.ts`
 * defines and `createLocalDriver` takes as its one constructor argument. `fixtures/container-fixture.ts`
 * calls this directly from inside its own hand-written `RuntimeDriver.startAgent`, since the
 * returned function's shape — `(runtime, request) => AgentConnection<TEvent> | Promise<...>` — is
 * exactly `RuntimeDriver.startAgent`'s own signature once a handle is known to be live.
 */
export function createFixtureStarter(
  options: {
    readonly network?: FixtureNetworkPolicy;
    readonly fileAccess?: FixtureFileAccess;
    readonly fileWrite?: FixtureFileWrite;
    /**
     * When set, the `'long-running'` branch below enforces this ceiling itself — the fixture's
     * own analogue of a real driver's cpu/memory/timeout ceiling (§14.4, `RuntimeCapabilities.
     * maxSessionSeconds`). Left unset (as `local-fixture.ts` leaves it), a `'long-running'` turn
     * runs until something external calls `interrupt()`, exactly matching `local`'s own honest
     * `maxSessionSeconds: null`. This is the seam `tests/conformance/scenarios.ts`'s
     * `enforce-resource-limits` scenario (A.12 #7) actually exercises: the scenario itself never
     * calls `interrupt()` (ADR-0046 rule 2 — a gate must not supply the force it is testing for),
     * so a fixture that declares a ceiling and does not wire this option will run forever and the
     * scenario will honestly report `fail`, not a manufactured `pass`.
     */
    readonly maxSessionSeconds?: number;
  } = {},
): AgentStarter<FixtureRequest, FixtureEvent> {
  const network = options.network ?? OPEN_NETWORK;
  const fileAccess = options.fileAccess ?? OPEN_FILE_ACCESS;
  const fileWrite = options.fileWrite ?? OPEN_FILE_WRITE;
  const maxSessionSeconds = options.maxSessionSeconds;

  return (runtime, request) => {
    const { action } = request;
    const sessionId = action.kind === 'resume' ? action.priorSessionId : randomUUID();

    let resolveInterrupt: () => void = () => {
      /* replaced synchronously below */
    };
    const interrupted$ = new Promise<void>((resolve) => {
      resolveInterrupt = resolve;
    });

    async function* generate(): AsyncGenerator<FixtureEvent> {
      yield {
        type: 'started',
        sessionId,
        claudeConfigDir: request.claudeConfigDir,
        settingSources: request.settingSources,
      };

      if (action.kind === 'trivial') {
        const prior = sessionTranscripts.get(sessionId) ?? [];
        sessionTranscripts.set(sessionId, [...prior, action.marker]);
        yield { type: 'output', text: action.marker };
        yield { type: 'completed' };
        return;
      }

      if (action.kind === 'resume') {
        const prior = sessionTranscripts.get(sessionId) ?? [];
        const updated = [...prior, action.marker];
        sessionTranscripts.set(sessionId, updated);
        // Echoing the whole transcript, not only the new marker, is what makes "continuity" an
        // observable fact in the events rather than an assumption: scenario 4 asserts both the
        // pre-destroy marker and the post-resume one appear in this one turn's output.
        yield { type: 'output', text: updated.join(' | ') };
        yield { type: 'completed' };
        return;
      }

      if (action.kind === 'network-probe') {
        yield {
          type: 'network-result',
          allowedReachable: network('allowed'),
          blockedReachable: network('blocked'),
        };
        yield { type: 'completed' };
        return;
      }

      if (action.kind === 'read-path') {
        const result = await fileAccess(runtime, action.target);
        yield { type: 'read-path-result', ...result };
        yield { type: 'completed' };
        return;
      }

      if (action.kind === 'write-path') {
        const result = await fileWrite(runtime, action.target, action.content);
        yield { type: 'write-path-result', ...result };
        yield { type: 'completed' };
        return;
      }

      // 'long-running': streams output until interrupt() resolves interrupted$, or — when a
      // ceiling was configured above — until this fixture's own enforcement of it fires first.
      // Nothing here is driven by the scenario: the scenario only *observes* whether the turn
      // stopped inside its declared budget.
      let limitTimer: ReturnType<typeof setTimeout> | undefined;
      const limitReached$: Promise<void> =
        maxSessionSeconds === undefined
          ? new Promise<void>(() => {
              /* never resolves — no ceiling declared, matching an honest `maxSessionSeconds: null` */
            })
          : new Promise<void>((resolve) => {
              limitTimer = setTimeout(resolve, maxSessionSeconds * 1000);
            });

      let tick = 0;
      for (;;) {
        yield { type: 'output', text: `${action.marker}-${String(tick)}` };
        tick += 1;
        const winner = await Promise.race([
          new Promise<'tick'>((resolve) => {
            setTimeout(() => {
              resolve('tick');
            }, 20);
          }),
          interrupted$.then((): 'interrupt' => 'interrupt'),
          limitReached$.then((): 'limit' => 'limit'),
        ]);
        if (winner === 'interrupt' || winner === 'limit') break;
      }
      if (limitTimer !== undefined) {
        clearTimeout(limitTimer);
      }
      yield { type: 'interrupted' };
    }

    const iterator = generate();
    let resolveSessionId: (value: string) => void = () => {
      /* replaced synchronously below */
    };
    const sessionIdPromise = new Promise<string>((resolve) => {
      resolveSessionId = resolve;
    });
    let sessionIdSettled = false;

    return {
      events: {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              const result = await iterator.next();
              if (!sessionIdSettled && !result.done && result.value.type === 'started') {
                sessionIdSettled = true;
                resolveSessionId(result.value.sessionId);
              }
              return result;
            },
          };
        },
      },
      sessionId: sessionIdPromise,
      async interrupt() {
        resolveInterrupt();
        return await Promise.resolve();
      },
    };
  };
}

/** The `A12AgentProbe` every fixture in this directory shares — `interpretEvents` never varies. */
export const fixtureAgentProbe: A12AgentProbe<FixtureRequest, FixtureEvent> = {
  buildRequest: buildFixtureRequest,
  interpretEvents(events: readonly FixtureEvent[]): A12AgentOutcome {
    const outputs = events
      .filter(
        (event): event is Extract<FixtureEvent, { type: 'output' }> => event.type === 'output',
      )
      .map((event) => event.text);
    const started = events.find(
      (event): event is Extract<FixtureEvent, { type: 'started' }> => event.type === 'started',
    );
    const networkResult = events.find(
      (event): event is Extract<FixtureEvent, { type: 'network-result' }> =>
        event.type === 'network-result',
    );
    const readPathResult = events.find(
      (event): event is Extract<FixtureEvent, { type: 'read-path-result' }> =>
        event.type === 'read-path-result',
    );
    const writePathResult = events.find(
      (event): event is Extract<FixtureEvent, { type: 'write-path-result' }> =>
        event.type === 'write-path-result',
    );
    const wasInterrupted = events.some((event) => event.type === 'interrupted');

    return {
      containsMarker: (marker) => outputs.some((text) => text.includes(marker)),
      wasInterrupted,
      ...(networkResult
        ? {
            network: {
              allowedReachable: networkResult.allowedReachable,
              blockedReachable: networkResult.blockedReachable,
            },
          }
        : {}),
      ...(readPathResult
        ? {
            readPath: {
              succeeded: readPathResult.succeeded,
              ...(readPathResult.content !== undefined ? { content: readPathResult.content } : {}),
            },
          }
        : {}),
      ...(writePathResult ? { writePath: { succeeded: writePathResult.succeeded } } : {}),
      ...(started
        ? {
            config: {
              claudeConfigDir: started.claudeConfigDir,
              settingSources: started.settingSources,
            },
          }
        : {}),
    };
  },
};
