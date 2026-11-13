import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT, SDK_BOUNDARY, SDK_PACKAGE } from './boundaries.js';
import { isFile, owningPackageName, realPath, sdkOwns } from './packages.js';
import { resolveSpecifier } from './resolve.js';

const WEB_ROUTE = path.join(REPO_ROOT, 'apps/web/app/api/runs/[id]/route.ts');
const BOUNDARY_FILE = path.join(REPO_ROOT, SDK_BOUNDARY);

/** The file a specifier resolved to, or `undefined` when it resolved to nothing. */
function resolvedFile(importer: string, specifier: string): string | undefined {
  const resolution = resolveSpecifier(importer, specifier);
  return resolution.kind === 'resolved' ? resolution.file : undefined;
}

type ScratchProject = {
  /** Files to write, relative to the project directory. */
  readonly files?: Readonly<Record<string, string>>;
  /** The project's `tsconfig.json`. */
  readonly tsconfig: object;
};

/** Writes a scratch project and returns the path of an importer inside it. */
function writeProject(dir: string, project: ScratchProject): string {
  for (const [relative, content] of Object.entries(project.files ?? {})) {
    mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    writeFileSync(path.join(dir, relative), content);
  }
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(project.tsconfig));
  const importer = path.join(dir, 'src', 'app.ts');
  writeFileSync(importer, 'export {};\n');
  return importer;
}

const TARGET = { 'roots/probes/target.ts': 'export const x = 1;\n' };
const BUNDLER = { module: 'esnext', moduleResolution: 'bundler' };

describe('a reference is decided by resolving it, not by reading its text', () => {
  it('resolves the SDK to a file its own package.json claims, so the comparison is not a name', () => {
    // ADR-0015 on the resolver itself: every §42 assertion is "this resolved path belongs to the
    // SDK", and all of them pass vacuously if the SDK stops resolving or if `owningPackageName`
    // stops answering. Both halves are asserted against the installed package.
    const resolution = resolveSpecifier(BOUNDARY_FILE, SDK_PACKAGE);
    expect(resolution.kind, `${SDK_PACKAGE} did not resolve from ${SDK_BOUNDARY}`).toBe('resolved');
    if (resolution.kind !== 'resolved') return;
    expect(isFile(resolution.file), `${resolution.file} is not a file on disk`).toBe(true);
    expect(owningPackageName(resolution.file)).toBe(SDK_PACKAGE);
    expect(sdkOwns(resolution.file)).toBe(true);
    // A file in this repository is not the SDK, which makes the check a comparison of packages
    // rather than a function that says yes.
    expect(sdkOwns(BOUNDARY_FILE)).toBe(false);
  });

  it('honours a paths alias declared in the project that owns the importing file', () => {
    // `apps/web/tsconfig.json` really does map `@/*`. Nothing in this gate knows that: the alias
    // is applied by `ts.resolveModuleName`.
    expect(resolvedFile(WEB_ROUTE, '@/server/runs/api')).toBe(
      realPath(path.join(REPO_ROOT, 'apps/web/server/runs/api.ts')),
    );
    // The same specifier from a project with no such alias resolves to nothing, so the assertion
    // above is about the project's configuration and not about the text `@/`.
    expect(resolveSpecifier(BOUNDARY_FILE, '@/server/runs/api').kind).toBe('unresolved');
  });
});

describe('a reference is decided by resolving it, not by reading its text', () => {
  it('honours a baseUrl and a paths block reached through an extends of any filename', () => {
    // The two resolution roots the alias table this replaced did not model. Each project is
    // handed to the compiler, and the compiler answers.
    const root = mkdtempSync(path.join(os.tmpdir(), 'w2-int-01-resolution-'));
    try {
      // (a) `baseUrl` alone: no `paths` entry exists, and a bare specifier still resolves.
      const byBaseUrl = writeProject(path.join(root, 'by-base-url'), {
        files: TARGET,
        tsconfig: { compilerOptions: { ...BUNDLER, baseUrl: './roots' } },
      });
      expect(resolvedFile(byBaseUrl, 'probes/target'), 'a baseUrl root did not resolve').toBe(
        realPath(path.join(root, 'by-base-url', 'roots', 'probes', 'target.ts')),
      );

      // (b) a `paths` block in an `extends` target whose extension is not `.json`. `tsc` loads
      //     that file verbatim; a gate that only opened `tsconfig*.json` never saw the table.
      const byExtends = writeProject(path.join(root, 'by-extends'), {
        files: {
          ...TARGET,
          'shared.base': JSON.stringify({
            compilerOptions: { paths: { '@probe/*': ['./roots/probes/*'] } },
          }),
        },
        tsconfig: { extends: './shared.base', compilerOptions: BUNDLER },
      });
      expect(resolvedFile(byExtends, '@probe/target'), 'a non-.json extends target').toBe(
        realPath(path.join(root, 'by-extends', 'roots', 'probes', 'target.ts')),
      );

      // The negative that makes both about the configuration: a project that declares neither
      // root resolves the same two specifiers to nothing.
      const plain = writeProject(path.join(root, 'plain'), {
        tsconfig: { compilerOptions: BUNDLER },
      });
      expect(resolveSpecifier(plain, 'probes/target').kind).toBe('unresolved');
      expect(resolveSpecifier(plain, '@probe/target').kind).toBe('unresolved');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a reference is decided by resolving it, not by reading its text', () => {
  it('refuses a specifier no resolver could place, naming the reference', () => {
    // ADR-0030 clause 3: the branch a resolver leaves open is a refusal rather than a skip. The
    // specifier is syntactically fine and points at nothing.
    expect(resolveSpecifier(BOUNDARY_FILE, './there-is-no-such-module.js').kind).toBe('unresolved');
  });

  it('follows a symlink to the same file the pnpm store holds', () => {
    // Why every answer goes through `realpathSync`: `node_modules/@anthropic-ai/…` is a link into
    // the content-addressed store, and a reference through the link and one through the store are
    // the same module. Comparing the two spellings as text says otherwise.
    const linked = path.join(
      REPO_ROOT,
      'packages/engine-claude-agent-sdk/node_modules',
      SDK_PACKAGE,
      'package.json',
    );
    expect(existsSync(linked), `${linked} is missing, so this control proves nothing`).toBe(true);
    expect(realPath(linked)).not.toBe(path.resolve(linked));
    expect(owningPackageName(realPath(linked))).toBe(SDK_PACKAGE);
  });
});
