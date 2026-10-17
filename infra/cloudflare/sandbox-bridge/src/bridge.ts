/**
 * The bridge Worker's protocol (ADR-0120 LC1-LC4, LC6), kept free of Cloudflare imports so a fake
 * sandbox binding can drive it in `tests/cloudflare-sandbox-bridge.test.ts`. `worker.ts` is the
 * thin entry that binds it to Durable Object containers.
 *
 *   POST   /v1/sandboxes                   create       (manager -> bridge secret)
 *   DELETE /v1/sandboxes/{id}              destroy      (manager -> bridge secret)
 *   ANY    /v1/sandboxes/{id}/runtime/...  forward to the runner server (access token for {id})
 *
 * Every request is refused without its credential before any route, method or sandbox id is
 * decided (a forward needs the access token and a runner bearer), and the 401 never echoes what
 * was presented. The
 * access token is HMAC-SHA256(bridge secret, sandbox id): the manager keeps it, not the secret
 * (LC6), and it is useless without the per-sandbox bearer the runner server also requires (LC3).
 */

/**
 * ADR-0120 LC4 "always denied", kept for the future IP-level enforcement (F-LC4-open). NOT ENFORCED:
 * `@cloudflare/containers@0.3.7` matches `deniedHosts` as hostname globs, so these CIDRs match
 * nothing, which is why `create` refuses `open`. A copy on purpose: the bridge is deployed on its own
 * and imports nothing from `packages/runtime`.
 */
export const DENIED_RANGES = [
  '169.254.0.0/16',
  'fe80::/10',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  'fc00::/7',
  '127.0.0.0/8',
  '::1/128',
] as const;

export type NetworkPolicy = 'none' | 'open';

/**
 * The Container settings per policy (`worker.ts` assigns them). `none` turns outbound internet off
 * and allows only the gateway host. Cloudflare still answers on ports 80 and 443 from its L7
 * interceptor, so the live lane cannot prove `none` holds and the driver refuses it (ADR-0131).
 * https://developers.cloudflare.com/containers/platform-details/outbound-traffic/, checked 2026-10-09.
 */
export function containerSettings(
  policy: NetworkPolicy,
  gatewayHost: string,
): { enableInternet: boolean; allowedHosts?: string[] } {
  return policy === 'none'
    ? { enableInternet: false, allowedHosts: [gatewayHost] }
    : { enableInternet: true };
}

/** One sandbox's container, as the bridge sees it. */
export interface SandboxStub {
  start(settings: { bearer: string; timeoutSeconds: number }): Promise<void>;
  forward(request: Request): Promise<Response>;
  destroy(): Promise<void>;
}

export interface BridgeEnv {
  /** Worker secret: the manager -> bridge credential. */
  readonly bridgeSecret: string;
  /** The runtime image this deployment runs; a create naming another is refused (LC2). */
  readonly runtimeImage: string;
  /** The only host a `none` sandbox may reach (LC4). */
  readonly gatewayHost: string;
  /** The container for a sandbox id under the policy that created it. */
  sandbox(policy: NetworkPolicy, id: string): SandboxStub;
}

const SANDBOX_ID = /^([no])-([0-9a-f]{32})$/u;
const BEARER = /^[A-Za-z0-9_-]{32,256}$/u;
const MIN_SECRET_LENGTH = 32;
const MAX_BODY_BYTES = 8_192;
const MAX_TIMEOUT_SECONDS = 604_800;
const CREATE_KEYS = new Set([
  'image',
  'sessionKey',
  'bearer',
  'networkPolicy',
  'gatewayHost',
  'timeoutSeconds',
]);

const encoder = new TextEncoder();

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

/** Constant time in the length of the inputs: both sides are hashed to a fixed width first. */
export async function secretsMatch(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

export async function accessTokenFor(bridgeSecret: string, sandboxId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(bridgeSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(sandboxId)));
  return [...mac].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const unauthorized = (): Response => json(401, { error: 'unauthorized' });
const invalid = (): Response => json(400, { error: 'invalid_request' });

function bearerOf(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

async function readCreate(request: Request): Promise<Record<string, unknown> | null> {
  const raw = await request.text();
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  return Object.keys(record).every((key) => CREATE_KEYS.has(key)) ? record : null;
}

async function create(request: Request, env: BridgeEnv): Promise<Response> {
  const body = await readCreate(request);
  if (body === null) return invalid();
  const { image, sessionKey, bearer, networkPolicy, gatewayHost, timeoutSeconds } = body;
  // LC4: `deniedHosts` is matched as hostname globs, so the always-denied CIDRs are not enforced and
  // only `none` (gateway host only) is served until the live lane proves IP-level denial.
  if (networkPolicy === 'open' || networkPolicy === 'restricted') {
    return json(422, { error: 'network_policy_unsupported' });
  }
  if (
    typeof image !== 'string' ||
    typeof sessionKey !== 'string' ||
    sessionKey.length === 0 ||
    typeof bearer !== 'string' ||
    !BEARER.test(bearer) ||
    networkPolicy !== 'none' ||
    typeof gatewayHost !== 'string' ||
    typeof timeoutSeconds !== 'number' ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > MAX_TIMEOUT_SECONDS
  ) {
    return invalid();
  }
  // The image and the gateway host are fixed per deployment: the container classes are built with
  // them, so a different one cannot be honoured and must not be silently ignored.
  if (image !== env.runtimeImage || gatewayHost !== env.gatewayHost) {
    return json(409, { error: 'deployment_mismatch' });
  }
  const id = `n-${crypto.randomUUID().replaceAll('-', '')}`;
  const sandbox = env.sandbox(networkPolicy, id);
  try {
    await sandbox.start({ bearer, timeoutSeconds });
  } catch {
    // The id never reaches the manager, so nothing else could destroy this sandbox or its stored
    // bearer; the start error may carry provider text, so it is not echoed.
    await sandbox.destroy().catch(() => undefined);
    return json(502, { error: 'start_failed' });
  }
  return json(201, { sandboxId: id, accessToken: await accessTokenFor(env.bridgeSecret, id) });
}

function forwardTarget(request: Request, id: string): URL {
  const url = new URL(request.url);
  const prefix = `/v1/sandboxes/${id}/runtime`;
  url.pathname = url.pathname.slice(prefix.length) || '/';
  return url;
}

export async function handleBridgeRequest(request: Request, env: BridgeEnv): Promise<Response> {
  // An unset secret would hash to the same digest as an empty credential and let an unauthenticated
  // call through (LC3), so a deployment without a real secret serves nothing.
  if (typeof env.bridgeSecret !== 'string' || env.bridgeSecret.length < MIN_SECRET_LENGTH) {
    return json(503, { error: 'not_configured' });
  }
  const url = new URL(request.url);
  const match = /^\/v1\/sandboxes(?:\/([^/]+)(\/runtime(?:\/.*)?)?)?$/u.exec(url.pathname);
  const [, id, runtime] = match ?? [];

  // Authenticate before anything decides what exists: a caller without the credentials learns
  // nothing about routes, methods or sandbox ids. A forward needs both the access token for its id
  // and a runner bearer (the bridge cannot check the bearer, the runner server does, LC3).
  if (id !== undefined && runtime !== undefined) {
    const expected = await accessTokenFor(env.bridgeSecret, id);
    const presented = request.headers.get('x-bridge-access') ?? '';
    if (bearerOf(request) === '' || !(await secretsMatch(presented, expected))) {
      return unauthorized();
    }
  } else if (!(await secretsMatch(bearerOf(request), env.bridgeSecret))) {
    return unauthorized();
  }

  if (match === null) return json(404, { error: 'not_found' });

  if (id === undefined) {
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    return await create(request, env);
  }

  const parts = SANDBOX_ID.exec(id);
  const policy: NetworkPolicy | null = parts === null ? null : parts[1] === 'n' ? 'none' : 'open';

  if (runtime === undefined) {
    if (request.method !== 'DELETE') return json(405, { error: 'method_not_allowed' });
    if (policy === null) return json(404, { error: 'not_found' });
    await env.sandbox(policy, id).destroy();
    return new Response(null, { status: 204 });
  }

  if (policy === null) return json(404, { error: 'not_found' });
  const headers = new Headers(request.headers);
  headers.delete('x-bridge-access');
  const forwarded = new Request(forwardTarget(request, id), {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual',
    // Required by Node's fetch when a stream body is forwarded; Workers ignores it.
    ...(request.body === null ? {} : { duplex: 'half' }),
  } as RequestInit);
  return await env.sandbox(policy, id).forward(forwarded);
}
