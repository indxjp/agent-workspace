// The bundled SeaweedFS answers a browser's CORS preflight from any origin unless
// `-s3.allowedOrigins` names the allowed ones: SeaweedFS 4.47 (the pinned image) echoes
// `Access-Control-Allow-Origin` for an arbitrary origin by default, and refuses that same
// preflight with 403 once the flag is set. So the root compose file sets it to the app's own
// origin, in both loopback spellings, never `*` (#1745, from the STO-116 and STO-117 reviews).
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { corsProblems } from '../scripts/ci/check-object-store-cors.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The `-s3.allowedOrigins=` origins of a compose file's SeaweedFS command, or `null` without one. */
function allowedOrigins(compose: string): string[] | null {
  const flag = /-s3\.allowedOrigins=([^'"\s\]]+)/u.exec(compose)?.[1];
  return flag === undefined ? null : flag.split(',');
}

/** The host port the app's own origin uses, as the compose file publishes web. */
function webPort(compose: string): string | null {
  return /'127\.0\.0\.1:(\$\{WEB_PORT:-\d+\}):3000'/u.exec(compose)?.[1] ?? null;
}

describe('the bundled object store CORS', () => {
  it('reads the flag and refuses a wildcard', () => {
    expect(allowedOrigins("command: ['server', '-s3']")).toBeNull();
    expect(allowedOrigins("'-s3.allowedOrigins=http://a:1,http://b:1',")).toEqual([
      'http://a:1',
      'http://b:1',
    ]);
  });

  it('allows only the app origin in compose.yaml', () => {
    const compose = readFileSync(path.join(ROOT, 'compose.yaml'), 'utf8');
    const port = webPort(compose);
    expect(port).not.toBeNull();
    const origins = allowedOrigins(compose);
    expect(origins).toEqual([`http://localhost:${port ?? ''}`, `http://127.0.0.1:${port ?? ''}`]);
    expect(origins?.some((origin) => origin.includes('*'))).toBe(false);
  });

  it('the stack check fails a store that allows a foreign origin', async () => {
    const store =
      (allowed: (origin: string) => boolean) =>
      (_target: URL, init: { headers: Record<string, string> }) => {
        const origin = init.headers['Origin'] ?? '';
        const headers = new Headers(
          allowed(origin) ? { 'Access-Control-Allow-Origin': origin } : {},
        );
        return Promise.resolve({ status: allowed(origin) ? 200 : 403, headers });
      };
    const app = 'http://localhost:3000';
    expect(
      await corsProblems(
        store((o) => o === app),
        'http://localhost:8333',
        app,
      ),
    ).toEqual([]);
    expect(
      await corsProblems(
        store(() => true),
        'http://localhost:8333',
        app,
      ),
    ).toEqual([expect.stringContaining('a preflight from a foreign origin was allowed')]);
    expect(
      await corsProblems(
        store(() => false),
        'http://localhost:8333',
        app,
      ),
    ).toEqual([expect.stringContaining(`the preflight from ${app} was not allowed`)]);
  });

  it('the stack check reads the status and names a wildcard', async () => {
    const answer = (status: number, allowOrigin: (origin: string) => string | null) => {
      return (_target: URL, init: { headers: Record<string, string> }) => {
        const value = allowOrigin(init.headers['Origin'] ?? '');
        const headers = new Headers(value === null ? {} : { 'Access-Control-Allow-Origin': value });
        return Promise.resolve({ status, headers });
      };
    };
    const app = 'http://localhost:3000';
    const endpoint = 'http://localhost:8333';
    // A refused preflight that still echoes the origin is refused: the browser reads the status.
    expect(
      await corsProblems(
        answer(403, (origin) => origin),
        endpoint,
        app,
      ),
    ).toEqual([`the preflight from ${app} was not allowed (status 403, Allow-Origin: ${app})`]);
    expect(
      await corsProblems(
        answer(200, () => '*'),
        endpoint,
        app,
      ),
    ).toEqual([
      `the preflight from ${app} was answered with the wildcard Allow-Origin: *, which allows every origin`,
      'a preflight from a foreign origin was allowed by the wildcard Allow-Origin: *',
    ]);
  });
});
