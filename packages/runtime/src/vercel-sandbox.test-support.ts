import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RuntimeRunSpec } from './driver.js';
import { createExternalDriver } from './external/driver.js';
import { createVercelSandboxProvider } from './vercel-sandbox.js';

export const TOKEN = 'vercel_SENTINEL_access_token_0123456789';

export const IMAGE = `registry.example.com/agent-runtime@sha256:${'a'.repeat(64)}`;

const IMAGES = new Map([['claude-agent-sdk', IMAGE]]);

export type Recorded = {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
};

export type Answer = { status: number; body: unknown };

export const servers: Server[] = [];

export const createdOk: Answer = {
  status: 200,
  body: {
    sandbox: { name: 'ignored' },
    session: { id: 'sess_1', timeout: 3_600_000 },
    routes: [
      { port: 3000, url: 'https://other.vercel.run', subdomain: 'other' },
      { port: 8080, url: 'https://runner.vercel.run', subdomain: 'runner' },
    ],
  },
};

const isStrings = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

function networkPolicyProblem(policy: unknown): string | undefined {
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    return 'networkPolicy must be an object';
  }
  const record = policy as Record<string, unknown>;
  if ('mode' in record) {
    return record['mode'] === 'allow-all' || record['mode'] === 'deny-all'
      ? undefined
      : 'networkPolicy.mode must be allow-all or deny-all';
  }
  const unknownKey = Object.keys(record).find((key) => key !== 'allow' && key !== 'subnets');
  if (unknownKey !== undefined) return `networkPolicy.${unknownKey} is not a request field`;
  const allow = record['allow'];
  if (allow !== undefined && !isStrings(allow)) return 'networkPolicy.allow must be strings';
  return subnetPolicyProblem(record['subnets']);
}

function validateCreate(call: Recorded): Answer | undefined {
  if (call.method !== 'POST' || !call.url.startsWith('/v4/sandboxes')) return undefined;
  const policy = (call.body as { networkPolicy?: unknown }).networkPolicy;
  const problem = policy === undefined ? undefined : networkPolicyProblem(policy);
  return problem === undefined
    ? undefined
    : {
        status: 400,
        body: { error: { code: 'bad_request', message: `Invalid request: ${problem}` } },
      };
}

export async function fakeVercel(
  respond: (call: Recorded) => Answer = (call) =>
    call.url.startsWith('/v4/sandboxes') ? createdOk : { status: 200, body: {} },
): Promise<{ apiBase: string; calls: Recorded[] }> {
  const calls: Recorded[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const call: Recorded = {
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body: raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined,
      };
      calls.push(call);
      const answer = validateCreate(call) ?? respond(call);
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { apiBase: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, calls };
}

export function driverFor(apiBase: string, tier?: 'hobby' | 'pro') {
  return createExternalDriver<string, string>({
    provider: createVercelSandboxProvider({
      teamId: 'team_1',
      projectId: 'prj_1',
      apiBase,
      ...(tier === undefined ? {} : { tier }),
    }),
    driverId: 'vercel-sandbox',
    images: IMAGES,
    gatewayUrl: 'https://gateway.example.com/v1',
    startAgent: () => {
      throw new Error('not used');
    },
  });
}

export function spec(over: Partial<RuntimeRunSpec> = {}): RuntimeRunSpec {
  return {
    runtimeProfileId: 'profile-1',
    driver: 'vercel-sandbox',
    networkPolicy: 'none',
    filesystem: 'read-write',
    ...over,
  };
}

export const config = (runSpec?: RuntimeRunSpec) => ({
  engine: 'claude-agent-sdk',
  sessionId: 'session-1',
  workspacePath: '/ws/session-1',
  ...(runSpec === undefined ? {} : { runSpec }),
});

function subnetPolicyProblem(subnets: unknown): string | undefined {
  if (subnets === undefined) return undefined;
  if (typeof subnets !== 'object' || subnets === null) {
    return 'networkPolicy.subnets must be an object';
  }
  const { allow: subnetAllow, deny } = subnets as Record<string, unknown>;
  if (subnetAllow !== undefined && !isStrings(subnetAllow)) {
    return 'networkPolicy.subnets.allow must be strings';
  }
  if (deny !== undefined && !isStrings(deny)) return 'networkPolicy.subnets.deny must be strings';
  const ipv6 = [subnetAllow, deny]
    .flatMap((list) => (Array.isArray(list) ? (list as string[]) : []))
    .find((cidr) => cidr.includes(':'));
  return ipv6 === undefined ? undefined : `Invalid CIDR "${ipv6}"`;
}
