import { describe, expect, it } from 'vitest';

import { renderAppSpec, renderGeneratorTemplate } from './generate.js';
import { appScripts, scriptEdit } from './templates.js';
import {
  agent,
  app,
  contentsOf,
  digests,
  pages,
  resource,
  resourcePages,
} from './templates.test-support.js';

describe('the generator templates: snapshots', () => {
  it('app: the files and their digests', async () => {
    expect(await digests(app)).toMatchSnapshot();
  });

  it('resource: the files and their digests', async () => {
    expect(await digests(resource)).toMatchSnapshot();
  });

  it('resource-pages: the files and their digests', async () => {
    expect(await digests(resourcePages)).toMatchSnapshot();
  });

  it('page/*: the files and their digests', async () => {
    expect({
      dashboard: await digests(pages.dashboard),
      list: await digests(pages.list),
      custom: await digests(pages.custom),
    }).toMatchSnapshot();
  });

  it('agent: the files and their digests', async () => {
    expect(await digests(agent)).toMatchSnapshot();
  });

  it('renders the same bytes every time', async () => {
    const again = renderGeneratorTemplate('app', renderAppSpec('service-desk', ['ticket']));

    expect(await digests(again)).toEqual(await digests(app));
  });
});

describe('the generator templates: the app image', () => {
  it('builds the app as an image that migrates on start and answers /api/health', () => {
    const dockerfile = contentsOf(app, 'Dockerfile') ?? '';
    const from = dockerfile.split('\n').filter((line) => line.startsWith('FROM '));

    expect(from).toHaveLength(2);
    for (const line of from) {
      expect(line).toMatch(/^FROM node:24[.0-9]*-bookworm-slim@sha256:[0-9a-f]{64}( AS build)?$/u);
    }
    expect(dockerfile).toContain('RUN npm ci\n');
    expect(dockerfile).toContain('RUN npm run build');
    for (const copied of ['.next/standalone', '.next/static', 'public', 'db/migrations']) {
      expect(dockerfile).toContain(`COPY --from=build --chown=node:node /app/${copied} `);
    }
    expect(dockerfile).toContain('USER node\nEXPOSE 3000\nCMD ["node", "server.js"]\n');
    expect(contentsOf(app, '.dockerignore')?.split('\n')).toEqual(
      expect.arrayContaining(['node_modules', '.next', '.aw', '.env*']),
    );
    expect(contentsOf(app, 'next.config.ts')).toContain("output: 'standalone'");

    const instrumentation = contentsOf(app, 'instrumentation.ts') ?? '';
    expect(instrumentation).toContain(
      "if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.AW_APP_MIGRATE_ON_START === '1') {",
    );
    expect(instrumentation).toContain("await import('@indx-workspace/app/db')");
    expect(instrumentation).toContain("migrationsFolder: 'db/migrations'");
    // A failed migration is not caught: it fails register(), so the container exits.
    expect(instrumentation).not.toContain('catch');

    const health = contentsOf(app, 'app/api/health/route.ts') ?? '';
    expect(health).toContain("new Response('ok', { headers: { 'cache-control': 'no-store' } })");
    expect(health).not.toContain('appRuntime');
    expect(health).not.toMatch(/^import /mu);
  });

  it('adds the build script the Dockerfile runs, and names the image script after the app', () => {
    expect(appScripts('service-desk')).toEqual([
      { name: 'build', command: 'next build' },
      { name: 'image', command: 'docker build -t service-desk .' },
    ]);
    expect(contentsOf(app, 'Dockerfile')).toContain('RUN npm run build');
    expect(scriptEdit({ name: 'image', command: 'docker build -t desk .' })).toEqual({
      path: 'package.json',
      added: '{"scripts":{"image":"docker build -t desk ."}}',
    });
  });
});

describe('the generator templates: routes, schema and config', () => {
  it('writes the two route files as the app kit documents them', () => {
    expect(contentsOf(resource, 'app/api/tickets/route.ts')).toBe(
      [
        "import ticket from '@/resources/ticket';",
        "import { resourceRoutes } from '@indx-workspace/app/server';",
        'export const { GET, POST } = resourceRoutes(ticket);',
        '',
      ].join('\n'),
    );
    expect(contentsOf(resource, 'app/api/tickets/[id]/route.ts')).toBe(
      [
        "import ticket from '@/resources/ticket';",
        "import { resourceItemRoutes } from '@indx-workspace/app/server';",
        'export const { GET, PATCH, DELETE } = resourceItemRoutes(ticket);',
        '',
      ].join('\n'),
    );
    expect(contentsOf(app, 'app/api/mcp/route.ts')).toContain(
      'export const { POST, GET, DELETE } = mcpEndpoint(app);',
    );
  });

  it('writes the resource file from the parsed fields', () => {
    expect(contentsOf(resource, 'resources/ticket.ts')).toMatchSnapshot();
    expect(contentsOf(resource, 'tests/ticket.test.ts')).toMatchSnapshot();
  });

  it("writes the app's schema into its first migration and the resource into app.config.ts", () => {
    expect(contentsOf(app, 'db/migrations/0000_app_kit.sql')).toContain(
      'CREATE TABLE IF NOT EXISTS "app_service_desk"."app_audit_events"',
    );
    expect(contentsOf(app, 'app.config.ts')).toBe(
      [
        "import { defineApp } from '@indx-workspace/app';",
        "import ticket from './resources/ticket.ts';",
        '',
        'export default defineApp({',
        "  name: 'service-desk',",
        '  resources: [',
        '    ticket,',
        '  ],',
        '  recipes: [',
        '  ],',
        '});',
        '',
      ].join('\n'),
    );
  });
});
