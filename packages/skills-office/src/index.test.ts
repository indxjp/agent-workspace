import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { bundleSkills, bundleText } from '../scripts/bundle.mjs';
import { builtinSkillFiles } from './index.mjs';

describe('builtinSkillFiles', () => {
  it('is current with every skill directory (run `node scripts/bundle.mjs` in this package to refresh)', () => {
    expect(readFileSync(new URL('./skills.json', import.meta.url), 'utf8')).toBe(bundleText());
  });

  it('lists the office-reader skill: SKILL.md, its scripts and the modules a use case imports, without types', () => {
    const files = builtinSkillFiles('office-reader');
    expect(files.map((file) => file.path)).toStrictEqual([
      'SKILL.md',
      'scripts/dxf.mjs',
      'scripts/lib/cli.mjs',
      'scripts/lib/public-source.mjs',
      'scripts/lib/table.mjs',
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

  it('bundles office-writer: SKILL.md, the one callable script and its modules, without types', () => {
    const files = bundleSkills()['office-writer'] ?? [];
    expect(files.map((file) => file.path)).toStrictEqual([
      'SKILL.md',
      'scripts/lib/docx.mjs',
      'scripts/lib/model.mjs',
      'scripts/lib/package.mjs',
      'scripts/lib/pptx.mjs',
      'scripts/lib/xlsx.mjs',
      'scripts/write.mjs',
    ]);
    const skill = files.find((file) => file.path === 'SKILL.md')?.content ?? '';
    expect(skill).toMatch(
      /^---\nname: office-writer\ndescription: .*Word.*PowerPoint.*Excel.*\n---\n/u,
    );
    expect(skill).toContain('"script": "write.mjs"');
  });
});
