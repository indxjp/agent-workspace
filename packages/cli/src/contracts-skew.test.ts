import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CONTRACTS_MINIMUM_VERSION_HEADER,
  CONTRACTS_VERSION,
  CONTRACTS_VERSION_HEADER,
} from '@indx-workspace/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CLI_PUBLISHED_PACKAGE,
  assertServerServesContracts,
  describeSkew,
  probeServerContracts,
} from './contracts-skew.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

/** A stub control plane: answers `GET /api/me` with a 401 and the given headers. */
async function stubServer(headers: Record<string, string>): Promise<string> {
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/api/me' ? 401 : 404, headers);
    response.end('{}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

const range = (minimum: string, current: string) => ({
  [CONTRACTS_MINIMUM_VERSION_HEADER]: minimum,
  [CONTRACTS_VERSION_HEADER]: current,
});

describe('probeServerContracts', () => {
  it('reads a served range from a 401 answer', async () => {
    const url = await stubServer(range(CONTRACTS_VERSION, CONTRACTS_VERSION));
    await expect(probeServerContracts(url)).resolves.toEqual({ kind: 'served' });
  });

  it('reports a server that only serves newer contracts as a client upgrade', async () => {
    const url = await stubServer(range('99.0.0', '99.1.0'));
    const probe = await probeServerContracts(url);
    expect(probe).toMatchObject({ kind: 'skew', skew: { upgrade: 'client' } });
  });

  it('reports a server that only serves older contracts as a server upgrade', async () => {
    const url = await stubServer(range('0.0.1', '0.0.2'));
    const probe = await probeServerContracts(url);
    expect(probe).toMatchObject({ kind: 'skew', skew: { upgrade: 'server' } });
  });

  it('reports an answer without headers, and an unreachable server, without throwing', async () => {
    const url = await stubServer({});
    await expect(probeServerContracts(url)).resolves.toEqual({ kind: 'no-headers' });
    const down = await stubServer({});
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    await expect(probeServerContracts(down, { timeoutMs: 500 })).resolves.toMatchObject({
      kind: 'unreachable',
    });
  });

  it('asks the injected fetch for /api/me under the base URL, without credentials', async () => {
    const seen: string[] = [];
    const stub = ((input: URL, init: RequestInit) => {
      seen.push(`${String(init.method)} ${input.href} ${JSON.stringify(init.headers ?? null)}`);
      return Promise.resolve(new Response(null, { status: 401 }));
    }) as unknown as typeof fetch;
    await probeServerContracts('https://aw.example/base', { fetch: stub });
    expect(seen).toEqual(['GET https://aw.example/base/api/me null']);
  });
});

describe('describeSkew', () => {
  const skew = {
    clientVersion: CONTRACTS_VERSION,
    servedMinimum: '99.0.0',
    serverVersion: '99.1.4',
    upgrade: 'client' as const,
  };

  it('names both versions, the server, and the install command of the published package', () => {
    const text = describeSkew(skew, 'https://aw.example');
    expect(text).toContain(`contracts ${CONTRACTS_VERSION}`);
    expect(text).toContain('99.0.0 to 99.1.4');
    expect(text).toContain('https://aw.example');
    expect(text).toContain(`npm install --global ${CLI_PUBLISHED_PACKAGE}@99.1`);
    expect(text).not.toContain('@agent-workspace/');
  });

  it('offers a server upgrade, or a CLI downgrade, when the server is the older side', () => {
    const text = describeSkew(
      { ...skew, servedMinimum: '0.0.1', serverVersion: '0.0.9', upgrade: 'server' },
      'https://aw.example',
    );
    expect(text).toContain('Upgrade the server');
    // BH061-026: the Compose project's own way to move its images to this CLI's release.
    expect(text).toContain('`agent-workspace render --upgrade` then `agent-workspace start`');
    expect(text).toContain(
      `or downgrade the CLI: npm install --global ${CLI_PUBLISHED_PACKAGE}@0.0`,
    );
  });
});

describe('CLI_PUBLISHED_PACKAGE', () => {
  it('is the name packages/cli/package.json publishes', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { name: string };
    expect(CLI_PUBLISHED_PACKAGE).toBe(manifest.name);
    expect(CLI_PUBLISHED_PACKAGE).toBe('@indx-workspace/cli');
  });
});

describe('assertServerServesContracts', () => {
  it('is silent when the server serves this CLI', async () => {
    const url = await stubServer(range(CONTRACTS_VERSION, CONTRACTS_VERSION));
    const warnings: string[] = [];
    await assertServerServesContracts(url, { warn: (text) => warnings.push(text) });
    expect(warnings).toEqual([]);
  });

  it('refuses an unsupported server', async () => {
    const url = await stubServer(range('99.0.0', '99.1.0'));
    await expect(assertServerServesContracts(url)).rejects.toThrow(
      /serves contracts 99\.0\.0 to 99\.1\.0/,
    );
  });

  it('warns and proceeds without headers, naming the ADR-0078 rule', async () => {
    const url = await stubServer({});
    const warnings: string[] = [];
    await assertServerServesContracts(url, { warn: (text) => warnings.push(text) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ADR-0078 accepts a missing header');
  });

  it('warns and proceeds when the server is unreachable', async () => {
    const warnings: string[] = [];
    const failing = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    await assertServerServesContracts('http://127.0.0.1:9', {
      fetch: failing,
      warn: (text) => warnings.push(text),
    });
    expect(warnings[0]).toContain('could not check the contracts version');
  });
});
