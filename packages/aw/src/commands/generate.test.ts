import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { AW_VERSION } from '../version.js';

import {
  aw,
  changed,
  generatedApp,
  project,
  removeProjectsAfterEach,
  RESOURCE,
  tree,
} from './generate.test-support.js';

removeProjectsAfterEach();

describe('aw generate app', () => {
  it('generate app, resource and agent write exactly the listed paths', async () => {
    const root = await project();
    const empty = await tree(root);

    const app = await aw(root, ['generate', 'app', 'service-desk']);
    const afterApp = await tree(root);
    const resource = await aw(root, [...RESOURCE, '--board', 'status']);
    const afterResource = await tree(root);
    const agent = await aw(root, ['generate', 'agent', 'triage', '--tools', 'ticket']);
    const afterAgent = await tree(root);

    expect([app.code, resource.code, agent.code]).toEqual([0, 0, 0]);
    expect(changed(empty, afterApp)).toEqual([
      '.dockerignore',
      '.github/workflows/app-ci.yml',
      'Dockerfile',
      'README.md',
      'app.config.ts',
      'app/api/health/route.ts',
      'app/api/mcp/route.ts',
      'app/layout.tsx',
      'app/page.tsx',
      'aw-generated.json',
      'db/migrations/0000_app_kit.sql',
      'db/migrations/0001_app_kit_recipes.sql',
      'db/migrations/0002_app_kit_channels.sql',
      'db/migrations/meta/_journal.json',
      'dependency-cruiser.config.mjs',
      'instrumentation.ts',
      'next.config.ts',
      'package.json',
      'tsconfig.json',
    ]);
    expect(changed(afterApp, afterResource)).toEqual([
      'app.config.ts',
      'app/api/tickets/[id]/route.ts',
      'app/api/tickets/route.ts',
      'app/tickets/[id]/edit/page.tsx',
      'app/tickets/[id]/page.tsx',
      'app/tickets/new/page.tsx',
      'app/tickets/page.tsx',
      'aw-generated.json',
      'db/migrations/0003_create_tickets.sql',
      'db/migrations/meta/_journal.json',
      'resources/ticket.ts',
      'tests/ticket.test.ts',
    ]);
    expect(changed(afterResource, afterAgent)).toEqual(['agents/triage.ts', 'aw-generated.json']);
    expect(app.stderr).toContain('next: npm install');
  });

  it('writes the same files on every run', async () => {
    const first = await generatedApp();
    const second = await generatedApp();
    await aw(first, RESOURCE);
    await aw(second, RESOURCE);

    expect(await tree(second)).toEqual(await tree(first));
  });
});

describe('aw generate app package.json', () => {
  it('pins the app kit and its peers in package.json', async () => {
    const root = await generatedApp();
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(manifest.dependencies).toMatchObject({
      '@indx-workspace/app': AW_VERSION,
      next: '16.4.6',
      react: '19.3.1',
    });
    expect(Object.keys(manifest.devDependencies)).toEqual(['dependency-cruiser']);
  });

  it('adds the build and image scripts to package.json and records them', async () => {
    const root = await generatedApp();
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const generated = JSON.parse(await readFile(path.join(root, 'aw-generated.json'), 'utf8')) as {
      entries: Record<string, { edits: { path: string; added: string }[] }>;
    };

    expect(manifest.scripts).toEqual({
      build: 'next build',
      image: 'docker build -t service-desk .',
    });
    expect(generated.entries['app:service-desk']?.edits).toContainEqual({
      path: 'package.json',
      added: '{"scripts":{"build":"next build"}}',
    });
    expect(generated.entries['app:service-desk']?.edits).toContainEqual({
      path: 'package.json',
      added: '{"scripts":{"image":"docker build -t service-desk ."}}',
    });
  });

  it('keeps an image script the project already has, and destroy leaves it', async () => {
    const root = await project();
    const own = '{\n  "name": "desk",\n  "scripts": {\n    "image": "make image"\n  }\n}\n';
    await writeFile(path.join(root, 'package.json'), own);

    const run = await aw(root, ['generate', 'app', 'service-desk']);
    const written = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const generated = await readFile(path.join(root, 'aw-generated.json'), 'utf8');
    const destroy = await aw(root, ['destroy', 'app', 'service-desk', '--yes']);

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toContain('kept the existing package.json script image');
    expect(written.scripts).toEqual({ image: 'make image', build: 'next build' });
    expect(generated).not.toContain('docker build');
    expect(destroy.code).toBe(EXIT_CODE.ok);
    expect(await readFile(path.join(root, 'package.json'), 'utf8')).toBe(own);
  });
});

describe('aw generate app preconditions', () => {
  it('refuses a package.json that pins a package at another version', async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'package.json'),
      '{\n  "name": "desk",\n  "dependencies": {\n    "next": "15.0.0"\n  }\n}\n',
    );
    const before = await tree(root);

    const run = await aw(root, ['generate', 'app', 'service-desk']);

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('pins next at another version');
    expect(await tree(root)).toEqual(before);
  });

  it('keeps an existing README.md and records nothing for it', async () => {
    const root = await project();
    await writeFile(path.join(root, 'README.md'), '# Desk\n');

    const run = await aw(root, ['generate', 'app', 'service-desk']);

    expect(run.stdout).toContain('kept the existing README.md');
    expect(await readFile(path.join(root, 'README.md'), 'utf8')).toBe('# Desk\n');
    expect(await readFile(path.join(root, 'aw-generated.json'), 'utf8')).not.toContain('README');
  });

  it('refuses when the app kit is not installed', async () => {
    const root = await generatedApp();
    await rm(path.join(root, 'node_modules'), { recursive: true });

    const run = await aw(root, RESOURCE);

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('app_kit_not_installed');
    expect(run.stderr).toContain('fix: npm install');
  });
});
