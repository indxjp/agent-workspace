/**
 * Every path the files routes refuse, pinned before refactoring part 10 step 6 moves the two
 * reserved skill roots (`skill-revisions/`, `.skills/`) into storage's key layout. A move that
 * changes what is refused fails here.
 */
import { describe, expect, it } from 'vitest';

import {
  attachmentsRefusal,
  EMPTY_FOLDER_MARKER,
  isReservedAttachmentPath,
  isUnderSkillRows,
  reservedFileWriteRefusal,
  targetsPublishedSkillRevisions,
  targetsRunnerPrivateDirectory,
} from './file-path-policy';
import type { FileResult } from './file-result';

/** The refusal's status, code and message, or `null` when the path is admitted. */
function refusalOf(result: FileResult | null) {
  if (result === null) return null;
  return { status: result.status, body: result.kind === 'json' ? result.body : result.kind };
}

const reserved = (message: string) => ({
  status: 400,
  body: { error: { code: 'reserved_path', message } },
});

describe('a write to a reserved path', () => {
  it.each([
    ['skill-revisions/triage/1/SKILL.md', 'Published skill revisions are immutable.'],
    ['Skill-Revisions/triage/SKILL.md', 'Published skill revisions are immutable.'],
    ['skill-revisions', 'Published skill revisions are immutable.'],
    ['.claude/settings.json', 'The .claude directory is reserved for runner state.'],
    ['.CLAUDE/x', 'The .claude directory is reserved for runner state.'],
    [`docs/${EMPTY_FOLDER_MARKER}`, 'That file path is reserved for internal metadata.'],
    [`${EMPTY_FOLDER_MARKER}/a.txt`, 'That file path is reserved for internal metadata.'],
  ])('%s is refused: %s', (key, message) => {
    expect(refusalOf(reservedFileWriteRefusal(key))).toEqual(reserved(message));
  });

  it.each([
    'docs/notes.md',
    'skill-revisions-old/a.txt',
    'docs/skill-revisions/a.txt',
    'docs/.claude/a.txt',
    '.skills/triage/SKILL.md',
  ])('%s is admitted by the write rule', (key) => {
    expect(reservedFileWriteRefusal(key)).toBeNull();
  });

  it('names the two root checks it is built from', () => {
    expect(targetsPublishedSkillRevisions('SKILL-REVISIONS/a')).toBe(true);
    expect(targetsPublishedSkillRevisions('a/skill-revisions')).toBe(false);
    expect(targetsRunnerPrivateDirectory('.claude')).toBe(true);
    expect(targetsRunnerPrivateDirectory('a/.claude')).toBe(false);
  });
});

describe('the .skills root', () => {
  it.each([
    ['.skills/triage/SKILL.md', true],
    ['.SKILLS/triage', true],
    ['.skills', true],
    ['docs/.skills/a', false],
    ['.skills-old/a', false],
    ['../.skills/a', false],
  ])('%s is under the skill rows: %s', (path, under) => {
    expect(isUnderSkillRows(path)).toBe(under);
  });

  it('refuses a write under it for every token, and lets a read or a delete through', () => {
    const refused = reserved('The .skills directory holds skills; use /api/skills.');
    for (const scope of [null, { kind: 'session' }, { kind: 'run' }]) {
      expect(refusalOf(attachmentsRefusal(scope, '.skills/triage/SKILL.md', 'write'))).toEqual(
        refused,
      );
      expect(attachmentsRefusal(scope, '.skills/triage/SKILL.md', 'read')).toBeNull();
      expect(attachmentsRefusal(scope, '.skills/triage/SKILL.md', 'delete')).toBeNull();
    }
  });
});

describe('the .attachments root', () => {
  it('conceals a read and refuses a write or a delete for any principal but a session token', () => {
    expect(refusalOf(attachmentsRefusal(null, '.attachments/s1/a.png', 'read'))).toEqual({
      status: 404,
      body: { error: { code: 'file_not_found', message: 'No file has that id.' } },
    });
    for (const access of ['write', 'delete'] as const) {
      expect(refusalOf(attachmentsRefusal(null, '.attachments/s1/a.png', access))).toEqual(
        reserved('The .attachments directory holds surface visitors’ uploads.'),
      );
    }
    expect(attachmentsRefusal({ kind: 'session' }, '.attachments/s1/a.png', 'write')).toBeNull();
  });

  it.each([
    ['.attachments/s1/a.png', true],
    ['.ATTACHMENTS/s1', true],
    ['docs/.attachments/a', false],
  ])('%s is a reserved attachment path: %s', (path, reservedPath) => {
    expect(isReservedAttachmentPath(path)).toBe(reservedPath);
  });
});
