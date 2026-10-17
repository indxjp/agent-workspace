import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkImagesServeContracts, checkReleaseTree } from '../../scripts/release/check.mjs';

const roots: string[] = [];

async function fixture(
  options: {
    packageVersion?: string;
    releaseVersion?: string;
    sdkSpecifier?: string;
    changelog?: boolean;
    invalidManifest?: boolean;
  } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'wave8-release-'));
  roots.push(root);
  const packageVersion = options.packageVersion ?? '0.1.0';
  const releaseVersion = options.releaseVersion ?? '0.1.0';
  await mkdir(path.join(root, 'docs', 'research'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'release', 'notes'), { recursive: true });
  await mkdir(path.join(root, 'apps', 'runner'), { recursive: true });
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: packageVersion }),
  );
  await writeFile(
    path.join(root, 'docs', 'release', 'notes', `${packageVersion}.md`),
    `# Agent Workspace ${releaseVersion} release notes\n`,
  );
  await writeFile(
    path.join(root, 'docs', 'research', 'R-01-options.json'),
    JSON.stringify({ version: '0.3.258' }),
  );
  await writeFile(
    path.join(root, 'apps', 'runner', 'package.json'),
    options.invalidManifest
      ? '{'
      : JSON.stringify({
          dependencies: {
            '@anthropic-ai/claude-agent-sdk': options.sdkSpecifier ?? '0.3.258',
          },
        }),
  );
  if (options.changelog !== false) {
    await writeFile(path.join(root, 'CHANGELOG.md'), `# Changelog\n\n## ${releaseVersion}\n`);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Wave 8 release consistency gate', () => {
  it('accepts agreeing versions and reports an absent tag as unreleased', async () => {
    await expect(checkReleaseTree(await fixture(), { tags: [] })).resolves.toMatchObject({
      version: '0.1.0',
      tagStatus: 'unreleased',
      sdkVersion: '0.3.258',
    });
  });

  it('rejects a release-notes version disagreement', async () => {
    await expect(
      checkReleaseTree(await fixture({ releaseVersion: '0.1.1' }), { tags: [] }),
    ).rejects.toThrow(/RELEASE_NOTES_VERSION_MISMATCH/u);
  });

  it('rejects a ranged SDK specifier', async () => {
    await expect(
      checkReleaseTree(await fixture({ sdkSpecifier: '^0.3.258' }), { tags: [] }),
    ).rejects.toThrow(/SDK_SPECIFIER_NOT_EXACT/u);
  });

  it('rejects a missing changelog', async () => {
    await expect(
      checkReleaseTree(await fixture({ changelog: false }), { tags: [] }),
    ).rejects.toThrow(/RELEASE_SOURCE_UNREADABLE/u);
  });

  it('rejects an unreadable JSON manifest', async () => {
    await expect(
      checkReleaseTree(await fixture({ invalidManifest: true }), { tags: [] }),
    ).rejects.toThrow(/RELEASE_JSON_INVALID/u);
  });

  it('keeps every enforcement path named by the upgrade policy resolvable', async () => {
    const repository = new URL('../../', import.meta.url);
    const policy = await readFile(new URL('../../docs/upgrade-policy.md', import.meta.url), 'utf8');
    const paths = [
      ...new Set(
        [...policy.matchAll(/`((?:scripts|tests)\/[^`]+\.(?:mjs|ts))`/gu)].map(
          (match) => match[1]!,
        ),
      ),
    ];
    expect(paths).toHaveLength(4);
    await Promise.all(paths.map((entry) => access(new URL(entry, repository))));
  });
});

// PR #403 review: a generated project's images must serve its own clients' contracts minor.
describe('the pinned images serve the contracts minor (ADR-0078 D2)', () => {
  async function versions(images: string, contracts: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'images-contracts-'));
    roots.push(root);
    await mkdir(path.join(root, 'packages', 'cli', 'src'), { recursive: true });
    await mkdir(path.join(root, 'packages', 'contracts', 'src'), { recursive: true });
    await writeFile(
      path.join(root, 'packages', 'cli', 'src', 'release-images.json'),
      JSON.stringify({ registry: 'ghcr.io/example', version: images, images: {} }),
    );
    await writeFile(
      path.join(root, 'packages', 'contracts', 'src', 'version.ts'),
      `export const CONTRACTS_VERSION = '${contracts}';\n`,
    );
    return root;
  }

  it('holds for this repository', async () => {
    await expect(
      checkImagesServeContracts(path.resolve(import.meta.dirname, '../..')),
    ).resolves.toBeDefined();
  });

  it('accepts a different patch of the same minor', async () => {
    await expect(checkImagesServeContracts(await versions('0.2.3', '0.2.0'))).resolves.toEqual({
      imageVersion: '0.2.3',
      contractsVersion: '0.2.0',
    });
  });

  it('refuses images of an older minor, and of another major', async () => {
    await expect(checkImagesServeContracts(await versions('0.1.2', '0.2.0'))).rejects.toThrow(
      /IMAGES_CONTRACTS_MINOR_MISMATCH/u,
    );
    await expect(checkImagesServeContracts(await versions('1.2.0', '0.2.0'))).rejects.toThrow(
      /IMAGES_CONTRACTS_MINOR_MISMATCH/u,
    );
  });
});
