import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { bundleText } from '../scripts/bundle.mjs';
import { builtinSkillFiles } from './index.mjs';

describe('builtinSkillFiles', () => {
  it('is current with office-reader/ (run `node scripts/bundle.mjs` in this package to refresh)', () => {
    expect(readFileSync(new URL('./skills.json', import.meta.url), 'utf8')).toBe(bundleText());
  });

  it('lists the office-reader skill: SKILL.md and its scripts, without the type declarations', () => {
    const files = builtinSkillFiles('office-reader');
    expect(files.map((file) => file.path)).toStrictEqual([
      'SKILL.md',
      'scripts/dxf.mjs',
      'scripts/ooxml.mjs',
      'scripts/pdf.mjs',
    ]);
  });

  it('names the skill in its frontmatter and describes all four formats', () => {
    const skill = builtinSkillFiles('office-reader').find((file) => file.path === 'SKILL.md');
    const text = Buffer.from(skill?.contentBase64 ?? '', 'base64').toString('utf8');
    expect(text).toMatch(
      /^---\nname: office-reader\ndescription: .*PDF.*Excel.*Word.*DXF.*\n---\n/u,
    );
    for (const script of ['pdf.mjs', 'ooxml.mjs', 'dxf.mjs']) expect(text).toContain(script);
  });
});
