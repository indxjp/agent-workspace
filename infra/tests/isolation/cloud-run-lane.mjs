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
 *                   runner manager and check the positive control: the Cloud SQL private address
 *                   must be reachable from the services subnet.
 *   destroy <id>    (same identity) delete that sandbox.
 *   probe           (sandbox network shape, runtime service account) assert the isolation.
 *   token           (services subnet, runtime service account) assert the sandbox identity's
 *                   metadata token has no permissions: the Cloud Run API must answer 403, and
 *                   testIamPermissions on the project must grant none of SENSITIVE_PERMISSIONS. It
 *                   runs outside the sandbox shape because a sandbox reaches no Google API at all,
 *                   so its token cannot be tried from there.
 *
 * No mode depends on a model reply, and none logs a token, a header or a secret value.
 */
import { connect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MARKER = 'AW_ISOLATION_RESULT';
const METADATA = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default';
// private.googleapis.com (199.36.153.8/30): every *.run.app host and Google API. The services reach
// each other through it; a sandbox must not reach it at all.
const PRIVATE_GOOGLE_VIP = '199.36.153.8';
// restricted.googleapis.com (199.36.153.4/30): the VPC Service Controls VIP, denied to sandboxes too.
const RESTRICTED_GOOGLE_VIP = '199.36.153.4';
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Permissions the sandbox identity must not hold on its project. The runtime service account holds
 * no project role at all, so testIamPermissions must grant none of them. `logging.logEntries.create`
 * is included on purpose: Cloud Run collects a container's stdout without the workload's own
 * permission, so the runtime service account needs no log writer role and has none. A binding on a
 * single resource (one bucket, one secret, one service account) is not visible to this project-level
 * check; the Cloud Run API call and the zero-role Terraform cover that side.
 */
export const SENSITIVE_PERMISSIONS = Object.freeze([
  'run.services.list',
  'run.services.create',
  'run.jobs.run',
  'storage.objects.get',
  'storage.objects.create',
  'storage.objects.list',
  'storage.buckets.list',
  'secretmanager.versions.access',
  'secretmanager.secrets.list',
  'aiplatform.endpoints.predict',
  'iam.serviceAccounts.getAccessToken',
  'iam.serviceAccounts.actAs',
  'iam.serviceAccountKeys.create',
  'cloudsql.instances.connect',
  'compute.instances.list',
  'logging.logEntries.create',
  'resourcemanager.projects.setIamPolicy',
]);

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
  if (!gatewayOk) {
    return {
      'gateway-reachable': gateway,
      'egress-internet': blind(internetTitle),
      'egress-private-range': blind(privateTitle),
      'egress-google-vip': blind(vipTitle),
      'egress-gateway-run-app': blind(runAppTitle),
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

/**
 * The permissions of a testIamPermissions answer. An answer with no permission granted omits the
 * field, so an absent field is an empty list; anything else malformed is undefined.
 *
 * @param {string} body @returns {string[] | undefined}
 */
export function grantedPermissions(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const { permissions } = parsed;
  if (permissions === undefined) return [];
  if (!Array.isArray(permissions) || !permissions.every((permission) => typeof permission === 'string')) {
    return undefined;
  }
  return permissions;
}

/**
 * A raw TCP connect with a timeout. Never throws.
 *
 * @param {string} host @param {number} port @param {number} [timeoutMs] @returns {Promise<Attempt>}
 */
export function tcpAttempt(host, port, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (attempt) => {
      socket.destroy();
      resolve(attempt);
    };
    socket.setTimeout(timeoutMs, () => done({ connected: false, timedOut: true, error: 'timed out' }));
    socket.once('connect', () => done({ connected: true }));
    socket.once('error', (error) => done({ connected: false, code: error.code, error: error.message }));
  });
}

/**
 * One request with a timeout, on a fresh connection (no keep-alive reuse, so `connected` is about
 * this request). Resolves the status, and the body only when asked; never throws.
 *
 * @returns {Promise<Attempt & { body?: string }>}
 */
export function requestAttempt(requestFn, options, body = undefined, { readBody = false, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let connected = false;
    let timedOut = false;
    let settled = false;
    const finish = (attempt) => {
      if (settled) return;
      settled = true;
      resolve({ connected, timedOut, ...attempt });
    };
    const req = requestFn({ ...options, agent: false, timeout: timeoutMs }, (res) => {
      if (!readBody) {
        res.resume();
        finish({ status: res.statusCode });
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      });
      res.once('end', () => finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.once('error', (error) => finish({ status: res.statusCode, error: error.message }));
    });
    req.once('socket', (socket) => {
      if (!socket.connecting && socket.remoteAddress !== undefined) connected = true;
      socket.once('connect', () => {
        connected = true;
      });
    });
    req.once('timeout', () => {
      timedOut = true;
      req.destroy(new Error('timed out'));
    });
    req.once('error', (error) => finish({ code: error.code, error: error.message }));
    req.end(body);
  });
}

const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

async function metadataGet(route, headers = {}) {
  const response = await fetch(`${METADATA}/${route}`, {
    headers: { 'Metadata-Flavor': 'Google', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return response;
}

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
  if (!response.ok) throw new Error(`runner manager ${method} ${route} answered ${String(response.status)}`);
  return text === '' ? null : JSON.parse(text);
}

async function create() {
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
        networkPolicy: 'none',
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
  return { mode: 'create', handleId, service: handleId === undefined ? undefined : `rt-${handleId}`, results };
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

/** A request to a Google VIP by IP literal, with the SNI and Host of the given name. */
const vipRequest = (vip, host, options = {}, body = undefined, extra = {}) =>
  requestAttempt(
    httpsRequest,
    { path: '/', ...options, host: vip, servername: host, headers: { Host: host, ...options.headers } },
    body,
    extra,
  );

async function probe() {
  const internetUrl = new URL(need('ISOLATION_INTERNET_URL'));
  const internetAddress = need('ISOLATION_INTERNET_ADDRESS');
  const privateAddress = need('ISOLATION_PRIVATE_ADDRESS');

  // The gateway through its internal load balancer: plain HTTP to a private address.
  const gatewayUrl = new URL(need('ISOLATION_GATEWAY_URL'));
  const gatewayAnswer = await requestAttempt(gatewayUrl.protocol === 'https:' ? httpsRequest : httpRequest, {
    hostname: gatewayUrl.hostname,
    ...(gatewayUrl.port === '' ? {} : { port: gatewayUrl.port }),
    path: `${gatewayUrl.pathname.replace(/\/+$/u, '')}/health`,
  });
  // The gateway's own run.app URL, resolved by the sandbox through the private run.app zone to the VIP.
  const runAppUrl = new URL(need('ISOLATION_GATEWAY_RUN_APP_URL'));
  const gatewayRunApp = await requestAttempt(httpsRequest, {
    hostname: runAppUrl.hostname,
    path: `${runAppUrl.pathname.replace(/\/+$/u, '')}/health`,
  });
  // The public host and the private range: an HTTP request and raw TCP connects, all by IP literal.
  const internetPort = Number(internetUrl.port || 80);
  const [internetHttp, internetTcp443, privateTcp] = await Promise.all([
    requestAttempt(httpRequest, {
      host: internetAddress,
      port: internetPort,
      path: `${internetUrl.pathname}${internetUrl.search}`,
      headers: { Host: internetUrl.host },
    }),
    tcpAttempt(internetAddress, 443),
    tcpAttempt(privateAddress, 5432),
  ]);

  // Attempts that may only time out before the connect. The API probes and the raw TCP connects need
  // no configuration, so the check always runs; the external run.app host and bucket are the
  // attacker-shaped targets when set. They run in parallel: each silent one waits the full timeout.
  const runAppHostViaVip = `${runAppUrl.hostname} on private.googleapis.com`;
  const attempts = {
    'run.googleapis.com on private.googleapis.com': vipRequest(PRIVATE_GOOGLE_VIP, 'run.googleapis.com'),
    'run.googleapis.com on restricted.googleapis.com': vipRequest(RESTRICTED_GOOGLE_VIP, 'run.googleapis.com'),
    [runAppHostViaVip]: vipRequest(PRIVATE_GOOGLE_VIP, runAppUrl.hostname, { path: '/health' }),
  };
  for (const [label, vip] of [
    ['private.googleapis.com', PRIVATE_GOOGLE_VIP],
    ['restricted.googleapis.com', RESTRICTED_GOOGLE_VIP],
  ]) {
    for (const port of [443, 80]) attempts[`TCP ${String(port)} to ${label} (${vip})`] = tcpAttempt(vip, port);
  }
  const externalRunApp = process.env.ISOLATION_EXTERNAL_RUNAPP_HOST;
  if (externalRunApp) {
    attempts['run.app service outside the project'] = vipRequest(PRIVATE_GOOGLE_VIP, externalRunApp);
  }
  const externalBucket = process.env.ISOLATION_EXTERNAL_BUCKET;
  if (externalBucket) {
    attempts['GCS upload outside the project'] = vipRequest(
      PRIVATE_GOOGLE_VIP,
      'storage.googleapis.com',
      {
        method: 'POST',
        path: `/upload/storage/v1/b/${encodeURIComponent(externalBucket)}/o?uploadType=media&name=aw-isolation-probe`,
        headers: { 'Content-Type': 'text/plain', 'Content-Length': 2 },
      },
      'ok',
    );
  }
  const names = Object.keys(attempts);
  const settled = await Promise.all(Object.values(attempts));
  const googleVip = Object.fromEntries(names.map((name, index) => [name, settled[index]]));

  const results = evaluateProbes({
    googleVip,
    gateway: gatewayAnswer,
    gatewayRunApp,
    gatewayRunAppViaVip: googleVip[runAppHostViaVip],
    internet: {
      [`HTTP ${internetUrl.host} at ${internetAddress}:${String(internetPort)}`]: internetHttp,
      [`TCP 443 to ${internetAddress}`]: internetTcp443,
    },
    private: { [`TCP 5432 to ${privateAddress}`]: privateTcp },
    privateControl: process.env.ISOLATION_CONTROL_PRIVATE === 'pass',
  });
  return { mode: 'probe', results };
}

/** The sandbox identity's token against Google APIs, from the services subnet. */
async function token() {
  const project = need('GCP_PROJECT');
  const region = need('GCP_REGION');
  const metadata = {};
  try {
    const tokenResponse = await metadataGet('token');
    metadata.tokenStatus = tokenResponse.status;
    if (tokenResponse.ok) {
      const accessToken = (await tokenResponse.json()).access_token;
      const api = await vipRequest(PRIVATE_GOOGLE_VIP, 'run.googleapis.com', {
        path: `/v2/projects/${project}/locations/${region}/services`,
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      metadata.apiStatus = api.status;
      metadata.error = api.error;
      const payload = JSON.stringify({ permissions: SENSITIVE_PERMISSIONS });
      const iam = await vipRequest(
        PRIVATE_GOOGLE_VIP,
        'cloudresourcemanager.googleapis.com',
        {
          method: 'POST',
          path: `/v1/projects/${encodeURIComponent(project)}:testIamPermissions`,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        payload,
        { readBody: true },
      );
      // Only the status and the granted permission names are kept, never the rest of the body.
      metadata.iam = {
        status: iam.status,
        error: iam.error,
        granted: iam.status === 200 && iam.body !== undefined ? grantedPermissions(iam.body) : undefined,
      };
    }
  } catch (error) {
    metadata.error = message(error);
  }
  return { mode: 'token', results: { 'metadata-token-useless': evaluateToken(metadata) } };
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
    else throw new Error('usage: cloud-run-lane.mjs create | destroy <id> | probe | token');
  } catch (error) {
    payload = { mode, error: message(error), results: {} };
  }
  process.stdout.write(`${MARKER} ${JSON.stringify({ ...payload, nonce })}\n`);
}
