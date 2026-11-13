import { log } from './telemetry/logger.ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import { checkDeploymentPosture, readDeploymentPosture } from '@agent-workspace/core/posture';
import nextModule from 'next/dist/server/next.js';
import { z } from 'zod';

import { closeHeldComposition } from './composition/held-composition.ts';
import { markEmbeddedStart } from './composition/stop-on-failed-start.ts';

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

/**
 * The `http` request listener around Next's handler. A handler that rejects answers 500 while the
 * headers are unsent and otherwise drops the connection; neither is an unhandled rejection. Only
 * the message is logged, never the request.
 */
export function serveRequest(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    handler(request, response).catch((error: unknown) => {
      log.error('[web] request handler failed', { error });
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.statusCode = 500;
      response.end();
    });
  };
}

/** `PORT` is set but is not a port number. Names no value. */
export class InvalidPortError extends Error {
  readonly code = 'invalid_port';

  constructor() {
    super('PORT must be a whole number from 0 to 65535.');
    this.name = 'InvalidPortError';
  }
}

/** The port the web process listens on when PORT is unset or blank. */
const DEFAULT_PORT = 3000;
/** The highest TCP port number. */
const MAX_PORT = 65_535;

/** The port `startWeb` listens on: PORT as digits in 0..65535, or 3000 when unset or blank. */
function listenPort(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env['PORT']?.trim();
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = /^\d{1,5}$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port > MAX_PORT) throw new InvalidPortError();
  return port;
}

/** The running web server: where it listens, and how to stop it. */
export type WebHandle = {
  readonly url: string;
  readonly close: () => Promise<void>;
};

type Environment = Readonly<Record<string, string | undefined>>;

/** Where this process listens, and the launch options it was given, both checked. */
type LaunchPlan = {
  readonly port: number;
  readonly host: string;
  readonly dev: boolean;
  readonly dir: string;
};

/**
 * Everything that can fail before Next is created. `env` must name a valid posture, and a local one
 * needs a loopback HOST. The posture sites (the runtime registry, the engine images and the egress
 * policy) read `process.env`, so its posture must also hold for the host bound here, or a launcher
 * passing a different `env` would relax them on a server reachable from the network.
 */
function planLaunch(env: Environment, options: StartWebOptions): LaunchPlan {
  const parsedOptions = startWebOptionsSchema.safeParse(options);
  if (!parsedOptions.success) throw new StartWebOptionsError();
  const port = listenPort(env);
  const host = bindHost(env);
  readDeploymentPosture(env);
  checkDeploymentPosture(process.env, host);
  return {
    port,
    host,
    dev: parsedOptions.data.dev ?? env['NODE_ENV'] !== 'production',
    dir: parsedOptions.data.dir ?? fileURLToPath(new URL('..', import.meta.url)),
  };
}

/**
 * In production `prepare()` does not wait for `register()`: Next starts it in the background, only
 * logs a failure, and then answers 500 to every request. So wait for it here, and reject rather than
 * hand back a server that cannot serve. Next is closed on the way out.
 */
async function awaitRegistration(registered: Promise<void>, app: ProgrammaticNext): Promise<void> {
  try {
    await registered;
  } catch (error) {
    try {
      await app.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Web did not start, and Next could not be closed.',
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** Closes what a failed start left running: Next, then the composition's database pools. */
async function closeAfterFailedStart(app: ProgrammaticNext): Promise<void> {
  try {
    await app.close();
  } finally {
    await closeHeldComposition();
  }
}

export async function startWeb(
  env: Environment = process.env,
  options: StartWebOptions = {},
): Promise<WebHandle> {
  const { port, host, dev, dir } = planLaunch(env, options);
  // A failed `register()` then rejects this call rather than exiting the caller's process.
  const registered = markEmbeddedStart();
  const app = createNext({ customServer: true, dev, dir, hostname: host, port });
  await app.prepare();
  await awaitRegistration(registered, app);
  const server = createServer(serveRequest(app.getRequestHandler()));
  try {
    await listen(server, port, host);
  } catch (error) {
    // A port in use must not leave Next and the composition's pools running behind a failed start.
    await closeAfterFailedStart(app);
    throw error;
  }
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
