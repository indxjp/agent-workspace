import { describe, expect, it } from 'vitest';

import {
  EXTRA_DIRECTORIES,
  PACK_DIRECTORIES,
  PUBLISHED_PACKAGES,
  checkTarballEntries,
  importedSpecifiers,
  tarballName,
} from '../../scripts/release/pack-packages.mjs';

import { MANIFESTS } from './pack-packages.test-support.js';

describe('the published package set (issue #246, ADR-0082)', () => {
  it('publishes contracts, platforms, the SDK, react, the app kit, aw, the CLI, embedded, then create, each after what it depends on', () => {
    expect(PUBLISHED_PACKAGES).toEqual([
      'contracts',
      'platforms',
      'sdk',
      'react',
      'app',
      'aw',
      'cli',
      'embedded',
      'create',
    ]);
    expect(EXTRA_DIRECTORIES).toEqual({ cli: ['templates/', 'schema/', 'modules/'] });
  });

  it('packs embedded from its generated staging directory and every other package in place', () => {
    expect(PACK_DIRECTORIES).toEqual({ embedded: 'packages/embedded/publish' });
  });

  it('names the tarball pnpm pack writes, so a re-run into the same directory replaces it', () => {
    expect(tarballName({ name: '@indx-workspace/sdk', version: '0.1.0' })).toBe(
      'indx-workspace-sdk-0.1.0.tgz',
    );
  });

  it('collects the package imports the developer site shows', () => {
    const documents = [
      'import { createClient } from \'@indx-workspace/sdk\';\nimport { x } from "@indx-workspace/contracts/runs";',
      "import { fixtures } from '@indx-workspace/sdk/testing'; // npm install @indx-workspace/aw",
      "await import('@indx-workspace/sdk/events'); import '@indx-workspace/contracts/agents';",
    ];
    expect(importedSpecifiers(documents)).toEqual([
      '@indx-workspace/contracts/agents',
      '@indx-workspace/contracts/runs',
      '@indx-workspace/sdk',
      '@indx-workspace/sdk/events',
      '@indx-workspace/sdk/testing',
    ]);
  });
});

describe('the files a published tarball may ship', () => {
  it("accepts the embedded runtime's dist/web, dist/migrations and launcher entries (S1-12)", () => {
    const entries = [
      ...MANIFESTS,
      'package/dist/bin.js',
      'package/dist/launch.js',
      'package/dist/migrations/0001_initial.sql',
      'package/dist/web/.next-embedded/server/app/page.js',
      'package/dist/web/.next-embedded/server/app/(workspace)/w/[workspaceSlug]/agents/[agentId]/runs/[runId]/page.js',
      'package/dist/web/.next-embedded/static/chunks/app/(workspace)/layout-0123456789abcdef.js',
    ];
    expect(checkTarballEntries(entries)).toEqual([]);
    expect(checkTarballEntries([...entries, 'package/dist/web/server.js.map'])).toEqual([
      'dist/web/server.js.map: source maps point at unshipped src/',
    ]);
  });

  it('accepts the CLI generator templates only where the package declares them', () => {
    const cli = [...MANIFESTS, 'package/dist/index.js', 'package/templates/compose.yaml'];
    expect(checkTarballEntries(cli, ['templates/'])).toEqual([]);
    expect(checkTarballEntries(cli)).toHaveLength(1);
  });

  it('accepts the profile JSON Schema the CLI ships for its $schema URL (#424, ADR-0091)', () => {
    const cli = [
      ...MANIFESTS,
      'package/dist/index.js',
      'package/schema/agent-workspace.schema.json',
    ];
    expect(checkTarballEntries(cli, EXTRA_DIRECTORIES['cli'])).toEqual([]);
    expect(checkTarballEntries(cli, ['templates/'])).toHaveLength(1);
  });

  it('accepts the gcp-cloudrun Terraform module the CLI ships under modules/ (#794)', () => {
    const cli = [
      ...MANIFESTS,
      'package/dist/index.js',
      'package/modules/gcp-cloudrun/main.tf',
      'package/modules/gcp-cloudrun/.terraform.lock.hcl',
    ];
    expect(checkTarballEntries(cli, EXTRA_DIRECTORIES['cli'])).toEqual([]);
    expect(checkTarballEntries(cli, ['templates/', 'schema/'])).toHaveLength(2);
  });

  it('accepts dist/ and the manifests, and nothing else', () => {
    expect(checkTarballEntries([...MANIFESTS, 'package/dist/index.js'])).toEqual([]);
    expect(
      checkTarballEntries([
        ...MANIFESTS,
        'package/dist/index.js',
        'package/src/index.ts',
        'package/dist/index.js.map',
        'package/dist/index.test.js',
      ]),
    ).toHaveLength(3);
  });

  it('requires every manifest and a built dist/', () => {
    expect(checkTarballEntries(['package/package.json'])).toHaveLength(4);
  });
});
