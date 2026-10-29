#!/usr/bin/env node
// Proves the running bundled object store refuses a browser upload from any origin but the app's:
//
//   node scripts/ci/check-object-store-cors.mjs <s3 endpoint> <app origin>
//
// It sends the preflight a browser sends before a direct `PUT` to a signed link, once from the app's
// origin (which must be allowed, by name) and once from a foreign origin (which must not be). The
// SeaweedFS the stack bundles allows every origin unless `-s3.allowedOrigins` is set, so a browser
// test that only uploads from the app's origin passes either way; this is the negative half.
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/* global console, fetch, URL */

const FOREIGN_ORIGIN = 'https://foreign-origin.invalid';

/**
 * @param {(url: URL, init: { method: string, headers: Record<string, string> }) => Promise<{ status: number, headers: { get(name: string): string | null } }>} send
 *   `fetch`, or a fake of it
 * @param {string} endpoint the S3 endpoint as a browser reaches it, e.g. http://localhost:8333
 * @param {string} origin the app's origin
 * @returns {Promise<string[]>} one message per failed expectation; empty when the store is right
 */
export async function corsProblems(send, endpoint, origin) {
  const target = new URL('/agent-workspace/cors-probe.txt', endpoint);
  /**
   * The answer to a browser's preflight from `from`. A browser goes on only when the status is 2xx
   * and Allow-Origin names `from` or is the wildcard.
   * @param {string} from
   */
  const preflight = async (from) => {
    const response = await send(target, {
      method: 'OPTIONS',
      headers: { Origin: from, 'Access-Control-Request-Method': 'PUT' },
    });
    const allowOrigin = response.headers.get('access-control-allow-origin');
    const ok = response.status >= 200 && response.status < 300;
    return { status: response.status, allowOrigin, ok };
  };
  const problems = [];
  const own = await preflight(origin);
  if (own.ok && own.allowOrigin === '*') {
    problems.push(
      `the preflight from ${origin} was answered with the wildcard Allow-Origin: *, which allows every origin`,
    );
  } else if (!own.ok || own.allowOrigin !== origin) {
    problems.push(
      `the preflight from ${origin} was not allowed (status ${String(own.status)}, Allow-Origin: ${String(own.allowOrigin)})`,
    );
  }
  const foreign = await preflight(FOREIGN_ORIGIN);
  if (foreign.ok && foreign.allowOrigin === '*') {
    problems.push('a preflight from a foreign origin was allowed by the wildcard Allow-Origin: *');
  } else if (foreign.ok && foreign.allowOrigin === FOREIGN_ORIGIN) {
    problems.push(
      `a preflight from a foreign origin was allowed (Allow-Origin: ${foreign.allowOrigin})`,
    );
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [endpoint, origin] = process.argv.slice(2);
  if (endpoint === undefined || origin === undefined) {
    console.error('usage: node scripts/ci/check-object-store-cors.mjs <s3 endpoint> <app origin>');
    process.exit(2);
  }
  const problems = await corsProblems(fetch, endpoint, origin);
  for (const problem of problems) console.error(`::error title=Object store CORS::${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(`${endpoint} allows ${origin} and refuses a foreign origin.`);
}
