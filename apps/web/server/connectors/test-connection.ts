/**
 * Test Connection — spec §8, the R-06 research note §4 (the deliverable).
 *
 * Completes the real MCP lifecycle — `initialize` → validate protocol version →
 * `notifications/initialized` → `tools/list` — over whichever transport the connector uses, using
 * the from-scratch wire clients in `./wire/*.ts` (see `classify.ts`'s header for why this does not
 * depend on `@modelcontextprotocol/sdk`). DNS resolving, a TCP connect, or an HTTP 200 on some
 * unrelated path are all insufficient — R-06 §4.1 — which is why every transport probe goes all
 * the way to a real `tools/list` count before reporting success.
 *
 * Every outcome is a tagged {@link TestConnectionOutcome}, never a parsed string. `classify.ts`
 * decides the tag on positive assertions only, ending in an explicit `unknown-failure` else
 * (ADR-0015) — there is no path here on which an unrecognised failure reads as success.
 */
import {
  classify,
  MESSAGES,
  type FailureKind,
  type MessageDetail,
  type ProbeSignal,
} from './classify';
import { createDeadline, ProbeError } from './wire/probe-error';
import { probeHttp } from './wire/http';
import { probeSse } from './wire/sse';
// There is intentionally no stdio probe implementation in this process. ADR-0045 forbids the
// control plane from spawning a caller-supplied command; that capability belongs in a sandboxed
// runner when it is implemented.

/** Ten seconds — far shorter than the MCP SDK's own 60s per-request default (R-06 §5), because
 *  this is a button a person is looking at. */
export const CONNECT_TIMEOUT_MS = 10_000;

export type TestConnectionConfig =
  | {
      readonly transport: 'stdio';
      readonly command: string;
      readonly args: readonly string[];
      /** The connector's own declared environment, stored for the future sandboxed runner. */
      readonly env: Readonly<Record<string, string>>;
      /** Whether the caller considers a credential configured — see `contract.ts`'s
       *  `credentialConfiguredForAuthType`. Never inferred from `env` here (ADR-0015): "some
       *  environment variable exists" is true of every stdio connector once the runner's own
       *  environment is overlaid underneath it, and decides nothing. */
      readonly credentialConfigured: boolean;
    }
  | {
      readonly transport: 'http' | 'sse';
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly credentialConfigured: boolean;
    };

export type TestConnectionOutcome =
  | {
      readonly ok: true;
      readonly kind: 'ok';
      readonly message: string;
      readonly serverName: string | null;
      readonly serverVersion: string | null;
      readonly toolCount: number;
    }
  | {
      readonly ok: false;
      readonly kind: FailureKind;
      readonly message: string;
    };

function describeSignal(signal: ProbeSignal, fallback: string): string {
  switch (signal.kind) {
    case 'json-rpc-app-error':
      return signal.message;
    case 'json-rpc-protocol-error':
      return `JSON-RPC error ${String(signal.code)}`;
    case 'sse-transport-error':
      return signal.text;
    case 'unknown':
      return signal.detail;
    case 'network-error':
    case 'tls-error':
    case 'spawn-error':
      return signal.code;
    case 'process-died':
      return signal.stderr ?? `exit code ${String(signal.exitCode)}`;
    case 'protocol-version-unsupported':
      return signal.version;
    default:
      return fallback;
  }
}

/**
 * Run Test Connection against `config`, with a wall-clock deadline covering the whole sequence —
 * R-06 §4.3: the SDK's own per-request timeout would not bound the `sse` handshake, and this
 * probe has no SDK request timeout to begin with, so the deadline here is the only bound there is.
 *
 * ## `baseEnv` has no default, on purpose (ADR-0015) — and stays required even though `stdio`
 * no longer uses it (ADR-0045)
 *
 * This used to be `options.baseEnv ?? process.env`, which handed a `stdio` probe — a
 * caller-supplied command this route spawns — every secret this container's own environment
 * holds (`compose.yaml`: `DATABASE_URL`, `MASTER_ENCRYPTION_KEY`, `SESSION_SECRET`,
 * `BOOTSTRAP_ADMIN_PASSWORD`) the moment a route call site forgot to pass one. Round 2 closed that
 * by making `baseEnv` required with no fallback (see
 * `docs/adr/W2-CP-05-stdio-probe-base-env-must-not-default-to-process-env.md`) — and round 3
 * (ADR-0045) went further and removed the `spawn` itself from this function's `stdio` branch
 * below, because a narrowed environment only bounds what a spawned child's environment CONTAINS,
 * never what the child can READ (its own filesystem; on the Linux containers this deploys to,
 * `/proc/<ppid>/environ`). `baseEnv` remains required so a future delegated stdio implementation
 * cannot accidentally reintroduce an implicit `process.env` fallback at the existing call sites.
 */
export async function testConnection(
  config: TestConnectionConfig,
  options: {
    readonly timeoutMs?: number;
    /** The environment the RUNNER would launch this connector with — REQUIRED, never defaulted.
     *  Build it with `./base-env.ts`'s `restrictedBaseEnv`, never pass `process.env` itself. */
    readonly baseEnv: Readonly<Record<string, string | undefined>>;
  },
): Promise<TestConnectionOutcome> {
  if (options.baseEnv === undefined) {
    // Belt-and-braces beyond the type system: a `.js` caller or an `as any` cannot silently get
    // `process.env` back. ADR-0015 — the absence of a value must be an error, not a decision.
    throw new Error(
      'testConnection: options.baseEnv is required and was not provided. Refusing to fall back ' +
        'to process.env (that fallback is the credential leak this signature exists to prevent) ' +
        '— pass an explicit environment, e.g. restrictedBaseEnv() from ./base-env.',
    );
  }

  if (config.transport === 'stdio') {
    // ADR-0045: the control plane does not `spawn` a caller-supplied command — not with a
    // narrowed environment, not with a scrubbed message, not behind a permission check. The
    // primitive underneath a stdio probe is arbitrary code execution as the control-plane user;
    // round 2's `restrictedBaseEnv()` was a real improvement but does not and cannot close that,
    // so this branch has no local probe implementation at all. The connector is still
    // accepted and stored by `contract.ts`/`store.ts` (unaffected by this function) — only the
    // PROBE is refused here, naming the missing resource, until Wave 3's sandboxed runner exists
    // to run it safely (ADR-0035 declared gap; see this task's PR report and
    // `docs/adr/0045-the-stdio-connector-probe-runs-in-a-sandbox-or-it-does-not-run.md`).
    return {
      ok: false,
      kind: 'stdio-probe-unavailable',
      message: MESSAGES['stdio-probe-unavailable']({
        target: config.command,
        command: config.command,
        status: null,
        timeoutMs: options.timeoutMs ?? CONNECT_TIMEOUT_MS,
        stderr: null,
        detail: '',
        serverVersion: null,
      }),
    };
  }

  const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const deadline = createDeadline(timeoutMs);
  const target = config.url;

  try {
    const result =
      config.transport === 'http'
        ? await Promise.race([
            probeHttp(config.url, config.headers, deadline.signal),
            deadline.promise,
          ])
        : await Promise.race([
            probeSse(config.url, config.headers, deadline.signal),
            deadline.promise,
          ]);
    return {
      ok: true,
      kind: 'ok',
      message: MESSAGES.ok({
        target,
        command: null,
        status: null,
        timeoutMs,
        stderr: null,
        detail: '',
        serverVersion: result.serverVersion,
      }),
      serverName: result.serverName,
      serverVersion: result.serverVersion,
      toolCount: result.toolCount,
    };
  } catch (error) {
    const signal: ProbeSignal =
      error instanceof ProbeError
        ? error.signal
        : { kind: 'unknown', detail: error instanceof Error ? error.message : String(error) };
    const kind = classify(signal, { credentialConfigured: config.credentialConfigured });
    const detail: MessageDetail = {
      target,
      command: null,
      status: signal.kind === 'http-status' ? signal.status : null,
      timeoutMs,
      stderr: signal.kind === 'process-died' ? signal.stderr : null,
      detail: describeSignal(signal, error instanceof Error ? error.message : String(error)),
      serverVersion: signal.kind === 'protocol-version-unsupported' ? signal.version : null,
    };
    return { ok: false, kind, message: MESSAGES[kind](detail) };
  } finally {
    deadline.cancel();
  }
}
