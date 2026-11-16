import { symlink } from 'node:fs/promises';

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  agentFile,
  instructionsOf,
  io,
  load,
  markdownAgent,
  project,
} from './load.fixture.test-support.js';

import { loadProject } from './load.js';
describe('the loader reads agents/*.agent.md beside agents/*.ts (ADR-0166 D12)', () => {
  it('loads an installed agents/<name>.agent.md as an agent, beside a .ts agent', async () => {
    const root = await project({
      'agents/support.ts': agentFile('support', ''),
      'agents/triage.agent.md': markdownAgent('triage'),
    });
    const result = await load(root);
    expect(result.problems).toEqual([]);
    expect(result.agents.map((agent) => [agent.name, agent.file])).toEqual([
      ['support', 'agents/support.ts'],
      ['triage', 'agents/triage.agent.md'],
    ]);
    expect(instructionsOf(result, 'triage')).toBe('Route the request.');
  });

  it('loads a project whose only agents are .agent.md files, with a surface naming one', async () => {
    const root = await project({
      'agents/triage.agent.md': markdownAgent('triage'),
      'surfaces/main.ts': `import { defineSurface } from '@indx-workspace/sdk/define';
export default defineSurface({ name: 'main', agent: 'triage' });
`,
    });
    const result = await load(root);
    expect(result.problems).toEqual([]);
    expect(result.agents.map((agent) => agent.name)).toEqual(['triage']);
    expect(result.agents[0]?.surfaceFiles).toEqual(['surfaces/main.ts']);
  });

  it('refuses a name defined both as agents/<name>.ts and agents/<name>.agent.md', async () => {
    const root = await project({
      'agents/triage.ts': agentFile('triage', ''),
      'agents/triage.agent.md': markdownAgent('triage'),
    });
    const result = await load(root);
    expect(result.agents.map((agent) => agent.file)).toEqual(['agents/triage.ts']);
    expect(result.problems).toEqual([
      {
        file: 'agents/triage.agent.md',
        status: null,
        code: 'agent_defined_twice',
        details: ['agents/triage.ts also defines triage; keep one of the two files'],
      },
    ]);
  });

  it('refuses an .agent.md whose agent a .ts file of another name also defines', async () => {
    const root = await project({
      'agents/support.ts': agentFile('triage', ''),
      'agents/triage.agent.md': markdownAgent('triage'),
    });
    const result = await load(root);
    expect(result.problems.map((problem) => [problem.file, problem.code])).toEqual([
      ['agents/triage.agent.md', 'agent_name_duplicate'],
    ]);
  });

  it('refuses a conversion that would drop a field (ADR-0133 D5)', async () => {
    const root = await project({
      'agents/triage.agent.md': markdownAgent('triage', {
        tools: [{ kind: 'mcp', name: 'git', transport: 'stdio', command: 'git-mcp' }],
      }),
    });
    const result = await load(root);
    expect(result.agents).toEqual([]);
    expect(result.problems).toEqual([
      {
        file: 'agents/triage.agent.md',
        status: null,
        code: 'agent_conversion_lossy',
        details: [
          'tools.0: Agent Workspace project files name remote connectors only (http or sse)',
        ],
      },
    ]);
  });

  it('refuses an .agent.md that is not one, or that names another agent', async () => {
    const root = await project({
      'agents/broken.agent.md': 'no front matter\n',
      'agents/triage.agent.md': markdownAgent('support'),
    });
    const result = await load(root);
    expect(result.agents).toEqual([]);
    expect(result.problems.map((problem) => [problem.file, problem.code])).toEqual([
      ['agents/broken.agent.md', 'agent_markdown_invalid'],
      ['agents/triage.agent.md', 'agent_markdown_invalid'],
    ]);
    expect(result.problems[1]?.details).toEqual([
      'the file defines the agent support; name it agents/support.agent.md',
    ]);
  });

  it('refuses an .agent.md linked from outside the project', async () => {
    const outside = await project({ 'triage.agent.md': markdownAgent('triage') });
    const root = await project({ 'agents/support.ts': agentFile('support', '') });
    await symlink(
      path.join(outside, 'triage.agent.md'),
      path.join(root, 'agents', 'triage.agent.md'),
    );
    const result = await load(root);
    expect(result.agents.map((agent) => agent.name)).toEqual(['support']);
    expect(result.problems).toEqual([
      {
        file: 'agents/triage.agent.md',
        status: null,
        code: 'file_link_refused',
        details: ['the link points outside the project'],
      },
    ]);
  });

  it('leaves .agent.md files to aw platforms when asked to', async () => {
    const root = await project({
      'agents/support.ts': agentFile('support', ''),
      'agents/triage.agent.md': markdownAgent('triage'),
    });
    const result = await loadProject({
      root,
      io,
      signal: new AbortController().signal,
      agentMarkdown: false,
    });
    expect(result.problems).toEqual([]);
    expect(result.agents.map((agent) => agent.name)).toEqual(['support']);
  });
});
