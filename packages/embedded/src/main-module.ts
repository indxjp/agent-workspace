import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The extensions Node's CommonJS loader probes, in its order, when it resolves the main module. */
const MAIN_MODULE_EXTENSIONS = ['.js', '.json', '.node'] as const;

/** Whether `candidate` is a regular file (through links); fail-closed on any error. */
function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** `base` itself when it is a file, then `base` with each probed extension: Node's `tryFile` and `tryExtensions`. */
function resolveFile(base: string): string | undefined {
  if (isFile(base)) return base;
  return MAIN_MODULE_EXTENSIONS.map((extension) => `${base}${extension}`).find(isFile);
}

/** The `main` a directory's `package.json` names, when it names one; fail-closed on any error. */
function packageMain(directory: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('main' in parsed)) return undefined;
    return typeof parsed.main === 'string' && parsed.main.length > 0 ? parsed.main : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The file Node loads for the main-module path `entry`, or `undefined` when it loads none.
 *
 * It restates the order of Node's CommonJS `Module._findPath`, which resolves the main entry: the
 * exact file, then the probed extensions, then a directory — its `package.json` `main` (as a file,
 * with extensions, or as a directory's index), else its `index`. It is written out rather than
 * delegated to `createRequire(url).resolve(entry)` because the §42 boundary gate
 * (`tests/no-sdk-import.test.ts`) refuses a resolver applied to anything but a string literal: it
 * cannot tell what such a resolver reaches. Here nothing is loaded, only stat-ed.
 */
export function resolveMainModulePath(entry: string): string | undefined {
  const base = path.resolve(entry);
  const file = resolveFile(base);
  if (file !== undefined) return file;
  const main = packageMain(base);
  if (main !== undefined) {
    const target = path.resolve(base, main);
    const resolved = resolveFile(target) ?? resolveFile(path.join(target, 'index'));
    if (resolved !== undefined) return resolved;
  }
  return resolveFile(path.join(base, 'index'));
}

/**
 * Whether `entry` (normally `process.argv[1]`) is the file `moduleUrl` names, following package-manager
 * bin symlinks. Fail-closed: a missing entry or a path that cannot be resolved is not the module.
 *
 * `entry` is resolved as Node resolves the main module ({@link resolveMainModulePath}):
 * `node dist/launch` loads `dist/launch.js` while `argv[1]` keeps the path as typed, so the path
 * is resolved before the real paths are compared.
 *
 * It restates `@indx-workspace/cli`'s `isMainModule` rather than importing it, so `dist/bin.js`
 * stays a few lines with one import (`./launch.js`) instead of inlining the CLI.
 */
export function isMainModule(entry: string | undefined, moduleUrl: string): boolean {
  if (entry === undefined || entry.length === 0) return false;
  try {
    const loaded = resolveMainModulePath(entry);
    if (loaded === undefined) return false;
    return realpathSync(loaded) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/** What the bin prints, on stderr, when it is given an argument: it takes none. */
export const BIN_ARGUMENT_REFUSAL =
  'agent-workspace-embedded takes no arguments; it is configured through the environment and ' +
  '.env, and `aw dev` starts it';

/** What {@link runBin} needs from the process; the tests pass fakes. */
export interface BinProcess {
  /** The arguments after the script path (`process.argv.slice(2)`). */
  readonly args: readonly string[];
  readonly writeError: (chunk: string) => void;
  readonly exit: (code: number) => void;
  /** Starts the runtime and resolves with its exit code (`runLocalRuntime`). */
  readonly start: () => Promise<number>;
}

/**
 * The bin's body. It refuses any argument rather than ignore it, and leaves through
 * `exit` on a non-zero code: `embedded-postgres` installs `async-exit-hook`, whose `beforeExit`
 * listener calls `process.exit(0)` and would otherwise turn a failed start into a success.
 * A started runtime (code 0) keeps the process alive through its servers.
 */
export async function runBin(binProcess: BinProcess): Promise<void> {
  if (binProcess.args.length > 0) {
    binProcess.writeError(`${BIN_ARGUMENT_REFUSAL}\n`);
    binProcess.exit(1);
    return;
  }
  const code = await binProcess.start();
  if (code !== 0) binProcess.exit(code);
}
