/**
 * Every `@earendil-works` package pi pulls in is pinned exactly in this manifest.
 *
 * pi declares its siblings with caret ranges, so an unpinned sibling floats to the newest release
 * on a fresh npm install (pi-codemode 1.2.0 dropped an export pi 1.0.2 imports and `aw dev`
 * crashed). The build stages these pins into the published manifest.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));

interface Manifest {
  readonly version: string;
  readonly dependencies?: Record<string, string>;
}

function readManifest(file: string): Manifest {
  return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
}

function installedManifest(name: string, from: string): string {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const file = path.join(directory, 'node_modules', name, 'package.json');
    if (existsSync(file)) return realpathSync(file);
    if (directory === path.dirname(directory)) throw new Error(`${name} is not installed`);
  }
}

describe('the pi family', () => {
  it('is pinned in this manifest at the version installed, for every package pi pulls in', () => {
    const family = new Map<string, Manifest>();
    const walk = (name: string, from: string): void => {
      if (family.has(name)) return;
      const file = installedManifest(name, from);
      const manifest = readManifest(file);
      family.set(name, manifest);
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        if (dependency.startsWith('@earendil-works/')) walk(dependency, path.dirname(file));
      }
    };
    walk('@earendil-works/pi-coding-agent', packageDirectory);

    const ours = readManifest(path.join(packageDirectory, 'package.json')).dependencies ?? {};
    for (const [name, manifest] of family) {
      expect(ours[name], name).toBe(manifest.version);
    }
  });
});
