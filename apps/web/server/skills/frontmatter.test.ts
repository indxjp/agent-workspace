import { describe, expect, it } from 'vitest';

import { extractSkillInstructions, parseSkillFrontmatter } from './frontmatter';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('parseSkillFrontmatter', () => {
  it('reads name and description out of the minimal valid skill from R-01 §8', () => {
    const skillMd = [
      '---',
      'name: security-check',
      'description: Run a security vulnerability scan',
      '---',
      '',
      'Analyze the codebase for security vulnerabilities including:',
      '- SQL injection risks',
      '- Exposed credentials',
      '',
    ].join('\n');
    expect(parseSkillFrontmatter(utf8(skillMd))).toEqual({
      name: 'security-check',
      description: 'Run a security vulnerability scan',
    });
  });

  it('strips one layer of matching quotes from a value', () => {
    const skillMd = '---\nname: "quoted-name"\ndescription: \'quoted description\'\n---\nbody\n';
    expect(parseSkillFrontmatter(utf8(skillMd))).toEqual({
      name: 'quoted-name',
      description: 'quoted description',
    });
  });

  it('returns {} for a file with no frontmatter block at all', () => {
    expect(parseSkillFrontmatter(utf8('# Just a heading\n\nNo frontmatter here.\n'))).toEqual({});
  });

  it('returns {} for an unterminated frontmatter block', () => {
    expect(
      parseSkillFrontmatter(utf8('---\nname: unterminated\n\nbody with no closing fence\n')),
    ).toEqual({});
  });

  it('ignores fields it does not recognise, keeps only the first of a repeated key, and reads allowed-tools', () => {
    const skillMd = [
      '---',
      'name: first-name',
      'name: second-name',
      'allowed-tools: Read, Write',
      'description: only description',
      'license: MIT',
      '---',
      'body',
      '',
    ].join('\n');
    expect(parseSkillFrontmatter(utf8(skillMd))).toEqual({
      name: 'first-name',
      description: 'only description',
      allowedTools: ['Read', 'Write'],
    });
  });

  it('splits a space-separated allowed-tools value too, and keeps only the first of a repeated key', () => {
    const skillMd =
      '---\nname: n\nallowed-tools: Read Grep Bash\nallowed-tools: Write\n---\nbody\n';
    expect(parseSkillFrontmatter(utf8(skillMd))).toEqual({
      name: 'n',
      allowedTools: ['Read', 'Grep', 'Bash'],
    });
  });

  it('returns {} rather than throwing on bytes that are not valid UTF-8', () => {
    const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0x00, 0x00]);
    expect(parseSkillFrontmatter(invalidUtf8)).toEqual({});
  });

  it('tolerates CRLF line endings in the frontmatter block', () => {
    const skillMd = '---\r\nname: crlf-skill\r\ndescription: has CRLF endings\r\n---\r\nbody\r\n';
    expect(parseSkillFrontmatter(utf8(skillMd))).toEqual({
      name: 'crlf-skill',
      description: 'has CRLF endings',
    });
  });

  it('handles a UTF-8 BOM at the very start of the file', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('---\nname: bom\n---\nbody\n')]);
    expect(parseSkillFrontmatter(withBom)).toEqual({ name: 'bom' });
  });
});

describe('extractSkillInstructions', () => {
  it('returns the Markdown body after the frontmatter fence', () => {
    const skillMd = [
      '---',
      'name: security-check',
      'description: Run a security vulnerability scan',
      '---',
      '',
      'Analyze the codebase for security vulnerabilities including:',
      '- SQL injection risks',
      '',
    ].join('\n');
    expect(extractSkillInstructions(utf8(skillMd))).toBe(
      '\nAnalyze the codebase for security vulnerabilities including:\n- SQL injection risks\n',
    );
  });

  it('returns the whole decoded text when there is no recognised frontmatter block', () => {
    const skillMd = '# Just a heading\n\nNo frontmatter here.\n';
    expect(extractSkillInstructions(utf8(skillMd))).toBe(skillMd);
  });

  it('returns the whole decoded text for an unterminated frontmatter block, same as parseSkillFrontmatter', () => {
    const skillMd = '---\nname: unterminated\n\nbody with no closing fence\n';
    expect(extractSkillInstructions(utf8(skillMd))).toBe(skillMd);
  });

  it('strips a UTF-8 BOM before deciding whether a frontmatter fence is present', () => {
    const withBom = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...utf8('---\nname: bom\n---\ninstructions\n'),
    ]);
    expect(extractSkillInstructions(withBom)).toBe('instructions\n');
  });

  it('returns null rather than throwing on bytes that are not valid UTF-8', () => {
    const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0x00, 0x00]);
    expect(extractSkillInstructions(invalidUtf8)).toBeNull();
  });
});
