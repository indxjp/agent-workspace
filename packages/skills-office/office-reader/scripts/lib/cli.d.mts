// Types for the skill-script command line (cli.mjs), plain JavaScript so it runs with Node alone
// inside a run's sandbox (ADR-0173). Use cases and this package's tests import it through these
// declarations.

export interface ScriptSpec<P extends string = string, O extends string = string> {
  /** One line, shown after a refused argument: `analyse.mjs <export.csv> [--month YYYY-MM]`. */
  readonly usage: string;
  readonly positionals: readonly P[];
  readonly options?: Readonly<Record<O, { readonly default?: string }>>;
}

export interface ParsedArgs<P extends string = string, O extends string = string> {
  readonly positionals: Readonly<Record<P, string>>;
  readonly options: Readonly<Partial<Record<O, string>>>;
}

export const EXIT_CODES: Readonly<{ ok: 0; refused: 1; usage: 2 }>;

/** @throws {import('./table.mjs').TableError} `usage`. */
export function parseArgs<const P extends string, const O extends string = never>(
  argv: readonly string[],
  spec: ScriptSpec<P, O>,
): ParsedArgs<P, O>;

interface Stream {
  write(text: string): unknown;
}

/** The exit code: 0 printed, 1 refused (JSON on stderr), 2 arguments the script does not take. */
export function runScript<const P extends string, const O extends string = never>(
  argv: readonly string[],
  spec: ScriptSpec<P, O>,
  compute: (args: ParsedArgs<P, O>) => unknown,
  io: { readonly stdout: Stream; readonly stderr: Stream },
): number;

/** {@link runScript} with the process's arguments, when `moduleUrl` is the script Node started. */
export function runWhenMain<const P extends string, const O extends string = never>(
  moduleUrl: string,
  spec: ScriptSpec<P, O>,
  compute: (args: ParsedArgs<P, O>) => unknown,
): void;
