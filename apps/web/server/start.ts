import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import { checkDeploymentPosture, readDeploymentPosture } from '@agent-workspace/core/posture';
import nextModule from 'next/dist/server/next.js';
import { z } from 'zod';

import { closeHeldComposition } from './composition/held-composition.ts';

type ProgrammaticNext = {
  prepare(): Promise<void>;
  getRequestHandler(): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  close(): Promise<void>;
};

const createNext = nextModule as unknown as (options: {
  customServer: boolean;
  dev: boolean;
  dir: string;
  hostname: string;
  port: number;
}) => ProgrammaticNext;

/**
 * How `startWeb` runs Next.js (contract C2). `dir` is the Next.js app root (default: this app),
 * and `dev` selects the development server (default: `NODE_ENV !== 'production'`).
 */
export type StartWebOptions = {
  readonly dir?: string;
  readonly dev?: boolean;
};

const startWebOptionsSchema = z.strictObject({
  dir: z.string().min(1).optional(),
  dev: z.boolean().optional(),
});

/** `startWeb` was given options it does not accept. Names no value. */
export class StartWebOptionsError extends Error {
  readonly code = 'invalid_start_options';

  constructor() {
    super('startWeb accepts only { dir?: non-empty string, dev?: boolean }.');
    this.name = 'StartWebOptionsError';
  }
}

/** The host `startWeb` listens on: HOST as given, or `127.0.0.1` when HOST is unset or blank. */
function bindHost(env: Readonly<Record<string, string | undefined>>): string {
  const raw = env['HOST'];
  return raw === undefined || raw.trim().length === 0 ? '127.0.0.1' : raw;
}

/** An IPv6 literal goes in brackets in a URL. */
function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export async function startWeb(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: StartWebOptions = {},
) {
  const parsedOptions = startWebOptionsSchema.safeParse(options);
  if (!parsedOptions.success) throw new StartWebOptionsError();
  const parsed = parsedOptions.data;
  const port = Number.parseInt(env['PORT'] ?? '3000', 10);
  const host = bindHost(env);
  // Everything below fails before Next is created. `env` must name a valid posture, and a local one
  // needs a loopback HOST. The posture sites (the runtime registry, the engine images and the
  // egress policy) read `process.env`, so its posture must also hold for the host bound here, or a
  // launcher passing a different `env` would relax them on a server reachable from the network.
  readDeploymentPosture(env);
  checkDeploymentPosture(process.env, host);
  const app = createNext({
    customServer: true,
    dev: parsed.dev ?? env['NODE_ENV'] !== 'production',
    dir: parsed.dir ?? fileURLToPath(new URL('..', import.meta.url)),
    hostname: host,
    port,
  });
  await app.prepare();
  const handler = app.getRequestHandler();
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    url: `http://${urlHost(host)}:${String(port)}`,
    // The composition's database pools close last, so the caller can stop PostgreSQL afterwards
    // without terminating an idle pooled connection (S1-25, #510).
    close: async () => {
      try {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
      } finally {
        await closeHeldComposition();
      }
    },
  };
}
