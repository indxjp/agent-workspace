/**
 * The tool host (issue #693, D48): forks `host-child.ts` for a project and keeps it running.
 *
 * The URL (`http://127.0.0.1:<port>/<token>/mcp`) is chosen once, here, and is the same after every
 * restart, so what registers it need not follow edits. Editing a source file below `tools/`
 * restarts only the child (debounced); declarations are re-read by the child on every start.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CliIo } from '../io.js';

const CHILD_PATH = fileURLToPath(
  new URL(import.meta.url.endsWith('.ts') ? './host-child.ts' : './host-child.js', import.meta.url),
);
const RESTART_DEBOUNCE_MS = 50;
const READY_TIMEOUT_MS = 20_000;
// A `stdio` server's package is fetched on first start; the child's own start limit is 90 s.
const STDIO_READY_TIMEOUT_MS = 120_000;
const SOURCE_FILE = /\.[cm]?[jt]s$/u;

/**
 * The hosted form (issue #791, ADR-0118 TS3-TS5): the tool sandbox serves the declarations a
 * version pinned from bundles already on disk, on `<host>:<port>/mcp`, for the bearer tokens in
 * `tokensFile`. `io.env` is the child's whole environment, so it holds exactly the declared secrets.
 */
export interface HostedTools {
  readonly host: string;
  readonly port: number;
  /** A JSON array of the bearer tokens the host accepts, read again on every request. */
  readonly tokensFile: string;
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
    readonly timeoutMs: number;
    /** Absolute path of the bundle: an ES module whose default export is the run function. */
    readonly file: string;
  }[];
  /**
   * `stdio` MCP servers launched with the host and served at `/stdio/<name>/mcp` (issue #793, TS6).
   * Each command is already pinned by the manifest; the host fails if one cannot start.
   */
  readonly stdioServers?: readonly {
    readonly name: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly timeoutMs: number;
  }[];
}

export interface ToolHostOptions {
  /** The child's working directory; the project for `aw dev`. */
  readonly root: string;
  readonly io: Pick<CliIo, 'stderr' | 'env'>;
  /** Stops the host when aborted. */
  readonly signal: AbortSignal;
  /** Serve a version's pinned tools in a tool sandbox instead of the project's `tools/`. */
  readonly hosted?: HostedTools | undefined;
}

export interface ToolHost {
  readonly url: string;
  /** The tools served now; changes after a restart. */
  readonly tools: () => readonly string[];
  /** Settles once the signal aborted and the child is gone. */
  readonly closed: Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
}

export async function startToolHost(options: ToolHostOptions): Promise<ToolHost> {
  const { root, io, signal, hosted } = options;
  const port = hosted?.port ?? (await freePort());
  const token = randomBytes(24).toString('hex');
  const config = JSON.stringify(
    hosted === undefined ? { root, port, token } : { mode: 'hosted', ...hosted },
  );
  let served: readonly string[] = [];
  let child: ChildProcess | undefined;
  let stopped = false;
  let lost: () => void = () => undefined;
  const childLost = new Promise<void>((resolve) => {
    lost = resolve;
  });

  const stop = async (): Promise<void> => {
    const old = child;
    child = undefined;
    old?.kill();
    if (old !== undefined) await exited(old);
  };

  /** Resolves when the child said it is ready, failed or exited (never rejects). */
  const spawn = (): Promise<void> =>
    new Promise((resolve) => {
      served = [];
      const next = fork(CHILD_PATH, [], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        serialization: 'json',
        cwd: root,
        env: { ...io.env, AW_TOOL_HOST: config },
      });
      child = next;
      const timer = setTimeout(
        resolve,
        hosted?.stdioServers?.length ? STDIO_READY_TIMEOUT_MS : READY_TIMEOUT_MS,
      );
      const settle = (): void => {
        clearTimeout(timer);
        resolve();
      };
      for (const stream of [next.stdout, next.stderr]) {
        if (stream === null) continue;
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
          io.stderr(chunk);
        });
      }
      next.on('message', (message: unknown) => {
        const tools = (message as { tools?: unknown } | null)?.tools;
        if (Array.isArray(tools)) served = tools.map(String);
        settle();
      });
      next.on('error', (error) => {
        io.stderr(`[tool host] ${error.message}\n`);
        settle();
      });
      next.on('exit', (code) => {
        if (child === next && !stopped && hosted !== undefined) lost();
        if (child === next && !stopped) {
          io.stderr(`[tool host] exited (code ${String(code)}); save a file to restart it\n`);
        }
        settle();
      });
    });

  await spawn();

  if (hosted !== undefined) {
    const closed = new Promise<void>((resolve) => {
      const finish = (): void => {
        stopped = true;
        void stop().then(resolve);
      };
      if (signal.aborted) finish();
      else signal.addEventListener('abort', finish, { once: true });
      // A sandbox whose child died serves nothing and nothing restarts it: let the owner see it.
      void childLost.then(finish);
    });
    return { url: `http://${hosted.host}:${String(port)}/mcp`, tools: () => served, closed };
  }

  // Restarts run one after another, so two debounced edits can never fork two children.
  let restarting: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      restarting = restarting.then(stop).then(() => (stopped ? undefined : spawn()));
    }, RESTART_DEBOUNCE_MS);
  };

  // Only `tools/` is watched recursively: the root holds `node_modules` and the runtime's state.
  // The root's watcher (not recursive) only notices `tools/` appearing, and attaches again.
  const watchFailed = (error: Error): void => {
    io.stderr(`[tool host] cannot watch for edits: ${error.message}
`);
  };
  let toolsWatcher: FSWatcher | undefined;
  const attach = (): void => {
    toolsWatcher?.close();
    try {
      toolsWatcher = watch(path.join(root, 'tools'), { recursive: true }, (_event, name) => {
        if (name !== null && SOURCE_FILE.test(name)) schedule();
      });
      toolsWatcher.on('error', watchFailed);
    } catch {
      toolsWatcher = undefined; // absent: the root's watcher attaches it when it appears
    }
  };
  attach();
  const rootWatcher = watch(root, (event, name) => {
    if (event === 'rename' && (name === null || name === 'tools')) {
      attach();
      schedule();
    }
  });
  rootWatcher.on('error', watchFailed);

  const closed = new Promise<void>((resolve) => {
    const finish = (): void => {
      stopped = true;
      clearTimeout(timer);
      toolsWatcher?.close();
      rootWatcher.close();
      void restarting.then(stop).then(resolve);
    };
    if (signal.aborted) finish();
    else signal.addEventListener('abort', finish, { once: true });
  });

  return { url: `http://127.0.0.1:${String(port)}/${token}/mcp`, tools: () => served, closed };
}
