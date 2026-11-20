// The live Cloud Run preview (issue #2112). Run 42441982795 failed twice over:
// - the app-minimal image was built with examples/minimal as its context, whose Dockerfile copies a
//   package-lock.json the example does not ship (`"/package-lock.json": not found`);
// - "Destroy the stack" then ran `aw deploy destroy` with no project file (see the destroy tests).
// Every file an image's Dockerfile copies must be in the context the workflow builds it from.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  CHECKOUT_VERSION,
  LOCKFILE,
  copyExample,
  lockArguments,
  parseArguments,
} from '../apps/app-image.mjs';
import { ROOT, step } from './workflow-cloud-run-preview.test-support.js';

/**
 * The sources of a Dockerfile's `COPY` instructions that read the build context (not another
 * stage), with build arguments left out: they are resolved only at build time.
 */
function copySources(dockerfile: string): string[] {
  const instructions = dockerfile.replace(/\\\n/gu, ' ').split('\n');
  return instructions.flatMap((line) => {
    const words = line.trim().split(/\s+/u);
    if (words[0]?.toUpperCase() !== 'COPY') return [];
    const operands = words.slice(1).filter((word) => !word.startsWith('--'));
    if (words.some((word) => word.startsWith('--from='))) return [];
    return operands.slice(0, -1).filter((source) => !source.includes('$'));
  });
}

function trackedFiles(directory: string): Set<string> {
  const listed = execFileSync('git', ['ls-files', '-z', '--', directory], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return new Set(listed.split('\0').filter(Boolean));
}

/** The sources `dockerfile` copies that `holds` says its context lacks. */
function missing(dockerfile: string, holds: (source: string) => boolean): string[] {
  return copySources(dockerfile).filter((source) => source !== '.' && !holds(source));
}

const EXAMPLES = path.join(ROOT, 'examples');
const work = mkdtempSync(path.join(tmpdir(), 'preview-images-'));
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** The `name:Dockerfile:target:context` build specs the workflow's build step lists. */
const SPEC = /([a-z-]+):([A-Za-z./-]*Dockerfile):([a-z-]*):([^\s;]+)/gu;

/** What the Dockerfile of each build spec copies that its build context does not hold. */
function missingFromBuildContexts(build: string): string[] {
  return [...build.matchAll(SPEC)].flatMap(([, name, file, , context]) => {
    if (name === undefined || file === undefined || context === undefined) return [];
    const tracked = trackedFiles(context);
    const holds = (source: string) => {
      const relative = path.posix.join(context, source.replace(/\/$/u, ''));
      return (
        tracked.has(relative) || [...tracked].some((entry) => entry.startsWith(`${relative}/`))
      );
    };
    return missing(readFileSync(path.join(ROOT, file), 'utf8'), holds).map(
      (source) => `${name}: ${file} copies ${source}, which ${context} does not hold`,
    );
  });
}

/** The names of the example directories that hold `file`. */
function examplesWith(file: string): string[] {
  return readdirSync(EXAMPLES).filter((id) => existsSync(path.join(EXAMPLES, id, file)));
}

/** The `@indx-workspace/*` dependencies of a copied example not pinned to the checkout version. */
function stalePins(id: string, copy: string): string[] {
  const manifest = JSON.parse(readFileSync(path.join(copy, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter(([name, spec]) => name.startsWith('@indx-workspace/') && spec !== CHECKOUT_VERSION)
    .map(([name, spec]) => `${id}: ${name}@${spec}`);
}

/** What each example's Dockerfile copies that its context lacks once the lock step has run. */
function missingFromExampleContexts(examples: string[]): string[] {
  return examples.flatMap((id) => {
    const context = path.join(work, id);
    copyExample(id, context);
    const dockerfile = readFileSync(path.join(context, 'Dockerfile'), 'utf8');
    // The lock step writes LOCKFILE; everything else must have been copied.
    const holds = (source: string) => source === LOCKFILE || existsSync(path.join(context, source));
    return missing(dockerfile, holds).map((source) => `${id}: the context lacks ${source}`);
  });
}

describe('the images the live preview builds', () => {
  const build = step('Build the six images from the ref');

  it('finds every file each Dockerfile copies in the context it is built from', () => {
    expect(missingFromBuildContexts(build)).toEqual([]);
    const names = [...build.matchAll(SPEC)].map((spec) => spec[1]);
    expect(names).toEqual(['web', 'gateway', 'runner', 'runtime', 'tool-host']);
  });

  it('builds the app through app-image.mjs, never from examples/minimal as it is', () => {
    expect(build).not.toMatch(/app-minimal:examples\/minimal/u);
    expect(build).toMatch(
      /node tests\/apps\/app-image\.mjs --app minimal --work "\$RUNNER_TEMP\/app-image" -- \\\n\s+--platform linux\/amd64 --tag "\$staging\/app-minimal:\$tag" --push --metadata-file "\$RUNNER_TEMP\/meta\/app-minimal\.json"/u,
    );
    // The packages it packs are built first, and its digest is read like the others'.
    expect(build.indexOf('scripts/ci/nx.sh run-many -t build')).toBeLessThan(
      build.indexOf('node tests/apps/app-image.mjs'),
    );
    expect(build).toContain('pids[app-minimal]=$!');
    expect(build).toMatch(/for name in web gateway runner runtime tool-host app-minimal; do/u);
    expect(parseArguments(['--app', 'minimal', '--work', 'w', '--', '--push', '.'])).toEqual({
      app: 'minimal',
      work: path.resolve('w'),
      build: ['--push', '.'],
    });
  });
});

describe('the example images the live preview builds', () => {
  it("pins every copied example to the checkout's packed version, whatever it was written at", () => {
    const pins = mkdtempSync(path.join(tmpdir(), 'app-image-pins-'));
    try {
      const examples = examplesWith('package.json');
      const stale = examples.flatMap((id) => {
        const copy = path.join(pins, id);
        copyExample(id, copy);
        return stalePins(id, copy);
      });
      expect(examples.length).toBeGreaterThan(0);
      expect(stale).toEqual([]);
    } finally {
      rmSync(pins, { recursive: true, force: true });
    }
  });

  it('gives every example Dockerfile a context that holds what it copies once locked', () => {
    expect(lockArguments('http://127.0.0.1:1')).toContain('--package-lock-only');
    const examples = examplesWith('Dockerfile');
    expect(examples).toContain('minimal');
    expect(missingFromExampleContexts(examples)).toEqual([]);
    // Without the lock step the context is what failed live.
    const minimal = readFileSync(path.join(ROOT, 'examples/minimal/Dockerfile'), 'utf8');
    expect(copySources(minimal)).toContain(LOCKFILE);
    expect(existsSync(path.join(work, 'minimal', LOCKFILE))).toBe(false);
  });
});
