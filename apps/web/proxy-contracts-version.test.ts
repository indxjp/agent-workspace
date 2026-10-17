/**
 * Contracts version negotiation at the edge (issue #244, SDK-12, S-7): `proxy()` judges the
 * `X-Agent-Workspace-Contracts` header before any exemption, authentication, authorisation or body
 * parsing, and stamps the served range on every `/api/**` answer.
 */
import {
  ApiProblemSchema,
  CONTRACTS_MINIMUM_VERSION_HEADER,
  CONTRACTS_VERSION,
  CONTRACTS_VERSION_HEADER,
  parseContractsVersion,
} from '@indx-workspace/contracts';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { proxy } from './proxy';
import { MIN_SESSION_SECRET_LENGTH } from './server/auth/session';
import {
  CONTRACTS_UPGRADE_TOKEN,
  MINIMUM_SERVED_CONTRACTS_VERSION,
  minimumServedContractsVersion,
  negotiateContractsVersion,
} from './server/versioning/contracts-version';

const PASSED_THROUGH = 'x-middleware-next';
const API_KEY_HEADER = 'Bearer ak_live_00000000000000000000000000000000';

function request(
  pathname: string,
  init: { readonly method?: string; readonly headers?: Readonly<Record<string, string>> } = {},
): NextRequest {
  return new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), {
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
  });
}

function version(major: number, minor: number, patch = 0) {
  return { major, minor, patch };
}

describe('minimumServedContractsVersion: the current minor and the previous one', () => {
  const first = version(0, 1);

  it('serves the previous minor of the same major, at patch 0', () => {
    expect(minimumServedContractsVersion(version(0, 5, 3), null, first)).toEqual(version(0, 4));
    expect(minimumServedContractsVersion(version(2, 1), null, first)).toEqual(version(2, 0));
  });

  it('never goes below the first released version', () => {
    expect(minimumServedContractsVersion(version(0, 1), null, first)).toEqual(version(0, 1));
    expect(minimumServedContractsVersion(version(0, 2, 4), null, first)).toEqual(version(0, 1));
  });

  it('at X.0 serves the last minor of the previous major, for that one minor only', () => {
    expect(minimumServedContractsVersion(version(1, 0), version(0, 9), first)).toEqual(
      version(0, 9),
    );
    expect(minimumServedContractsVersion(version(1, 1), version(0, 9), first)).toEqual(
      version(1, 0),
    );
  });

  it('at X.0 with no declared previous major serves X.0 only', () => {
    expect(minimumServedContractsVersion(version(3, 0), null, first)).toEqual(version(3, 0));
  });

  it('rejects a previous-major declaration that is not from the major before', () => {
    expect(() => minimumServedContractsVersion(version(2, 0), version(0, 9), first)).toThrow();
  });
});

describe('negotiateContractsVersion', () => {
  it('treats an absent header as absent, and the current and minimum versions as served', () => {
    expect(negotiateContractsVersion(null)).toEqual({ kind: 'absent' });
    expect(negotiateContractsVersion(CONTRACTS_VERSION)).toEqual({ kind: 'served' });
    expect(negotiateContractsVersion(MINIMUM_SERVED_CONTRACTS_VERSION)).toEqual({
      kind: 'served',
    });
  });

  it('serves every patch of the previous minor and refuses the minor before it (ADR-0078 D7)', () => {
    // A minor release (0.1.x to 0.2.0 for issue #393) keeps serving the clients one minor behind.
    // The rule at `X.0` differs; this pins the in-major case the current release is in.
    const current = parseContractsVersion(CONTRACTS_VERSION);
    if (current === null || current.minor === 0) throw new Error('expected an X.Y release, Y > 0');
    const previous = `${String(current.major)}.${String(current.minor - 1)}`;
    const below =
      current.minor >= 2 ? `${String(current.major)}.${String(current.minor - 2)}.9` : '0.0.9';
    expect(MINIMUM_SERVED_CONTRACTS_VERSION).toBe(`${previous}.0`);

    const currentMinor = `${String(current.major)}.${String(current.minor)}`;
    for (const served of [
      `${previous}.0`,
      `${previous}.2`,
      `${currentMinor}.0`,
      CONTRACTS_VERSION,
    ]) {
      expect(negotiateContractsVersion(served), served).toEqual({ kind: 'served' });
    }
    const next = `${String(current.major)}.${String(current.minor + 1)}.0`;
    for (const refused of [below, next, `${String(current.major + 1)}.0.0`]) {
      expect(negotiateContractsVersion(refused).kind, refused).toBe('refused');
    }
  });

  it('refuses a version below the served range with 426 naming both versions', () => {
    const negotiation = negotiateContractsVersion('0.0.9');
    expect(negotiation.kind).toBe('refused');
    if (negotiation.kind !== 'refused') return;
    expect(negotiation.status).toBe(426);
    expect(negotiation.headers).toEqual({ upgrade: CONTRACTS_UPGRADE_TOKEN });
    const problem = ApiProblemSchema.parse(negotiation.body).error;
    expect(problem.code).toBe('contracts_version_unsupported');
    expect(problem.message).toContain('0.0.9');
    expect(problem.message).toContain(CONTRACTS_VERSION);
    expect(problem.detail).toBe(problem.message);
  });

  it('refuses a version above the served range with 426, asking for the server to move', () => {
    const negotiation = negotiateContractsVersion('99.0.0');
    if (negotiation.kind !== 'refused') throw new Error('expected a refusal');
    expect(negotiation.status).toBe(426);
    expect(ApiProblemSchema.parse(negotiation.body).error.message).toContain('Upgrade the server');
  });

  it.each(['', 'latest', '1.2', 'v0.1.0', '0.1.0-beta'])(
    'refuses the malformed header %j with 400 contracts_version_malformed',
    (header) => {
      const negotiation = negotiateContractsVersion(header);
      if (negotiation.kind !== 'refused') throw new Error('expected a refusal');
      expect(negotiation.status).toBe(400);
      const problem = ApiProblemSchema.parse(negotiation.body).error;
      expect(problem.code).toBe('contracts_version_malformed');
      expect(problem.message).toContain(CONTRACTS_VERSION);
    },
  );
});

describe('apps/web/proxy.ts negotiates the contracts version on every /api/** request', () => {
  const previousSecret = process.env['SESSION_SECRET'];
  beforeAll(() => {
    process.env['SESSION_SECRET'] = 'k'.repeat(MIN_SESSION_SECRET_LENGTH);
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env['SESSION_SECRET'];
    else process.env['SESSION_SECRET'] = previousSecret;
  });

  it('passes an in-range request through unchanged and stamps the served range', async () => {
    const response = await proxy(
      request('/api/me', {
        headers: { authorization: API_KEY_HEADER, [CONTRACTS_VERSION_HEADER]: CONTRACTS_VERSION },
      }),
    );

    expect(response.headers.get(PASSED_THROUGH)).toBe('1');
    expect(response.headers.get(CONTRACTS_VERSION_HEADER)).toBe(CONTRACTS_VERSION);
    expect(response.headers.get(CONTRACTS_MINIMUM_VERSION_HEADER)).toBe(
      MINIMUM_SERVED_CONTRACTS_VERSION,
    );
  });

  it('answers 426 below the range before authentication: no credential, and still 426', async () => {
    const response = await proxy(
      request('/api/agents', { method: 'POST', headers: { [CONTRACTS_VERSION_HEADER]: '0.0.1' } }),
    );

    expect(response.status).toBe(426);
    expect(response.headers.get(PASSED_THROUGH)).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('upgrade')).toBe(CONTRACTS_UPGRADE_TOKEN);
    expect(response.headers.get(CONTRACTS_VERSION_HEADER)).toBe(CONTRACTS_VERSION);
    const problem = ApiProblemSchema.parse(await response.json()).error;
    expect(problem.code).toBe('contracts_version_unsupported');
    expect(problem.message).toContain('0.0.1');
  });

  it('answers 426 even on a pre-authentication exemption, since negotiation runs first', async () => {
    const response = await proxy(
      request('/api/setup', { method: 'POST', headers: { [CONTRACTS_VERSION_HEADER]: '0.0.1' } }),
    );

    expect(response.status).toBe(426);
  });

  it('answers 400 for a malformed header', async () => {
    const response = await proxy(
      request('/api/me', {
        headers: { authorization: API_KEY_HEADER, [CONTRACTS_VERSION_HEADER]: 'latest' },
      }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('upgrade')).toBeNull();
    expect(ApiProblemSchema.parse(await response.json()).error.code).toBe(
      'contracts_version_malformed',
    );
  });

  it.each([
    ['GET', '/api/me'],
    ['GET', '/api/auth/login'],
    ['POST', '/api/auth/callback'],
    ['POST', '/api/auth/workspace'],
    ['GET', '/api/files/f_1/download'],
  ])(
    'never refuses %s %s without the header (a browser form, link or IdP callback), and stamps the range',
    async (method, pathname) => {
      const response = await proxy(
        request(pathname, { method, headers: { authorization: API_KEY_HEADER } }),
      );

      expect(response.status).not.toBe(426);
      expect(response.status).not.toBe(400);
      expect(response.headers.get(CONTRACTS_VERSION_HEADER)).toBe(CONTRACTS_VERSION);
    },
  );

  it('stamps the range on a refusal the auth gate makes after negotiation passes', async () => {
    const response = await proxy(
      request('/api/agents', { headers: { [CONTRACTS_VERSION_HEADER]: CONTRACTS_VERSION } }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get(CONTRACTS_VERSION_HEADER)).toBe(CONTRACTS_VERSION);
  });

  it('leaves the page surface alone, whatever the header says', async () => {
    const response = await proxy(
      request('/signin', { headers: { [CONTRACTS_VERSION_HEADER]: '0.0.1' } }),
    );

    expect(response.status).not.toBe(426);
    expect(response.headers.get(CONTRACTS_VERSION_HEADER)).toBeNull();
  });
});
