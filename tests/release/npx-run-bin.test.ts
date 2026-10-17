/**
 * ADR-0087 D1: after `pnpm dlx` installs a connector's package, `infra/images/npx-run-bin.mjs`
 * hands pnpm's bin script to `/bin/sh` instead of executing it, because the dlx cache sits on a
 * `noexec` `/tmp` under the Docker driver. These tests hold the package and bin choice to pnpm's
 * own rules (for every form of spec) and prove a bin script runs even when it is not executable.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  binProcess,
  dlxNodeModules,
  installedPackageName,
  isInside,
  listBinDirectory,
  NpxBinError,
  packageBinNames,
  realPath,
  resolveBin,
  selectPackageBin,
} from '../../infra/images/npx-run-bin.mjs';

const RUN_BIN = path.resolve(import.meta.dirname, '../../infra/images/npx-run-bin.mjs');
const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
  const root = mkdtempSync(path.join(tmpdir(), 'npx-run-bin-'));
  temporary.push(root);
  return root;
}

/**
 * A dlx-shaped install: `<root>/package.json` naming the installed dependencies in order, and
 * `<root>/node_modules/{.bin/<bins>,<key>/package.json}`. A dependency's key is the name pnpm
 * installed it under; its manifest is what its own package.json holds.
 */
function install(
  packages: Record<string, Record<string, unknown>>,
  bins: Record<string, string> = {},
  files: Record<string, string> = {},
) {
  const root = temporaryDirectory();
  const nodeModules = path.join(root, 'node_modules');
  mkdirSync(path.join(nodeModules, '.bin'), { recursive: true });
  const dependencies = Object.fromEntries(Object.keys(packages).map((key) => [key, '*']));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies }));
  for (const [key, manifest] of Object.entries(packages)) {
    mkdirSync(path.join(nodeModules, key), { recursive: true });
    writeFileSync(path.join(nodeModules, key, 'package.json'), JSON.stringify(manifest));
  }
  for (const [name, script] of Object.entries(bins)) {
    // As on a noexec mount: the script can be read, not executed.
    writeFileSync(path.join(nodeModules, '.bin', name), script);
    chmodSync(path.join(nodeModules, '.bin', name), 0o644);
  }
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(nodeModules, file)), { recursive: true });
    writeFileSync(path.join(nodeModules, file), content);
  }
  return nodeModules;
}

const PACKAGE = path.join(path.sep, 'dlx', 'node_modules', 'pkg');
const noFiles = () => [];

describe('the npx bin runner', () => {
  it.each([
    // What pnpm dlx records in the dlx project's package.json for each form of spec.
    ['cowsay@1.6.0', { cowsay: '1.6.0' }, 'cowsay'],
    ['@scope/pkg@^2.1.0', { '@scope/pkg': '^2.1.0' }, '@scope/pkg'],
    ['alias@npm:@scope/pkg@1', { alias: 'npm:@scope/pkg@1' }, 'alias'],
    ['github:org/repo', { 'repo-package': 'github:org/repo' }, 'repo-package'],
    ['./dir', { 'dir-package': 'file:dir' }, 'dir-package'],
    ['https://host/pkg-1.0.0.tgz', { pkg: 'https://host/pkg-1.0.0.tgz' }, 'pkg'],
    // pnpm takes the first dependency.
    ['a', { a: '1', b: '2' }, 'a'],
  ])('finds the package %s was installed as, as pnpm does', (spec, dependencies, name) => {
    expect(installedPackageName({ dependencies }, spec)).toBe(name);
  });

  it.each([[{}], [{ dependencies: {} }], [{ dependencies: 'x' }]])(
    'refuses a dlx project with no dependency: %j',
    (project) => {
      expect(() => installedPackageName(project, 'x')).toThrow(/recorded no installed dependency/u);
    },
  );

  it('chooses the bin as npx does: the only one, else the one named after the package', () => {
    expect(selectPackageBin({ name: '@scope/pkg', bin: 'cli.js' }, '@scope/pkg', PACKAGE)).toBe(
      'pkg',
    );
    // An alias: the bin is named after the real package, not the alias it was installed under.
    expect(selectPackageBin({ name: '@scope/real', bin: 'cli.js' }, 'alias', PACKAGE)).toBe('real');
    // No name in the manifest: the installed name stands in.
    expect(selectPackageBin({ bin: 'cli.js' }, '@scope/pkg', PACKAGE)).toBe('pkg');
    expect(selectPackageBin({ bin: { anything: 'a.js' } }, 'pkg', PACKAGE)).toBe('anything');
    expect(
      selectPackageBin({ bin: { other: 'o.js', 'server-x': 's.js' } }, '@s/server-x', PACKAGE),
    ).toBe('server-x');
    expect(
      selectPackageBin({ name: '@s/real', bin: { other: 'o.js', real: 'r.js' } }, 'alias', PACKAGE),
    ).toBe('real');
    expect(() => selectPackageBin({ bin: { a: 'a.js', b: 'b.js' } }, 'pkg', PACKAGE)).toThrow(
      NpxBinError,
    );
    expect(() => selectPackageBin({}, 'pkg', PACKAGE)).toThrow(
      /could not determine the executable/u,
    );
  });

  it('reads bin names as pnpm links them', () => {
    // A scope is dropped from a bin key.
    expect(packageBinNames({ bin: { '@scope/tool': 't.js' } }, 'pkg', PACKAGE, noFiles)).toEqual([
      'tool',
    ]);
    // Names pnpm does not link, and paths outside the package, are left out.
    expect(
      packageBinNames(
        { bin: { '': 'a.js', '..': 'b.js', 'a b': 'c.js', ok: 'ok.js', out: '../x.js', n: 1 } },
        'pkg',
        PACKAGE,
        noFiles,
      ),
    ).toEqual(['ok']);
    // `bin` wins over `directories.bin`.
    expect(
      packageBinNames(
        { bin: { only: 'o.js' }, directories: { bin: 'bin' } },
        'pkg',
        PACKAGE,
        () => ['x', 'y'],
      ),
    ).toEqual(['only']);
  });

  it('reads directories.bin: every file under it is a bin named after the file', () => {
    const listed: string[] = [];
    const listFiles = (directory: string) => {
      listed.push(directory);
      return ['tool', path.join('nested', 'pkg')];
    };
    expect(
      packageBinNames({ name: 'pkg', directories: { bin: './bin' } }, 'pkg', PACKAGE, listFiles),
    ).toEqual(['tool', 'pkg']);
    expect(listed).toEqual([path.join(PACKAGE, 'bin')]);
    // Several bins: the one named after the package; a single bin: that one.
    const withBinDirectory = (name: string) => ({ name, directories: { bin: 'bin' } });
    expect(selectPackageBin(withBinDirectory('@s/pkg'), '@s/pkg', PACKAGE, listFiles)).toBe('pkg');
    expect(selectPackageBin(withBinDirectory('other'), 'other', PACKAGE, () => ['cli'])).toBe(
      'cli',
    );
    expect(() => selectPackageBin(withBinDirectory('other'), 'other', PACKAGE, listFiles)).toThrow(
      NpxBinError,
    );
    // A directory outside the package, or none, links nothing.
    for (const directories of [{ bin: '../elsewhere' }, { bin: '' }, { bin: 3 }, 'bin', null]) {
      expect(packageBinNames({ directories }, 'pkg', PACKAGE, listFiles)).toEqual([]);
    }
  });

  it('resolves a missing path through the real path of its nearest existing ancestor', () => {
    // As macOS's tmpdir (/var → /private/var): a linked root, a target under it that does not exist.
    const root = temporaryDirectory();
    const real = path.join(root, 'real');
    const linked = path.join(root, 'linked');
    mkdirSync(real);
    symlinkSync(real, linked, 'junction');
    const realRoot = realPath(real);
    expect(realPath(path.join(linked, 'missing', 'cli.js'))).toBe(
      path.join(realRoot, 'missing', 'cli.js'),
    );
    expect(realPath(linked)).toBe(realRoot);
    expect(isInside(linked, path.join(linked, '..x', 'cli.js'))).toBe(true);
    expect(isInside(linked, path.join(linked, '..', 'other'))).toBe(false);
  });

  it('keeps a path inside its package only when it really is inside', () => {
    const root = temporaryDirectory();
    expect(isInside(root, path.join(root, '..x', 'cli.js'))).toBe(true);
    expect(isInside(root, path.join(root, '...'))).toBe(true);
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, path.join(root, '..'))).toBe(false);
    expect(isInside(root, path.join(root, '..', 'sibling', 'cli.js'))).toBe(false);
    expect(
      packageBinNames({ bin: { x: '..x/cli.js', y: '../y.js' } }, 'pkg', PACKAGE, noFiles),
    ).toEqual(['x']);
  });

  it('follows no symbolic link out of the package: directories.bin and bin files are judged on real paths', () => {
    const root = temporaryDirectory();
    const packageDirectory = path.join(root, 'pkg');
    const outside = path.join(root, 'outside');
    mkdirSync(path.join(packageDirectory, 'real-bin'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'evil'), '');
    writeFileSync(path.join(packageDirectory, 'real-bin', 'tool'), '');
    // 'junction' makes a directory link without privileges on Windows; POSIX ignores the type.
    symlinkSync(outside, path.join(packageDirectory, 'escape'), 'junction');
    symlinkSync(
      path.join(packageDirectory, 'real-bin'),
      path.join(packageDirectory, 'inner'),
      'junction',
    );
    const names = (manifest: Record<string, unknown>) =>
      packageBinNames(manifest, 'pkg', packageDirectory);
    expect(names({ directories: { bin: 'escape' } })).toEqual([]);
    expect(names({ bin: { evil: 'escape/evil' } })).toEqual([]);
    // A link that stays inside the package is fine.
    expect(names({ directories: { bin: 'inner' } })).toEqual(['tool']);
    expect(names({ directories: { bin: 'real-bin' } })).toEqual(['tool']);
  });

  it('lists a bin directory as pnpm does: files at any depth, no dot-entries', () => {
    const root = temporaryDirectory();
    mkdirSync(path.join(root, 'nested', '.hidden'), { recursive: true });
    writeFileSync(path.join(root, 'a'), '');
    writeFileSync(path.join(root, '.dot'), '');
    writeFileSync(path.join(root, 'nested', 'b'), '');
    writeFileSync(path.join(root, 'nested', '.hidden', 'c'), '');
    expect(listBinDirectory(root).sort()).toEqual(['a', path.join('nested', 'b')]);
    expect(listBinDirectory(path.join(root, 'absent'))).toEqual([]);
  });

  it("resolves a package spec or an installed bin to pnpm's script, else a command on PATH", () => {
    const nodeModules = install(
      {
        '@scope/server': { name: '@scope/server', bin: { server: 'dist/index.js' } },
        typescript: { name: 'typescript', bin: { tsc: 'bin/tsc' } },
      },
      { server: '#!/bin/sh\n', tsc: '#!/bin/sh\n' },
    );
    const bin = (name: string) => path.join(nodeModules, '.bin', name);
    expect(resolveBin({ nodeModules, package: '@scope/server@1.0.0' })).toEqual({
      script: bin('server'),
    });
    expect(resolveBin({ nodeModules, command: 'tsc' })).toEqual({ script: bin('tsc') });
    expect(resolveBin({ nodeModules, command: 'node' })).toEqual({ command: 'node' });
  });

  it.each([
    ['alias@npm:@scope/real@1', 'alias', { name: '@scope/real', bin: 'cli.js' }, 'real'],
    ['github:org/repo', 'repo-package', { name: 'repo-package', bin: { repo: 'r.js' } }, 'repo'],
    ['./dir', 'dir-package', { name: 'dir-package', bin: 'cli.js' }, 'dir-package'],
    ['https://host/t-1.0.0.tgz', 't', { name: 't', directories: { bin: 'bin' } }, 'tool'],
  ])(
    'resolves the non-registry spec %s through the name pnpm installed it under',
    (spec, key, manifest, binName) => {
      const nodeModules = install(
        { [key]: manifest },
        { [binName]: '#!/bin/sh\n' },
        { [path.join(key, 'bin', 'tool')]: '' },
      );
      expect(resolveBin({ nodeModules, package: spec })).toEqual({
        script: path.join(nodeModules, '.bin', binName),
      });
    },
  );

  it('runs a --command that contains a slash as a path, never as a bin', () => {
    const nodeModules = install(
      { tool: { name: 'tool', bin: { x: 'x.js' } } },
      { x: '#!/bin/sh\n' },
    );
    expect(resolveBin({ nodeModules, command: 'x' })).toEqual({
      script: path.join(nodeModules, '.bin', 'x'),
    });
    for (const command of ['./x', '../.bin/x', 'a/../../x', 'bin/x', '/usr/bin/env']) {
      expect(resolveBin({ nodeModules, command })).toEqual({ command });
    }
    // `.` and `..` would be joined onto `.bin` itself or its parent.
    for (const command of ['.', '..']) {
      expect(() => resolveBin({ nodeModules, command })).toThrow(
        new RegExp(`npx: \\${command} is a directory, not a command to run`, 'u'),
      );
    }
  });

  it('refuses a package it cannot resolve, naming why', () => {
    const nodeModules = install({ present: { name: 'present', bin: 'cli.js' } });
    // Installed, but pnpm linked no bin.
    expect(() => resolveBin({ nodeModules, package: 'present' })).toThrow(/did not link/u);
    rmSync(path.join(nodeModules, 'present'), { recursive: true });
    expect(() => resolveBin({ nodeModules, package: 'present@1' })).toThrow(
      /present@1 did not install a package named present/u,
    );
    rmSync(path.join(path.dirname(nodeModules), 'package.json'));
    expect(() => resolveBin({ nodeModules, package: 'present' })).toThrow(
      /left no project manifest for present/u,
    );
  });

  it('reads a bin script with the shell instead of executing it', () => {
    expect(binProcess({ script: '/tmp/x/node_modules/.bin/server' }, ['--root', '/w'])).toEqual([
      '/bin/sh',
      ['/tmp/x/node_modules/.bin/server', '--root', '/w'],
    ]);
    expect(binProcess({ command: 'node' }, ['-v'])).toEqual(['node', ['-v']]);
  });

  it('finds the dlx node_modules from the first PATH entry, and only there', () => {
    const bin = path.join('/tmp', 'pnpm', 'dlx', 'x', 'node_modules', '.bin');
    expect(dlxNodeModules([bin, '/usr/bin'].join(path.delimiter))).toBe(path.dirname(bin));
    expect(() => dlxNodeModules(['/usr/bin', bin].join(path.delimiter))).toThrow(NpxBinError);
    expect(() => dlxNodeModules(undefined)).toThrow(/not started by pnpm dlx/u);
  });

  // /bin/sh is the image's shell; the Windows development host has none at that path.
  it.skipIf(process.platform === 'win32')(
    'runs a non-executable bin script, passing its arguments, stdio and exit status',
    () => {
      const nodeModules = install(
        { 'echo-server': { name: 'echo-server', bin: { 'echo-server': 'cli.js' } } },
        { 'echo-server': '#!/bin/sh\nprintf "%s|" "$@"\nexit 5\n' },
      );
      const result = spawnSync(
        process.execPath,
        [RUN_BIN, '--package', 'echo-server@1.0.0', '--', '--root', '/workspace'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: [path.join(nodeModules, '.bin'), process.env['PATH']].join(path.delimiter),
          },
        },
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(5);
      expect(result.stdout).toBe('--root|/workspace|');
    },
  );

  it('refuses a malformed invocation with exit status 2', () => {
    const result = spawnSync(process.execPath, [RUN_BIN, '--package', 'x'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage: npx-run-bin/u);
  });
});
