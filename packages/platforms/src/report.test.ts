import { describe, expect, it } from 'vitest';

import { formatPlatformReport } from './report.js';

describe('formatPlatformReport', () => {
  it('lists the rows in report order with a count', () => {
    const text = formatPlatformReport('copilot-studio', [
      { path: 'a.name', verdict: 'native', note: 'kept' },
      { path: 'a.skills', verdict: 'dropped', code: 'skills_unsupported', note: 'no skills' },
      { path: 'a.model', verdict: 'mapped', note: 'renamed' },
    ]);
    const rows = text
      .split('\n')
      .filter(
        (line) => line.startsWith('| ') && !line.startsWith('| Field') && !line.startsWith('| ---'),
      );
    expect(rows).toStrictEqual([
      '| a.name | native |  | kept |',
      '| a.skills | dropped | skills_unsupported | no skills |',
      '| a.model | mapped |  | renamed |',
    ]);
    expect(text).toContain('1 native · 1 mapped · 1 dropped');
  });

  it('groups a multi-agent report under a Project section, then one section per agent', () => {
    const text = formatPlatformReport('gemini-enterprise', [
      { path: 'toolEndpoint', verdict: 'mapped', note: 'unused' },
      { path: 'root.model', verdict: 'mapped', note: 'a' },
      { path: 'sub.model', verdict: 'native', note: 'b' },
      { path: 'root.instructions', verdict: 'mapped', note: 'c' },
    ]);
    expect(text).toBe(
      [
        '# Platform report: gemini-enterprise',
        '',
        '## Project',
        '',
        '| Field | Verdict | Code | Why |',
        '| --- | --- | --- | --- |',
        '| toolEndpoint | mapped |  | unused |',
        '',
        '## Agent `root`',
        '',
        '| Field | Verdict | Code | Why |',
        '| --- | --- | --- | --- |',
        '| model | mapped |  | a |',
        '| instructions | mapped |  | c |',
        '',
        '## Agent `sub`',
        '',
        '| Field | Verdict | Code | Why |',
        '| --- | --- | --- | --- |',
        '| model | native |  | b |',
        '',
        '1 native · 3 mapped · 0 dropped',
        '',
      ].join('\n'),
    );
  });

  it('omits the Project section when no project-level field is reported', () => {
    const text = formatPlatformReport('gemini-enterprise', [
      { path: 'a.model', verdict: 'mapped', note: 'x' },
      { path: 'b.model', verdict: 'mapped', note: 'y' },
    ]);
    expect(text).not.toContain('## Project');
    expect(text).toContain('## Agent `a`\n\n| Field');
  });

  it('escapes a pipe and a newline in a note', () => {
    const text = formatPlatformReport('copilot-studio', [
      { path: 'a.x', verdict: 'native', note: 'a|b\nc' },
    ]);
    expect(text).toContain('| a.x | native |  | a\\|b c |');
  });

  it('summarises an empty report', () => {
    expect(formatPlatformReport('copilot-studio', [])).toContain('0 native · 0 mapped · 0 dropped');
  });
});
