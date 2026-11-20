/**
 * The tool sandbox lane. A code tool runs in a tool sandbox (a Cloud Run service `rt-tool-...`) that
 * only the gateway's identity may invoke. `tool-open` ships tool-probe.mjs as the one tool of a
 * sandbox it opens through the runner manager; `tool-call` invokes it as the gateway, so the probe's
 * attempts run inside the tool sandbox, and judges them here with the same evaluations as the agent
 * sandbox; `tool-close` removes the sandbox. The bearer token and the run id come from the workflow,
 * which gives the same values to `tool-open` and `tool-call`; no mode prints the token.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { targetsFromEnv } from './attempts.mjs';
import { SECURITY_PREFIX, isRecord, message, result } from './lane-result.mjs';
import { idTokenFor, managerCall, need } from './manager-client.mjs';
import {
  GATEWAY_CONTROL_FAILED,
  classifyAttempt,
  describeAttempt,
  evaluateProbes,
  evaluateToken,
} from './probe-evaluation.mjs';

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
  if (!SHARED_IMPORT.test(probeSource))
    throw new Error('tool-probe.mjs must import only ./attempts.mjs');
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

export async function toolOpen() {
  const title = 'A tool sandbox is opened through the runner manager';
  const runId = need('ISOLATION_TOOL_RUN_ID');
  const request = toolOpenRequest({
    id: randomBytes(3).toString('hex'),
    runId,
    token: need('ISOLATION_TOOL_TOKEN'),
  });
  const { workspaceId, clientId } = request;
  try {
    const origin = (await managerCall('POST', '/tool-sandboxes', request))?.toolSandbox?.origin;
    if (typeof origin !== 'string' || origin === '')
      throw new Error('the runner manager answered no tool sandbox origin');
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

export async function toolClose() {
  const title = 'The tool sandbox is closed through the runner manager';
  const route = `/tool-sandboxes/sessions/${encodeURIComponent(need('ISOLATION_TOOL_CLIENT_ID'))}`;
  try {
    await managerCall(
      'DELETE',
      `${route}?workspaceId=${encodeURIComponent(need('ISOLATION_TOOL_WORKSPACE_ID'))}`,
    );
    return {
      mode: 'tool-close',
      results: { 'tool-sandbox-close': result(title, 'pass', 'closed') },
    };
  } catch (error) {
    return {
      mode: 'tool-close',
      results: { 'tool-sandbox-close': result(title, 'fail', message(error)) },
    };
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
  const candidates = [
    text,
    ...text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5)),
  ];
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

const PROBE_FIELDS = ['gateway', 'gatewayRunApp', 'internet', 'private', 'googleVip'];

const PROBE_OUTPUT_PROBLEM = 'the tool result is not the probe output';

/** Why a non-200 tools/call answer was refused, as a suffix for the problem text. */
function refusalReason(status, answer) {
  const reason = typeof answer?.error === 'string' ? answer.error : answer?.error?.message;
  if (typeof reason === 'string') return ` (${reason.slice(0, 120)})`;
  // The tool host answers JSON; a bare 403 is Cloud Run's own refusal, before the container.
  const refusedByCloudRun = status === 403 && answer === undefined;
  return refusedByCloudRun
    ? ' (by Cloud Run, before the container: the caller may not invoke this service)'
    : '';
}

/** The probe output the tool returned as text, or a problem. */
function parseProbeOutput(text) {
  let output;
  try {
    output = JSON.parse(text);
  } catch {
    return { problem: PROBE_OUTPUT_PROBLEM };
  }
  const attempts = output?.attempts;
  if (!isRecord(attempts) || !PROBE_FIELDS.every((field) => isRecord(attempts[field]))) {
    return { problem: PROBE_OUTPUT_PROBLEM };
  }
  return { probe: { attempts, metadata: isRecord(output.metadata) ? output.metadata : undefined } };
}

/**
 * The probe's raw attempts out of a tools/call answer, or the reason there are none. Pure.
 *
 * @param {{ status?: number; text?: string; error?: string }} response
 * @returns {{ probe: { attempts: Record<string, any>; metadata?: Record<string, any> } } | { problem: string }}
 */
export function readToolProbe(response) {
  if (typeof response.status !== 'number')
    return { problem: `no answer: ${response.error ?? 'unknown'}` };
  const answer = parseToolAnswer(response.text);
  if (response.status !== 200) {
    return {
      problem: `POST /mcp answered ${String(response.status)}${refusalReason(response.status, answer)}`,
    };
  }
  if (!isRecord(answer?.result)) {
    return {
      problem: `POST /mcp answered 200 without a tools/call result${isRecord(answer?.error) ? ' (a JSON-RPC error)' : ''}`,
    };
  }
  const text = answer.result.content?.[0]?.text;
  if (answer.result.isError === true) {
    return {
      problem: `the tool failed: ${typeof text === 'string' ? text.slice(0, 120) : 'no message'}`,
    };
  }
  return parseProbeOutput(text);
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
  if (
    isRecord(attempts) &&
    classifyAttempt(attempts.api ?? {}) === 'silent' &&
    classifyAttempt(attempts.iam ?? {}) === 'silent'
  ) {
    return result(
      TOOL_METADATA_TITLE,
      'pass',
      `the token has no route to a Google API: Cloud Run API ${describeAttempt(attempts.api)}, testIamPermissions ${describeAttempt(attempts.iam)}`,
    );
  }
  if (metadata === undefined)
    return result(TOOL_METADATA_TITLE, 'inconclusive', 'no metadata token probe ran');
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
  const results = {
    'tool-call': result(callTitle, 'pass', 'tools/call returned the probe output'),
  };
  for (const [key, value] of Object.entries(judged)) {
    results[TOOL_KEYS[key]] = { ...value, title: toolTitle(value.title) };
  }
  results['tool-metadata-token'] =
    judged['gateway-reachable'].outcome === 'pass'
      ? evaluateToolMetadata(metadata)
      : result(TOOL_METADATA_TITLE, 'inconclusive', GATEWAY_CONTROL_FAILED);
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
    return result(
      title,
      'fail',
      `${SECURITY_PREFIX} the gateway identity invoked an agent sandbox (answered ${String(attempt.status)}, want 403)`,
    );
  }
  if (typeof attempt.status !== 'number')
    return result(title, 'inconclusive', `no answer: ${attempt.error ?? 'unknown'}`);
  if (typeof toolCall.status !== 'number' || toolCall.status === 403) {
    const control =
      typeof toolCall.status === 'number'
        ? 'answered 403 too'
        : `gave no answer (${toolCall.error ?? 'unknown'})`;
    return result(
      title,
      'inconclusive',
      `Cloud Run answered 403, but the tool sandbox ${control}, so the gateway identity is not shown to invoke anything`,
    );
  }
  return result(
    title,
    'pass',
    `Cloud Run answered 403, and ${String(toolCall.status)} to the same identity at the tool sandbox`,
  );
}

/** A request as the gateway identity; never throws. */
async function gatewayFetch(url, init) {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TOOL_TIMEOUT_MS + 30_000),
      ...init,
    });
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

export async function toolCall() {
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
    await gatewayFetch(agentSandbox, {
      headers: { authorization: `Bearer ${await idTokenFor(agentSandbox)}` },
    }),
    response,
  );
  return { mode: 'tool-call', results };
}
