import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BUNDLE_ENTRY_REFUSAL, isBundleEntry, selectLaunchMode, signalOwner } from './launch.js';
import { LAUNCHER_SIGNALS } from './launcher-signals.js';
import {
  BIN_ARGUMENT_REFUSAL,
  type BinProcess,
  isMainModule,
  resolveMainModulePath,
  runBin,
} from './main-module.js';

let directory = '';
let bundle = '';
let linked = '';

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'embedded-argv-'));
  mkdirSync(path.join(directory, 'package', 'dist'), { recursive: true });
  bundle = path.join(directory, 'package', 'dist', 'launch.js');
  writeFileSync(bundle, '');
  // A directory link, as a package manager's node_modules entry is; a junction needs no privilege
  // on Windows and is a plain symlink elsewhere.
  symlinkSync(path.join(directory, 'package'), path.join(directory, 'linked'), 'junction');
  linked = path.join(directory, 'linked', 'dist', 'launch.js');
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe.each([
  ['isBundleEntry', isBundleEntry],
  ['isMainModule', isMainModule],
])('%s (the argv guard)', (_name, guard) => {
  it('is true when argv[1] is the module itself', () => {
    expect(guard(bundle, pathToFileURL(bundle).href)).toBe(true);
  });

  it('is true when argv[1] reaches the module through a link', () => {
    expect(guard(linked, pathToFileURL(bundle).href)).toBe(true);
  });

  it('is false when argv[1] is unset or empty', () => {
    expect(guard(undefined, pathToFileURL(bundle).href)).toBe(false);
    expect(guard('', pathToFileURL(bundle).href)).toBe(false);
  });

  it('is false when argv[1] is another file, or a path that does not exist', () => {
    const other = path.join(directory, 'package', 'dist', 'bin.js');
    writeFileSync(other, '');
    expect(guard(other, pathToFileURL(bundle).href)).toBe(false);
    expect(guard(path.join(directory, 'missing.js'), pathToFileURL(bundle).href)).toBe(false);
  });
});

describe('the bundle refusal', () => {
  it('names the entry to run instead', () => {
    expect(BUNDLE_ENTRY_REFUSAL).toBe('run dist/bin.js, not the bundle');
  });

  it('does not fire when this module is imported rather than run', () => {
    expect(isBundleEntry(process.argv[1], import.meta.url)).toBe(false);
  });
});

describe('selectLaunchMode', () => {
  it('chooses the IPC launcher only when process.send is a function', () => {
    const send: unknown = () => true;
    expect(selectLaunchMode(typeof send)).toBe('ipc');
    expect(selectLaunchMode(typeof undefined)).toBe('environment');
    expect(selectLaunchMode(typeof 'send')).toBe('environment');
  });
});

describe('the argv guard with an extensionless argv[1]', () => {
  it('matches the module Node loads for `node dist/launch` (argv[1] keeps the typed path)', () => {
    const typed = bundle.slice(0, -'.js'.length);
    expect(isBundleEntry(typed, pathToFileURL(bundle).href)).toBe(true);
    expect(isMainModule(typed, pathToFileURL(bundle).href)).toBe(true);
    expect(isMainModule(linked.slice(0, -'.js'.length), pathToFileURL(bundle).href)).toBe(true);
  });
});

describe("resolveMainModulePath (Node's main-module resolution order)", () => {
  it('prefers the exact file, then an added extension, over a directory of the same name', () => {
    const root = path.join(directory, 'order');
    mkdirSync(path.join(root, 'entry'), { recursive: true });
    writeFileSync(path.join(root, 'entry', 'index.js'), '');
    writeFileSync(path.join(root, 'entry.js'), '');
    expect(resolveMainModulePath(path.join(root, 'entry'))).toBe(path.join(root, 'entry.js'));
    expect(resolveMainModulePath(path.join(root, 'entry.js'))).toBe(path.join(root, 'entry.js'));
  });

  it("follows a directory's package.json main, and falls back to its index", () => {
    const withMain = path.join(directory, 'with-main');
    mkdirSync(path.join(withMain, 'lib'), { recursive: true });
    writeFileSync(path.join(withMain, 'package.json'), JSON.stringify({ main: 'lib/start' }));
    writeFileSync(path.join(withMain, 'lib', 'start.js'), '');
    writeFileSync(path.join(withMain, 'index.js'), '');
    expect(resolveMainModulePath(withMain)).toBe(path.join(withMain, 'lib', 'start.js'));

    const withoutMain = path.join(directory, 'without-main');
    mkdirSync(withoutMain, { recursive: true });
    writeFileSync(path.join(withoutMain, 'index.js'), '');
    expect(resolveMainModulePath(withoutMain)).toBe(path.join(withoutMain, 'index.js'));
  });

  it('resolves nothing for a path Node could not load', () => {
    expect(resolveMainModulePath(path.join(directory, 'nothing-here'))).toBeUndefined();
  });
});

describe('runBin', () => {
  function fakeProcess(args: readonly string[], code: number) {
    const calls = { errors: [] as string[], exits: [] as number[], starts: 0 };
    const binProcess: BinProcess = {
      args,
      writeError: (chunk) => {
        calls.errors.push(chunk);
      },
      exit: (exitCode) => {
        calls.exits.push(exitCode);
      },
      start: () => {
        calls.starts += 1;
        return Promise.resolve(code);
      },
    };
    return { binProcess, calls };
  }

  it('refuses any argument without starting the runtime', async () => {
    const { binProcess, calls } = fakeProcess(['--help'], 0);
    await runBin(binProcess);
    expect(calls).toStrictEqual({ errors: [`${BIN_ARGUMENT_REFUSAL}\n`], exits: [1], starts: 0 });
  });

  it('exits with the code of a failed start, which an exit hook would otherwise turn into 0', async () => {
    const { binProcess, calls } = fakeProcess([], 1);
    await runBin(binProcess);
    expect(calls).toStrictEqual({ errors: [], exits: [1], starts: 1 });
  });

  it('leaves a started runtime running', async () => {
    const { binProcess, calls } = fakeProcess([], 0);
    await runBin(binProcess);
    expect(calls).toStrictEqual({ errors: [], exits: [], starts: 1 });
  });
});

/**
 * Starting the workspace loads `embedded-postgres`, whose `async-exit-hook` adds its own SIGINT
 * and SIGTERM listeners that stop the database. Left in place, SIGINT stopped the database while
 * the launcher was still revoking the credential, and the revoked token stayed valid on the next
 * start (the integration test's 401 came back 200 on Linux CI).
 */
describe('signalOwner (the launcher owns SIGINT, SIGTERM, SIGHUP and SIGBREAK)', () => {
  it('leaves only the launcher listeners once claimed, and keeps other events', () => {
    const target = new EventEmitter();
    const calls: string[] = [];
    const owner = signalOwner(target);
    for (const signal of LAUNCHER_SIGNALS) {
      owner.on(signal, () => void calls.push(`launcher:${signal}`));
    }
    // What `async-exit-hook` adds when `embedded-postgres` is imported during the start.
    for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'SIGUSR2']) {
      target.on(event, () => void calls.push(`hook:${event}`));
    }

    owner.claim();
    for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'SIGUSR2']) target.emit(event);

    // S1-25 (#510): the hook's SIGHUP and SIGBREAK listeners go too. Since the postmaster is
    // detached, the launcher's ordered stop is what ends it on a closed terminal or console.
    expect(calls).toStrictEqual([
      'launcher:SIGINT',
      'launcher:SIGTERM',
      'launcher:SIGHUP',
      'launcher:SIGBREAK',
      'hook:SIGUSR2',
    ]);
    for (const signal of LAUNCHER_SIGNALS) expect(target.listenerCount(signal)).toBe(1);
  });

  it('delivers signals to the launcher before the claim too', () => {
    const target = new EventEmitter();
    const calls: string[] = [];
    signalOwner(target).on('SIGINT', () => void calls.push('launcher'));
    target.emit('SIGINT');
    expect(calls).toStrictEqual(['launcher']);
  });
});
