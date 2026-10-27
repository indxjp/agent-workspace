import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultProfile } from '../profile-defaults.js';
import {
  renderVercelPartSettings,
  renderVercelProject,
  VERCEL_FUNCTION_OUTPUT_DIRECTORY,
  VERCEL_FUNCTION_STATIC_FILE,
  VERCEL_PARTS,
  VERCEL_RETENTION_CRON_PATH,
  VERCEL_STORAGE_CLEANUP_CRON_PATH,
  VERCEL_TRIGGERS_CRON_PATH,
} from './vercel.js';

describe('the Vercel project settings', () => {
  it('declares the Next.js preset, a scoped install and build of its dependencies, a daily retention and schedule-trigger cron and a daily storage cleanup cron', () => {
    const artefact = renderVercelProject(defaultProfile({ cloud: 'vercel', projectName: 'a' }));
    expect(artefact?.directory).toBe('vercel');
    expect(artefact?.fileName).toBe('vercel.json');
    expect(JSON.parse(artefact?.contents ?? 'null')).toEqual({
      framework: 'nextjs',
      installCommand: 'pnpm install --frozen-lockfile --filter "{.}..."',
      buildCommand: 'pnpm --filter "{.}^..." run build && pnpm run build',
      crons: [
        { path: VERCEL_RETENTION_CRON_PATH, schedule: '0 3 * * *' },
        { path: VERCEL_TRIGGERS_CRON_PATH, schedule: '0 4 * * *' },
        { path: VERCEL_STORAGE_CLEANUP_CRON_PATH, schedule: '0 5 * * *' },
      ],
    });
    expect(VERCEL_RETENTION_CRON_PATH).toBe('/api/cron/retention');
    expect(VERCEL_TRIGGERS_CRON_PATH).toBe('/api/cron/triggers');
    expect(VERCEL_STORAGE_CLEANUP_CRON_PATH).toBe('/api/cron/storage-cleanup');
  });

  it.each(['aws', 'gcp', 'azure', 'local'] as const)('renders nothing for %s', (cloud) => {
    expect(renderVercelProject(defaultProfile({ cloud, projectName: 'a' }))).toBeNull();
    expect(renderVercelPartSettings(defaultProfile({ cloud, projectName: 'a' }))).toEqual([]);
  });
});

describe('the Vercel function parts', () => {
  it('are exactly the workspace packages with a function entry, so the two cannot drift', () => {
    const root = join(import.meta.dirname, '..', '..', '..', '..');
    const withEntry = ['apps', 'packages']
      .flatMap((parent) => readdirSync(join(root, parent)).map((name) => `${parent}/${name}`))
      .filter((directory) => existsSync(join(root, directory, 'src', 'api', 'index.ts')))
      .sort();
    expect(
      VERCEL_PARTS.flatMap(({ filter }) =>
        filter === null ? [] : [filter.replace(/^\.\//u, '')],
      ).sort(),
    ).toEqual(withEntry);
  });
});

describe('the Vercel part settings', () => {
  const parts = renderVercelPartSettings(defaultProfile({ cloud: 'vercel', projectName: 'a' }));
  const settings = (fileName: string): Record<string, unknown> =>
    JSON.parse(parts.find((part) => part.fileName === fileName)?.contents ?? 'null') as Record<
      string,
      unknown
    >;

  it('renders one file for the gateway, the manager and the frontend, beside vercel.json', () => {
    expect(parts.map((part) => `${part.directory}/${part.fileName}`)).toEqual([
      'vercel/gateway.json',
      'vercel/manager.json',
      'vercel/frontend.json',
    ]);
    expect(VERCEL_PARTS.map(({ suffix }) => suffix)).toEqual(['-gateway', '-manager', '-web']);
  });

  it('routes every path of a function part to its one function, installing and building only its closure', () => {
    for (const [fileName, filter] of [
      ['gateway.json', './packages/gateway'],
      ['manager.json', './apps/runner'],
    ] as const) {
      expect(settings(fileName)).toEqual({
        framework: null,
        installCommand: `pnpm install --frozen-lockfile --filter "{${filter}}..."`,
        buildCommand: `pnpm --filter "{${filter}}..." run build && mkdir -p public && printf 'User-agent: *\\nDisallow: /\\n' > public/robots.txt`,
        outputDirectory: 'public',
        rewrites: [{ source: '/(.*)', destination: '/api' }],
        functions: { 'api/index.js': { maxDuration: 300 } },
      });
    }
  });

  it('has a function part leave a non-empty output directory, which Vercel requires', () => {
    for (const fileName of ['gateway.json', 'manager.json']) {
      const { buildCommand, outputDirectory, rewrites } = settings(fileName);
      expect(outputDirectory).toBe(VERCEL_FUNCTION_OUTPUT_DIRECTORY);
      const robots = `${VERCEL_FUNCTION_OUTPUT_DIRECTORY}/${VERCEL_FUNCTION_STATIC_FILE}`;
      expect(buildCommand).toContain(`&& mkdir -p ${VERCEL_FUNCTION_OUTPUT_DIRECTORY} && printf `);
      expect(buildCommand).toMatch(new RegExp(`> ${robots}$`, 'u'));
      expect(buildCommand).toContain('Disallow: /');
      // a static file wins over a rewrite, so the only path it may shadow is /robots.txt
      expect(VERCEL_FUNCTION_STATIC_FILE).toBe('robots.txt');
      expect(rewrites).toEqual([{ source: '/(.*)', destination: '/api' }]);
    }
  });

  it('writes a robots.txt that disallows everything when the build command runs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vercel-output-'));
    try {
      const { buildCommand } = settings('gateway.json');
      const output = String(buildCommand).split(' && ').slice(1).join(' && ');
      execFileSync('sh', ['-c', output], { cwd: directory });
      expect(readFileSync(join(directory, 'public', 'robots.txt'), 'utf8')).toBe(
        'User-agent: *\nDisallow: /\n',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('builds the frontend as a Vite project, with Vercel its own install, build and output', () => {
    expect(settings('frontend.json')).toEqual({ framework: 'vite' });
  });
});
