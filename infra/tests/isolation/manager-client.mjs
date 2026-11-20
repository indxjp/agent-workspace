/**
 * The lane's side of the runner manager: required environment, the authenticated manager call, and the
 * network policy a `create` asks for. The manager is internal to the VPC, so a call carries the job's
 * identity token (Cloud Run) and the manager's bearer token. No function here logs either.
 */
import { metadataGet } from './attempts.mjs';

const NETWORK_POLICIES = new Set(['none', 'restricted', 'open']);
const MANAGER_TIMEOUT_MS = 240_000;

export const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export async function managerCall(method, route, body) {
  const managerUrl = need('CLOUD_RUN_MANAGER_URL').replace(/\/+$/u, '');
  const idToken = await idTokenFor(managerUrl);
  const response = await fetch(`${managerUrl}${route}`, {
    method,
    headers: {
      'x-serverless-authorization': `Bearer ${idToken}`,
      authorization: `Bearer ${need('RUNNER_MANAGER_TOKEN')}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(MANAGER_TIMEOUT_MS),
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

/** An identity token of the job's service account for `audience`. */
export async function idTokenFor(audience) {
  return (await metadataGet(`identity?audience=${encodeURIComponent(audience)}`)).text();
}
