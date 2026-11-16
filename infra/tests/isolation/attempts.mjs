/**
 * The network attempts the Cloud Run isolation lane makes, shared by the `probe` job (a sandbox
 * shaped job) and by the tool probe (tool-probe.mjs, which runs inside a tool sandbox). Only Node
 * built-ins and globals are used and every declaration is a top-level `export const|function`:
 * the `tool-open` mode inlines this file into the single-file bundle the tool host imports (see
 * toolProbeBundle in cloud-run-lane.mjs). Nothing here judges an attempt; evaluation stays in
 * cloud-run-lane.mjs.
 */
import { connect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export const METADATA = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default';
// private.googleapis.com (199.36.153.8/30): every *.run.app host and Google API. The services reach
// each other through it; a sandbox must not reach it at all.
export const PRIVATE_GOOGLE_VIP = '199.36.153.8';
// restricted.googleapis.com (199.36.153.4/30): the VPC Service Controls VIP, denied to sandboxes too.
export const RESTRICTED_GOOGLE_VIP = '199.36.153.4';
export const TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 64 * 1024;

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

const message = (error) => (error instanceof Error ? error.message : String(error));

/**
 * A raw TCP connect with a timeout. Never throws.
 *
 * @param {string} host @param {number} port @param {number} [timeoutMs]
 * @returns {Promise<{ connected: boolean; timedOut?: boolean; code?: string; error?: string }>}
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

/** A request to a Google VIP by IP literal, with the SNI and Host of the given name. */
export const vipRequest = (vip, host, options = {}, body = undefined, extra = {}) =>
  requestAttempt(
    httpsRequest,
    { path: '/', ...options, host: vip, servername: host, headers: { Host: host, ...options.headers } },
    body,
    extra,
  );

/** GET `<url><suffix>` over the URL's own scheme, by name. */
export function getAttempt(url, suffix) {
  const parsed = new URL(url);
  return requestAttempt(parsed.protocol === 'https:' ? httpsRequest : httpRequest, {
    hostname: parsed.hostname,
    ...(parsed.port === '' ? {} : { port: parsed.port }),
    path: `${parsed.pathname.replace(/\/+$/u, '')}${suffix}`,
  });
}

export async function metadataGet(route, headers = {}) {
  return fetch(`${METADATA}/${route}`, {
    headers: { 'Metadata-Flavor': 'Google', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
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
 * The destinations of the sandbox probe, read from the lane's environment. `appRunAppUrl`,
 * `externalRunAppHost` and `externalBucket` are optional.
 *
 * @param {Record<string, string | undefined>} env
 */
export function targetsFromEnv(env) {
  const required = (name) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  return {
    internetUrl: required('ISOLATION_INTERNET_URL'),
    internetAddress: required('ISOLATION_INTERNET_ADDRESS'),
    privateAddress: required('ISOLATION_PRIVATE_ADDRESS'),
    gatewayUrl: required('ISOLATION_GATEWAY_URL'),
    gatewayRunAppUrl: required('ISOLATION_GATEWAY_RUN_APP_URL'),
    ...(env['ISOLATION_APP_RUN_APP_URL'] ? { appRunAppUrl: env['ISOLATION_APP_RUN_APP_URL'] } : {}),
    ...(env['ISOLATION_EXTERNAL_RUNAPP_HOST'] ? { externalRunAppHost: env['ISOLATION_EXTERNAL_RUNAPP_HOST'] } : {}),
    ...(env['ISOLATION_EXTERNAL_BUCKET'] ? { externalBucket: env['ISOLATION_EXTERNAL_BUCKET'] } : {}),
    ...(env['GCP_PROJECT'] ? { project: env['GCP_PROJECT'], region: required('GCP_REGION') } : {}),
  };
}

/**
 * Every network attempt of the sandbox probe, raw and unjudged. Never throws.
 *
 * @param {ReturnType<typeof targetsFromEnv>} targets
 */
export async function collectAttempts(targets) {
  const internetUrl = new URL(targets.internetUrl);
  const { internetAddress, privateAddress } = targets;
  // The gateway through its internal load balancer: plain HTTP to a private address.
  const gateway = await getAttempt(targets.gatewayUrl, '/health');
  // The gateway's own run.app URL, resolved by the sandbox through the private run.app zone to the VIP.
  const runAppUrl = new URL(targets.gatewayRunAppUrl);
  const gatewayRunApp = await getAttempt(targets.gatewayRunAppUrl, '/health');
  // The public host and the private range: an HTTP request and raw TCP connects, all by IP literal.
  const internetPort = Number(internetUrl.port || 80);
  const appRunAppUrl = targets.appRunAppUrl === undefined ? undefined : new URL(targets.appRunAppUrl);
  const [internetHttp, internetTcp443, privateTcp, appRunApp] = await Promise.all([
    requestAttempt(httpRequest, {
      host: internetAddress,
      port: internetPort,
      path: `${internetUrl.pathname}${internetUrl.search}`,
      headers: { Host: internetUrl.host },
    }),
    tcpAttempt(internetAddress, 443),
    tcpAttempt(privateAddress, 5432),
    appRunAppUrl === undefined ? undefined : getAttempt(targets.appRunAppUrl, '/api/health'),
  ]);

  // Attempts that may only time out before the connect. The API probes and the raw TCP connects need
  // no configuration, so the check always runs; the external run.app host and bucket are the
  // attacker-shaped targets when set. They run in parallel: each silent one waits the full timeout.
  const runAppHostViaVip = `${runAppUrl.hostname} on private.googleapis.com`;
  const appRunAppHostViaVip = appRunAppUrl === undefined ? undefined : `${appRunAppUrl.hostname} on private.googleapis.com`;
  const attempts = {
    'run.googleapis.com on private.googleapis.com': vipRequest(PRIVATE_GOOGLE_VIP, 'run.googleapis.com'),
    'run.googleapis.com on restricted.googleapis.com': vipRequest(RESTRICTED_GOOGLE_VIP, 'run.googleapis.com'),
    [runAppHostViaVip]: vipRequest(PRIVATE_GOOGLE_VIP, runAppUrl.hostname, { path: '/health' }),
    ...(appRunAppUrl === undefined
      ? {}
      : { [appRunAppHostViaVip]: vipRequest(PRIVATE_GOOGLE_VIP, appRunAppUrl.hostname, { path: '/api/health' }) }),
  };
  for (const [label, vip] of [
    ['private.googleapis.com', PRIVATE_GOOGLE_VIP],
    ['restricted.googleapis.com', RESTRICTED_GOOGLE_VIP],
  ]) {
    for (const port of [443, 80]) attempts[`TCP ${String(port)} to ${label} (${vip})`] = tcpAttempt(vip, port);
  }
  if (targets.externalRunAppHost) {
    attempts['run.app service outside the project'] = vipRequest(PRIVATE_GOOGLE_VIP, targets.externalRunAppHost);
  }
  if (targets.externalBucket) {
    attempts['GCS upload outside the project'] = vipRequest(
      PRIVATE_GOOGLE_VIP,
      'storage.googleapis.com',
      {
        method: 'POST',
        path: `/upload/storage/v1/b/${encodeURIComponent(targets.externalBucket)}/o?uploadType=media&name=aw-isolation-probe`,
        headers: { 'Content-Type': 'text/plain', 'Content-Length': 2 },
      },
      'ok',
    );
  }
  const names = Object.keys(attempts);
  const settled = await Promise.all(Object.values(attempts));
  const googleVip = Object.fromEntries(names.map((name, index) => [name, settled[index]]));

  return {
    googleVip,
    gateway,
    gatewayRunApp,
    gatewayRunAppViaVip: googleVip[runAppHostViaVip],
    ...(appRunApp === undefined
      ? {}
      : { appRunApp, appRunAppViaVip: googleVip[appRunAppHostViaVip] }),
    internet: {
      [`HTTP ${internetUrl.host} at ${internetAddress}:${String(internetPort)}`]: internetHttp,
      [`TCP 443 to ${internetAddress}`]: internetTcp443,
    },
    private: { [`TCP 5432 to ${privateAddress}`]: privateTcp },
  };
}

/** An attempt without its body: only what classifies it. */
const bare = ({ status, code, error, connected, timedOut }) => ({ status, code, error, connected, timedOut });

/**
 * What the identity's metadata token can do against Google APIs, by the Cloud Run API and
 * testIamPermissions through the private VIP. Only statuses and granted permission names are kept,
 * never the token or a body. `attempts` holds the two raw API attempts so a caller can tell a
 * refusal from a path that does not exist. Never throws.
 */
export async function collectMetadata(project, region) {
  const metadata = {};
  try {
    const tokenResponse = await metadataGet('token');
    metadata.tokenStatus = tokenResponse.status;
    if (tokenResponse.ok) {
      const accessToken = (await tokenResponse.json()).access_token;
      const payload = JSON.stringify({ permissions: SENSITIVE_PERMISSIONS });
      const [api, iam] = await Promise.all([
        vipRequest(PRIVATE_GOOGLE_VIP, 'run.googleapis.com', {
          path: `/v2/projects/${project}/locations/${region}/services`,
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
        vipRequest(
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
        ),
      ]);
      metadata.apiStatus = api.status;
      metadata.error = api.error;
      metadata.iam = {
        status: iam.status,
        error: iam.error,
        granted: iam.status === 200 && iam.body !== undefined ? grantedPermissions(iam.body) : undefined,
      };
      metadata.attempts = { api: bare(api), iam: bare(iam) };
    }
  } catch (error) {
    metadata.error = message(error);
  }
  return metadata;
}
