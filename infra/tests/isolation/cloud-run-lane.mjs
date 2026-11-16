/**
 * The Cloud Run isolation lane. It runs as Cloud Run Jobs inside the install's VPC, because the
 * runner manager is internal and has no command-exec route: nothing outside the VPC can reach it,
 * and nothing can run inside a sandbox the manager created. Instead the probe job is given the
 * sandbox's exact network shape (subnet, network tag, egress setting, service account) and asserts
 * what such a workload can reach. Every mode prints exactly one line, `AW_ISOLATION_RESULT <json>`,
 * which carries the execution's `AW_ISOLATION_NONCE`: the workflow accepts only the line of the
 * execution it started (see log-result.mjs).
 *
 *   create          (services subnet, web service account) create a `none` sandbox through the
 *                   runner manager and check the positive controls: the Cloud SQL private address
 *                   must be reachable from the services subnet, and with ISOLATION_APP_URL an app
 *                   must answer /api/health.
 *   destroy <id>    (same identity) delete that sandbox.
 *   probe           (sandbox network shape, runtime service account) assert the isolation.
 *   token           (services subnet, runtime service account) assert the sandbox identity's
 *                   metadata token has no permissions: the Cloud Run API must answer 403, and
 *                   testIamPermissions on the project must grant none of SENSITIVE_PERMISSIONS. It
 *                   runs outside the sandbox shape because a sandbox reaches no Google API at all,
 *                   so its token cannot be tried from there.
 *   tool-open       (services subnet, web service account) open a tool sandbox through the runner
 *                   manager whose one code tool is tool-probe.mjs; prints its origin, never the token.
 *   tool-call       (services subnet, GATEWAY service account, the only identity allowed to invoke a
 *                   tool sandbox) call that tool: its attempts run inside the tool sandbox and are
 *                   judged like probe's, and the tool sandbox's metadata token is fetched there and
 *                   tried against the Cloud Run API and testIamPermissions (GCP_PROJECT, GCP_REGION
 *                   are required); plus the gateway identity must get 403 from an agent sandbox.
 *   tool-close      (web service account) close that tool sandbox.
 *   proxy-restricted (sandbox network shape) through the shared egress proxy of a `restricted`
 *                   sandbox: a listed host answers (the positive control), an unlisted host is refused,
 *                   a direct socket that bypasses the proxy times out, and a request with no or a
 *                   forged credential is refused with 407.
 *   proxy-open      (sandbox network shape) through the proxy of an `open` sandbox: a public host
 *                   answers (the positive control); the private ranges, the metadata server, the
 *                   Google VIPs and the gateway's load balancer are refused or silent.
 *
 * No mode depends on a model reply, and none logs a token, a header or a secret value.
 */
import { request as httpRequest } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  MAX_BODY_BYTES,
  PRIVATE_GOOGLE_VIP,
  RESTRICTED_GOOGLE_VIP,
  SENSITIVE_PERMISSIONS,
  TIMEOUT_MS,
  collectAttempts,
  collectMetadata,
  getAttempt,
  grantedPermissions,
  metadataGet,
  requestAttempt,
  targetsFromEnv,
  tcpAttempt,
} from './attempts.mjs';

// The attempts live in attempts.mjs so the tool probe (tool-probe.mjs) shares them.
export { SENSITIVE_PERMISSIONS, grantedPermissions, requestAttempt, tcpAttempt };

const MARKER = 'AW_ISOLATION_RESULT';
const NETWORK_POLICIES = new Set(['none', 'restricted', 'open']);

/** @param {string} title @param {'pass'|'fail'|'inconclusive'|'n/a'} outcome @param {string} detail */
const result = (title, outcome, detail) => ({ title, outcome, detail });
const message = (error) => (error instanceof Error ? error.message : String(error));

export const METADATA_TITLE = 'The sandbox metadata token has no permissions';

/**
 * @typedef {{ status?: number; error?: string; code?: string; connected?: boolean; timedOut?: boolean }} Attempt
 * One network attempt: `status` is the HTTP status when one came back, `connected` is true once the
 * TCP connection opened, `timedOut` is true when the attempt ended on its timeout, and `code` is the
 * Node error code.
 */

// Codes that prove a packet came back from the far end: a refusal, a reset, a hang-up, or a TLS
// failure (which needs a handshake to have started).
const REACHED_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ECONNABORTED']);
const REACHED_CODE_PATTERN = /^(?:ERR_SSL_|ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH|HPE_)/u;
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'ENODATA']);

/**
 * What one attempt proves. Pure. A GCP firewall deny drops packets silently, so a denied attempt can
 * only time out before its TCP connect.
 *
 *   silent   it timed out before any TCP connect: a firewall drop, the only outcome that passes;
 *   reached  a packet came back: a connect, an HTTP status, a refusal, a reset, a hang-up, a TLS
 *            error, or a timeout after the connect;
 *   dns      the name did not resolve, so nothing was sent;
 *   unclear  anything else (a local error, an unknown code), never a pass.
 *
 * @param {Attempt} attempt
 * @returns {'silent' | 'reached' | 'dns' | 'unclear'}
 */
export function classifyAttempt(attempt) {
  if (typeof attempt.status === 'number' || attempt.connected === true) return 'reached';
  const code = attempt.code ?? '';
  if (REACHED_CODES.has(code) || REACHED_CODE_PATTERN.test(code) || /socket hang up/iu.test(attempt.error ?? '')) {
    return 'reached';
  }
  if (DNS_CODES.has(code)) return 'dns';
  if (attempt.timedOut === true) return 'silent';
  return 'unclear';
}

/** @param {Attempt} attempt */
function describeAttempt(attempt) {
  if (typeof attempt.status === 'number') return `answered ${String(attempt.status)}`;
  const why = [attempt.code, attempt.error].filter((part) => part !== undefined && part !== '').join(' ') || 'unknown';
  if (attempt.connected === true) return `connected, then ${why}`;
  if (attempt.timedOut === true) return 'timed out before connecting';
  return `got no answer (${why})`;
}

/**
 * Turn the raw probe measurements into the lane's results. Pure.
 *
 * Every attempt at a denied destination (the public host, the private range, the Google VIPs and the
 * gateway's run.app URL) must time out before the TCP connect: the sandbox firewall drops those
 * packets silently. Anything that proves a packet came back is a `SECURITY:` fail; the VIPs matter
 * because Google's front end serves every *.run.app service and bucket of every project.
 *
 * @param {{
 *   gateway: Attempt;
 *   gatewayRunApp: Attempt;
 *   gatewayRunAppViaVip?: Attempt;
 *   appRunApp?: Attempt;
 *   appRunAppViaVip?: Attempt;
 *   internet: Record<string, Attempt>;
 *   private: Record<string, Attempt>;
 *   privateControl: boolean;
 *   googleVip: Record<string, Attempt>;
 * }} raw
 */
export function evaluateProbes(raw) {
  // Cloud Run answers 404 when its ingress refuses a request, so only the gateway's own 200 proves it was reached.
  const gatewayOk = raw.gateway.status === 200;
  const gateway = result(
    'The gateway answers from a none sandbox through its internal load balancer',
    gatewayOk ? 'pass' : 'fail',
    typeof raw.gateway.status === 'number'
      ? `GET /health answered ${String(raw.gateway.status)} (want 200)`
      : `no answer: ${raw.gateway.error ?? 'unknown'}`,
  );
  const blind = (title) =>
    result(title, 'inconclusive', 'the gateway control failed, so the sandbox network is not proven to work at all');

  const internetTitle = 'A none sandbox cannot reach a public host';
  const privateTitle = 'A none sandbox cannot reach the private ranges';
  const vipTitle = 'A none sandbox gets no answer from the Google VIPs (run.app services and buckets of any project)';
  const runAppTitle = "A none sandbox gets no answer from the gateway's run.app URL";
  const appTitle = 'A none sandbox cannot reach an app service';
  const hasApp = raw.appRunApp !== undefined;
  if (!gatewayOk) {
    return {
      'gateway-reachable': gateway,
      'egress-internet': blind(internetTitle),
      'egress-private-range': blind(privateTitle),
      'egress-google-vip': blind(vipTitle),
      'egress-gateway-run-app': blind(runAppTitle),
      ...(hasApp ? { 'egress-app-run-app': blind(appTitle) } : {}),
    };
  }

  const privateRange = raw.privateControl
    ? evaluateSilent(privateTitle, 'the private range', raw.private)
    : result(
        privateTitle,
        'inconclusive',
        'the positive control failed: the private address is not reachable from the services subnet either',
      );

  return {
    'gateway-reachable': gateway,
    'egress-internet': evaluateSilent(internetTitle, 'a public host', raw.internet),
    'egress-private-range': privateRange,
    'egress-google-vip': evaluateSilent(vipTitle, 'the Google VIP', raw.googleVip),
    'egress-gateway-run-app': evaluateRunApp(runAppTitle, raw.gatewayRunApp, raw.gatewayRunAppViaVip),
    ...(hasApp ? { 'egress-app-run-app': evaluateRunApp(appTitle, raw.appRunApp, raw.appRunAppViaVip) } : {}),
  };
}

/**
 * Attempts at one denied destination: a pass only when every one timed out before its connect.
 *
 * @param {string} title @param {string} target @param {Record<string, Attempt>} attempts
 */
function evaluateSilent(title, target, attempts) {
  const all = Object.entries(attempts).map(([name, attempt]) => ({ name, attempt, kind: classifyAttempt(attempt) }));
  const seen = all.map(({ name, attempt }) => `${name} ${describeAttempt(attempt)}`).join(', ');
  if (all.length === 0) return result(title, 'inconclusive', `no probe of ${target} ran`);
  if (all.some(({ kind }) => kind === 'reached')) {
    return result(title, 'fail', `SECURITY: a none sandbox reached ${target} (${seen})`);
  }
  if (all.some(({ kind }) => kind !== 'silent')) {
    return result(title, 'inconclusive', `only a timeout before the connect proves the deny (${seen})`);
  }
  return result(title, 'pass', seen);
}

/**
 * The gateway's run.app URL by name. A DNS failure sends nothing, so by itself it proves nothing; it
 * passes only when the IP-literal request for the same host to the VIP timed out before connecting.
 *
 * @param {string} title @param {Attempt} byName @param {Attempt | undefined} viaVip
 */
function evaluateRunApp(title, byName, viaVip) {
  const kind = classifyAttempt(byName);
  if (kind === 'reached') {
    return result(
      title,
      'fail',
      `SECURITY: a none sandbox reached a run.app URL through the Google VIP (${describeAttempt(byName)})`,
    );
  }
  if (kind === 'silent') return result(title, 'pass', describeAttempt(byName));
  if (kind === 'dns' && viaVip !== undefined && classifyAttempt(viaVip) === 'silent') {
    return result(
      title,
      'pass',
      `the name did not resolve (${describeAttempt(byName)}); the IP-literal request to the VIP ${describeAttempt(viaVip)}`,
    );
  }
  return result(title, 'inconclusive', `only a timeout before the connect proves the deny (${describeAttempt(byName)})`);
}

/**
 * The token result. Pure. The Cloud Run API must refuse the sandbox identity's token with 403, and
 * testIamPermissions on the project must answer 200 and grant none of SENSITIVE_PERMISSIONS. Any
 * other answer from either call is inconclusive, which fails the lane.
 *
 * @param {{
 *   tokenStatus?: number;
 *   apiStatus?: number;
 *   error?: string;
 *   iam?: { status?: number; granted?: unknown; error?: string };
 * }} metadata
 */
export function evaluateToken(metadata) {
  const { tokenStatus, apiStatus, iam } = metadata;
  const failures = [];
  const unclear = [];

  if (typeof apiStatus === 'number' && apiStatus >= 200 && apiStatus < 300) {
    failures.push(`the metadata token was accepted by the Cloud Run API (${String(apiStatus)})`);
  } else if (apiStatus !== 403) {
    unclear.push(`token endpoint ${String(tokenStatus ?? 'no answer')}, Cloud Run API ${String(apiStatus ?? metadata.error ?? 'no answer')}`);
  }

  const granted = iam?.granted;
  if (iam?.status !== 200) {
    unclear.push(`testIamPermissions ${String(iam?.status ?? iam?.error ?? 'did not run')}`);
  } else if (!Array.isArray(granted) || !granted.every((permission) => typeof permission === 'string')) {
    unclear.push('testIamPermissions answered 200 without a permission list');
  } else if (granted.length > 0) {
    failures.push(`testIamPermissions granted the metadata token ${granted.join(', ')}`);
  }

  if (failures.length > 0) return result(METADATA_TITLE, 'fail', failures.join('; '));
  if (unclear.length > 0) return result(METADATA_TITLE, 'inconclusive', unclear.join('; '));
  return result(
    METADATA_TITLE,
    'pass',
    `the Cloud Run API answered 403, and testIamPermissions granted none of ${String(SENSITIVE_PERMISSIONS.length)} sensitive permissions`,
  );
}

const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

async function managerCall(method, route, body) {
  const managerUrl = need('CLOUD_RUN_MANAGER_URL').replace(/\/+$/u, '');
  const idToken = await (await metadataGet(`identity?audience=${encodeURIComponent(managerUrl)}`)).text();
  const response = await fetch(`${managerUrl}${route}`, {
    method,
    headers: {
      'x-serverless-authorization': `Bearer ${idToken}`,
      authorization: `Bearer ${need('RUNNER_MANAGER_TOKEN')}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(240_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(managerFailure(method, route, response.status, text));
  return text === '' ? null : JSON.parse(text);
}

/**
 * Why a runner manager call failed: its status, and the error code and message of its JSON answer.
 * The manager's messages never carry a value; the message is still capped. Pure.
 *
 * @param {string} method
 * @param {string} route
 * @param {number} status
 * @param {string} text
 */
export function managerFailure(method, route, status, text) {
  let answer;
  try {
    answer = JSON.parse(text);
  } catch {
    answer = undefined;
  }
  const code = typeof answer?.error === 'string' ? answer.error : undefined;
  const reason = typeof answer?.message === 'string' ? answer.message.slice(0, 300) : undefined;
  const detail = [code, reason].filter((part) => part !== undefined).join(': ');
  return `runner manager ${method} ${route} answered ${String(status)}${detail === '' ? '' : ` (${detail})`}`;
}

/**
 * The network policy a `create` asks for, from ISOLATION_NETWORK_POLICY (none|restricted|open, default
 * none) and ISOLATION_ALLOWED_DOMAINS (a comma list, used by `restricted` only). Pure.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ networkPolicy: string; allowedDomains?: string[] }}
 */
export function networkPolicyFromEnv(env) {
  const networkPolicy = env.ISOLATION_NETWORK_POLICY || 'none';
  if (!NETWORK_POLICIES.has(networkPolicy))
    throw new Error('ISOLATION_NETWORK_POLICY must be none, restricted or open');
  if (networkPolicy !== 'restricted') return { networkPolicy };
  const allowedDomains = (env.ISOLATION_ALLOWED_DOMAINS ?? '')
    .split(',')
    .map((domain) => domain.trim())
    .filter((domain) => domain !== '');
  return { networkPolicy, allowedDomains };
}

/**
 * The positive control for app reachability: an app answers /api/health with 200 inside the VPC.
 * Pure.
 *
 * @param {Attempt} attempt
 */
export function evaluateAppHealth(attempt) {
  const ok = attempt.status === 200;
  return result(
    'An app answers /api/health inside the VPC',
    ok ? 'pass' : 'fail',
    typeof attempt.status === 'number'
      ? `GET /api/health answered ${String(attempt.status)} (want 200)`
      : `no answer: ${attempt.error ?? 'unknown'}`,
  );
}

async function create() {
  const { networkPolicy, allowedDomains } = networkPolicyFromEnv(process.env);
  const id = randomBytes(3).toString('hex');
  const results = {};
  let handleId;
  try {
    const { handle } = await managerCall('POST', '/runtimes', {
      workspaceId: `aw-iso-${id}`,
      sessionId: `aw-iso-${id}-cloud-run`,
      engine: 'claude-agent-sdk',
      runSpec: {
        runtimeProfileId: 'isolation-suite',
        driver: 'cloud-run-service',
        networkPolicy,
        ...(allowedDomains === undefined ? {} : { allowedDomains }),
        filesystem: 'read-write',
      },
    });
    handleId = handle.id;
    results['sandbox-create'] = result('A sandbox is created through the runner manager', 'pass', `handle ${handleId}`);
  } catch (error) {
    results['sandbox-create'] = result('A sandbox is created through the runner manager', 'fail', message(error));
  }
  const reached = (await tcpAttempt(need('ISOLATION_PRIVATE_ADDRESS'), 5432)).connected === true;
  results['control-private-range'] = result(
    'The private address is reachable from the services subnet',
    reached ? 'pass' : 'fail',
    reached ? 'TCP 5432 connected' : 'TCP 5432 did not connect',
  );
  if (process.env.ISOLATION_APP_URL) {
    results['control-app-health'] = evaluateAppHealth(await getAttempt(process.env.ISOLATION_APP_URL, '/api/health'));
  }
  return {
    mode: 'create',
    networkPolicy,
    handleId,
    service: handleId === undefined ? undefined : `rt-${handleId}`,
    results,
  };
}

async function destroy(id) {
  if (!id) throw new Error('destroy needs a sandbox id');
  const title = 'The sandbox is destroyed through the runner manager';
  try {
    await managerCall('DELETE', `/runtimes/${id}`);
    return { mode: 'destroy', results: { 'sandbox-destroy': result(title, 'pass', 'deleted') } };
  } catch (error) {
    return { mode: 'destroy', results: { 'sandbox-destroy': result(title, 'fail', message(error)) } };
  }
}

async function probe() {
  const raw = await collectAttempts(targetsFromEnv(process.env));
  const results = evaluateProbes({ ...raw, privateControl: process.env.ISOLATION_CONTROL_PRIVATE === 'pass' });
  return { mode: 'probe', results };
}

/** The sandbox identity's token against Google APIs, from the services subnet. */
async function token() {
  const metadata = await collectMetadata(need('GCP_PROJECT'), need('GCP_REGION'));
  return { mode: 'token', results: { 'metadata-token-useless': evaluateToken(metadata) } };
}

// ---- The tool sandbox ------------------------------------------------------------------------
//
// A code tool runs in a tool sandbox (a Cloud Run service `rt-tool-...`) that only the gateway's
// identity may invoke. `tool-open` ships tool-probe.mjs as the one tool of a sandbox it opens through
// the runner manager; `tool-call` invokes it as the gateway, so the probe's attempts run inside the
// tool sandbox, and judges them here with the same evaluations as the agent sandbox; `tool-close`
// removes the sandbox. The bearer token and the run id come from the workflow, which gives the same
// values to `tool-open` and `tool-call`; no mode prints the token.

export const TOOL_NAME = 'isolation_probe';
const TOOL_TIMEOUT_MS = 120_000;
const TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: { targets: { type: 'object' } },
  required: ['targets'],
  additionalProperties: false,
};
const SHARED_EXPORT = /^export (?=(?:async )?(?:const|function) )/gmu;
const SHARED_IMPORT = /^import \{[^}]*\} from '\.\/attempts\.mjs';\n/mu;

/**
 * The single-file ES module the tool host imports: attempts.mjs without its `export` keywords, then
 * tool-probe.mjs without its import of attempts.mjs (the host imports one file, which cannot import a
 * sibling). Its default export is the run function.
 */
export function toolProbeBundle() {
  const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
  const probeSource = read('tool-probe.mjs');
  if (!SHARED_IMPORT.test(probeSource)) throw new Error('tool-probe.mjs must import only ./attempts.mjs');
  return `${read('attempts.mjs').replace(SHARED_EXPORT, '')}\n${probeSource.replace(SHARED_IMPORT, '')}`;
}

/** The runner manager request that opens the probe's tool sandbox. Pure, apart from the bundle read. */
export function toolOpenRequest({ id, runId, token }) {
  const bytes = Buffer.from(toolProbeBundle(), 'utf8');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const workspaceId = `aw-iso-${id}`;
  return {
    workspaceId,
    clientId: `${workspaceId}-tool`,
    toolSandbox: {
      key: `isolation-${id}`,
      manifest: {
        tools: [
          {
            name: TOOL_NAME,
            description: 'Attempt the isolation lane destinations from inside the tool sandbox',
            inputSchema: TOOL_INPUT_SCHEMA,
            timeoutMs: TOOL_TIMEOUT_MS,
            digest,
            bundleBase64: bytes.toString('base64'),
          },
        ],
        stdioServers: [],
        env: {},
      },
      allowedDomains: [],
      run: { runId, token },
    },
  };
}

async function toolOpen() {
  const title = 'A tool sandbox is opened through the runner manager';
  const runId = need('ISOLATION_TOOL_RUN_ID');
  const request = toolOpenRequest({ id: randomBytes(3).toString('hex'), runId, token: need('ISOLATION_TOOL_TOKEN') });
  const { workspaceId, clientId } = request;
  try {
    const origin = (await managerCall('POST', '/tool-sandboxes', request))?.toolSandbox?.origin;
    if (typeof origin !== 'string' || origin === '') throw new Error('the runner manager answered no tool sandbox origin');
    return {
      mode: 'tool-open',
      handleOrigin: origin,
      clientId,
      workspaceId,
      runId,
      results: { 'tool-sandbox-open': result(title, 'pass', `origin ${origin}`) },
    };
  } catch (error) {
    return {
      mode: 'tool-open',
      clientId,
      workspaceId,
      runId,
      results: { 'tool-sandbox-open': result(title, 'fail', message(error)) },
    };
  }
}

async function toolClose() {
  const title = 'The tool sandbox is closed through the runner manager';
  const route = `/tool-sandboxes/sessions/${encodeURIComponent(need('ISOLATION_TOOL_CLIENT_ID'))}`;
  try {
    await managerCall('DELETE', `${route}?workspaceId=${encodeURIComponent(need('ISOLATION_TOOL_WORKSPACE_ID'))}`);
    return { mode: 'tool-close', results: { 'tool-sandbox-close': result(title, 'pass', 'closed') } };
  } catch (error) {
    return { mode: 'tool-close', results: { 'tool-sandbox-close': result(title, 'fail', message(error)) } };
  }
}

/**
 * The JSON-RPC message of a tools/call answer, plain JSON or one `data:` event of an SSE stream.
 * Pure. Undefined when the text holds none.
 *
 * @param {string | undefined} text
 */
export function parseToolAnswer(text) {
  if (text === undefined) return undefined;
  const candidates = [text, ...text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5))];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Not JSON: try the next candidate.
    }
  }
  return undefined;
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const PROBE_FIELDS = ['gateway', 'gatewayRunApp', 'internet', 'private', 'googleVip'];

/**
 * The probe's raw attempts out of a tools/call answer, or the reason there are none. Pure.
 *
 * @param {{ status?: number; text?: string; error?: string }} response
 * @returns {{ probe: { attempts: Record<string, any>; metadata?: Record<string, any> } } | { problem: string }}
 */
export function readToolProbe(response) {
  if (typeof response.status !== 'number') return { problem: `no answer: ${response.error ?? 'unknown'}` };
  const answer = parseToolAnswer(response.text);
  if (response.status !== 200) {
    const reason = typeof answer?.error === 'string' ? answer.error : answer?.error?.message;
    // The tool host answers JSON; a bare 403 is Cloud Run's own refusal, before the container.
    const refusedByCloudRun = response.status === 403 && answer === undefined;
    const why = typeof reason === 'string' ? ` (${reason.slice(0, 120)})` : refusedByCloudRun ? ' (by Cloud Run, before the container: the caller may not invoke this service)' : '';
    return { problem: `POST /mcp answered ${String(response.status)}${why}` };
  }
  if (!isRecord(answer?.result)) {
    return { problem: `POST /mcp answered 200 without a tools/call result${isRecord(answer?.error) ? ' (a JSON-RPC error)' : ''}` };
  }
  const text = answer.result.content?.[0]?.text;
  if (answer.result.isError === true) {
    return { problem: `the tool failed: ${typeof text === 'string' ? text.slice(0, 120) : 'no message'}` };
  }
  let output;
  try {
    output = JSON.parse(text);
  } catch {
    return { problem: 'the tool result is not the probe output' };
  }
  const attempts = output?.attempts;
  if (!isRecord(attempts) || !PROBE_FIELDS.every((field) => isRecord(attempts[field]))) {
    return { problem: 'the tool result is not the probe output' };
  }
  return { probe: { attempts, metadata: isRecord(output.metadata) ? output.metadata : undefined } };
}

const TOOL_METADATA_TITLE = 'The tool sandbox metadata token has no permissions';
const TOOL_KEYS = {
  'gateway-reachable': 'tool-gateway-reachable',
  'egress-internet': 'tool-egress-internet',
  'egress-private-range': 'tool-egress-private',
  'egress-google-vip': 'tool-egress-google-vip',
  'egress-gateway-run-app': 'tool-egress-gateway-run-app',
  'egress-app-run-app': 'tool-egress-app-run-app',
};
const toolTitle = (title) => `In a tool sandbox: ${title.charAt(0).toLowerCase()}${title.slice(1)}`;

/**
 * The tool sandbox's metadata token. Inside the sandbox the Google APIs are unreachable, so the token
 * is useless when both API attempts timed out before connecting; otherwise it is judged like the
 * token mode: an answer must be a 403 and no permission granted. Pure.
 */
export function evaluateToolMetadata(metadata) {
  const attempts = metadata?.attempts;
  if (isRecord(attempts) && classifyAttempt(attempts.api ?? {}) === 'silent' && classifyAttempt(attempts.iam ?? {}) === 'silent') {
    return result(
      TOOL_METADATA_TITLE,
      'pass',
      `the token has no route to a Google API: Cloud Run API ${describeAttempt(attempts.api)}, testIamPermissions ${describeAttempt(attempts.iam)}`,
    );
  }
  if (metadata === undefined) return result(TOOL_METADATA_TITLE, 'inconclusive', 'no metadata token probe ran');
  return { ...evaluateToken(metadata), title: TOOL_METADATA_TITLE };
}

/**
 * The tool lane's results out of one tools/call answer. Pure. `tool-call` passes only on a tools/call
 * result holding the probe's output; without one every other result is inconclusive. A failed gateway
 * control makes the security results inconclusive (evaluateProbes). A reached target is a
 * `SECURITY:` fail, as in the agent sandbox's probe.
 *
 * @param {{ status?: number; text?: string; error?: string }} response @param {boolean} privateControl
 */
export function evaluateToolCall(response, privateControl) {
  const callTitle = 'A code tool runs in a Cloud Run tool sandbox';
  const read = readToolProbe(response);
  if ('problem' in read) {
    const none = result('', 'inconclusive', 'the tool returned no result, so nothing is proven');
    return {
      'tool-call': result(callTitle, 'fail', read.problem),
      ...Object.fromEntries(
        [...Object.values(TOOL_KEYS), 'tool-metadata-token'].map((key) => [
          key,
          { ...none, title: toolTitle(key) },
        ]),
      ),
    };
  }
  const { attempts, metadata } = read.probe;
  const judged = evaluateProbes({ ...attempts, privateControl });
  const results = { 'tool-call': result(callTitle, 'pass', 'tools/call returned the probe output') };
  for (const [key, value] of Object.entries(judged)) {
    results[TOOL_KEYS[key]] = { ...value, title: toolTitle(value.title) };
  }
  results['tool-metadata-token'] =
    judged['gateway-reachable'].outcome === 'pass'
      ? evaluateToolMetadata(metadata)
      : result(TOOL_METADATA_TITLE, 'inconclusive', 'the gateway control failed, so the sandbox network is not proven to work at all');
  return results;
}

/**
 * The gateway's identity must not invoke an agent sandbox: Cloud Run answers 403 before the container
 * runs, because the gateway's grant matches only an `rt-tool-` host. Any other HTTP answer means an
 * invoker binding reaches it. A 403 proves that only when the same identity, by the same route, got
 * past Cloud Run at the tool sandbox (`toolCall`, the positive control): refused there too, the 403
 * may be a refusal of every call, not of the agent sandbox. Pure.
 *
 * @param {{ status?: number; error?: string }} attempt
 * @param {{ status?: number; error?: string }} toolCall
 */
export function evaluateGatewayDenied(attempt, toolCall) {
  const title = 'The gateway identity cannot invoke an agent sandbox';
  if (typeof attempt.status === 'number' && attempt.status !== 403) {
    return result(title, 'fail', `${SECURITY_PREFIX} the gateway identity invoked an agent sandbox (answered ${String(attempt.status)}, want 403)`);
  }
  if (typeof attempt.status !== 'number') return result(title, 'inconclusive', `no answer: ${attempt.error ?? 'unknown'}`);
  if (typeof toolCall.status !== 'number' || toolCall.status === 403) {
    const control = typeof toolCall.status === 'number' ? 'answered 403 too' : `gave no answer (${toolCall.error ?? 'unknown'})`;
    return result(title, 'inconclusive', `Cloud Run answered 403, but the tool sandbox ${control}, so the gateway identity is not shown to invoke anything`);
  }
  return result(title, 'pass', `Cloud Run answered 403, and ${String(toolCall.status)} to the same identity at the tool sandbox`);
}

async function idTokenFor(audience) {
  return (await metadataGet(`identity?audience=${encodeURIComponent(audience)}`)).text();
}

/** A request as the gateway identity; never throws. */
async function gatewayFetch(url, init) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TOOL_TIMEOUT_MS + 30_000), ...init });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    return { error: message(error) };
  }
}

/**
 * The targets `tool-call` hands the probe tool. Unlike the agent sandbox's probe they always carry
 * the project and region, so the tool fetches its sandbox's metadata token and tries it (run
 * 42577620759 sent none, and `tool-metadata-token` was inconclusive). Throws on a missing one. Pure.
 *
 * @param {Record<string, string | undefined>} env
 */
export function toolTargetsFromEnv(env) {
  const targets = targetsFromEnv(env);
  if (targets.project === undefined) throw new Error('GCP_PROJECT is required');
  return targets;
}

async function toolCall() {
  const origin = need('ISOLATION_TOOL_ORIGIN').replace(/\/+$/u, '');
  const targets = toolTargetsFromEnv(process.env);
  const response = await gatewayFetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${need('ISOLATION_TOOL_TOKEN')}`,
      'x-aw-run-id': need('ISOLATION_TOOL_RUN_ID'),
      'x-serverless-authorization': `Bearer ${await idTokenFor(origin)}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: TOOL_NAME, arguments: { targets } },
    }),
  });
  const results = evaluateToolCall(response, process.env.ISOLATION_CONTROL_PRIVATE === 'pass');
  const agentSandbox = need('ISOLATION_AGENT_SANDBOX_URL');
  results['gateway-cannot-invoke-agent-sandbox'] = evaluateGatewayDenied(
    await gatewayFetch(agentSandbox, { headers: { authorization: `Bearer ${await idTokenFor(agentSandbox)}` } }),
    response,
  );
  return { mode: 'tool-call', results };
}

// ---- The shared egress proxy -----------------------------------------------------------------
//
// A sandbox with networkPolicy `restricted` or `open` reaches the world only through the shared
// proxy at a private address, with a proxy URL the runner manager minted. A refusal from the proxy is
// a 403 (a 407 for a credential refusal) whose body is `{"error":"egress_denied", ...}`, for CONNECT
// and for absolute-URI forward requests alike. No detail below ever carries the proxy URL, the token
// or a header: only host:port and the outcome.

const PROXY_DEFAULT_PORT = 3128;
const SECURITY_PREFIX = 'SECURITY:';

/**
 * @typedef {Attempt & { body?: string; tls?: boolean }} ProxyAttempt
 * One request through the proxy: `status` and `body` are the proxy's (or the target's) answer, `tls`
 * is true once a TLS handshake with the target completed through a CONNECT tunnel.
 */

/** @param {string | undefined} body */
function isEgressDenied(body) {
  if (body === undefined) return false;
  try {
    const parsed = JSON.parse(body);
    return parsed !== null && typeof parsed === 'object' && parsed.error === 'egress_denied';
  } catch {
    return false;
  }
}

/**
 * What one request through the proxy proves. Pure.
 *
 *   refused   the proxy answered with the egress_denied body, at any status (403, 407, 502, 400: its own refusal);
 *   answered  anything a target could have produced: a 200 tunnel, a completed TLS handshake, or any
 *             status without the egress_denied body (a forwarded 403 is not a refusal);
 *   silent    no response at all before the timeout, so nothing came back from the target;
 *   unclear   anything else (the proxy refused the connection or reset it, a DNS or local error):
 *             never a pass, because a dead or broken proxy proves nothing about the policy, and never
 *             a fail, because no target answered. It is inconclusive, which fails the lane.
 *
 * @param {ProxyAttempt} attempt
 * @returns {'refused' | 'answered' | 'silent' | 'unclear'}
 */
export function classifyProxyAttempt(attempt) {
  if (attempt.tls === true) return 'answered';
  if (typeof attempt.status === 'number') {
    return isEgressDenied(attempt.body) ? 'refused' : 'answered';
  }
  return attempt.timedOut === true ? 'silent' : 'unclear';
}

/** @param {ProxyAttempt} attempt */
function describeProxyAttempt(attempt) {
  const kind = classifyProxyAttempt(attempt);
  if (kind === 'refused') return `refused ${String(attempt.status)} egress_denied`;
  if (attempt.tls === true) return 'TLS handshake completed';
  if (kind === 'answered') return `answered ${String(attempt.status)}`;
  // Whether the TCP connection to the proxy opened tells a dead or unreachable proxy (a firewall drop,
  // no listener behind the VM's host firewall) from a proxy that accepted and then stalled.
  if (kind === 'silent') {
    return `no response before the timeout (${attempt.connected === true ? 'TCP to the proxy connected' : 'no TCP connection to the proxy'})`;
  }
  return `no usable answer (${attempt.code ?? 'no code'})`;
}

const describeAll = (attempts) =>
  Object.entries(attempts)
    .map(([name, attempt]) => `${name} ${describeProxyAttempt(attempt)}`)
    .join(', ');

/**
 * Attempts at destinations the proxy must refuse: a pass only when every one was refused by the proxy
 * or got no response at all. Any answer from a target is a `SECURITY:` fail.
 *
 * @param {string} title @param {string} target @param {Record<string, ProxyAttempt>} attempts
 */
function evaluateDenied(title, target, attempts) {
  const all = Object.values(attempts).map(classifyProxyAttempt);
  const seen = describeAll(attempts);
  if (all.length === 0) return result(title, 'inconclusive', `no probe of ${target} ran`);
  if (all.includes('answered'))
    return result(title, 'fail', `${SECURITY_PREFIX} the proxy let a request reach ${target} (${seen})`);
  if (all.includes('unclear')) {
    return result(title, 'inconclusive', `only a proxy refusal or no response proves the deny (${seen})`);
  }
  return result(title, 'pass', seen);
}

/**
 * The positive control: through the proxy the listed (or public) host must really answer, by a forward
 * request (2xx or 3xx that is not a proxy refusal) and by a CONNECT tunnel with a TLS handshake.
 *
 * @param {string} title @param {ProxyAttempt} forward @param {ProxyAttempt} tunnel
 */
function evaluateControl(title, forward, tunnel) {
  const forwardOk =
    typeof forward.status === 'number' &&
    forward.status >= 200 &&
    forward.status < 400 &&
    !isEgressDenied(forward.body);
  const tunnelOk = tunnel.tls === true;
  const seen = `forward ${describeProxyAttempt(forward)}, CONNECT ${describeProxyAttempt(tunnel)}`;
  return result(title, forwardOk && tunnelOk ? 'pass' : 'fail', seen);
}

const blind = (title) =>
  result(title, 'inconclusive', 'the positive control failed, so the proxy path is not proven to work at all');

/**
 * The restricted sandbox's results. Pure. When the listed-host control fails, every security result
 * is inconclusive.
 *
 * @param {{
 *   listedForward: ProxyAttempt;
 *   listedConnect: ProxyAttempt;
 *   unlisted: Record<string, ProxyAttempt>;
 *   direct: Record<string, Attempt>;
 *   noCredential: Record<string, ProxyAttempt>;
 * }} raw
 */
export function evaluateProxyRestricted(raw) {
  const listedTitle = 'A restricted sandbox reaches a listed host through the proxy';
  const unlistedTitle = 'A restricted sandbox is refused an unlisted host by the proxy';
  const directTitle = 'A restricted sandbox cannot bypass the proxy with a direct socket';
  const credentialTitle = 'The proxy refuses a request with no credential or a forged one';
  const listed = evaluateControl(listedTitle, raw.listedForward, raw.listedConnect);
  if (listed.outcome !== 'pass') {
    return {
      'proxy-listed-host': listed,
      'proxy-unlisted-host': blind(unlistedTitle),
      'proxy-direct-bypass': blind(directTitle),
      'proxy-no-credential': blind(credentialTitle),
    };
  }
  return {
    'proxy-listed-host': listed,
    'proxy-unlisted-host': evaluateDenied(unlistedTitle, 'an unlisted host', raw.unlisted),
    'proxy-direct-bypass': evaluateSilent(directTitle, 'the public host without the proxy', raw.direct),
    'proxy-no-credential': evaluateCredential(credentialTitle, raw.noCredential),
  };
}

/**
 * A request without a valid credential must be a 407 egress_denied refusal from the proxy. Silence is
 * not enough here (the proxy must say why), and a 403 refusal is the wrong refusal.
 *
 * @param {string} title @param {Record<string, ProxyAttempt>} attempts
 */
function evaluateCredential(title, attempts) {
  const entries = Object.values(attempts);
  const seen = describeAll(attempts);
  if (entries.length === 0) return result(title, 'inconclusive', 'no probe without a valid credential ran');
  if (entries.some((attempt) => classifyProxyAttempt(attempt) === 'answered')) {
    return result(title, 'fail', `${SECURITY_PREFIX} the proxy served a request without a valid credential (${seen})`);
  }
  if (entries.some((attempt) => classifyProxyAttempt(attempt) === 'refused' && attempt.status !== 407)) {
    return result(title, 'fail', `a credential refusal must be a 407 (${seen})`);
  }
  if (entries.some((attempt) => classifyProxyAttempt(attempt) !== 'refused')) {
    return result(title, 'inconclusive', `only a 407 egress_denied refusal proves the credential check (${seen})`);
  }
  return result(title, 'pass', seen);
}

/**
 * The open sandbox's results. Pure. Every destination that is not the public internet must be refused
 * by the proxy or get no response; the public host is the positive control.
 *
 * @param {{
 *   publicForward: ProxyAttempt;
 *   publicConnect: ProxyAttempt;
 *   privateTarget: Record<string, ProxyAttempt>;
 *   metadata: Record<string, ProxyAttempt>;
 *   googleVip: Record<string, ProxyAttempt>;
 *   gatewayIlb: Record<string, ProxyAttempt>;
 * }} raw
 */
export function evaluateProxyOpen(raw) {
  const publicTitle = 'An open sandbox reaches a public host through the proxy';
  const titles = {
    'proxy-private-target': 'The proxy refuses an open sandbox the private ranges',
    'proxy-metadata': 'The proxy refuses an open sandbox the metadata server',
    'proxy-google-vip': 'The proxy refuses an open sandbox the Google VIPs',
    'proxy-gateway-ilb': "The proxy refuses an open sandbox the gateway's internal load balancer",
  };
  const control = evaluateControl(publicTitle, raw.publicForward, raw.publicConnect);
  const checks = {
    'proxy-private-target': ['a private address', raw.privateTarget],
    'proxy-metadata': ['the metadata server', raw.metadata],
    'proxy-google-vip': ['a Google VIP', raw.googleVip],
    'proxy-gateway-ilb': ['the gateway load balancer', raw.gatewayIlb],
  };
  const results = { 'proxy-public-host': control };
  for (const [id, [target, attempts]] of Object.entries(checks)) {
    results[id] = control.outcome === 'pass' ? evaluateDenied(titles[id], target, attempts) : blind(titles[id]);
  }
  return results;
}

/**
 * The proxy's address and credentials out of a proxy URL. Pure. It throws a message that never echoes
 * the URL.
 *
 * @param {string} proxyUrl
 * @returns {{ host: string; port: number; credentials?: string }}
 */
export function parseProxyUrl(proxyUrl) {
  let url;
  try {
    url = new URL(proxyUrl);
  } catch {
    throw new Error('ISOLATION_PROXY_URL is not a valid URL');
  }
  const credentials =
    url.username === '' && url.password === ''
      ? undefined
      : `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  return {
    host: url.hostname,
    port: Number(url.port || PROXY_DEFAULT_PORT),
    ...(credentials === undefined ? {} : { credentials }),
  };
}

/**
 * The same credentials with the first signature character changed (a forged signature). A middle
 * character carries all six data bits, unlike the last, whose unused low bits decode away. Pure.
 */
export function forgeCredentials(credentials) {
  if (credentials === undefined || credentials === '') return 'aw:forged';
  const at = Math.max(credentials.indexOf(':'), credentials.lastIndexOf('.')) + 1;
  const char = credentials.charAt(at);
  return `${credentials.slice(0, at)}${char === 'A' ? 'B' : 'A'}${credentials.slice(at + 1)}`;
}

const proxyAuthorization = (credentials) =>
  credentials === undefined ? {} : { 'Proxy-Authorization': `Basic ${Buffer.from(credentials).toString('base64')}` };

/**
 * An absolute-URI forward request through the proxy. Never throws.
 *
 * @param {{ host: string; port: number; credentials?: string }} proxy @param {string} targetUrl
 * @returns {Promise<ProxyAttempt>}
 */
export function proxyForward(proxy, targetUrl, headers = {}) {
  return requestAttempt(
    httpRequest,
    {
      host: proxy.host,
      port: proxy.port,
      method: 'GET',
      path: targetUrl,
      headers: {
        Host: new URL(targetUrl).host,
        ...proxyAuthorization(proxy.credentials),
        ...headers,
      },
    },
    undefined,
    { readBody: true },
  );
}

/**
 * A CONNECT tunnel to `authority` (host:port) through the proxy. With `tlsServername` a 200 tunnel is
 * followed by a TLS handshake with the target, which is only checked for completing (the certificate is
 * not what is under test). Never throws.
 *
 * @param {{ host: string; port: number; credentials?: string }} proxy @param {string} authority
 * @returns {Promise<ProxyAttempt>}
 */
export function proxyConnect(proxy, authority, { tlsServername = undefined, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let connected = false;
    let timedOut = false;
    let settled = false;
    let status;
    let socket;
    const chunks = [];
    const finish = (attempt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      req.destroy();
      resolve({ connected, timedOut, ...(status === undefined ? {} : { status }), ...attempt });
    };
    const body = () => Buffer.concat(chunks).toString('utf8');
    const timer = setTimeout(() => {
      timedOut = true;
      finish(status === undefined ? { error: 'timed out' } : { body: body() });
    }, timeoutMs);
    const req = httpRequest({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      headers: { Host: authority, ...proxyAuthorization(proxy.credentials) },
      agent: false,
    });
    req.once('socket', (opened) => {
      opened.once('connect', () => {
        connected = true;
      });
    });
    req.once('error', (error) => finish({ code: error.code, error: error.message }));
    req.once('connect', (res, tunnel, head) => {
      socket = tunnel;
      status = res.statusCode;
      if (status === 200) {
        if (tlsServername === undefined) return finish({});
        const secure = tlsConnect({
          socket: tunnel,
          servername: tlsServername,
          rejectUnauthorized: false,
        });
        secure.once('secureConnect', () => finish({ tls: true }));
        secure.once('error', (error) => finish({ tls: false, code: error.code, error: 'TLS handshake failed' }));
        return undefined;
      }
      // A refusal carries its JSON body on the same socket: read it up to its Content-Length.
      const expected = Number(res.headers['content-length'] ?? Number.NaN);
      let size = head.length;
      chunks.push(head);
      const settle = () => finish({ body: body() });
      if (size >= expected) return settle();
      tunnel.on('data', (chunk) => {
        size += chunk.length;
        if (size <= MAX_BODY_BYTES) chunks.push(chunk);
        if (size >= expected) settle();
      });
      tunnel.once('end', settle);
      tunnel.once('close', settle);
      tunnel.once('error', settle);
      return undefined;
    });
    req.end();
  });
}

/** Run named probes in parallel (each silent one waits the full timeout) and keep their names. */
async function settleAll(probes) {
  const names = Object.keys(probes);
  const settled = await Promise.all(Object.values(probes));
  return Object.fromEntries(names.map((name, index) => [name, settled[index]]));
}

const authorityOf = (host, port) => `${host}:${String(port)}`;

/** CONNECT and forward probes of host:port. A forward needs HTTP semantics, so it is `http://`. */
function tunnelAndForward(proxy, host, port, headers = {}) {
  const authority = authorityOf(host, port);
  return {
    [`CONNECT ${authority}`]: proxyConnect(proxy, authority),
    [`GET http://${authority}`]: proxyForward(proxy, `http://${authority}/`, headers),
  };
}

async function proxyRestricted() {
  const proxy = parseProxyUrl(need('ISOLATION_PROXY_URL'));
  const listedUrl = new URL(need('ISOLATION_LISTED_URL'));
  const unlistedHost = need('ISOLATION_UNLISTED_HOST');
  const internetAddress = need('ISOLATION_INTERNET_ADDRESS');
  const listedAuthority = authorityOf(listedUrl.hostname, 443);

  const [listedForward, listedConnect, unlisted, direct, noCredential] = await Promise.all([
    proxyForward(proxy, listedUrl.href),
    proxyConnect(proxy, listedAuthority, { tlsServername: listedUrl.hostname }),
    settleAll({
      [`CONNECT ${authorityOf(unlistedHost, 443)}`]: proxyConnect(proxy, authorityOf(unlistedHost, 443)),
      [`GET http://${unlistedHost}`]: proxyForward(proxy, `http://${unlistedHost}/`),
    }),
    settleAll({
      [`TCP 443 to ${internetAddress} without the proxy`]: tcpAttempt(internetAddress, 443),
      [`TCP 80 to ${internetAddress} without the proxy`]: tcpAttempt(internetAddress, 80),
    }),
    settleAll({
      [`CONNECT ${listedAuthority} with no credential`]: proxyConnect(
        { ...proxy, credentials: undefined },
        listedAuthority,
      ),
      [`CONNECT ${listedAuthority} with a forged token`]: proxyConnect(
        { ...proxy, credentials: forgeCredentials(proxy.credentials) },
        listedAuthority,
      ),
    }),
  ]);
  return {
    mode: 'proxy-restricted',
    results: evaluateProxyRestricted({
      listedForward,
      listedConnect,
      unlisted,
      direct,
      noCredential,
    }),
  };
}

async function proxyOpen() {
  const proxy = parseProxyUrl(need('ISOLATION_PROXY_URL'));
  const listedUrl = new URL(need('ISOLATION_LISTED_URL'));
  const privateAddress = need('ISOLATION_PRIVATE_ADDRESS');
  const gatewayUrl = new URL(need('ISOLATION_GATEWAY_URL'));
  const metadataHeaders = { 'Metadata-Flavor': 'Google' };

  const [publicForward, publicConnect, privateTarget, metadata, googleVip, gatewayIlb] = await Promise.all([
    proxyForward(proxy, listedUrl.href),
    proxyConnect(proxy, authorityOf(listedUrl.hostname, 443), {
      tlsServername: listedUrl.hostname,
    }),
    settleAll({
      ...tunnelAndForward(proxy, privateAddress, 5432),
      ...tunnelAndForward(proxy, privateAddress, 80),
    }),
    settleAll({
      ...Object.fromEntries(
        ['169.254.169.254', 'metadata.google.internal'].map((host) => [
          `GET http://${host}:80`,
          proxyForward(proxy, `http://${host}:80/computeMetadata/v1/`, metadataHeaders),
        ]),
      ),
      ...Object.fromEntries(
        ['169.254.169.254', 'metadata.google.internal'].map((host) => [
          `CONNECT ${host}:443`,
          proxyConnect(proxy, authorityOf(host, 443)),
        ]),
      ),
    }),
    settleAll(
      Object.fromEntries(
        [PRIVATE_GOOGLE_VIP, RESTRICTED_GOOGLE_VIP, 'private.googleapis.com', 'restricted.googleapis.com'].map(
          (host) => [`CONNECT ${host}:443`, proxyConnect(proxy, authorityOf(host, 443))],
        ),
      ),
    ),
    settleAll(tunnelAndForward(proxy, gatewayUrl.hostname, 80)),
  ]);
  return {
    mode: 'proxy-open',
    results: evaluateProxyOpen({
      publicForward,
      publicConnect,
      privateTarget,
      metadata,
      googleVip,
      gatewayIlb,
    }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [mode, argument] = process.argv.slice(2);
  // The workflow's per-execution nonce, echoed so a line of an earlier execution is never read.
  const nonce = process.env.AW_ISOLATION_NONCE ?? '';
  let payload;
  try {
    if (mode === 'create') payload = await create();
    else if (mode === 'destroy') payload = await destroy(argument);
    else if (mode === 'probe') payload = await probe();
    else if (mode === 'token') payload = await token();
    else if (mode === 'tool-open') payload = await toolOpen();
    else if (mode === 'tool-call') payload = await toolCall();
    else if (mode === 'tool-close') payload = await toolClose();
    else if (mode === 'proxy-restricted') payload = await proxyRestricted();
    else if (mode === 'proxy-open') payload = await proxyOpen();
    else
      throw new Error(
        'usage: cloud-run-lane.mjs create | destroy <id> | probe | token | tool-open | tool-call | tool-close | proxy-restricted | proxy-open',
      );
  } catch (error) {
    payload = { mode, error: message(error), results: {} };
  }
  process.stdout.write(`${MARKER} ${JSON.stringify({ ...payload, nonce })}\n`);
}
