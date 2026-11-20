import { probeKey } from './prepare.mjs';

export const BUILD_ID = '11111111-2222-4333-8444-555555555555';
export const DIGEST = `sha256:${'a'.repeat(64)}`;
export const KEY = 'unit-test-key-0123456789';
export const probeFiles = {
  dockerfile: 'ARG NODE_IMAGE=node:1@sha256:00\nFROM ${NODE_IMAGE}\nUSER node\n',
  probe: 'probe',
};
export const TAG = `p-${probeKey(probeFiles)}`;
export const e2bEnv = { E2B_API_KEY: KEY };
export const vercelEnv = { VERCEL_TOKEN: KEY, VERCEL_TEAM_ID: 'team_unit' };
export const cloudflareEnv = { CLOUDFLARE_API_TOKEN: KEY, CLOUDFLARE_ACCOUNT_ID: 'acct0123' };

/** Fakes for `prepare`: `respond("GET /path")` answers `[status, body]`, `run` stands in for the CLIs. */
export function fakeDeps({ respond = () => [500, undefined], run = () => '', now = () => 0 } = {}) {
  const calls = { fetch: [], run: [] };
  return {
    calls,
    readFiles: async () => probeFiles,
    sleep: async () => {},
    now,
    fetch: async (url, init = {}) => {
      const call = `${init.method ?? 'GET'} ${new URL(url).pathname}`;
      calls.fetch.push(call);
      const [status, body] = respond(call, init);
      return { status, json: async () => body };
    },
    run: (command, args, options) => {
      calls.run.push({ command, args, options });
      return run(command, args, options);
    },
  };
}
