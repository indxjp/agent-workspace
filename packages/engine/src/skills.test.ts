/**
 * `skillPlacementVerdict` — the check that joins "the engine says where" to "the runner writes".
 *
 * The conformance kit drives this against whole adapters; these cases drive the five refusals
 * directly, because each of them is one specific way an adapter can be wrong and a scenario that
 * only reported "not conformant" would not say which.
 */
import { describe, expect, it } from 'vitest';

import {
  SKILL_PLACEMENT_REFUSALS,
  skillPlacementVerdict,
  skillsUnderConfigDirectory,
} from './skills.js';
import type { EngineSkillGrant } from './port.js';

const GRANTS: readonly EngineSkillGrant[] = [
  {
    name: 'invoice-review',
    files: [
      { path: 'SKILL.md', contentBase64: 'IyBJ' },
      { path: 'reference/rates.md', contentBase64: 'cg==' },
    ],
  },
  { name: 'document-writer', files: [{ path: 'SKILL.md', contentBase64: 'IyBX' }] },
];

const CONFIG = '.engine-config';

describe('skillsUnderConfigDirectory', () => {
  it('places one entry per granted file, under <config>/skills/<name>/', () => {
    expect(skillsUnderConfigDirectory(GRANTS, CONFIG)).toEqual([
      {
        skill: 'invoice-review',
        path: '.engine-config/skills/invoice-review/SKILL.md',
        contentBase64: 'IyBJ',
      },
      {
        skill: 'invoice-review',
        path: '.engine-config/skills/invoice-review/reference/rates.md',
        contentBase64: 'cg==',
      },
      {
        skill: 'document-writer',
        path: '.engine-config/skills/document-writer/SKILL.md',
        contentBase64: 'IyBX',
      },
    ]);
  });

  it('places nothing for a request that grants nothing', () => {
    expect(skillsUnderConfigDirectory([], CONFIG)).toEqual([]);
  });
});

describe('skillPlacementVerdict accepts a placement it can account for', () => {
  it('counts the files and reports their normalised paths', () => {
    const verdict = skillPlacementVerdict(
      skillsUnderConfigDirectory(GRANTS, CONFIG),
      GRANTS,
      CONFIG,
    );
    expect(verdict).toEqual({
      ok: true,
      files: 3,
      paths: [
        '.engine-config/skills/invoice-review/SKILL.md',
        '.engine-config/skills/invoice-review/reference/rates.md',
        '.engine-config/skills/document-writer/SKILL.md',
      ],
    });
  });

  it('accepts a layout that is not <config>/skills/, as long as it is inside the directory', () => {
    const verdict = skillPlacementVerdict(
      [{ skill: 'document-writer', path: `${CONFIG}/plugins/writer.md`, contentBase64: 'x' }],
      [GRANTS[1] as EngineSkillGrant],
      CONFIG,
    );
    expect(verdict.ok).toBe(true);
  });

  it('accepts a grant with no files at all without demanding a placement for it', () => {
    // A skill row with an empty file list is not something the platform composes, but the rule the
    // refusal states is about *dropping* files — so a grant with none is not a dropped skill.
    const verdict = skillPlacementVerdict([], [{ name: 'empty', files: [] }], CONFIG);
    expect(verdict).toEqual({ ok: true, files: 0, paths: [] });
  });
});

describe('skillPlacementVerdict names each way an adapter can be wrong', () => {
  it('lists every refusal it can answer with, so a caller can branch on them', () => {
    expect([...SKILL_PLACEMENT_REFUSALS]).toEqual([
      'unusable_path',
      'outside_config_directory',
      'unknown_skill',
      'duplicate_path',
      'skill_dropped',
    ]);
  });

  it('refuses a path that climbs out of the workspace', () => {
    expect(
      skillPlacementVerdict(
        [{ skill: 'document-writer', path: '../../etc/skill.md', contentBase64: 'x' }],
        [GRANTS[1] as EngineSkillGrant],
        CONFIG,
      ),
    ).toMatchObject({ ok: false, refusal: 'unusable_path' });
  });

  it('refuses a path inside the workspace but outside the declared directory', () => {
    expect(
      skillPlacementVerdict(
        [{ skill: 'document-writer', path: 'skills/document-writer/SKILL.md', contentBase64: 'x' }],
        [GRANTS[1] as EngineSkillGrant],
        CONFIG,
      ),
    ).toMatchObject({ ok: false, refusal: 'outside_config_directory' });
  });

  it('refuses a sibling directory whose name merely starts with the declared one', () => {
    // Compared segment by segment, never as a string prefix: `.engine-config-backup` starts with
    // `.engine-config` as text and is a different directory as a path.
    expect(
      skillPlacementVerdict(
        [{ skill: 'document-writer', path: `${CONFIG}-backup/SKILL.md`, contentBase64: 'x' }],
        [GRANTS[1] as EngineSkillGrant],
        CONFIG,
      ),
    ).toMatchObject({ ok: false, refusal: 'outside_config_directory' });
  });

  it('refuses the declared directory itself, which is a file where a directory belongs', () => {
    expect(
      skillPlacementVerdict(
        [{ skill: 'document-writer', path: CONFIG, contentBase64: 'x' }],
        [GRANTS[1] as EngineSkillGrant],
        CONFIG,
      ),
    ).toMatchObject({ ok: false, refusal: 'outside_config_directory' });
  });

  it('refuses a placement for a skill the request does not grant', () => {
    expect(
      skillPlacementVerdict(
        [{ skill: 'not-assigned', path: `${CONFIG}/skills/x/SKILL.md`, contentBase64: 'x' }],
        GRANTS,
        CONFIG,
      ),
    ).toMatchObject({ ok: false, refusal: 'unknown_skill' });
  });

  it('refuses two placements on one path, which would silently keep only the second', () => {
    const doubled = [
      { skill: 'document-writer', path: `${CONFIG}/skills/w/SKILL.md`, contentBase64: 'a' },
      { skill: 'document-writer', path: `${CONFIG}/skills/w/./SKILL.md`, contentBase64: 'b' },
    ];
    expect(skillPlacementVerdict(doubled, [GRANTS[1] as EngineSkillGrant], CONFIG)).toMatchObject({
      ok: false,
      refusal: 'duplicate_path',
    });
  });

  it('refuses a placement that drops a granted skill entirely', () => {
    const only = skillsUnderConfigDirectory([GRANTS[0] as EngineSkillGrant], CONFIG);
    expect(skillPlacementVerdict(only, GRANTS, CONFIG)).toMatchObject({
      ok: false,
      refusal: 'skill_dropped',
    });
  });

  it('refuses a placement whose path uses ".." to escape its own skill directory, rather than resolving it', () => {
    // `.engine-config/skills/document-writer/../../settings.json` normalises to
    // `.engine-config/settings.json` — still inside the declared directory, so `inside` alone would
    // accept it. The engine's own settings live there; a skill file must not be able to land on it.
    expect(
      skillPlacementVerdict(
        [
          {
            skill: 'document-writer',
            path: `${CONFIG}/skills/document-writer/../../settings.json`,
            contentBase64: 'x',
          },
        ],
        [GRANTS[1] as EngineSkillGrant],
        CONFIG,
      ),
    ).toMatchObject({ ok: false, refusal: 'unusable_path' });
  });

  it('refuses a backslash-spelled ".." segment the same way', () => {
    expect(
      skillPlacementVerdict(
        [
          {
            skill: 'document-writer',
            path: `${CONFIG}\\skills\\document-writer\\..\\..\\settings.json`,
            contentBase64: 'x',
          },
        ],
        [GRANTS[1] as EngineSkillGrant],
        CONFIG,
      ),
    ).toMatchObject({ ok: false, refusal: 'unusable_path' });
  });

  it('refuses a declared configuration directory that is not a usable path', () => {
    expect(skillPlacementVerdict([], [], '../escape')).toMatchObject({
      ok: false,
      refusal: 'outside_config_directory',
    });
  });
});
