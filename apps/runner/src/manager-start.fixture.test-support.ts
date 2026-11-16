import { vi } from 'vitest';

export const TOKEN = 'runner-manager-fixture-token-more-than-32-characters';

export const ORDER_TOOL = {
  name: 'get_order',
  description: 'Looks up an order.',
  inputSchema: { type: 'object' },
  timeoutMs: 5_000,
  digest: 'a'.repeat(64),
  bundleBase64: Buffer.from('export default () => 1;').toString('base64'),
};

function processStartedResponse(): Response {
  const payload = Buffer.from(JSON.stringify({ event: { start: { pid: 7 } } }));
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 1);
  return new Response(Buffer.concat([header, payload]));
}

/** E2B's API and envd retain sandbox state across fresh manager instances. */
export function e2bProviderFixture() {
  const running = new Map<string, { metadata: Record<string, string>; endAt: number }>();
  const created: { timeout: number; metadata: Record<string, string> }[] = [];
  const renewed: number[] = [];
  let count = 0;
  const sandboxBody = (id: string) => ({
    sandboxID: id,
    domain: 'e2b.test',
    trafficAccessToken: 'traffic-token',
    envdAccessToken: 'envd-token',
  });
  function createSandbox(body: unknown): Response {
    const { timeout, metadata } = body as (typeof created)[number];
    count += 1;
    const id = `sbx${String(count)}`;
    created.push({ timeout, metadata });
    running.set(id, { metadata, endAt: Date.now() + timeout * 1_000 });
    return Response.json(sandboxBody(id), { status: 201 });
  }

  function listSandboxes(url: URL): Response {
    const wanted = [...new URLSearchParams(url.searchParams.get('metadata') ?? '')];
    return Response.json(
      [...running]
        .filter(([, entry]) => wanted.every(([k, v]) => entry.metadata[k] === v))
        .map(([id, entry]) => ({ sandboxID: id, endAt: new Date(entry.endAt).toISOString() })),
    );
  }

  const respond = (input: Parameters<typeof fetch>[0], init?: RequestInit): Response => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    if (url.pathname === '/v2/sandboxes' && method === 'POST') {
      return createSandbox(body);
    }
    if (url.pathname === '/v2/sandboxes') {
      return listSandboxes(url);
    }
    const connect = /^\/sandboxes\/([^/]+)\/connect$/u.exec(url.pathname);
    if (connect !== null) {
      renewed.push((body as { timeout: number }).timeout);
      return Response.json(sandboxBody(connect[1] ?? ''));
    }
    const kill = /^\/sandboxes\/([^/]+)$/u.exec(url.pathname);
    if (kill !== null && method === 'DELETE') {
      running.delete(kill[1] ?? '');
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/process.Process/Start') {
      return processStartedResponse();
    }
    if (url.pathname === '/files') return Response.json([{ name: 'ok' }]);
    // The tool host's own answer to the readiness probe: it refuses a call with no run token.
    return new Response(null, { status: 401 });
  };
  const provider = vi.fn<typeof fetch>((input, init) => Promise.resolve(respond(input, init)));
  return { running, created, renewed, provider };
}
