import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { profileKeyRefs } from '../config.js';
import { CommandRefusedError, type CliIo } from '../io.js';
import { withoutNames } from '../local-runtime/environment.js';
import { type LoadProjectOptions } from './load-types.js';
import { EvaluatingMessageSchema, type LoadMessage } from './protocol.js';

/** How long the child may linger after it answered (a timer the user's code left) before it is killed. */
const EXIT_GRACE_MS = 2_000;

/**
 * The credential variables `aw` itself may read; every profile's `apiKeyRef` is withheld too.
 * This keeps the environment's keys out of the child only: the definition files are the user's
 * own code, run with the user's file access, as `node agents/x.ts` would run them (ADR-0111).
 */
const WITHHELD_ENV = ['AGENT_WORKSPACE_API_KEY', 'ANTHROPIC_API_KEY'];

/**
 * The child's file, beside this one: `loader-child.ts` when this module runs from `src` (the test
 * runner, where Node strips the child itself), `loader-child.js` from `dist`.
 */
const CHILD_PATH = fileURLToPath(
  new URL(
    import.meta.url.endsWith('.ts') ? './loader-child.ts' : './loader-child.js',
    import.meta.url,
  ),
);

/**
 * `io.env` without {@link WITHHELD_ENV}, every profile's `apiKeyRef` and `withheld`, whatever their
 * case.
 */
export async function childEnv(
  io: CliIo,
  withheld: readonly string[] = [],
): Promise<Record<string, string>> {
  return withoutNames(io.env, [
    ...WITHHELD_ENV,
    ...(await profileKeyRefs(io.homeDir)),
    ...withheld,
  ]);
}

/**
 * How the child ended: with its answer; killed at the timeout; or exited without answering while
 * it evaluated `file`, the one it last announced (`null` before the first).
 */
type ChildOutcome =
  | { readonly kind: 'reply'; readonly message: unknown }
  | { readonly kind: 'timeout'; readonly file: string | null }
  | { readonly kind: 'unfinished'; readonly file: string; readonly code: number | null };

/**
 * Fork the child, hand it the files and wait for its one answer. Its stdout and stderr — the
 * definition files' own `console` output — go to `aw`'s stderr, so `--json` output stays clean.
 */
export function runChild(
  request: LoadMessage,
  options: LoadProjectOptions,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<ChildOutcome> {
  const { io, signal } = options;
  return new Promise((resolve, reject) => {
    const child = fork(CHILD_PATH, [], {
      execArgv: ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
      env,
      cwd: request.root,
    });
    let reply: { readonly message: unknown } | null = null;
    let evaluating: string | null = null;
    let timedOut = false;
    let grace: NodeJS.Timeout | undefined;
    const kill = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal.addEventListener('abort', kill, { once: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      if (grace !== undefined) clearTimeout(grace);
      signal.removeEventListener('abort', kill);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      io.stderr(chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      io.stderr(chunk);
    });
    child.on('message', (message: unknown) => {
      if (reply !== null) return;
      const announced = EvaluatingMessageSchema.safeParse(message);
      if (announced.success) {
        evaluating = announced.data.file;
        return;
      }
      reply = { message };
      grace = setTimeout(kill, EXIT_GRACE_MS);
    });
    child.once('error', (error) => {
      cleanup();
      kill();
      reject(error);
    });
    child.once('close', (code) => {
      cleanup();
      if (reply !== null) resolve({ kind: 'reply', message: reply.message });
      else if (timedOut) resolve({ kind: 'timeout', file: evaluating });
      else if (signal.aborted)
        reject(new CommandRefusedError('the project loader was interrupted'));
      else if (evaluating !== null) resolve({ kind: 'unfinished', file: evaluating, code });
      else {
        reject(
          new CommandRefusedError(
            `the project loader exited (code ${String(code)}) before it answered`,
          ),
        );
      }
    });
    child.send(request);
  });
}
