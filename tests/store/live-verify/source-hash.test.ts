/**
 * The source hash an R1 record carries (`./source-hash.ts`): what it covers, what it leaves out,
 * that it is the same on every machine for the same commit, and the check that a run verifies what
 * the deployment seeded.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  defineEntry,
  type CatalogEntry,
  type LiveEntry,
} from '../../../examples/store/catalog/define.ts';
import { CATALOG } from '../../../examples/store/catalog/index.ts';
import {
  deployedSourceDiffers,
  entrySourceHash,
  sourceFolderOf,
  sourceHash,
  stagedView,
} from './source-hash.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (root: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], {
    cwd: root,
    encoding: 'utf8',
  }).trim();

function write(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
}

/** A git repository with `files` written and every one of them added (tracked). */
function repository(files: Record<string, string>, untracked: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'source-hash-'));
  roots.push(root);
  git(root, 'init', '-q');
  write(root, files);
  git(root, 'add', '--', ...Object.keys(files));
  write(root, untracked);
  return root;
}

const SOURCE = {
  'use-cases/nda/agent-workspace.yaml': 'name: nda\n',
  'use-cases/nda/agents/nda.ts': 'export default {};\n',
  'use-cases/nda/data/ja/a.md': 'あ\n',
};

const DEFINED = defineEntry({
  slug: 'nda',
  area: 'legal',
  status: 'live',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/nda',
  name: { ja: 'あ', en: 'A' },
  summary: { ja: 'あ', en: 'A' },
  demo: {
    agent: 'nda',
    prompts: [{ ja: 'あ', en: 'A' }],
    moment: { ja: 'あ', en: 'A' },
    data: { ja: 'あ', en: 'A' },
    seed: [{ collection: 'contracts', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: null },
  },
  safety: ['files'],
});
if (DEFINED.status !== 'live') throw new Error('the fixture entry is live');
const LIVE: LiveEntry = DEFINED;

describe('the source hash', () => {
  it('is a sha256 of the tracked files only, the same whatever else is on disk', () => {
    const hash = sourceHash('use-cases/nda', repository(SOURCE));
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    const noise = repository(SOURCE, {
      'use-cases/nda/node_modules/x/index.js': 'x\n',
      'use-cases/nda/scratch.md': 'local\n',
    });
    expect(sourceHash('use-cases/nda', noise)).toBe(hash);
    expect(sourceHash('use-cases/nda/', noise)).toBe(hash);
  });

  it('changes when a file the agent reads changes, is added or is renamed', () => {
    const hash = sourceHash('use-cases/nda', repository(SOURCE));
    for (const changed of [
      { ...SOURCE, 'use-cases/nda/agents/nda.ts': 'export default { x: 1 };\n' },
      { ...SOURCE, 'use-cases/nda/data/ja/a.md': 'い\n' },
      { ...SOURCE, 'use-cases/nda/skills/s/SKILL.md': '# s\n' },
      { ...SOURCE, 'use-cases/nda/skills/s/README.md': '# read by nobody, but not top level\n' },
      {
        'use-cases/nda/agent-workspace.yaml': 'name: nda\n',
        'use-cases/nda/agents/renamed.ts': 'export default {};\n',
        'use-cases/nda/data/ja/a.md': 'あ\n',
      },
    ]) {
      expect(sourceHash('use-cases/nda', repository(changed))).not.toBe(hash);
    }
  });

  it('leaves out tests, test support, e2e, the top-level README and other folders', () => {
    const hash = sourceHash('use-cases/nda', repository(SOURCE));
    const extra = repository({
      ...SOURCE,
      'use-cases/nda/nda.test.ts': 'x\n',
      'use-cases/nda/flows.spec.mjs': 'x\n',
      'use-cases/nda/nda.fixture.test-support.ts': 'x\n',
      'use-cases/nda/e2e/store.e2e.mjs': 'x\n',
      'use-cases/nda/README.md': '# nda\n',
      'use-cases/nda-two/agents/x.ts': 'x\n',
      'use-cases/other/agents/x.ts': 'x\n',
    });
    expect(sourceHash('use-cases/nda', extra)).toBe(hash);
  });

  it('leaves out a tracked file deleted from the working tree, and is null for no files', () => {
    const root = repository({ ...SOURCE, 'use-cases/nda/gone.md': 'x\n' });
    rmSync(path.join(root, 'use-cases/nda/gone.md'));
    expect(sourceHash('use-cases/nda', root)).toBe(sourceHash('use-cases/nda', repository(SOURCE)));
    expect(sourceHash('use-cases/missing', root)).toBeNull();
    expect(entrySourceHash(LIVE, repository({}))).toBeNull();
  });

  it("covers the entry's demo block, but not its status", () => {
    const root = repository(SOURCE);
    const hash = entrySourceHash(LIVE, root);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(hash).not.toBe(sourceHash('use-cases/nda', root));
    const changed = (demo: Partial<LiveEntry['demo']>) =>
      entrySourceHash({ ...LIVE, demo: { ...LIVE.demo, ...demo } }, root);
    expect(changed({ prompts: [{ ja: 'い', en: 'B' }] })).not.toBe(hash);
    expect(changed({ check: { tools: [], approval: null } })).not.toBe(hash);
    expect(changed({ seed: [] })).not.toBe(hash);
    expect(changed({ records: 'data' })).not.toBe(hash);
    // The same demo with its keys in another order hashes alike.
    const reordered = Object.fromEntries(Object.entries(LIVE.demo).reverse());
    expect(entrySourceHash({ ...LIVE, demo: reordered } as CatalogEntry, root)).toBe(hash);
    const soon = defineEntry({
      slug: 'nda',
      area: 'legal',
      status: 'soon',
      wave: 2,
      name: { ja: 'あ', en: 'A' },
      summary: { ja: 'あ', en: 'A' },
    });
    expect(entrySourceHash(soon, root)).toMatch(/^[0-9a-f]{64}$/u);
    expect(entrySourceHash(soon, root)).not.toBe(hash);
  });

  it('is the same for a coming-soon entry carrying its source and demo as once it is live', () => {
    // The batch PR merges the code as soon; R1's record is taken then, and the flip keeps it.
    const root = repository(SOURCE);
    const soon = defineEntry({ ...LIVE, status: 'soon', wave: 2 });
    expect(sourceFolderOf(soon)).toBe('use-cases/nda');
    expect(entrySourceHash(soon, root)).toBe(entrySourceHash(LIVE, root));
  });

  it("keeps a live entry's hash when a rebuild is staged, and the repoint gets the rebuild's", () => {
    // ADR-0174: R1 records the staged rebuild (`next`); the repoint moves it into place and drops
    // `next`, so the record it made stays current, while the live entry keeps its own until then.
    const root = repository({
      ...SOURCE,
      'tests/gallery/nda/agents/nda.ts': 'export default { gallery: true };\n',
      'tests/gallery/nda/data/contracts/a.md': 'あ\n',
    });
    const current = defineEntry({
      ...LIVE,
      source: 'tests/gallery/nda',
      demo: { ...LIVE.demo, seed: [{ collection: 'contracts', from: 'data/contracts' }] },
    });
    if (current.status !== 'live') throw new Error('the fixture entry is live');
    const rebuilt = defineEntry({ ...current, next: { source: LIVE.source, demo: LIVE.demo } });
    if (rebuilt.status !== 'live') throw new Error('the rebuilt entry is live');
    expect(entrySourceHash(rebuilt, root)).toBe(entrySourceHash(current, root));
    const staged = entrySourceHash(stagedView(rebuilt), root);
    expect(staged).not.toBe(entrySourceHash(current, root));
    // LIVE is the entry repointed: the rebuild's source and demo, and no `next`.
    expect(staged).toBe(entrySourceHash(LIVE, root));
  });

  it("is an entry's source, else a coming-soon entry's use-cases folder", () => {
    expect(sourceFolderOf(LIVE)).toBe('use-cases/nda');
    for (const entry of CATALOG) {
      if (entry.status !== 'live') continue;
      expect(sourceFolderOf(entry)).toBe(entry.source);
      expect(entrySourceHash(entry), entry.slug).toMatch(/^[0-9a-f]{64}$/u);
    }
  });
});

describe('the check that a run verifies what the deployment seeded', () => {
  const CATALOG_FILE = { 'examples/store/catalog/nda.ts': 'export default {};\n' };

  function committed(): { root: string; deployed: string } {
    const root = repository({ ...SOURCE, ...CATALOG_FILE });
    git(root, 'commit', '-q', '-m', 'deployed');
    return { root, deployed: git(root, 'rev-parse', 'HEAD') };
  }

  it('passes when the source folder and the catalog file are the trees the deployment had', () => {
    const { root, deployed } = committed();
    expect(deployedSourceDiffers(LIVE, deployed, root)).toBeNull();
    // A later commit elsewhere changes nothing for this entry.
    write(root, { 'use-cases/other/x.md': 'x\n' });
    git(root, 'add', '--', 'use-cases/other/x.md');
    git(root, 'commit', '-q', '-m', 'elsewhere');
    expect(deployedSourceDiffers(LIVE, deployed, root)).toBeNull();
  });

  it('refuses a source or catalog file changed since, or not committed', () => {
    for (const file of ['use-cases/nda/agents/nda.ts', 'examples/store/catalog/nda.ts']) {
      const { root, deployed } = committed();
      write(root, { [file]: 'export default { changed: true };\n' });
      expect(deployedSourceDiffers(LIVE, deployed, root)).toMatch(/has uncommitted changes$/u);
      git(root, 'commit', '-q', '-am', 'changed');
      expect(deployedSourceDiffers(LIVE, deployed, root)).toMatch(
        /differs from what the deployment at [0-9a-f]{12} seeded$/u,
      );
    }
  });

  it('refuses a deployed commit that does not exist here or lacks the source', () => {
    const { root } = committed();
    expect(deployedSourceDiffers(LIVE, 'f'.repeat(40), root)).toMatch(/differs from/u);
    const missing = { ...LIVE, source: 'use-cases/missing' } as CatalogEntry;
    expect(deployedSourceDiffers(missing, 'HEAD', root)).toMatch(/differs from/u);
  });
});
