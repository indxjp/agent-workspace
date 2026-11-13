import { createServer, type Server } from 'node:net';

/**
 * Listen on `127.0.0.1:port` and keep listening. When something else (another embedded runtime on
 * this host) already holds the port, resolve with null: the port is taken either way.
 */
export function holdPort(port: number): Promise<Server | null> {
  return new Promise<Server | null>((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => {
      if ('code' in error && error.code === 'EADDRINUSE') resolve(null);
      else reject(error);
    });
    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

/** The range {@link freeLoopbackPorts} draws from: below the Linux ephemeral range (32768-60999). */
const LOOPBACK_PORT_RANGE = { first: 20_000, last: 32_767 } as const;

/**
 * `count` distinct loopback ports nothing listens on, for the runtime's listeners and its embedded
 * PostgreSQL. Each is drawn at random from {@link LOOPBACK_PORT_RANGE}, so two runs of this file on
 * one host almost never draw the same one, and, being outside the ephemeral range, none is handed
 * to an outgoing connection (the runtime's own database clients make many) between this probe and
 * the service binding it. An OS-assigned port is ephemeral: one such port was taken that way and
 * the start failed with `port <n> (runner) is already in use`. All probes hold their port until
 * every one is found, so no two are equal. A port that cannot be bound for any reason is skipped.
 */
async function freeLoopbackPorts(count: number, avoid: readonly number[] = []): Promise<number[]> {
  const span = LOOPBACK_PORT_RANGE.last - LOOPBACK_PORT_RANGE.first + 1;
  const held: { readonly port: number; readonly server: Server }[] = [];
  try {
    for (let attempt = 0; held.length < count && attempt < 50 * count; attempt += 1) {
      const port = LOOPBACK_PORT_RANGE.first + Math.floor(Math.random() * span);
      if (avoid.includes(port) || held.some((entry) => entry.port === port)) continue;
      const server = await holdPort(port).catch(() => null);
      if (server !== null) held.push({ port, server });
    }
    if (held.length < count)
      throw new Error(`no ${String(count)} free loopback ports after many attempts`);
    return held.map((entry) => entry.port);
  } finally {
    await Promise.all(
      held.map(async ({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  }
}

export const [DATABASE_PORT = 0] = await freeLoopbackPorts(1);

/** Three distinct loopback ports for the web, gateway and runner, none the database's. */
export async function freePorts(): Promise<{ web: number; gateway: number; runner: number }> {
  const [web = 0, gateway = 0, runner = 0] = await freeLoopbackPorts(3, [DATABASE_PORT]);
  return { web, gateway, runner };
}

export interface Ports {
  readonly web: number;
  readonly gateway: number;
  readonly runner: number;
}
