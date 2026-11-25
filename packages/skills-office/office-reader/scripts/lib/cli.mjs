// The command line of a use case's own skill script (ADR-0173), so the script is only its
// calculation: `runWhenMain(import.meta.url, spec, compute)` parses the arguments, refusing any it
// does not know, prints `compute`'s result as JSON on stdout, and a refusal as JSON on stderr with
// a non-zero exit code. Plain JavaScript that runs with Node alone in a run's sandbox; an entry
// imports it as `@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs`.
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { TableError } from './table.mjs';

/** Exit codes: a refusal of the data, and arguments the script does not take. */
export const EXIT_CODES = Object.freeze({ ok: 0, refused: 1, usage: 2 });

const usage = (spec, reason) => new TableError('usage', `${reason}; usage: ${spec.usage}`);

/**
 * `argv` as `spec` declares it: each name of `spec.positionals` once, in order, and `--name value`
 * or `--name=value` for each name of `spec.options`, at most once, with the option's `default`
 * when it is left out. Everything after a lone `--` is positional, so a file whose name starts
 * with `--` can still be named.
 *
 * @param {readonly string[]} argv the arguments after the script's path
 * @param {{ usage: string, positionals: readonly string[], options?: Readonly<Record<string, { default?: string }>> }} spec
 * @throws {TableError} `usage`: an unknown, repeated or empty option, or a wrong number of positionals.
 */
export function parseArgs(argv, spec) {
  const declared = spec.options ?? {};
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    if (!Object.hasOwn(declared, name)) throw usage(spec, `unknown option --${name}`);
    if (Object.hasOwn(options, name)) throw usage(spec, `--${name} is given twice`);
    const value = equals === -1 ? argv[index + 1] : arg.slice(equals + 1);
    if (value === undefined || value === '' || (equals === -1 && value.startsWith('--')))
      throw usage(spec, `--${name} needs a value`);
    if (equals === -1) index += 1;
    options[name] = value;
  }
  if (positionals.length !== spec.positionals.length)
    throw usage(
      spec,
      `${spec.positionals.length} argument(s) expected (${spec.positionals.join(', ')}), got ${positionals.length}`,
    );
  for (const [name, option] of Object.entries(declared)) {
    if (!Object.hasOwn(options, name) && option.default !== undefined)
      options[name] = option.default;
  }
  return {
    positionals: Object.fromEntries(spec.positionals.map((name, at) => [name, positionals[at]])),
    options,
  };
}

/**
 * Parse `argv`, run `compute` and print its result: the exit code. A {@link TableError} (from the
 * table, the arguments or `compute` itself) is printed as `{ error, message, row?, column?, value? }`
 * on stderr; any other error is a fault of the script and is thrown, and so is a promise from
 * `compute`: the calculation is synchronous, so a script cannot exit before its result is printed.
 */
export function runScript(argv, spec, compute, io) {
  try {
    const result = compute(parseArgs(argv, spec));
    if (typeof result?.then === 'function')
      throw new TypeError('compute returned a promise; a skill script computes synchronously');
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return EXIT_CODES.ok;
  } catch (error) {
    if (!(error instanceof TableError)) throw error;
    io.stderr.write(`${JSON.stringify(error)}\n`);
    return error.code === 'usage' ? EXIT_CODES.usage : EXIT_CODES.refused;
  }
}

/**
 * {@link runScript} with the process's arguments and streams, setting its exit code, when the
 * module at `moduleUrl` (the script's `import.meta.url`) is the one Node was started with; nothing
 * when a test imports the script.
 */
export function runWhenMain(moduleUrl, spec, compute) {
  if (moduleUrl !== pathToFileURL(String(process.argv[1])).href) return;
  process.exitCode = runScript(process.argv.slice(2), spec, compute, process);
}
