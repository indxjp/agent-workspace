/**
 * The public documentation says what the code makes true, and nothing it no longer does.
 *
 * A static check of the `docs-check` lane (tests/static-checks/vitest.config.ts): `pnpm docs:check`
 * runs it on every change, in fast-checks; no test lane runs it again. The slice and platform
 * claims live in public-slices.docs-check.ts and public-platforms.docs-check.ts.
 */
import { access, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { PUBLISHED_PACKAGES } from '../../scripts/release/pack-packages.mjs';

import { readCollapsed, repository } from './docs-truth.test-support.js';

interface PackageManifest {
  name: string;
  version: string;
}

interface EvidenceManifest {
  releaseVersion: string;
  artifacts: { package: { version: string; ownershipVerified: boolean } };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(new URL(path, repository), 'utf8')) as T;
}

describe('current public documentation follows executable truth', () => {
  it('does not retain superseded setup, storage, or runtime claims', async () => {
    const readme = await readFile(new URL('README.md', repository), 'utf8');
    expect(readme).not.toContain('Administrator and agent submission remain unavailable');
    expect(readme).not.toContain('zero-infrastructure start command creates embedded PostgreSQL');
    expect(readme).toContain('local driver is for development only');
    expect(readme).toContain('seeded bootstrap administrator');
    expect(readme).not.toContain('reserved by unrelated npm publishers');
    expect(readme).toContain('npm create @indx-workspace@latest my-agent-platform');
    expect(readme).toContain('npx -p @indx-workspace/cli create-agent-workspace my-agent-platform');
    expect(readme).toContain('npx @indx-workspace/aw me');
  });

  it('documents /signin, when the provider key is checked, and teardown in the self-hosting guide', async () => {
    const page = await readCollapsed('docs/sdk/site/building/self-hosting.mdx');
    expect(page).toContain('open `/signin`');
    expect(page).toContain('only at step 4');
    expect(page).toContain('which is checked when you click "Finish setup"');
    expect(page).toContain('`pnpm stop` (`agent-workspace stop`)');
    expect(page).toContain('add `--volumes`');
  });

  // Issue #416: first-run polish from the 0.2.0 verification.
  it('shows a complete agent.json, names the setup password, and notes mirrored WSL ports', async () => {
    const cli = await readCollapsed('docs/sdk/site/cli/overview.mdx');
    const selfHosting = await readCollapsed('docs/sdk/site/building/self-hosting.mdx');
    expect(cli).toContain('"modelConnectionId": null');
    expect(cli).toContain('"model": null');
    for (const permission of ['readFiles', 'writeFiles', 'runCommands', 'unrestrictedNetwork']) {
      expect(cli).toContain(`"${permission}":`);
    }
    expect(cli).toContain('cannot run until it has a runtime profile and a model');
    expect(selfHosting).toContain('`BOOTSTRAP_ADMIN_PASSWORD`');
    expect(selfHosting).toContain('"One-time setup password" the generator printed');
    expect(selfHosting).toContain('mirrored networking');
    expect(selfHosting).toContain('may be a Windows process');
  });
});

describe('release metadata and entry points follow executable truth', () => {
  /**
   * Two separate version lines. The platform release (root `package.json`) is what the evidence
   * manifest records. The five published `@indx-workspace` packages are lock-step at
   * `CONTRACTS_VERSION` (ADR-0082 D3) and take patch releases of their own, so they are held to
   * that constant rather than to the platform version.
   */
  it('keeps release/package versions aligned without claiming package ownership', async () => {
    const root = await readJson<PackageManifest>('package.json');
    const evidence = await readJson<EvidenceManifest>('docs/release/evidence-manifest.json');
    expect(evidence.releaseVersion).toBe(root.version);
    expect(evidence.artifacts.package.version).toBe(root.version);
    expect(evidence.artifacts.package.ownershipVerified).toBe(false);

    const { CONTRACTS_VERSION } = await import('@indx-workspace/contracts');
    for (const name of PUBLISHED_PACKAGES) {
      const published = await readJson<PackageManifest>(`packages/${name}/package.json`);
      expect(published.name).toBe(`@indx-workspace/${name}`);
      expect(published.version, published.name).toBe(CONTRACTS_VERSION);
    }
  });

  it('links to shipped agent-detail and Terraform entry points', async () => {
    await Promise.all([
      access(new URL('apps/web/app/(shell)/agents/[id]/page.tsx', repository)),
      access(new URL('infra/terraform/gcp-small/README.md', repository)),
    ]);
  });

  it('keeps the capability ledger and evidence manifest on their enforced schemas', async () => {
    const status = await readJson<{ schemaVersion: number; releaseEvidenceManifest: string }>(
      'docs/30-reference/capabilities/status.json',
    );
    expect(status.schemaVersion).toBe(2);
    expect(status.releaseEvidenceManifest).toBe('docs/release/evidence-manifest.json');
    await access(new URL(status.releaseEvidenceManifest, repository));
  });
});

// @story US-STO-13
describe('the required storage upgrade stop', () => {
  it('names a remedy for every cause that keeps a pass record from proving the move', async () => {
    const page = await readCollapsed('docs/sdk/site/building/self-hosting.mdx');
    const note = await readCollapsed('CHANGELOG.md');
    for (const text of [page, note]) {
      for (const cause of [
        '`skipped_ownerless`',
        '`skipped_path_taken`',
        '`skipped_failed`',
        'DELETE /api/skills/<name>',
      ])
        expect(text).toContain(cause);
    }
    expect(page).toContain('read the latest `adopt` row');
    expect(page).toContain("the latest `skills` row's `legacy_rows`");
  });

  it('says the finalize start is the last chance to remove the old objects', async () => {
    const page = await readCollapsed('docs/sdk/site/building/self-hosting.mdx');
    expect(page).toContain('This is the last release that removes the old objects');
    expect(page).toContain('would adopt a leftover old object as a live file again');
  });
});
