import { describe, expect, it } from 'vitest';

import { FEATURE_IDS } from '@indx-workspace/contracts/features';
import { CompleteSetupAnswersSchema, SETUP_THEMES } from '@indx-workspace/contracts/setup';

import { parseProjectFile } from './parse.js';
import { renderProjectFiles } from './render.js';
import { contentsOf, recommended, rendered } from './render.test-support.js';

describe('platforms (#977)', () => {
  const TWO = ['copilot-studio', 'claude-managed-agents'] as const;

  it.each(SETUP_THEMES)(
    'writes no platform file or text when none is chosen, theme %s',
    (theme) => {
      const files = rendered({ 'setup.theme': theme });
      for (const { path, contents } of files) {
        expect(contents, path).not.toContain('platforms');
      }
      expect(files.some((file) => file.path === 'README.md')).toBe(theme !== 'blank');
    },
  );

  it('writes the platforms block in PLATFORM_IDS order, and a project file that reads back', () => {
    const files = rendered({ 'setup.theme': 'support', 'admin.platforms': TWO });
    const text = contentsOf(files, 'agent-workspace.yaml');
    expect(text).toContain(
      'platforms:\n  claude-managed-agents:\n    enabled: true\n  copilot-studio:\n    enabled: true\n',
    );
    expect(parseProjectFile(text).project).toMatchObject({
      platforms: {
        'claude-managed-agents': { enabled: true },
        'copilot-studio': { enabled: true },
      },
    });
  });

  it("appends the section to the starter's README.md, with the commands of each platform", () => {
    const without = contentsOf(rendered({ 'setup.theme': 'support' }), 'README.md');
    const readme = contentsOf(
      rendered({ 'setup.theme': 'support', 'admin.platforms': TWO }),
      'README.md',
    );
    expect(readme.startsWith(`${without}\n## Publish to other agent platforms\n\n`)).toBe(true);
    expect(readme).toContain('`agents/assistant.ts` stays the one definition');
    expect(readme).toContain(
      'npx aw platforms export --platform claude-managed-agents    # writes platforms/claude-managed-agents/ and PLATFORM_REPORT.md; sends nothing\n' +
        'npx aw platforms publish --platform claude-managed-agents   # shows the plan; add --yes to publish with your own vendor login\n' +
        'npx aw platforms export --platform copilot-studio           # writes platforms/copilot-studio/ and PLATFORM_REPORT.md; sends nothing\n' +
        'npx aw platforms publish --platform copilot-studio          # shows the plan; add --yes to publish with your own vendor login\n' +
        'npx aw platforms doctor                                     # checks every enabled platform and its vendor CLI\n',
    );
    expect(readme.match(/aw platforms doctor/gu)).toHaveLength(1);
    expect(readme.endsWith('add `--strict` to `export` to fail instead.\n')).toBe(true);
  });

  it('adds a README.md for the blank theme, which has none', () => {
    const without = rendered({ 'setup.theme': 'blank' }).map((file) => file.path);
    const files = rendered({ 'setup.theme': 'blank', 'admin.platforms': ['aws-agentcore'] });
    expect(files.map((file) => file.path)).toStrictEqual([
      ...without.slice(0, 3),
      'README.md',
      'AGENTS.md',
    ]);
    expect(contentsOf(files, 'README.md')).toMatch(
      /^# assistant\n\n## Publish to other agent platforms\n\n/u,
    );
  });

  it('ends AGENTS.md with the section naming the platforms in PLATFORM_IDS order', () => {
    const agents = contentsOf(
      rendered({ 'setup.theme': 'support', 'admin.platforms': TWO }),
      'AGENTS.md',
    );
    const base = contentsOf(rendered({ 'setup.theme': 'support' }), 'AGENTS.md');
    expect(agents.startsWith(`${base}\n## Other agent platforms\n`)).toBe(true);
    expect(agents).toContain('(claude-managed-agents, copilot-studio)');
    expect(agents.endsWith('Never put a credential on the command line or in a file.\n')).toBe(
      true,
    );
  });

  it.each(SETUP_THEMES)('writes no .agent.md for theme %s', (theme) => {
    const files = rendered({ 'setup.theme': theme, 'admin.platforms': TWO });
    expect(files.some((file) => file.path.endsWith('.agent.md'))).toBe(false);
  });
});

describe('features (ADR-0160 D5)', () => {
  it('writes the chosen features in FEATURE_IDS order, and a project file that reads back', () => {
    const text = contentsOf(
      rendered({ 'admin.features': ['runs', 'files', 'chat'] }),
      'agent-workspace.yaml',
    );
    expect(text).toContain('features:\n  - chat\n  - files\n  - runs\n');
    expect(parseProjectFile(text).project).toMatchObject({ features: ['chat', 'files', 'runs'] });
  });

  it('writes no features key for the default answer or for every feature', () => {
    for (const answers of [{}, { 'admin.features': FEATURE_IDS }] as const) {
      const text = contentsOf(rendered(answers), 'agent-workspace.yaml');
      expect(text).not.toContain('features');
    }
  });

  it('writes no features key when the answer is absent', () => {
    const absent = renderProjectFiles(
      CompleteSetupAnswersSchema.parse(
        Object.fromEntries(Object.entries(recommended).filter(([id]) => id !== 'admin.features')),
      ),
      { name: 'my-project' },
    );
    expect(contentsOf(absent, 'agent-workspace.yaml')).not.toContain('features');
  });
});
