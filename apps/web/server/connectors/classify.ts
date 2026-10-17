/**
 * The Test Connection classifier — spec §8, the R-06 research note §4.
 *
 * ## Why this does not import `@modelcontextprotocol/sdk`
 *
 * R-06 §4.6's reference implementation is built on that package, and its header says plainly
 * "W2-CP-05 copies this file". This task's dispatch protocol is more specific than that note for
 * THIS wave: *"every `package.json` and `pnpm-lock.yaml` belong to the INTEGRATION task
 * W2-INT-02 … If you need a dependency … STATE IT … and DO NOT add it. Your routes will answer 503
 * until the integrator wires you up, and that is the correct intermediate state."* A Test
 * Connection button that answers 503 until a dependency lands cannot meet this task's acceptance
 * criterion (the Wave 2 plan 2b-2: *"a wrong URL and a wrong token produce two different
 * human-readable errors — drive both and paste both messages"*), which demands a real, driven
 * probe now, not after an integration round.
 *
 * So `wire/*.ts` speaks the MCP wire protocol directly — JSON-RPC 2.0 framed over stdio/http/sse
 * per the MCP specification — using only Node built-ins (`node:child_process`, `fetch`), and
 * reports what happened as a {@link ProbeSignal} rather than as an SDK error object. This module
 * turns a signal into exactly one {@link FailureKind}, preserving every discriminator R-06 §4.2
 * verified: the HTTP status split, the JSON-RPC pre-defined-vs-application error range split (mind
 * the direction — R-06 found an earlier draft's range comparison unsatisfiable), and the
 * credential-configured split on 401 and on a server-sent application error.
 *
 * Measured empirically before this file was written (`pnpm install --frozen-lockfile` in this
 * task's own worktree, checked against `apps/web/node_modules/` and `apps/runner/node_modules/`):
 * `@modelcontextprotocol/sdk` is not reachable from either without a new dependency declaration —
 * confirming R-06 §4.6's own finding that it is not yet a declared dependency of any workspace
 * package, only a transitive peer of `@anthropic-ai/claude-agent-sdk`.
 *
 * ADR-0015 governs every branch here exactly as it governs R-06's reference `classify()`: each
 * arm decides on a positive assertion, and the final arm is an explicit `else` that returns
 * `unknown-failure` — there is no path on which an unrecognised signal reads as success.
 */

/** Every outcome this probe can report. Tests assert on this; the sentence is derived from it. */
export const FAILURE_KINDS = [
  'auth-required',
  'credential-rejected',
  'credential-insufficient-scope',
  'unreachable',
  'endpoint-not-mcp',
  'tls-error',
  'command-not-found',
  'process-died',
  'timeout',
  'protocol-version-unsupported',
  'server-error',
  'rate-limited',
  'http-error',
  'server-refused',
  'sse-stream-failed',
  'unknown-failure',
  /** stdio only, and reached before any probe runs at all (ADR-0045) — this deployment has no
   *  sandbox to run a caller-supplied command in, so the control plane never spawns one. Not a
   *  probe failure signal; `test-connection.ts` returns this directly, without classifying a
   *  {@link ProbeSignal}, because there is no signal — nothing was ever executed. */
  'stdio-probe-unavailable',
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/**
 * What one transport probe observed, before it is turned into a {@link FailureKind}. Each member
 * is a POSITIVE fact this probe's own wire code established — never "nothing else matched".
 */
export type ProbeSignal =
  /** http or sse: an HTTP response with this status arrived (transport-level, before any
   *  JSON-RPC body is trusted — R-06 §4.2's `StreamableHTTPError.code`/`SseError.code` role). */
  | { readonly kind: 'http-status'; readonly status: number }
  /** A JSON-RPC error object arrived FROM THE SERVER, in the JSON-RPC application range
   *  (-32000..-32099, MCP's convention for e.g. "Unauthorized"). This is the one channel a stdio
   *  server has for "your credential is wrong" (R-06 §4.2, §7's stdio row). */
  | { readonly kind: 'json-rpc-app-error'; readonly code: number; readonly message: string }
  /** A JSON-RPC error arrived in the protocol's OWN pre-defined range (-32700..-32600): the peer
   *  speaks JSON-RPC but does not implement MCP's `initialize`. */
  | { readonly kind: 'json-rpc-protocol-error'; readonly code: number }
  /** The peer answered, but not with anything JSON-RPC-shaped at all. */
  | { readonly kind: 'not-json-rpc' }
  /** A socket/DNS/connect-level failure, with Node's own errno. */
  | { readonly kind: 'network-error'; readonly code: string }
  /** A TLS-level failure, with Node's own errno/reason. */
  | { readonly kind: 'tls-error'; readonly code: string }
  /** sse only: a transport-level failure with no structured code — R-06 §4.2's documented gap.
   *  `text` is scanned for a known errno token before this is trusted as genuinely unclassifiable. */
  | { readonly kind: 'sse-transport-error'; readonly text: string }
  /** stdio only: the child could not be spawned at all (`ENOENT`, `EACCES`, …). */
  | { readonly kind: 'spawn-error'; readonly code: string }
  /** stdio only: the child started and exited/closed before answering. */
  | {
      readonly kind: 'process-died';
      readonly exitCode: number | null;
      readonly stderr: string | null;
    }
  /** The server's `initialize` reply named a protocol version this probe does not support. */
  | { readonly kind: 'protocol-version-unsupported'; readonly version: string }
  /** This probe's own wall-clock deadline fired — R-06 §4.3: the one enforced by the caller,
   *  because no per-request timeout bounds the `sse` handshake. */
  | { readonly kind: 'timeout' }
  /** Nothing above applies. ADR-0015's explicit `else` — never success. */
  | { readonly kind: 'unknown'; readonly detail: string };

/** Header names that carry a credential by convention — R-06 §4.4's `CREDENTIAL_HEADER_NAMES`,
 *  used only as a fallback when a caller does not declare which field is the credential. */
export const CREDENTIAL_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'apikey',
  'x-api-token',
  'x-auth-token',
  'x-access-token',
]);

const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** The JSON-RPC application error range MCP servers use for things like "Unauthorized" (R-06 §4.2). */
export function isApplicationErrorRange(code: number): boolean {
  return code <= -32000 && code >= -32099;
}

/** JSON-RPC's OWN pre-defined range. Mind the direction: -32700 is the LOWER bound (R-06 §4.2's
 *  own warning — an earlier draft of the reference classifier wrote this the other way round and
 *  the branch was unreachable). */
export function isProtocolErrorRange(code: number): boolean {
  return code >= -32700 && code <= -32600;
}

/**
 * Classify one {@link ProbeSignal} into exactly one {@link FailureKind}.
 *
 * `credentialConfigured` is the caller's answer to "does this connector carry a credential" —
 * never inferred here from the signal itself. It is what splits `401` / a server-sent application
 * error into `credential-rejected` (a credential was sent and refused) versus `auth-required` /
 * `server-refused` (nothing was sent, so nothing was "rejected").
 */
export function classify(
  signal: ProbeSignal,
  options: { readonly credentialConfigured: boolean },
): FailureKind {
  switch (signal.kind) {
    case 'http-status': {
      const { status } = signal;
      if (status === 401)
        return options.credentialConfigured ? 'credential-rejected' : 'auth-required';
      if (status === 403) return 'credential-insufficient-scope';
      if (status === 404 || status === 405 || status === 400) return 'endpoint-not-mcp';
      if (status === 429) return 'rate-limited';
      if (status >= 500) return 'server-error';
      return 'http-error';
    }
    case 'json-rpc-app-error':
      return options.credentialConfigured ? 'credential-rejected' : 'server-refused';
    case 'json-rpc-protocol-error':
    case 'not-json-rpc':
      return 'endpoint-not-mcp';
    case 'network-error':
      return 'unreachable';
    case 'tls-error':
      return 'tls-error';
    case 'sse-transport-error': {
      const text = signal.text;
      for (const code of NETWORK_CODES) {
        if (text.includes(code)) return 'unreachable';
      }
      for (const marker of ['ERR_SSL_', 'ERR_TLS_', 'CERT_HAS_EXPIRED', 'SELF_SIGNED_CERT']) {
        if (text.includes(marker)) return 'tls-error';
      }
      return 'sse-stream-failed';
    }
    case 'spawn-error':
      return signal.code === 'ENOENT' || signal.code === 'EACCES'
        ? 'command-not-found'
        : 'unknown-failure';
    case 'process-died':
      return 'process-died';
    case 'protocol-version-unsupported':
      return 'protocol-version-unsupported';
    case 'timeout':
      return 'timeout';
    case 'unknown':
      // ADR-0015's explicit else. Nothing above asserted a known shape.
      return 'unknown-failure';
    default: {
      const unreachable: never = signal;
      return unreachable;
    }
  }
}

/** Everything a sentence is built from, beyond the tag itself. Only `detail` is free text. */
export interface MessageDetail {
  readonly target: string | null;
  readonly command: string | null;
  readonly status: number | null;
  readonly timeoutMs: number;
  readonly stderr: string | null;
  readonly detail: string;
  readonly serverVersion: string | null;
}

/**
 * One human-readable sentence per {@link FailureKind}, plus `ok`. R-06 §4.4's `MESSAGES`,
 * transcribed — the wording is the research's own, verified to discriminate a wrong URL from a
 * wrong token (R-06 §4.2's `classify-linux.txt`).
 */
export const MESSAGES: { readonly [K in FailureKind | 'ok']: (detail: MessageDetail) => string } = {
  ok: () => 'Connected. The server answered and accepted the credential.',
  'auth-required': () =>
    'The server is reachable but requires authentication. Choose an authentication method and supply a credential.',
  'credential-rejected': () =>
    'The server was reached, but it rejected the credential. The address or command is correct — check the token, API key or environment variable.',
  'credential-insufficient-scope': () =>
    'The server is reachable and the credential is valid, but it is not permitted to use this server. Ask for wider scope.',
  unreachable: (d) =>
    `Could not reach the server at ${d.target ?? '(unknown target)'}. Check the address and that it is reachable from this deployment.`,
  'endpoint-not-mcp': (d) =>
    d.status === null
      ? `"${d.command ?? d.target ?? '(unknown)'}" answered, but not as an MCP server — it did not implement the MCP handshake.`
      : `${d.target ?? '(unknown target)'} answered, but not as an MCP server (HTTP ${String(d.status)}). Check the URL — and whether this server uses the HTTP or the SSE transport.`,
  'tls-error': (d) =>
    `Could not establish a secure connection to ${d.target ?? '(unknown target)'}. The TLS certificate or protocol was rejected.`,
  'command-not-found': (d) =>
    `The command "${d.command ?? ''}" could not be run. Check that it is installed and on the PATH of the runner.`,
  // No stderr text here, ever — a caller-controlled `stdio` command's stderr is the exact channel
  // an attacker uses to exfiltrate whatever this process's own environment held (B1, round 2):
  // `console.error(process.env.MASTER_ENCRYPTION_KEY)` prints that value to stderr, and this
  // sentence used to echo it verbatim into a 200 response. `command-not-found` (a different
  // `FailureKind`, from `spawn-error`) already covers "the binary does not exist"; this sentence
  // covers everything else the child could have done, without quoting a byte it wrote.
  'process-died': (d) =>
    `The command "${d.command ?? ''}" started but stopped before answering. Check the runner's ` +
    `own logs for details — for safety, this message never repeats anything the command wrote to ` +
    `its own output.`,
  timeout: (d) =>
    `No answer within ${String(d.timeoutMs / 1000)} seconds. The server may be starting slowly, or unreachable behind a firewall that drops rather than refuses.`,
  'protocol-version-unsupported': (d) =>
    `The server speaks MCP protocol version ${d.serverVersion ?? '(unrecognised)'}, which this deployment does not support.`,
  'server-error': (d) =>
    `${d.target ?? '(unknown target)'} returned HTTP ${String(d.status ?? '')}. The server is reachable but failing.`,
  'rate-limited': (d) =>
    `${d.target ?? '(unknown target)'} is rate-limiting this deployment (HTTP 429). Try again shortly.`,
  'http-error': (d) => `${d.target ?? '(unknown target)'} returned HTTP ${String(d.status ?? '')}.`,
  'server-refused': (d) => `The server refused the connection: ${d.detail || 'no reason given'}.`,
  'sse-stream-failed': (d) =>
    `${d.target ?? '(unknown target)'} did not open an SSE stream, and the transport gave no machine-readable reason: ${d.detail}`,
  'unknown-failure': (d) =>
    `The connection failed for a reason this probe does not recognise: ${d.detail}`,
  // ADR-0045: the control plane does not spawn a caller-supplied command, sandboxed or not — the
  // primitive underneath a stdio probe is arbitrary code execution as the control-plane user, and
  // no environment allowlist or message scrub converts that into safe execution (round 2's
  // `restrictedBaseEnv()` narrowed what a spawned child's environment CONTAINS, not what it could
  // READ — a child still inherits this process's filesystem and, on the Linux containers this
  // deploys to, its own `/proc/<ppid>/environ`). So this connector is still saved; only the probe
  // is refused, naming the missing resource, until Wave 3's runtime layer can run it in a sandbox.
  'stdio-probe-unavailable': (d) =>
    `Test Connection cannot run a stdio server in this deployment: doing so would execute ` +
    `"${d.command ?? '(no command)'}" directly in the control plane, and there is no sandboxed ` +
    `runner here to execute it safely instead. The connector itself is saved; only this ` +
    `connection test is unavailable until a sandboxed runner is configured.`,
};
