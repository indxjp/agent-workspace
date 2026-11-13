import { failureOf, ROOT } from './harness-fixtures.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { firstHourSummaryMarkdown, quickstartCommands } from './harness.mjs';

describe('the first-hour stopwatch helpers (issue #700)', () => {
  it('reads the quickstart commands as the page writes them', () => {
    const page = readFileSync(
      path.join(ROOT, 'docs', 'sdk', 'site', 'getting-started', 'quickstart.mdx'),
      'utf8',
    );
    const commands = quickstartCommands(page);
    expect(commands.map((command) => command.split(' ').slice(0, 3).join(' '))).toEqual([
      'npm create @indx-workspace@latest',
      'cd my-agent',
      'npm run dev',
    ]);
    expect(commands[0]).toMatch(/^npm create @indx-workspace@\S+ my-agent -- --yes$/u);
    expect(commands.some((command) => command.startsWith('export '))).toBe(false);
    expect(commands.every((command) => !command.includes('#'))).toBe(true);
    expect(quickstartCommands('x\n```sh\n# c\na && b  # d\n```\n')).toEqual(['a', 'b']);
    // The docs-claims marker on the fence does not hide the block.
    expect(quickstartCommands('x\n```sh title="t" claim="run"\na && b\n```\n')).toEqual(['a', 'b']);
    // Only a placeholder export (value ending in `...`) is dropped; a real one is a command.
    expect(quickstartCommands('x\n```sh\nexport K=sk-ant-...\nexport A=1\nnpm i\n```\n')).toEqual([
      'export A=1',
      'npm i',
    ]);
    expect(failureOf(() => quickstartCommands('no block')).message).toMatch(/no ```sh block/u);
  });

  it('summarises timed and pending steps', () => {
    const markdown = firstHourSummaryMarkdown([
      { id: 'T2', name: 'npm install', seconds: 44, targetSeconds: 30 },
      { id: 'T3', name: 'aw dev ready', seconds: 6.4, targetSeconds: 15 },
      { id: 'T4', name: 'aw chat', pending: 'FH-10' },
    ]);
    expect(markdown).toContain('| T2 npm install | 44.0 | 30 | over target |');
    expect(markdown).toContain('| T3 aw dev ready | 6.4 | 15 | timed |');
    expect(markdown).toContain('| T4 aw chat | |  | pending FH-10 |');
  });
});
