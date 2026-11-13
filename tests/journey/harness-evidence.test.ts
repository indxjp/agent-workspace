import { failureOf, KEY, AGENT_SOURCE, HERE, ROOT } from './harness-fixtures.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { withRecommendedAnswers } from '@indx-workspace/contracts/setup';
import { renderProjectFiles } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';
import {
  agentIdOf,
  agentNameOfSource,
  mcpAgentSource,
  redact,
  toolAgentSource,
} from './harness.mjs';
import { PLAYWRIGHT_IMAGE, VERDACCIO_IMAGE } from './run.mjs';

describe('redaction', () => {
  it('replaces every occurrence of the fake key', () => {
    expect(redact(`key=${KEY}\nagain ${KEY}`, KEY)).toBe('key=<fake key>\nagain <fake key>');
  });

  it('leaves the text alone for a blank secret', () => {
    expect(redact('nothing secret', '')).toBe('nothing secret');
  });
});

describe('the untimed checks read what aw prints', () => {
  it('moves the rendered agent to engine pi with one mcp() tool', () => {
    const source = mcpAgentSource(AGENT_SOURCE, 'journey-mcp');
    expect(source).toContain("import { defineAgent, mcp } from '@indx-workspace/sdk/define';");
    expect(source).toContain("  engine: 'pi',\n  tools: [mcp('journey-mcp')],\n");
    expect(source).not.toContain('claude-agent-sdk');
    expect(agentNameOfSource(source)).toBe('assistant');
  });

  it('edits the real rendered support-starter agent, which also imports skill', () => {
    const file = renderProjectFiles(withRecommendedAnswers({ 'setup.theme': 'support' }), {
      name: 'demo',
    }).find((f) => f.path.startsWith('agents/'));
    const rendered = String(file?.contents);
    expect(rendered).toContain('import { defineAgent, skill } from');
    const mcpSource = mcpAgentSource(rendered, 'journey-mcp');
    expect(mcpSource).toContain(
      "import { defineAgent, skill, mcp } from '@indx-workspace/sdk/define';",
    );
    expect(mcpSource).toContain("  tools: [mcp('journey-mcp')],");
    expect(toolAgentSource(rendered)).toContain("import ordersTool from '../tools/orders';");
  });

  it('refuses an agent file that is not the renderer output', () => {
    expect(failureOf(() => mcpAgentSource('export default {};\n', 'journey-mcp')).message).toBe(
      'the agent file is not the renderer output (import and engine line)',
    );
  });

  it('finds the agent id by name', () => {
    const listing = JSON.stringify([
      { id: 'agt_1', name: 'helper' },
      { id: 'agt_2', name: 'assistant' },
    ]);
    expect(agentIdOf(listing, 'assistant')).toBe('agt_2');
    expect(failureOf(() => agentIdOf(listing, 'missing')).message).toBe(
      'the workspace has no agent named missing',
    );
  });
});

describe('regressions: the pinned images and the registry config', () => {
  it('runs the Playwright image of the root @playwright/test version', () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    const version = manifest.devDependencies['@playwright/test'];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(
      PLAYWRIGHT_IMAGE.startsWith(`mcr.microsoft.com/playwright:v${String(version)}-noble@`),
    ).toBe(true);
  });

  it('pins both images by digest', () => {
    for (const image of [PLAYWRIGHT_IMAGE, VERDACCIO_IMAGE]) {
      expect(image).toMatch(/^[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/u);
    }
  });

  it('keeps @indx-workspace/* local with no proxy, and proxies the rest to npmjs', () => {
    const config = readFileSync(path.join(HERE, 'verdaccio.yaml'), 'utf8');
    const blocks = new Map<string, string[]>();
    let current: string[] | undefined;
    for (const line of config.split('\n')) {
      const key = /^ {2}'([^']+)':$/u.exec(line)?.[1];
      if (key !== undefined) {
        current = [];
        blocks.set(key, current);
      } else if (/^ {4}\S/u.test(line)) current?.push(line.trim());
      else current = undefined;
    }
    const scope = blocks.get('@indx-workspace/*');
    expect(scope).toBeDefined();
    expect(scope?.some((line) => line.startsWith('proxy:'))).toBe(false);
    expect(scope).toContain('access: $all');
    expect(scope).toContain('publish: $authenticated');
    expect(blocks.get('**')).toContain('proxy: npmjs');
    expect([...blocks.keys()][0]).toBe('@indx-workspace/*');
    expect(config).toMatch(/^max_body_size: 300mb$/mu);
    expect(config).toMatch(/^ {4}max_users: 1$/mu);
  });
});
