// R-06 deliverable — the reference Test Connection probe for spec §8, written to be copied
// into `apps/web/server/connectors/` by W2-CP-05 and translated to TypeScript there.
//
// Three rules shape it:
//
//  * ADR-0015 — every branch decides on a POSITIVE assertion, and the classifier ends with an
//    explicit `else` that rejects. There is no path on which an unrecognised failure is
//    reported as success, and no path on which a check that could not run is skipped. The same
//    rule applies to `credentialConfigured`, which is a predicate about a CREDENTIAL and not
//    about the presence of some header or some environment variable — see
//    `credentialConfiguredFor`.
//  * The probe must PROVE the credential is accepted, not merely that the host answers. It
//    therefore completes the MCP `initialize` handshake and then calls `tools/list`. DNS
//    resolving, a TCP connect, or an HTTP 200 on some unrelated path are all insufficient.
//  * The probe must RETURN. `timeoutMs` is a wall-clock budget for the whole sequence, enforced
//    by this file and not delegated to the SDK's per-request timeout, which does not bound the
//    sse handshake — see `deadlineFor`.
//
// Every outcome is a tagged `kind`, never a parsed string. The human-readable sentence is
// derived from the tag; the tag is what tests assert on.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export const CONNECT_TIMEOUT_MS = 10_000;

/** Node socket-level error codes, i.e. "we never spoke to an MCP server at all". */
const NETWORK_CODES = new Set([
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

const isTlsCode = (c) => typeof c === 'string' && (c.startsWith('ERR_SSL_') || c.startsWith('ERR_TLS_') || c === 'DEPTH_ZERO_SELF_SIGNED_CERT' || c === 'SELF_SIGNED_CERT_IN_CHAIN' || c === 'CERT_HAS_EXPIRED' || c === 'ERR_TLS_CERT_ALTNAME_INVALID');

// Walk the cause chain: node's fetch reports `TypeError: fetch failed` and puts the real
// errno one or more levels down.
function rootCause(e) {
  let cur = e;
  for (let i = 0; i < 8 && cur; i++) {
    if (typeof cur.code === 'string') return cur.code;
    cur = cur.cause;
  }
  return null;
}

/**
 * Header names that carry a credential by convention, lower-cased.
 *
 * Used ONLY as the fallback rule of {@link credentialConfiguredFor}, when the caller did not say
 * which of its headers is the credential. It is a named set, not "a header exists": a connector
 * carrying a trace id and no token must not be told its token was rejected.
 */
export const CREDENTIAL_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'apikey',
  'x-api-token',
  'x-auth-token',
  'x-access-token',
]);

/**
 * Does this connector carry a credential? — the predicate the 401 split and the stdio-refusal
 * split turn on, so it has to mean what its name says.
 *
 * The caller decides, because only the caller can. `config.credentialFields` names the header
 * keys (http/sse) or `env` keys (stdio) whose value is the credential; in the storage shape this
 * note's Contract summary gives, those are exactly the keys whose stored value is a `SecretRef`.
 *
 * "Names nothing" is `credentialFields` absent — `undefined` or `null`. A `credentialFields` that
 * is present but is not an array is neither a declaration this function can read nor a caller who
 * declined to declare, so it is rejected by name rather than falling through to the fallbacks: the
 * fallbacks answer "the caller left this to me", and answering that for a caller who did try to
 * declare would hide the mistake behind a plausible tag. `credentialFields: 'MCP_TOKEN'` is the
 * shape this catches. ADR-0015 — a check that cannot run must fail, not pass quietly.
 *
 * Two fallbacks, for a caller that names nothing, and both are ADR-0015 shaped — a positive
 * assertion, then an `else` that decides rather than guesses:
 *
 *   * http/sse — a header whose NAME is in {@link CREDENTIAL_HEADER_NAMES}. "Some header is
 *     present" is not that predicate: an `X-Trace-Id` and no token would otherwise be read as a
 *     credential, and a 401 would tell the user to check a token they never supplied.
 *   * stdio — `false`. There is no naming convention for a credential environment variable, and
 *     the child's environment is the runner's whole environment with the connector's overlay on
 *     top (see `baseEnv` below), so "an environment variable exists" is true of every stdio
 *     connector on the platform and decides nothing.
 *
 * Both fallbacks err the same way on purpose: an undeclared credential reads as *absent*, so the
 * sentence is `auth-required` ("supply a credential") rather than `credential-rejected` ("your
 * token is wrong"). Being told to supply a credential you already supplied is a smaller lie than
 * being told a credential you never supplied was refused, and the second is the one W2-CP-05's
 * acceptance criterion is about.
 *
 * Returns the decision AND the rule that made it; the rule travels in `detail.credentialSource`
 * so a support transcript says why the user got that sentence.
 */
export function credentialConfiguredFor(config) {
  const type = config.type ?? 'stdio';
  const carrier = type === 'stdio' ? (config.env ?? {}) : (config.headers ?? {});
  const present = Object.keys(carrier);

  const declared = config.credentialFields;
  const namesNothing = declared === undefined || declared === null;

  if (!namesNothing) {
    if (!Array.isArray(declared)) {
      throw new TypeError(
        `credentialFields must be an array of key names when present; got ${typeof declared} ` +
          `${JSON.stringify(declared)}. A single key is a one-element array: ['MCP_TOKEN'].`,
      );
    }
    const found = declared.filter((name) =>
      present.some((key) => key.toLowerCase() === String(name).toLowerCase()),
    );
    return found.length > 0
      ? { configured: true, source: `declared:${found.join(',')}` }
      : { configured: false, source: 'declared-but-none-present' };
  }

  if (type === 'stdio') {
    return { configured: false, source: 'undeclared-stdio-env-is-not-evidence' };
  }

  const named = present.filter((key) => CREDENTIAL_HEADER_NAMES.has(key.toLowerCase()));
  return named.length > 0
    ? { configured: true, source: `well-known-header:${named.join(',')}` }
    : { configured: false, source: 'no-well-known-credential-header' };
}

/**
 * Classify a thrown connection error into exactly one tag.
 * `credentialConfigured` is the boolean {@link credentialConfiguredFor} decided — "this connector
 * carries a credential", not "this connector carries some header". It is what separates
 * "this server wants authentication and we sent none" from "we sent one and it was refused".
 */
export function classify(e, { credentialConfigured }) {
  // 1. HTTP-status-bearing errors. Both transports expose the status as `.code`, and both use
  //    `.code` for other things too, so require a plausible HTTP status number.
  const status = typeof e?.code === 'number' && e.code >= 100 && e.code <= 599 ? e.code : null;
  if (status !== null) {
    if (status === 401) return credentialConfigured ? 'credential-rejected' : 'auth-required';
    if (status === 403) return 'credential-insufficient-scope';
    if (status === 404 || status === 405 || status === 400) return 'endpoint-not-mcp';
    if (status === 429) return 'rate-limited';
    if (status >= 500) return 'server-error';
    return 'http-error';
  }

  // 2. MCP-level errors raised by the CLIENT after a transport was established.
  //    A client-side timeout is McpError(-32001) carrying `data.timeout`. A *server* may also
  //    send -32001 in a JSON-RPC error — the range is not reserved — and the two are otherwise
  //    identical, so the presence of the numeric `data.timeout` is the discriminator and the
  //    order of these two branches is load-bearing.
  const mcpCode = typeof e?.code === 'number' ? e.code : null;
  if (mcpCode === -32001 && typeof e?.data?.timeout === 'number') return 'timeout';
  if (mcpCode === -32000 && e?.data === undefined) return 'process-died';

  // 3. A JSON-RPC error the server itself returned. A stdio server has no HTTP status code and
  //    this is the only channel it has for "your credential is wrong".
  if (mcpCode !== null && mcpCode <= -32000 && mcpCode >= -32099) {
    return credentialConfigured ? 'credential-rejected' : 'server-refused';
  }
  // JSON-RPC's own pre-defined errors, -32700 (parse error) through -32600 (invalid request),
  // which includes -32601 method-not-found: something answered JSON-RPC but does not implement
  // `initialize`. Note the direction of the comparison — -32700 is the LOWER bound. An earlier
  // draft wrote `<= -32700 && >= -32603`, which is unsatisfiable, and the branch was dead.
  if (mcpCode !== null && mcpCode >= -32700 && mcpCode <= -32600) return 'endpoint-not-mcp';

  // 4. Socket / DNS / TLS, reached through the cause chain.
  const code = rootCause(e);
  if (code === 'ENOENT' || code === 'EACCES') return 'command-not-found';
  if (isTlsCode(code)) return 'tls-error';
  if (code !== null && NETWORK_CODES.has(code)) return 'unreachable';

  // 4b. SSEClientTransport is the exception to "read the code, not the string". It reports
  //     transport-level failures as SseError with `code` undefined and the underlying errno
  //     only inside the message of the wrapped ErrorEvent — there is no structured errno to
  //     read. The positive assertion available is: the error is an SseError (constructor
  //     name), and one of the errno tokens we know appears in its text.
  if (e?.constructor?.name === 'SseError') {
    const text = `${e.message ?? ''} ${e.event?.message ?? ''}`;
    for (const c of NETWORK_CODES) if (text.includes(c)) return 'unreachable';
    for (const c of ['ERR_SSL_', 'ERR_TLS_', 'CERT_HAS_EXPIRED', 'SELF_SIGNED_CERT']) {
      if (text.includes(c)) return 'tls-error';
    }
    return 'sse-stream-failed';
  }

  // 5. Protocol version. The MCP SDK throws a plain Error with no code for this one, so it is
  //    matched on the message the SDK itself constructs — pinned by a test against the
  //    installed SDK so an upstream rewording fails a test rather than production.
  if (typeof e?.message === 'string' && e.message.startsWith("Server's protocol version is not supported:")) {
    return 'protocol-version-unsupported';
  }

  // 6. ADR-0015's explicit else. Nothing above asserted a known shape, so the probe does not
  //    know what happened and says so. It never falls through to success.
  return 'unknown-failure';
}

export const MESSAGES = {
  ok: () => 'Connected. The server answered and accepted the credential.',
  'auth-required': () =>
    'The server is reachable but requires authentication. Choose an authentication method and supply a credential.',
  // Worded to hold for all three transports: a stdio server has no address, so the reassurance
  // has to name the command too. The reassurance is the point of the tag — it is what tells the
  // user not to go back and re-check the URL.
  'credential-rejected': () =>
    'The server was reached, but it rejected the credential. The address or command is correct — check the token, API key or environment variable.',
  'credential-insufficient-scope': () =>
    'The server is reachable and the credential is valid, but it is not permitted to use this server. Ask for wider scope.',
  unreachable: (d) => `Could not reach the server at ${d.target}. Check the address and that it is reachable from this deployment.`,
  // Two sentences, because this tag is reachable from both a remote endpoint (which has an HTTP
  // status and a transport the user may have chosen wrongly) and a local command (which has
  // neither). Naming a status of `null` or offering to change transport would be nonsense there.
  'endpoint-not-mcp': (d) =>
    d.status === null
      ? `"${d.command ?? d.target}" answered, but not as an MCP server — it did not implement the MCP handshake.`
      : `${d.target} answered, but not as an MCP server (HTTP ${d.status}). Check the URL — and whether this server uses the HTTP or the SSE transport.`,
  'tls-error': (d) => `Could not establish a secure connection to ${d.target}. The TLS certificate or protocol was rejected.`,
  'command-not-found': (d) => `The command "${d.command}" could not be run. Check that it is installed and on the PATH of the runner.`,
  'process-died': (d) => `The command "${d.command}" started but stopped before answering.${d.stderr ? ` It said: ${d.stderr}` : ''}`,
  timeout: (d) => `No answer within ${d.timeoutMs / 1000} seconds. The server may be starting slowly, or unreachable behind a firewall that drops rather than refuses.`,
  'protocol-version-unsupported': (d) => `The server speaks MCP protocol version ${d.serverVersion ?? '(unrecognised)'}, which this deployment does not support.`,
  'server-error': (d) => `${d.target} returned HTTP ${d.status}. The server is reachable but failing.`,
  'rate-limited': (d) => `${d.target} is rate-limiting this deployment (HTTP 429). Try again shortly.`,
  'http-error': (d) => `${d.target} returned HTTP ${d.status}.`,
  'sse-stream-failed': (d) => `${d.target} did not open an SSE stream, and the transport gave no machine-readable reason: ${d.detail}`,
  'server-refused': (d) => `The server refused the connection: ${d.detail ?? 'no reason given'}.`,
  'unknown-failure': (d) => `The connection failed for a reason this probe does not recognise: ${d.detail}`,
};

/**
 * A wall-clock deadline for the WHOLE probe, and the reason one exists on top of the `{ timeout }`
 * the SDK already takes.
 *
 * `Client.connect(transport, { timeout })` bounds the timed `initialize` REQUEST. It does not
 * bound `transport.start()`, which `Protocol.connect` awaits first — and on the sse transport
 * `SSEClientTransport.start()` is `_startOrAuth()`, a promise that settles only when the stream
 * errors or an `endpoint` event arrives (`dist/esm/client/sse.js`; its own comment at the
 * `onopen` handler says *"The connection is open, but we need to wait for the endpoint to be
 * received"*). A server that accepts the GET and writes nothing, or that opens a well-formed
 * `text/event-stream` and never sends `endpoint`, therefore parks `connect()` for ever: no
 * request has been issued, so there is nothing for the request timeout to fire on.
 *
 * That is not a hypothetical — it is a firewall or a stalled proxy, the case §4.3 is about, and a
 * Test Connection button that never returns is worse than one that reports the wrong reason. So
 * the deadline is raced against the whole sequence, and it rejects with the SAME shape the SDK's
 * own client-side timeout has — `McpError(-32001)` carrying a numeric `data.timeout` — so the
 * classifier's existing branch 2 recognises it and no new tag is needed.
 *
 * The timer is started once, before `connect()`, and covers `connect()` and `listTools()`
 * together: `timeoutMs` is the budget for the probe, not per call.
 */
function deadlineFor(timeoutMs) {
  let timer;
  const promise = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new McpError(ErrorCode.RequestTimeout, 'Request timed out', { timeout: timeoutMs })),
      timeoutMs,
    );
  });
  // Swallow nothing: the rejection is always consumed by a `Promise.race` below, and `cancel()`
  // clears the timer on every exit path so the deadline cannot outlive the call.
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * `baseEnv` must be the environment the RUNNER will launch the MCP server with. It is not
 * cosmetic: StdioClientTransport otherwise gives the child only its own six-name allowlist
 * (HOME, LOGNAME, PATH, SHELL, TERM, USER on Linux), while the Agent SDK gives it the runner's
 * whole environment at run time — so a probe that omits it fails connectors that need
 * HTTPS_PROXY or NODE_EXTRA_CA_CERTS and would have worked.
 *
 * `baseEnv` and `config.env` are different things and must stay that way: `config.env` is the
 * CONNECTOR's own overlay — the keys the user configured, among them the credential — and
 * `baseEnv` is the ambient environment underneath it. Folding the runner's environment into
 * `config.env` before calling would make every stdio connector look as though it carried a
 * credential; that is what {@link credentialConfiguredFor} refuses to infer from.
 */
export async function testConnection(config, { timeoutMs = CONNECT_TIMEOUT_MS, baseEnv = process.env } = {}) {
  const type = config.type ?? 'stdio';
  const credential = credentialConfiguredFor(config);
  const credentialConfigured = credential.configured;
  const target = type === 'stdio' ? config.command : config.url;

  let transport;
  let stderrChunks = [];
  if (type === 'http') {
    transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers ?? {} } });
  } else if (type === 'sse') {
    const h = config.headers ?? {};
    transport = new SSEClientTransport(new URL(config.url), {
      requestInit: { headers: h },
      eventSourceInit: { fetch: (u, i) => fetch(u, { ...i, headers: { ...(i?.headers ?? {}), ...h } }) },
    });
  } else if (type === 'stdio') {
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...baseEnv, ...(config.env ?? {}) },
      stderr: 'pipe',
      cwd: config.cwd,
    });
    // Capture stderr: on stdio it is the ONLY channel that carries a human-readable reason
    // when the child dies before answering.
    transport.stderr?.on('data', (c) => {
      if (stderrChunks.length < 64) stderrChunks.push(c.toString('utf8'));
    });
  } else {
    return { ok: false, kind: 'unknown-failure', message: MESSAGES['unknown-failure']({ detail: `unsupported transport "${type}"` }) };
  }

  const client = new Client({ name: 'agent-workspace-connection-test', version: '1' }, { capabilities: {} });
  const deadline = deadlineFor(timeoutMs);
  try {
    await Promise.race([client.connect(transport, { timeout: timeoutMs }), deadline.promise]);
    const tools = await Promise.race([client.listTools({}, { timeout: timeoutMs }), deadline.promise]);
    const info = client.getServerVersion();
    return {
      ok: true,
      kind: 'ok',
      message: MESSAGES.ok(),
      serverName: info?.name ?? null,
      serverVersion: info?.version ?? null,
      toolCount: tools.tools.length,
    };
  } catch (e) {
    const kind = classify(e, { credentialConfigured });
    const detail = {
      target,
      command: config.command,
      status: typeof e?.code === 'number' && e.code >= 100 && e.code <= 599 ? e.code : null,
      timeoutMs,
      // Only surface stderr when it decoded as text. A Windows console emits OEM-codepage bytes,
      // which arrive here as U+FFFD replacement characters; pasting that into a user-facing
      // sentence produces mojibake, so drop it rather than show it. Positive assertion: the text
      // is shown only if it contains no replacement character, never "shown unless it looks bad".
      stderr: (() => {
        const t = stderrChunks.join('').trim().split('\n').slice(-3).join(' ').slice(0, 300);
        return t.length > 0 && !t.includes('�') ? t : null;
      })(),
      detail: String(e?.message ?? e).slice(0, 300),
      serverVersion: /version is not supported: (\S+)/.exec(String(e?.message ?? ''))?.[1] ?? null,
      // Which rule decided `credentialConfigured`, so a support transcript says why this sentence
      // and not the other one. Never the credential itself.
      credentialSource: credential.source,
    };
    return { ok: false, kind, message: MESSAGES[kind](detail), detail };
  } finally {
    // Always reap. Client.connect() already closes the transport when initialize fails, but
    // listTools() failing after a successful connect does not, and — on the deadline path above —
    // nothing has closed anything, because the SDK never returned. The sse case is exactly that:
    // `transport.close()` is what aborts the parked EventSource and releases the socket.
    deadline.cancel();
    try {
      await client.close();
    } catch {}
    try {
      await transport.close?.();
    } catch {}
  }
}
