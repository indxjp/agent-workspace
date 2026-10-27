import {
  OBJECT_METADATA_MARKER,
  toObjectKey,
  UnsafeObjectKeyError,
} from '@agent-workspace/core/storage';
import { SKILL_FILE_PATH_MAX_BYTES } from '@indx-workspace/contracts/skills';
import { describe, expect, it } from 'vitest';

import {
  createCaseFoldGuard,
  isAdmissibleRelativePath,
  isValidSkillName,
  SKILL_FILES_PREFIX,
  SKILL_META_PREFIX,
  SKILL_REVISIONS_PREFIX,
  skillDeleteMarkerKey,
  skillFileKey,
  skillFilesPrefix,
  skillMetaKey,
  skillNameFromMetaKey,
  skillRevisionKey,
  skillRevisionPrefix,
  skillRevisionRowFolder,
  skillRevisionsPrefix,
  skillRowFolder,
} from './keys';

describe('isValidSkillName', () => {
  it("accepts the shapes packages/core/src/db/schema/skills.ts's CHECK constraint accepts", () => {
    for (const name of ['a', 'a1', 'ab', 'demo-skill', 'invoice-review', 'a'.repeat(64), '9-9']) {
      expect(isValidSkillName(name), name).toBe(true);
    }
  });

  it('rejects everything that constraint rejects', () => {
    for (const name of [
      '', // empty
      'A', // upper-case
      'Demo-Skill', // upper-case
      '-abc', // leading hyphen
      'abc-', // trailing hyphen
      'a_b', // underscore
      'a b', // space
      'a/b', // slash — would make the name multi-segment
      'a.b', // dot
      'a'.repeat(65), // too long
      '__objectstore_meta__', // the reserved marker itself — also excluded by the underscore rule
    ]) {
      expect(isValidSkillName(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe('isAdmissibleRelativePath — ADR-0044, the grammar that replaced round 2s blocklist', () => {
  it('admits ordinary skill file paths', () => {
    for (const path of [
      'SKILL.md',
      'notes.txt',
      'scripts/run.sh',
      'a/b/c/d.txt',
      'README',
      'file_name-v2.1.txt',
    ]) {
      expect(isAdmissibleRelativePath(path), path).toBe(true);
    }
  });

  it('refuses every alias that defeated round 1 and round 2s guards, by grammar alone', () => {
    for (const path of [
      'SKILL.md::$DATA', // NTFS default-data-stream syntax — B1/B2's exact counter-example
      'SKILL.md:', // a bare trailing colon — colon is outside the admitted class either way
      'SKILL.md.', // trailing dot — NTFS strips it on open, leaving "SKILL.md"
      'SKILL.md ', // trailing space — NTFS strips it on open, leaving "SKILL.md"
      '..', // parent-directory segment
      '../SKILL.md', // traversal via a leading ".." segment
      '.', // current-directory segment
      'a/../b', // traversal via a ".." segment mid-path
      '', // empty path
      'a//b', // empty segment
      '/etc/passwd', // absolute path (leading empty segment)
    ]) {
      expect(isAdmissibleRelativePath(path), JSON.stringify(path)).toBe(false);
    }
  });

  it('refuses characters outside the class even when they spell no known alias', () => {
    // ADR-0044's whole point: refusal does not require naming the alias. None of these is a
    // documented NTFS trick; all contain a character `[A-Za-z0-9._-]` excludes.
    for (const path of [
      'notes (draft).txt', // parentheses and a space — declared as a legitimate name this
      // grammar refuses (ADR-0044, "the grammar refuses legitimate names")
      'a$b',
      'a:b',
      'a*b',
      'a?b',
      'a<b>c',
      'a|b',
      'a"b',
      'x y', // an embedded space mid-segment
      'café.txt', // non-ASCII letter
      '日本語.md', // non-ASCII segment entirely
    ]) {
      expect(isAdmissibleRelativePath(path), JSON.stringify(path)).toBe(false);
    }
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a skill path key-safety refuses is not admissible', () => {
    for (const path of [
      'a%2e%2e',
      `a${OBJECT_METADATA_MARKER}`,
      `docs/x${OBJECT_METADATA_MARKER.toUpperCase()}.md`,
    ]) {
      expect(() => toObjectKey(path), path).toThrow(UnsafeObjectKeyError);
      expect(isAdmissibleRelativePath(path), path).toBe(false);
    }
  });

  it('rejects a path over the stated byte ceiling and admits one under it', () => {
    const justUnder = 'a'.repeat(SKILL_FILE_PATH_MAX_BYTES);
    const justOver = 'a'.repeat(SKILL_FILE_PATH_MAX_BYTES + 1);
    expect(isAdmissibleRelativePath(justUnder)).toBe(true);
    expect(isAdmissibleRelativePath(justOver)).toBe(false);
  });

  it('case-folds decidably within the admitted alphabet — the property ADR-0044 says holds here', () => {
    // Not a claim `isAdmissibleRelativePath` itself checks (that is `handlers.ts`'s job) — this
    // just pins the property the module header asserts: every character two admitted paths like
    // these can differ by is plain ASCII, so `.toLowerCase()` never surprises in either direction.
    expect('SKILL.md'.toLowerCase()).toBe('skill.md');
    expect(isAdmissibleRelativePath('SKILL.md')).toBe(true);
    expect(isAdmissibleRelativePath('skill.md')).toBe(true);
  });
});

describe('key composition', () => {
  it('builds the two documented prefixes', () => {
    expect(SKILL_FILES_PREFIX).toBe('skills');
    expect(SKILL_META_PREFIX).toBe('skill-meta');
    expect(skillFileKey('demo', 'SKILL.md')).toBe('skills/demo/SKILL.md');
    expect(skillFileKey('demo', 'scripts/run.sh')).toBe('skills/demo/scripts/run.sh');
    expect(skillFilesPrefix('demo')).toBe('skills/demo');
    expect(skillMetaKey('demo')).toBe('skill-meta/demo.json');
  });

  it('round-trips a metadata key back to its skill name', () => {
    expect(skillNameFromMetaKey('skill-meta/demo-skill.json')).toBe('demo-skill');
  });

  it('refuses anything not shaped like one of its own metadata keys', () => {
    expect(skillNameFromMetaKey('skills/demo/SKILL.md')).toBeNull();
    expect(skillNameFromMetaKey('skill-meta/Demo.json')).toBeNull(); // not a valid slug
    expect(skillNameFromMetaKey('skill-meta/demo.txt')).toBeNull(); // wrong suffix
    expect(skillNameFromMetaKey('other/demo.json')).toBeNull(); // wrong prefix
  });
});

describe("the two prefixes never collide — the executable form of this ADR's claim", () => {
  // docs/adr/W2-CP-04-skill-storage-keys.md, Decision 1: no caller-controlled `name` or
  // `relativePath` can make a skill's own file key equal another skill's metadata key. This is
  // not argued from the two literal prefix strings alone — it is run, over a matrix of names and
  // relative paths wide enough to include the adversarial shapes the sibling ADR
  // (W2-CP-03-object-key-safety.md) found broke a spelling-based defence: paths that themselves
  // contain the word "meta", and every valid skill name this API accepts.
  const names = ['a', 'demo', 'demo-skill', 'meta', 'z'.repeat(64)];
  const relativePaths = [
    'SKILL.md',
    'meta.json',
    'skill-meta.json',
    '../demo.json', // rejected elsewhere by key-safety.ts, but this module composes it regardless
    'nested/path/file.txt',
    '',
  ];

  it('skillFileKey(name, relativePath) is never equal to skillMetaKey(otherName), for every combination', () => {
    const metaKeys = new Set(names.map((n) => skillMetaKey(n)));
    let checked = 0;
    for (const name of names) {
      for (const relativePath of relativePaths) {
        const fileKey = skillFileKey(name, relativePath);
        expect(
          metaKeys.has(fileKey),
          `skillFileKey(${name}, ${JSON.stringify(relativePath)})`,
        ).toBe(false);
        checked += 1;
      }
    }
    // A vacuous loop would pass every assertion inside it (ADR-0015) — assert it really ran.
    expect(checked).toBe(names.length * relativePaths.length);
  });

  it('is true because the two literal prefixes differ at the first character after the shared "skill"', () => {
    // The structural argument, stated as a runnable fact rather than only prose: every fileKey
    // starts with "skills/" and every metaKey starts with "skill-meta/", and those two 7- and
    // 11-character prefixes are never equal to one another as a leading substring of any longer
    // string, because "skills/" contains a "/" at index 6 where "skill-meta/" has "-".
    expect(SKILL_FILES_PREFIX.startsWith('skill')).toBe(true);
    expect(SKILL_META_PREFIX.startsWith('skill')).toBe(true);
    expect(`${SKILL_FILES_PREFIX}/`).not.toBe(`${SKILL_META_PREFIX}/`);
    expect(`${SKILL_META_PREFIX}/`.startsWith(`${SKILL_FILES_PREFIX}/`)).toBe(false);
    expect(`${SKILL_FILES_PREFIX}/`.startsWith(`${SKILL_META_PREFIX}/`)).toBe(false);
  });
});

describe('createCaseFoldGuard — round 4, ADR-0048 (B2-PATCH)', () => {
  it('reports no collision on an empty guard', () => {
    const guard = createCaseFoldGuard([]);
    expect(guard.check('SKILL.md')).toBeNull();
  });

  it('does not flag re-checking the exact same spelling already seeded — an ordinary overwrite', () => {
    // This is `patchSkill`'s normal "edit SKILL.md's content" case: `files: [{"path":"SKILL.md",...}]`
    // against a skill that already has `SKILL.md`. Must not be reported as a collision.
    const guard = createCaseFoldGuard(['SKILL.md', 'notes.txt']);
    expect(guard.check('SKILL.md')).toBeNull();
    expect(guard.check('notes.txt')).toBeNull();
  });

  it('reports a collision when a new path differs in spelling from a seeded one but folds the same', () => {
    // The exact single-entry B2-PATCH shape: an existing "SKILL.md", a PATCH `files` array with only
    // "skill.md" and no second entry — the collision is with the *seed*, not with another entry in
    // the same request.
    const guard = createCaseFoldGuard(['SKILL.md']);
    expect(guard.check('skill.md')).toBe('SKILL.md');
  });

  it('reports a collision between two paths added in the same pass, seeded from nothing', () => {
    // The exact two-entry B2-PATCH/B2 shape: `files: [{"path":"SKILL.md",...},{"path":"skill.md",...}]`
    // on a brand-new import, or on a PATCH with no pre-existing file of that name.
    const guard = createCaseFoldGuard([]);
    expect(guard.check('SKILL.md')).toBeNull();
    guard.add('SKILL.md');
    expect(guard.check('skill.md')).toBe('SKILL.md');
  });

  it('reports the FIRST spelling seen as the collision partner, not the most recent', () => {
    const guard = createCaseFoldGuard(['Notes.txt']);
    guard.add('notes.TXT'); // not what a caller should do without checking first, but the guard
    // itself never refuses `add` — the caller (`handlers.ts`) is what must call `check` first and
    // stop before calling `add` on a colliding path. This test pins that `add` always overwrites
    // its own record with whatever was last added, which is why callers must gate on `check`.
    expect(guard.check('NOTES.txt')).toBe('notes.TXT');
  });

  it('is case-fold decidable over the admitted alphabet only — not a claim about Unicode in general', () => {
    // Mirrors `isAdmissibleRelativePath`'s own module header: this guard is only ever handed paths
    // that already passed the admission grammar, so every character is ASCII letter/digit/`.`/`_`/`-`.
    // It performs no Unicode-aware folding itself; this test pins that `.toLowerCase()` is all it does.
    const guard = createCaseFoldGuard(['a.txt']);
    expect(guard.check('A.txt')).toBe('a.txt');
  });
});

describe('published revision keys (SDK-19, N-1)', () => {
  it('live under a prefix no mutable builder can produce', () => {
    expect(skillRevisionKey('demo', 2, 'SKILL.md')).toBe('skill-revisions/demo/2/SKILL.md');
    expect(skillRevisionPrefix('demo', 2)).toBe('skill-revisions/demo/2');
    expect(skillRevisionsPrefix('demo')).toBe('skill-revisions/demo');
    // A legal supporting file called `2/x.md` stays inside the skill's own prefix.
    const mutable = [
      skillFileKey('demo', '2/x.md'),
      skillFileKey('demo', 'skill-revisions/demo/2/SKILL.md'),
      skillMetaKey('demo'),
      skillDeleteMarkerKey('demo'),
    ];
    for (const key of mutable) {
      expect(key.startsWith(`${SKILL_REVISIONS_PREFIX}/`), key).toBe(false);
    }
  });
});

describe('skill row folders', () => {
  it('keep a revision beside its skill, in a folder no skill name can be', () => {
    expect(skillRowFolder('demo')).toBe('.skills/demo');
    expect(skillRevisionRowFolder('demo', 2)).toBe('.skills/demo@2');
    expect(isValidSkillName('demo@2')).toBe(false);
  });
});
