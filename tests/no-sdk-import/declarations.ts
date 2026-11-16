import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { REPO_ROOT, type EngineSdkBoundary } from './boundaries.js';
import { sdkOwns } from './packages.js';
import { resolveSpecifier } from './resolve.js';
import { scanModuleSource } from './scan.js';

/**
 * What one file in the declaration emit is.
 *
 *   * `declaration`: a `.d.ts`, `.d.mts` or `.d.cts`. All three carry exported signatures, so all
 *     three can carry an SDK type out of the boundary; an earlier walk tested `endsWith('.d.ts')`
 *     and silently dropped the other two (the ADR-0027 clause 3 shape).
 *   * `declaration-map`: the `.map` written beside one when `declarationMap` is on. It holds
 *     positions into the source, not module specifiers.
 *
 * There is no third arm and no default: anything else is `unrecognised`, and a test asserts none
 * was emitted. A declaration this gate does not read is an SDK type it cannot see leaving.
 */
type EmittedKind = 'declaration' | 'declaration-map' | 'unrecognised';

export function classifyEmitted(name: string): EmittedKind {
  if (/\.d\.(?:ts|mts|cts)$/.test(name)) return 'declaration';
  if (/\.d\.(?:ts|mts|cts)\.map$/.test(name)) return 'declaration-map';
  return 'unrecognised';
}

export type EmittedFile = {
  readonly name: string;
  readonly kind: EmittedKind;
  readonly text: string;
};

/** Every file under the emit directory, classified, as repo-relative-looking paths. */
function emittedFiles(dir: string, prefix = ''): EmittedFile[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry): EmittedFile[] => {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) return emittedFiles(child, `${prefix}${entry.name}/`);
    const kind = classifyEmitted(entry.name);
    return [
      {
        name: `${prefix}${entry.name}`,
        kind,
        text: kind === 'declaration' ? readFileSync(child, 'utf8') : '',
      },
    ];
  });
}

export type DeclarationEmit = { readonly files: EmittedFile[]; readonly tscOutput: string };

function runDeclarationEmit(row: EngineSdkBoundary, outDir: string): string {
  const tsc = path.join(REPO_ROOT, 'node_modules', '@typescript', 'native', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error(`${tsc} is missing, so this gate could not run`);
  try {
    execFileSync(
      process.execPath,
      [
        tsc,
        '-p',
        row.emitProject,
        '--noEmit',
        'false',
        '--declaration',
        '--emitDeclarationOnly',
        '--rootDir',
        row.sourceRoot,
        '--outDir',
        outDir,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' },
    );
    return '';
  } catch (error) {
    // A type error still emits declarations (`noEmitOnError` is off), and the assertions are about
    // what was emitted. The output is kept for the failure message rather than swallowed.
    return error instanceof Error ? error.message : String(error);
  }
}

/** Emit the adapter's declarations into a temporary directory and read them back. */
export function emitDeclarations(row: EngineSdkBoundary): DeclarationEmit {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'w1-rn-01-dts-'));
  try {
    const tscOutput = runDeclarationEmit(row, outDir);
    return { files: emittedFiles(outDir), tscOutput };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * The declarations that name an SDK, and the references that could not be decided.
 *
 * The emit lands in a temporary directory, so each declaration's references are resolved from the
 * source file it was emitted for, `<sourceRoot>/<name>`, which is the context whose `package.json`
 * and `tsconfig.json` a consumer of the boundary resolves in.
 */
export function declarationLeaks(
  row: EngineSdkBoundary,
  declarations: readonly EmittedFile[],
): { leaks: string[]; unreadable: string[] } {
  const leaks: string[] = [];
  const unreadable: string[] = [];
  for (const declaration of declarations) {
    const emittedFrom = path.join(REPO_ROOT, row.sourceRoot, declaration.name);
    const scan = scanModuleSource(declaration.name, declaration.text);
    for (const entry of scan.undecidable) {
      unreadable.push(`${declaration.name}: ${entry.reason}`);
    }
    for (const reference of scan.references) {
      const resolution = resolveSpecifier(emittedFrom, reference.specifier);
      if (resolution.kind === 'unresolved') {
        unreadable.push(`${declaration.name}: ${reference.specifier} resolved to nothing`);
      } else if (resolution.kind === 'resolved' && sdkOwns(resolution.file)) {
        leaks.push(declaration.name);
      }
    }
  }
  return { leaks: [...new Set(leaks)], unreadable };
}
