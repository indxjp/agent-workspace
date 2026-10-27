import { createInterface } from 'node:readline/promises';

import type { MenuSpec } from '@indx-workspace/sdk/project';

export { isInteractive } from '@indx-workspace/sdk/project';

/** A line-oriented terminal for `aw chat`'s interactive loop (issue #697); a test supplies a fake. */
export interface ChatTerminal {
  /** The next line typed after `prompt`; `null` at end of input. */
  readonly question: (prompt: string) => Promise<string | null>;
  /** Called on every Ctrl-C, whether the person is at the prompt or a turn is running. */
  readonly onInterrupt: (handler: () => void) => void;
  readonly close: () => void;
}

/**
 * Everything the CLI takes from, or gives to, the process it runs in — passed in as one value so
 * every module below the entry file is testable without touching `process`, the real
 * environment, the real home directory or the network.
 */
export interface CliIo {
  /** Read the whole of standard input, once. The CLI guards against a second read. */
  readonly stdin: () => Promise<string>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where `~/.config/agent-workspace/profiles.json` is looked for. */
  readonly homeDir: string;
  readonly fetch: typeof fetch;
  /**
   * Whether a person can answer: stdin and stdout are a terminal and `CI` is not set
   * ({@link isInteractive}); decides whether a prompt is even possible.
   */
  readonly isTty: boolean;
  /** Whether stdin alone is a terminal (no piped input); falls back to `isTty` when absent. */
  readonly stdinIsTty?: boolean;
  /** Aborted on SIGINT; every request and stream the CLI opens observes it. */
  readonly signal?: AbortSignal;
  /** Wait between `aw login`'s polls; injected by tests, a real timer otherwise. */
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /**
   * The directory the command runs in: where `aw init` writes, where `aw dev` and the
   * configuration's project step look for `agent-workspace.yaml` (issue #451). Absent means there
   * is no project: the project step is skipped and `aw init` and `aw dev` refuse.
   */
  readonly cwd?: string;
  /**
   * Ask the person one question on the terminal and answer the line they typed. Absent where no
   * terminal is attached; a command that needs a confirmation then refuses and names `--yes`.
   */
  readonly prompt?: (question: string, signal?: AbortSignal) => Promise<string>;
  /**
   * Drop what was typed ahead on the terminal, so a keystroke typed while a run streamed cannot
   * answer the next {@link prompt}. Absent where no terminal is attached.
   */
  readonly discardInput?: () => Promise<void>;
  /**
   * Show one setup question as an arrow-key menu and answer the chosen value(s). Absent where no
   * terminal is attached, and in suites that type their answers; the typed prompt is used then.
   */
  readonly choose?: (spec: MenuSpec) => Promise<readonly string[]>;
  /** Like {@link prompt} but nothing typed is echoed: for a key pasted for this session (#690). */
  readonly promptSecret?: (question: string) => Promise<string>;
  /** Open `url` in the person's browser; `false` when it could not. Absent: the URL is only printed. */
  readonly openUrl?: (url: string) => Promise<boolean>;
  /** Open the terminal for an interactive `aw chat`. Absent where no terminal is attached. */
  readonly openTerminal?: () => ChatTerminal;
}

/** The person pressed Ctrl-C twice in `aw chat`: the same outcome as SIGINT, exit code 130. */
export class InterruptedError extends Error {
  public constructor() {
    super('interrupted');
    this.name = 'InterruptedError';
  }
}

/**
 * The caller misused the command line: an unknown command, a missing argument, a malformed flag,
 * a body that fails the contract, or configuration that cannot be resolved. Exit code 2.
 */
export class UsageError extends Error {
  /** The one line that resolves it, printed after the message as `fix: <fix>`. */
  public readonly fix: string | undefined;

  public constructor(message: string, fix?: string) {
    super(message);
    this.name = 'UsageError';
    this.fix = fix;
  }
}

/**
 * The command declined to act: there is no project, the local runtime is missing or skewed, a file
 * it would write already exists. `fix`, when set, is the one line that resolves it, printed after
 * the message as `fix: <fix>`. Exit code 1, the refused-request class (issue #451).
 */
export class CommandRefusedError extends Error {
  public readonly fix: string | undefined;

  public constructor(message: string, fix?: string) {
    super(message);
    this.name = 'CommandRefusedError';
    this.fix = fix;
  }
}

/**
 * `aw deploy` planned changes it was not given `--yes` to apply (issue #621): the deployment has
 * drifted from the project file. Exit code 3, the drift class.
 */
export class ChangesPendingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ChangesPendingError';
  }
}

/** `--strict` and the export dropped fields; the report was still written. Exit code 5. */
export class PlatformFieldsDroppedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PlatformFieldsDroppedError';
  }
}

/**
 * A run the command waited for or followed ended `failed`, and `--fail-on-error` asked for that to
 * be the command's outcome (issue #393). `code` is the run's safe failure code, or `null` when the
 * failure carries none. Exit code 1, as for a refused request.
 */
export class RunFailedError extends Error {
  public readonly code: string | null;

  public constructor(runId: string, code: string | null, message: string) {
    super(`run ${runId} failed: ${message}`);
    this.name = 'RunFailedError';
    this.code = code;
  }
}

/** How long piped standard input may stay silent before the command gives up on it. */
const STDIN_IDLE_TIMEOUT_MS = 10_000;

/**
 * Read `input` to its end. A pipe a parent holds open and never writes to or closes (CI, an agent
 * harness) would otherwise wait forever, so silence for `idleTimeoutMs` is a usage error.
 *
 * @throws {UsageError} when `input` stays silent for `idleTimeoutMs` without ending.
 */
export function readStreamWithIdleTimeout(
  input: NodeJS.ReadableStream,
  idleTimeoutMs: number = STDIN_IDLE_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let idle: NodeJS.Timeout | undefined;
    const detach = (): void => {
      clearTimeout(idle);
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.pause();
    };
    const arm = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        detach();
        reject(
          new UsageError(
            `standard input stayed open with no data for ${String(Math.round(idleTimeoutMs / 1000))}s`,
            'close it (</dev/null), or pass the value as a flag instead of reading standard input',
          ),
        );
      }, idleTimeoutMs);
    };
    const onData = (chunk: Buffer | string): void => {
      chunks.push(Buffer.from(chunk));
      arm();
    };
    const onEnd = (): void => {
      detach();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = (error: Error): void => {
      detach();
      reject(error);
    };
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    arm();
    input.resume();
  });
}

/**
 * Standard input can be consumed once; a second consumer is a usage error, never an empty read. A
 * terminal has nothing to read until a person types, so it is refused rather than waited on;
 * `flag`, when given, is the flag that asked for the read, named in the fix.
 */
export function stdinOnce(io: CliIo): (flag?: string) => Promise<string> {
  let consumed = false;
  return async (flag?: string): Promise<string> => {
    if (consumed) {
      throw new UsageError(
        'standard input can be read only once per invocation (--api-key-stdin, --value-stdin and --file - compete for it)',
      );
    }
    consumed = true;
    if (io.stdinIsTty ?? io.isTty) {
      const fix =
        'pipe the input in (… | aw …) or redirect a file (< file); for a key, set AGENT_WORKSPACE_API_KEY instead';
      throw new UsageError(
        'standard input is a terminal, so there is nothing to read',
        flag === undefined ? fix : `${flag} reads standard input: ${fix}`,
      );
    }
    return io.stdin();
  };
}

/** One line read from `input`; the interface is opened and closed per question. */
export async function promptLine(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  question: string,
  signal?: AbortSignal,
): Promise<string> {
  const terminal = createInterface({ input, output });
  // question() never settles once the input ends (Ctrl-D, a closed pipe): the close is the answer.
  let onClose = (): void => undefined;
  const closed = new Promise<never>((_resolve, reject) => {
    onClose = () => {
      reject(new InterruptedError());
    };
    terminal.once('close', onClose);
  });
  try {
    return await Promise.race([
      terminal.question(question, signal === undefined ? {} : { signal }),
      closed,
    ]);
  } catch (error) {
    // Ctrl-C and Ctrl-D, like `signal` (SIGINT/SIGTERM), are an interrupt, as for `promptSecret`.
    if (error instanceof Error && error.name === 'AbortError') throw new InterruptedError();
    throw error;
  } finally {
    terminal.off('close', onClose);
    terminal.close();
  }
}
