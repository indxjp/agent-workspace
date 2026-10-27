import { describe, expect, it } from 'vitest';

import {
  BUILTIN_SKILL_NAMES,
  MAX_SKILL_REQUEST_BODY_BYTES,
  PublishSkillRevisionRequestSchema,
  SKILLS_PROBLEM_CODES,
  SKILL_FILE_BASE64_PATTERN,
  SKILL_FILE_PATH_MAX_BYTES,
  SKILL_MD_FILENAME,
  SKILL_NAME_MAX_LENGTH,
  SKILL_NAME_PATTERN,
  SkillDetailSchema,
  SkillExportResponseSchema,
  SkillExportSchema,
  SkillFileSchema,
  SkillFileStatSchema,
  SkillListResponseSchema,
  SkillResponseSchema,
  SkillRevisionPinsByIdSchema,
  SkillRevisionPinsByNameSchema,
  SkillRevisionResponseSchema,
  SkillRevisionSchema,
  SkillSummarySchema,
  isBuiltinSkillName,
  SKILL_REVISION_PINS_MAX,
} from './skills.js';

const SKILL_MD =
  '---\nname: demo\ndescription: A demo skill\nallowed-tools: Read Grep\n---\n\nDo it.\n';

const summary = {
  id: '88888888-8888-4888-8888-888888888888',
  name: 'demo',
  enabled: true,
  description: 'A demo skill',
  fileCount: 2,
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:05:00.000Z',
};

const detail = {
  ...summary,
  source: SKILL_MD,
  instructions: 'Do it.\n',
  allowedTools: ['Read', 'Grep'],
  files: [
    { path: 'SKILL.md', sizeBytes: SKILL_MD.length },
    { path: 'scripts/run.sh', sizeBytes: 12 },
  ],
};

const skillMdBase64 = 'LS0tCm5hbWU6IGRlbW8KLS0tCg==';

describe('SkillSummarySchema and SkillDetailSchema', () => {
  it('accepts a skill with its catalog id, and one whose SKILL.md is unreadable', () => {
    expect(SkillSummarySchema.safeParse(summary).success).toBe(true);
    expect(SkillDetailSchema.safeParse(detail).success).toBe(true);
    expect(
      SkillDetailSchema.safeParse({
        ...detail,
        description: null,
        source: null,
        instructions: null,
        allowedTools: null,
      }).success,
    ).toBe(true);
  });

  it('K-4: rejects a missing id and a blank id', () => {
    const withoutId = Object.fromEntries(Object.entries(summary).filter(([key]) => key !== 'id'));
    expect(SkillSummarySchema.safeParse(withoutId).success).toBe(false);
    expect(SkillSummarySchema.safeParse({ ...summary, id: '' }).success).toBe(false);
    const detailWithoutId = Object.fromEntries(
      Object.entries(detail).filter(([key]) => key !== 'id'),
    );
    expect(SkillDetailSchema.safeParse(detailWithoutId).success).toBe(false);
    expect(SkillDetailSchema.safeParse({ ...detail, id: '' }).success).toBe(false);
  });

  it('rejects a wrong type, an unknown key, and a missing required field', () => {
    expect(SkillDetailSchema.safeParse({ ...detail, enabled: 'yes' }).success).toBe(false);
    expect(SkillDetailSchema.safeParse({ ...detail, assignedAgents: [] }).success).toBe(false);
    expect(SkillSummarySchema.safeParse({ ...summary, source: null }).success).toBe(false);
    const withoutFiles = Object.fromEntries(
      Object.entries(detail).filter(([key]) => key !== 'files'),
    );
    expect(SkillDetailSchema.safeParse(withoutFiles).success).toBe(false);
  });

  it('holds the name to the slug grammar and the counts to non-negative integers', () => {
    expect(SkillSummarySchema.safeParse({ ...summary, name: 'Demo' }).success).toBe(false);
    expect(SkillSummarySchema.safeParse({ ...summary, name: 'a'.repeat(65) }).success).toBe(false);
    expect(SkillSummarySchema.safeParse({ ...summary, name: 'a'.repeat(64) }).success).toBe(true);
    expect(SkillSummarySchema.safeParse({ ...summary, fileCount: -1 }).success).toBe(false);
    expect(SkillFileStatSchema.safeParse({ path: 'SKILL.md', sizeBytes: 1.5 }).success).toBe(false);
    expect(SkillSummarySchema.safeParse({ ...summary, createdAt: 1_700_000_000 }).success).toBe(
      false,
    );
  });
});

describe('SkillFileSchema', () => {
  it('accepts padded standard base64, the empty file included, and refuses anything else', () => {
    expect(
      SkillFileSchema.safeParse({ path: 'SKILL.md', contentBase64: skillMdBase64 }).success,
    ).toBe(true);
    expect(SkillFileSchema.safeParse({ path: 'empty.txt', contentBase64: '' }).success).toBe(true);
    expect(SkillFileSchema.safeParse({ path: 'x', contentBase64: 'not base64!' }).success).toBe(
      false,
    );
    expect(SkillFileSchema.safeParse({ path: 'x', contentBase64: 'YWJj' }).success).toBe(true);
    expect(SkillFileSchema.safeParse({ path: 'x', contentBase64: 'YWJ' }).success).toBe(false);
    expect(SkillFileSchema.safeParse({ path: '', contentBase64: '' }).success).toBe(false);
    expect(SkillFileSchema.safeParse({ path: 'x', contentBase64: '', sizeBytes: 0 }).success).toBe(
      false,
    );
  });
});

describe('response envelopes', () => {
  it('reads the list, the wrapped item and the wrapped export', () => {
    expect(SkillListResponseSchema.safeParse({ skills: [detail] }).success).toBe(true);
    expect(SkillListResponseSchema.safeParse({ skills: [summary] }).success).toBe(false);
    expect(SkillListResponseSchema.safeParse([detail]).success).toBe(false);
    expect(SkillResponseSchema.safeParse({ skill: detail }).success).toBe(true);
    expect(SkillResponseSchema.safeParse(detail).success).toBe(false);
    const exported = {
      name: 'demo',
      files: [{ path: 'SKILL.md', contentBase64: skillMdBase64 }],
    };
    expect(SkillExportSchema.safeParse(exported).success).toBe(true);
    expect(SkillExportResponseSchema.safeParse({ skill: exported }).success).toBe(true);
    expect(SkillExportResponseSchema.safeParse(exported).success).toBe(false);
    expect(SkillExportSchema.safeParse({ ...exported, enabled: true }).success).toBe(false);
  });
});

describe('bounds and vocabulary', () => {
  it('publishes the name grammar, the path and body ceilings, and the required file name', () => {
    expect(SKILL_NAME_PATTERN.test('a')).toBe(true);
    expect(SKILL_NAME_PATTERN.test('my-skill-2')).toBe(true);
    expect(SKILL_NAME_PATTERN.test('-leading')).toBe(false);
    expect(SKILL_NAME_PATTERN.test('trailing-')).toBe(false);
    expect(SKILL_NAME_PATTERN.test('a'.repeat(SKILL_NAME_MAX_LENGTH))).toBe(true);
    expect(SKILL_NAME_PATTERN.test('a'.repeat(SKILL_NAME_MAX_LENGTH + 1))).toBe(false);
    expect(SKILL_FILE_PATH_MAX_BYTES).toBe(4096);
    expect(MAX_SKILL_REQUEST_BODY_BYTES).toBe(16 * 1024 * 1024);
    expect(SKILL_MD_FILENAME).toBe('SKILL.md');
    expect(SKILL_FILE_BASE64_PATTERN.test('YQ==')).toBe(true);
    expect(SKILL_FILE_BASE64_PATTERN.test('YQ')).toBe(false);
  });

  it('publishes built-in skill names that are valid skill names', () => {
    expect(BUILTIN_SKILL_NAMES).toContain('office-reader');
    for (const name of BUILTIN_SKILL_NAMES) expect(SKILL_NAME_PATTERN.test(name)).toBe(true);
    expect(isBuiltinSkillName('office-reader')).toBe(true);
    expect(isBuiltinSkillName('my-own-skill')).toBe(false);
  });

  it('maps every skills problem code to the status it travels under', () => {
    expect(SKILLS_PROBLEM_CODES.skill_not_found).toBe(404);
    expect(SKILLS_PROBLEM_CODES.skill_already_exists).toBe(409);
    expect(SKILLS_PROBLEM_CODES.colliding_paths).toBe(409);
    expect(SKILLS_PROBLEM_CODES.skills_runtime_not_configured).toBe(503);
    for (const status of Object.values(SKILLS_PROBLEM_CODES)) {
      expect([400, 404, 409, 500, 503]).toContain(status);
    }
  });
});

describe('skill revisions', () => {
  const revision = { number: 1, fileCount: 2, publishedAt: '2026-09-21T10:00:00.000Z' };
  const file = { path: 'SKILL.md', contentBase64: 'YQ==' };

  it('accepts a revision and its response, and refuses unknown keys or a number below 1', () => {
    expect(SkillRevisionSchema.parse(revision)).toEqual(revision);
    expect(SkillRevisionResponseSchema.parse({ revision })).toEqual({ revision });
    expect(SkillRevisionSchema.safeParse({ ...revision, number: 0 }).success).toBe(false);
    expect(SkillRevisionSchema.safeParse({ ...revision, number: 1.5 }).success).toBe(false);
    expect(SkillRevisionSchema.safeParse({ ...revision, extra: true }).success).toBe(false);
  });

  it('keeps a skill detail without revisions valid and lists revisions when present', () => {
    expect(SkillDetailSchema.safeParse(detail).success).toBe(true);
    expect(SkillDetailSchema.safeParse({ ...detail, revisions: [revision] }).success).toBe(true);
  });

  it('publishes from files only', () => {
    expect(PublishSkillRevisionRequestSchema.safeParse({ files: [file] }).success).toBe(true);
    expect(PublishSkillRevisionRequestSchema.safeParse({}).success).toBe(false);
    expect(PublishSkillRevisionRequestSchema.safeParse({ files: [file], x: 1 }).success).toBe(
      false,
    );
  });

  it('pins by an integer revision, never by the word latest', () => {
    expect(SkillRevisionPinsByIdSchema.safeParse({ 'skill-1': 3 }).success).toBe(true);
    expect(SkillRevisionPinsByNameSchema.safeParse({ triage: 3 }).success).toBe(true);
    for (const bad of [0, -1, 1.5, 'latest', null]) {
      expect(SkillRevisionPinsByIdSchema.safeParse({ 'skill-1': bad }).success).toBe(false);
      expect(SkillRevisionPinsByNameSchema.safeParse({ triage: bad }).success).toBe(false);
    }
    expect(SkillRevisionPinsByNameSchema.safeParse({ 'Not A Slug': 1 }).success).toBe(false);
  });

  it('bounds the number of pins', () => {
    const many = Object.fromEntries(
      Array.from({ length: SKILL_REVISION_PINS_MAX + 1 }, (_, i) => [`skill-${String(i)}`, 1]),
    );
    expect(SkillRevisionPinsByIdSchema.safeParse(many).success).toBe(false);
  });
});
