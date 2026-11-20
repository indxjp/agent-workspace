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
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  collectAttempts,
  collectMetadata,
  getAttempt,
  targetsFromEnv,
  tcpAttempt,
} from './attempts.mjs';
import { message, result } from './lane-result.mjs';
import { managerCall, need, networkPolicyFromEnv } from './manager-client.mjs';
import { evaluateAppHealth, evaluateProbes, evaluateToken } from './probe-evaluation.mjs';
import { proxyOpen, proxyRestricted } from './proxy-lane.mjs';
import { toolCall, toolClose, toolOpen } from './tool-lane.mjs';

// The attempts live in attempts.mjs so the tool probe (tool-probe.mjs) shares them; the evaluations
// and the modes live in the modules below. This file keeps every name the lane's tests and callers
// have always imported from here.
export {
  SENSITIVE_PERMISSIONS,
  grantedPermissions,
  requestAttempt,
  tcpAttempt,
} from './attempts.mjs';
export { managerFailure, networkPolicyFromEnv } from './manager-client.mjs';
export {
  METADATA_TITLE,
  classifyAttempt,
  evaluateAppHealth,
  evaluateProbes,
  evaluateToken,
} from './probe-evaluation.mjs';
export {
  classifyProxyAttempt,
  evaluateProxyOpen,
  evaluateProxyRestricted,
} from './proxy-evaluation.mjs';
export { forgeCredentials, parseProxyUrl, proxyConnect, proxyForward } from './proxy-attempts.mjs';
export {
  TOOL_NAME,
  evaluateGatewayDenied,
  evaluateToolCall,
  evaluateToolMetadata,
  parseToolAnswer,
  readToolProbe,
  toolOpenRequest,
  toolProbeBundle,
  toolTargetsFromEnv,
} from './tool-lane.mjs';

const MARKER = 'AW_ISOLATION_RESULT';
const CREATE_TITLE = 'A sandbox is created through the runner manager';
const CLOUD_SQL_PORT = 5432;

/** The runner manager request that creates the `none`/`restricted`/`open` sandbox under test. */
function sandboxRequest(id, { networkPolicy, allowedDomains }) {
  return {
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
  };
}

/** Create the sandbox; its handle id (when it was created) and the result of trying. */
async function createSandbox(policy) {
  try {
    const { handle } = await managerCall(
      'POST',
      '/runtimes',
      sandboxRequest(randomBytes(3).toString('hex'), policy),
    );
    return { handleId: handle.id, outcome: result(CREATE_TITLE, 'pass', `handle ${handle.id}`) };
  } catch (error) {
    return { handleId: undefined, outcome: result(CREATE_TITLE, 'fail', message(error)) };
  }
}

/** The positive control: the Cloud SQL private address is reachable from the services subnet. */
async function privateRangeControl() {
  const reached =
    (await tcpAttempt(need('ISOLATION_PRIVATE_ADDRESS'), CLOUD_SQL_PORT)).connected === true;
  return result(
    'The private address is reachable from the services subnet',
    reached ? 'pass' : 'fail',
    reached
      ? `TCP ${String(CLOUD_SQL_PORT)} connected`
      : `TCP ${String(CLOUD_SQL_PORT)} did not connect`,
  );
}

async function create() {
  const policy = networkPolicyFromEnv(process.env);
  const { handleId, outcome } = await createSandbox(policy);
  const results = { 'sandbox-create': outcome };
  results['control-private-range'] = await privateRangeControl();
  if (process.env.ISOLATION_APP_URL) {
    results['control-app-health'] = evaluateAppHealth(
      await getAttempt(process.env.ISOLATION_APP_URL, '/api/health'),
    );
  }
  return {
    mode: 'create',
    networkPolicy: policy.networkPolicy,
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
    return {
      mode: 'destroy',
      results: { 'sandbox-destroy': result(title, 'fail', message(error)) },
    };
  }
}

async function probe() {
  const raw = await collectAttempts(targetsFromEnv(process.env));
  const results = evaluateProbes({
    ...raw,
    privateControl: process.env.ISOLATION_CONTROL_PRIVATE === 'pass',
  });
  return { mode: 'probe', results };
}

/** The sandbox identity's token against Google APIs, from the services subnet. */
async function token() {
  const metadata = await collectMetadata(need('GCP_PROJECT'), need('GCP_REGION'));
  return { mode: 'token', results: { 'metadata-token-useless': evaluateToken(metadata) } };
}

const MODES = {
  create,
  destroy,
  probe,
  token,
  'tool-open': toolOpen,
  'tool-call': toolCall,
  'tool-close': toolClose,
  'proxy-restricted': proxyRestricted,
  'proxy-open': proxyOpen,
};
const USAGE =
  'usage: cloud-run-lane.mjs create | destroy <id> | probe | token | tool-open | tool-call | tool-close | proxy-restricted | proxy-open';

async function runMode(mode, argument) {
  if (!Object.hasOwn(MODES, mode)) throw new Error(USAGE);
  return MODES[mode](argument);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [mode, argument] = process.argv.slice(2);
  // The workflow's per-execution nonce, echoed so a line of an earlier execution is never read.
  const nonce = process.env.AW_ISOLATION_NONCE ?? '';
  let payload;
  try {
    payload = await runMode(mode, argument);
  } catch (error) {
    payload = { mode, error: message(error), results: {} };
  }
  process.stdout.write(`${MARKER} ${JSON.stringify({ ...payload, nonce })}\n`);
}
