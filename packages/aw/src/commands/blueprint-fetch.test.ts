import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { CommandRefusedError } from '../io.js';
import {
  fetchBlueprint,
  npmEnvironment,
  sha512Integrity,
  unpackBlueprint,
  type NpmRunner,
} from './blueprint-fetch.js';

const TARBALL = gzipSync(Buffer.from('not read in these tests'));

interface Call {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** An `npm` that writes `bytes` as the tarball and reports `integrity` for it. */
function npm(
  calls: Call[],
  bytes: Uint8Array,
  integrity: string,
  name = '@acme/helpdesk-blueprint',
): NpmRunner {
  return async (args, options) => {
    calls.push({ args, cwd: options.cwd, env: options.env });
    const destination = args[args.indexOf('--pack-destination') + 1] ?? '';
    const filename = 'acme-helpdesk-blueprint-1.2.0.tgz';
    await writeFile(path.join(destination, filename), bytes);
    return {
      code: 0,
      stdout: JSON.stringify([{ name, version: '1.2.0', filename, integrity, files: [] }]),
      stderr: '',
    };
  };
}

const options = (env: Record<string, string | undefined> = {}) => ({
  cwd: '/project',
  env,
  signal: new AbortController().signal,
});

describe('fetchBlueprint', () => {
  it('runs npm pack with --ignore-scripts and an allowlisted environment', async () => {
    const calls: Call[] = [];
    const fetched = await fetchBlueprint(
      '@acme/helpdesk-blueprint@1.2.0',
      options({
        PATH: '/usr/bin',
        HOME: '/home/dev',
        AGENT_WORKSPACE_API_KEY: 'not-for-npm-either',
        ANTHROPIC_API_KEY: 'not-for-npm',
        NODE_OPTIONS: '--require /tmp/evil.js',
        npm_config_registry: 'https://registry.example.com/',
        NPM_TOKEN: 'registry-token',
      }),
      npm(calls, TARBALL, sha512Integrity(TARBALL)),
    );
    expect(fetched).toMatchObject({ package: '@acme/helpdesk-blueprint', version: '1.2.0' });
    const [call] = calls;
    expect(call?.args.slice(0, 4)).toEqual([
      'pack',
      '@acme/helpdesk-blueprint@1.2.0',
      '--json',
      '--ignore-scripts',
    ]);
    expect(call?.args[4]).toBe('--pack-destination');
    expect(call?.cwd).toBe('/project');
    expect(call?.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      npm_config_registry: 'https://registry.example.com/',
      NPM_TOKEN: 'registry-token',
    });
  });

  it('refuses a tarball that does not match its integrity, and removes the pack directory', async () => {
    const calls: Call[] = [];
    const other = sha512Integrity(Buffer.from('another tarball'));
    await expect(
      fetchBlueprint('@acme/helpdesk-blueprint', options(), npm(calls, TARBALL, other)),
    ).rejects.toThrow(/does not match the integrity npm reported; nothing was read from it/u);
    const destination = calls[0]?.args[5] ?? '';
    await expect(readdir(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a spec that npm would read as a flag, and a failed or missing npm', async () => {
    const never: NpmRunner = () => Promise.reject(new Error('not run'));
    await expect(fetchBlueprint('--registry=evil', options(), never)).rejects.toThrow(
      /is not an npm package spec/u,
    );
    const failed: NpmRunner = () =>
      Promise.resolve({ code: 1, stdout: '', stderr: 'npm error 404 Not Found' });
    await expect(fetchBlueprint('@acme/missing', options(), failed)).rejects.toThrow(
      /npm pack @acme\/missing failed: npm error 404 Not Found/u,
    );
    const missing: NpmRunner = () =>
      Promise.reject(Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }));
    await expect(fetchBlueprint('@acme/x', options(), missing)).rejects.toBeInstanceOf(
      CommandRefusedError,
    );
  });

  it('refuses output that names no single tarball', async () => {
    const odd: NpmRunner = () => Promise.resolve({ code: 0, stdout: '[]', stderr: '' });
    await expect(fetchBlueprint('@acme/x', options(), odd)).rejects.toThrow(
      /did not name exactly one tarball/u,
    );
  });
});

describe('npmEnvironment', () => {
  it('keeps what npm needs and drops every other variable', () => {
    expect(
      npmEnvironment({ Path: 'C:/bin', NPM_CONFIG_CACHE: '/c', NODE_OPTIONS: 'x', SECRET: 'y' }),
    ).toEqual({ Path: 'C:/bin', NPM_CONFIG_CACHE: '/c' });
  });
});

describe('unpackBlueprint', () => {
  it('refuses bytes that are not gzip', () => {
    expect(() =>
      unpackBlueprint({
        package: '@acme/x',
        version: '1.0.0',
        integrity: 'sha512-AA==',
        tarball: Buffer.from('plain'),
      }),
    ).toThrow(/is not a gzipped tarball/u);
  });
});
