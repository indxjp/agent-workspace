import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkPullRequest,
  collectFragments,
  mergeIntoChangelog,
  parseFragment,
  validateFragments,
} from '../../scripts/release/changes.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PLATFORM = `# Changelog

Intro.

## Unreleased

### Fixed

- Old fix.

## 0.1.0

### Added

- First.
`;

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'changes-'));
  roots.push(root);
  await mkdir(path.join(root, 'changes'));
  await mkdir(path.join(root, 'packages', 'sdk'), { recursive: true });
  await writeFile(path.join(root, 'CHANGELOG.md'), PLATFORM);
  await writeFile(
    path.join(root, 'packages', 'sdk', 'CHANGELOG.md'),
    '# Changelog — sdk\n\n## 0.1.0\n\n### Added\n\n- First.\n',
  );
  await writeFile(path.join(root, 'changes', 'README.md'), '# Fragments\n');
  return root;
}

const fragment = (changelog: string, section: string, body: string): string =>
  `---\nchangelog: ${changelog}\nsection: ${section}\n---\n\n${body}\n`;

describe('parseFragment', () => {
  it('reads the front matter and the list body', () => {
    expect(parseFragment(fragment('sdk', 'Added', '- One.\n  continued.'))).toEqual({
      changelog: 'sdk',
      section: 'Added',
      body: '- One.\n  continued.',
    });
  });

  it.each([
    ['no front matter', '- One.\n'],
    ['unknown section', fragment('sdk', 'Improved', '- One.')],
    ['missing changelog', '---\nsection: Added\n---\n\n- One.\n'],
    ['unknown key', '---\nchangelog: sdk\nsection: Added\npr: 1\n---\n\n- One.\n'],
    ['empty body', fragment('sdk', 'Added', '')],
    ['body that is not a list', fragment('sdk', 'Added', 'Prose.')],
    ['body with a heading', fragment('sdk', 'Added', '- One.\n\n## 0.2.0')],
  ])('refuses %s', (_name, source) => {
    expect(() => parseFragment(source)).toThrow(/CHANGE_FRAGMENT_INVALID/u);
  });

  it('accepts CRLF line endings', () => {
    expect(parseFragment(fragment('platform', 'Fixed', '- One.').replaceAll('\n', '\r\n'))).toEqual(
      { changelog: 'platform', section: 'Fixed', body: '- One.' },
    );
  });
});

describe('validateFragments', () => {
  it('names a fragment whose changelog does not exist', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'changes', 'a.md'), fragment('nope', 'Added', '- One.'));
    await writeFile(path.join(root, 'changes', 'b.md'), fragment('sdk', 'Added', '- One.'));
    expect(await validateFragments(root)).toEqual([
      'changes/a.md: CHANGE_FRAGMENT_INVALID: no changelog "nope" (use "platform" or a packages/<name> that has a CHANGELOG.md)',
    ]);
  });
});

describe('mergeIntoChangelog', () => {
  it('leaves existing text byte for byte, blank-line runs included', () => {
    const text = '# C\n\n## Unreleased\n\n### Fixed\n\n- Old.\n\n## 0.1.0\n\n```\na\n\n\nb\n```\n';
    expect(mergeIntoChangelog(text, new Map([['Fixed', ['- New.']]]))).toBe(
      text.replace('- Old.\n', '- Old.\n- New.\n'),
    );
  });
});

describe('collectFragments', () => {
  it('merges fragments into Unreleased in section order and deletes them', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'changes', 'b-fix.md'), fragment('platform', 'Fixed', '- B.'));
    await writeFile(path.join(root, 'changes', 'a-fix.md'), fragment('platform', 'Fixed', '- A.'));
    await writeFile(
      path.join(root, 'changes', 'added.md'),
      fragment('platform', 'Added', '- New.\n  wrapped.'),
    );
    await writeFile(path.join(root, 'changes', 'sec.md'), fragment('platform', 'Security', '- S.'));
    await writeFile(path.join(root, 'changes', 'sdk.md'), fragment('sdk', 'Changed', '- C.'));

    expect(await collectFragments(root)).toEqual({
      changelogs: ['CHANGELOG.md', 'packages/sdk/CHANGELOG.md'],
      fragments: 5,
    });

    expect(await readFile(path.join(root, 'CHANGELOG.md'), 'utf8')).toBe(`# Changelog

Intro.

## Unreleased

### Added

- New.
  wrapped.

### Fixed

- Old fix.
- A.
- B.

### Security

- S.

## 0.1.0

### Added

- First.
`);
    expect(await readFile(path.join(root, 'packages', 'sdk', 'CHANGELOG.md'), 'utf8')).toBe(
      '# Changelog — sdk\n\n## Unreleased\n\n### Changed\n\n- C.\n\n## 0.1.0\n\n### Added\n\n- First.\n',
    );
    expect(await readdir(path.join(root, 'changes'))).toEqual(['README.md']);
  });

  it('writes nothing when any fragment is invalid', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'changes', 'a.md'), fragment('platform', 'Fixed', '- A.'));
    await writeFile(path.join(root, 'changes', 'b.md'), 'not a fragment');
    await expect(collectFragments(root)).rejects.toThrow(
      /changes\/b\.md: CHANGE_FRAGMENT_INVALID/u,
    );
    expect(await readFile(path.join(root, 'CHANGELOG.md'), 'utf8')).toBe(PLATFORM);
    expect((await readdir(path.join(root, 'changes'))).sort()).toEqual([
      'README.md',
      'a.md',
      'b.md',
    ]);
  });
});

describe('checkPullRequest', () => {
  const git = (root: string, ...args: string[]): string =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

  async function repo(withGate: boolean): Promise<{ root: string; base: string }> {
    const root = await fixture();
    if (withGate) {
      await mkdir(path.join(root, 'scripts', 'release'), { recursive: true });
      await writeFile(path.join(root, 'scripts', 'release', 'changes.mjs'), '// gate\n');
    }
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
    return { root, base: git(root, 'rev-parse', 'HEAD') };
  }

  async function commit(root: string, file: string, content: string): Promise<string> {
    await writeFile(path.join(root, file), content);
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'change');
    return git(root, 'rev-parse', 'HEAD');
  }

  it('fails a pull request that edits a CHANGELOG.md', async () => {
    const { root, base } = await repo(true);
    const head = await commit(root, 'packages/sdk/CHANGELOG.md', '# edited\n');
    expect(checkPullRequest({ root, base, head, headRef: 'feature/x' })).toEqual({
      failures: [
        'packages/sdk/CHANGELOG.md: CHANGELOG_EDITED_OUTSIDE_RELEASE: add a changes/<slug>.md fragment instead (changes/README.md)',
      ],
      warnings: [],
    });
  });

  it('passes a pull request that adds a fragment', async () => {
    const { root, base } = await repo(true);
    const head = await commit(root, 'changes/x.md', fragment('sdk', 'Added', '- X.'));
    expect(checkPullRequest({ root, base, head, headRef: 'feature/x' })).toEqual({
      failures: [],
      warnings: [],
    });
  });

  it('lets a release/* branch edit CHANGELOG.md', async () => {
    const { root, base } = await repo(true);
    const head = await commit(root, 'CHANGELOG.md', '# released\n');
    expect(checkPullRequest({ root, base, head, headRef: 'release/0.7.0' }).failures).toEqual([]);
  });

  it('only warns for a branch forked before the gate existed', async () => {
    const { root, base } = await repo(false);
    const head = await commit(root, 'CHANGELOG.md', '# edited\n');
    expect(checkPullRequest({ root, base, head, headRef: 'feature/x' })).toEqual({
      failures: [],
      warnings: [
        'CHANGELOG.md: CHANGELOG_EDITED_OUTSIDE_RELEASE: add a changes/<slug>.md fragment instead (changes/README.md) (not enforced: this branch forked before the fragment gate; it is enforced once the branch merges main)',
      ],
    });
  });
});
