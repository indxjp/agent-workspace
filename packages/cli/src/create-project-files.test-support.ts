import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SETUP_QUESTIONS, withRecommendedAnswers } from '@indx-workspace/contracts/setup';
import { renderProjectFiles, renderProjectShell } from '@indx-workspace/sdk/project';
import { describe, expect, it, vi } from 'vitest';
import { createProject, runAsProcess } from './create.js';
import { CLI_VERSION } from './version.js';
import { create, captureStdout } from './create-test-fixtures.test-support.js';
import {
  V2_FILES,
  targetIn,
  listTree,
  scriptedTerminal,
} from './create-project-fixtures.test-support.js';

export function describeCreateProjectFiles(): void {
  describe('create writes a v2 project by default (S1-16)', () => {
    it('prints every setup flag for --help', async () => {
      const output = captureStdout();
      await create(['--help']);
      for (const question of SETUP_QUESTIONS) expect(output()).toContain(`--${question.flag} <`);
    });

    it('writes the platforms block and the README section for --platform (#977)', async () => {
      const target = await targetIn('acme-ai');
      captureStdout();
      vi.stubEnv('ANTHROPIC_API_KEY', 'set');

      await create([target, '--yes', '--no-install', '--platform', 'claude-managed-agents']);

      expect(await listTree(target)).toEqual([...V2_FILES].sort());
      expect(await readFile(path.join(target, 'agent-workspace.yaml'), 'utf8')).toContain(
        'platforms:\n  claude-managed-agents:\n    enabled: true\n',
      );
      expect(await readFile(path.join(target, 'README.md'), 'utf8')).toContain(
        '## Publish to other agent platforms',
      );
      expect(await readFile(path.join(target, 'AGENTS.md'), 'utf8')).toContain(
        '## Other agent platforms',
      );
    });

    it('refuses a platform setup does not offer as a usage error, writing no directory (#977)', async () => {
      const target = await targetIn('acme-ai');
      const written: string[] = [];

      const status = await runAsProcess(
        () => create([target, '--yes', '--no-install', '--platform', 'eject-mastra']),
        (chunk) => written.push(chunk),
      );

      expect(status).toBe(2);
      expect(written.join('')).toContain(
        '--platform: ["eject-mastra"] is not accepted: up to 6 of claude-managed-agents, copilot-studio, m365-declarative-agent, microsoft-foundry, gemini-enterprise, aws-agentcore, none, separated by commas',
      );
      expect(existsSync(target)).toBe(false);
    });

    it('refuses --platform with --cloud (#977)', async () => {
      const target = await targetIn('acme-ai');
      await expect(
        create([target, '--cloud', 'gcp', '--platform', 'copilot-studio']),
      ).rejects.toThrow(/setup flags/u);
      expect(existsSync(target)).toBe(false);
    });

    it('writes the six files of the golden project with --yes', async () => {
      const target = await targetIn('acme-ai');
      const output = captureStdout();
      vi.stubEnv('ANTHROPIC_API_KEY', 'set');

      await create([target, '--yes', '--no-install']);

      const name = 'acme-ai';
      const answers = withRecommendedAnswers({});
      const expected = [
        ...renderProjectShell({ name, version: CLI_VERSION, engine: answers['content.engine'] }),
        ...renderProjectFiles(answers, { name, version: CLI_VERSION }),
      ];
      expect(expected.map((file) => file.path)).toEqual(V2_FILES);
      expect(await listTree(target)).toEqual([...V2_FILES].sort());
      for (const file of expected) {
        expect(await readFile(path.join(target, file.path), 'utf8'), file.path).toBe(file.contents);
      }
      const manifest = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8')) as {
        name?: string;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        allowScripts?: Record<string, boolean>;
      };
      expect(manifest).toMatchObject({
        name: 'acme-ai',
        scripts: { dev: 'aw dev' },
        dependencies: {
          '@indx-workspace/aw': CLI_VERSION,
          '@indx-workspace/embedded': CLI_VERSION,
          '@indx-workspace/sdk': CLI_VERSION,
        },
        // npm 11's install-script policy (issue #689); the list itself is pinned in the sdk.
        allowScripts: { '@embedded-postgres/linux-x64': true, protobufjs: false },
      });

      const text = output();
      expect(text).toContain(`Created ${target}\n`);
      for (const file of V2_FILES) expect(text).toContain(`  ${file}\n`);
      expect(text).toContain(`Next steps:\n  cd ${target}\n  npm install\n  npm run dev\n`);
      expect(text).toContain('aw dev reads ANTHROPIC_API_KEY from its environment');
      // The recommended theme, support, writes its greeting (#543).
      expect(await readFile(path.join(target, 'surfaces/main.ts'), 'utf8')).toContain(
        "greeting: 'Hi! How can I help you today?',",
      );
      expect(text).not.toContain('Host runtime detected');
      expect(text).not.toContain('One-time setup password');
    });

    it('writes the same three starter files `aw init --yes` writes', async () => {
      const target = await targetIn('Acme AI');
      const result = await createProject(target, withRecommendedAnswers({}));

      expect(result.destination).toBe(path.resolve(target));
      expect(result.files).toEqual(V2_FILES);
      for (const file of renderProjectFiles(withRecommendedAnswers({}), { name: 'acme-ai' })) {
        expect(await readFile(path.join(target, file.path), 'utf8'), file.path).toBe(file.contents);
      }
    });

    it('asks the setup questions on a terminal, re-asks a refused answer, and writes on yes', async () => {
      const target = await targetIn('support');
      const output = captureStdout();
      const { terminal, asked } = scriptedTerminal([
        '',
        'local',
        '',
        'helpdesk',
        '',
        'none,openapi',
        'openapi',
        'apis/orders.openapi.json',
        'readFiles',
        'Support Desk',
        'blue',
        '#112233',
        '',
        '',
        'y',
      ]);

      await create([target], { terminal });

      // Thirteen questions, the refused tools and colour asked twice, then the confirmation.
      expect(asked).toHaveLength(15);
      expect(asked[0]).toBe(
        'Which theme should setup start from? (support | copilot | knowledge | automation | review | blank) [support] ',
      );
      expect(asked[1]).toBe('Where should agents run their tools? (auto | local) [auto] ');
      expect(asked[5]).toBe(
        'Which internal tools should the agent call? (openapi | postgres | none; comma-separated) [none] ',
      );
      expect(asked[6]).toBe(asked[5]);
      expect(asked[7]).toContain('Where is the OpenAPI document?');
      expect(asked[8]).toMatch(/^Which permissions should the agent have\? \(.*\) \[\] $/u);
      expect(asked[9]).toContain('(1-60 characters, no control or invisible characters');
      expect(asked[10]).toContain('[#2f5fd0]');
      expect(asked[11]).toBe(asked[10]);
      // The seven files, AGENTS.md, the OpenAPI tool (#543) and the example skill (#694).
      expect(asked[12]).toBe(
        'Which agent platforms should this agent also be published to? (claude-managed-agents | copilot-studio | m365-declarative-agent | microsoft-foundry | gemini-enterprise | aws-agentcore | none; comma-separated) [none] ',
      );
      expect(asked[13]).toBe(
        'Which features should this deployment include? (chat | projects | files | skills | connectors | runs | sharing | surfaces | triggers | evaluations | builder; comma-separated) [chat,projects,files,skills,connectors,runs,sharing,surfaces,triggers,evaluations,builder] ',
      );
      expect(asked[14]).toBe(`write these 11 files into ${target}? [y/N] `);
      expect(output()).toContain(
        '["none","openapi"] is not accepted: up to 2 of openapi, postgres, none, separated by commas; none must be chosen alone',
      );
      expect(output()).toContain('"blue" is not accepted: a hex colour');

      const answers = withRecommendedAnswers({
        'admin.sandbox': 'local',
        'content.agentName': 'helpdesk',
        'content.internalTools': ['openapi'],
        'content.openapiDocument': 'apis/orders.openapi.json',
        'content.permissions': ['readFiles'],
        'embedder.surfaceTitle': 'Support Desk',
        'embedder.brandColour': '#112233',
      });
      for (const file of renderProjectFiles(answers, { name: 'support' })) {
        expect(await readFile(path.join(target, file.path), 'utf8'), file.path).toBe(file.contents);
      }
      const surface = await readFile(path.join(target, 'surfaces/main.ts'), 'utf8');
      expect(surface).toContain("title: 'Support Desk'");
      expect(surface).toContain('#112233');
      expect(existsSync(path.join(target, 'agents/helpdesk.ts'))).toBe(true);
      expect(await readFile(path.join(target, 'tools/orders.ts'), 'utf8')).toContain(
        "auth: secret('ORDERS_TOKEN')",
      );
      expect(output()).toContain(
        'aw dev reads ANTHROPIC_API_KEY, ORDERS_TOKEN from its environment; no key is written',
      );
    });

    it('writes nothing when the file list is declined', async () => {
      const target = await targetIn('declined');
      const output = captureStdout();
      const { terminal } = scriptedTerminal([...Array<string>(11).fill(''), 'n']);

      await create([target], { terminal });

      expect(output()).toContain('create will write:\n  package.json\n');
      expect(output()).toContain('nothing written\n');
      expect(existsSync(target)).toBe(false);
    });
  });
}
