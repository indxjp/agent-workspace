import { CreateAgentFromVersionRequestSchema } from '@indx-workspace/contracts/agent-versions';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { EXIT_CODE } from '../output.js';
import { FIXTURES, json, stdoutJson, tempFile, type Route } from '../testing.js';
import {
  agentFile,
  aw,
  emptyServer,
  missingReferences,
  project,
  type RecordedRequest,
  requests,
  server,
  SKILL_AGENT,
  writes,
} from './project.fixture.test-support.js';

export function describeProjectCheckSkills(): void {
  const SKILL_MD = '---\nname: refunds\ndescription: Refund policy.\n---\n\nBe kind.\n';

  function withSkills(...names: readonly string[]): Route {
    const inner = server(emptyServer());
    return (request: RecordedRequest) => {
      const { pathname } = request.url;
      if (pathname === '/api/skills') {
        return json(200, { skills: names.map((name) => ({ ...FIXTURES.skill, name })) });
      }
      if (pathname.startsWith('/api/skills/')) {
        return json(200, { skill: { name: pathname.split('/').pop(), files: [] } });
      }
      if (request.method === 'POST' && pathname === '/api/agents') {
        // Like the server's dry run: a version naming a skill the workspace lacks is refused.
        const skills = CreateAgentFromVersionRequestSchema.parse(request.json).version.body
          .definition.resources.skills;
        const missing = skills.filter((name) => !names.includes(name));
        if (missing.length > 0) return missingReferences(missing.map((name) => `skill:${name}`));
      }
      return inner(request);
    };
  }

  it('does not refuse an agent that names only a folder the push would create (the dry run says so)', async () => {
    const root = await project({
      'agents/assistant.ts': SKILL_AGENT('refunds'),
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const run = await aw(root, ['check'], withSkills());
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toContain('agents/assistant.ts: ok (would be version 1)');
  });

  it('keeps any other missing reference a problem', async () => {
    const root = await project({
      'agents/assistant.ts': SKILL_AGENT('refunds'),
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const inner = server(emptyServer());
    const run = await aw(root, ['check'], (request) =>
      request.method === 'POST' && request.url.pathname === '/api/agents'
        ? missingReferences(['skill:refunds', 'connector:crm'])
        : inner(request),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toContain(
      'agent_definition_references_missing [skill:refunds, connector:crm]',
    );
  });

  it('accepts a skill() that names a folder with a SKILL.md', async () => {
    const root = await project({
      'agents/assistant.ts': SKILL_AGENT('refunds'),
      'skills/refunds/SKILL.md': SKILL_MD,
      'skills/refunds/policy.txt': 'ok',
    });
    const run = await aw(root, ['check'], withSkills());
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe(
      'skills/refunds: ok (would be created)\nagents/assistant.ts: ok (would be version 1)\n',
    );
    expect(writes(run)).toEqual([]);
  });

  it('lists a workspace skill with no folder as only in the workspace', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const run = await aw(root, ['check'], withSkills('refunds', 'old-one'));
    expect(run.stdout).toContain('skills/old-one: only in the workspace');
  });

  it('accepts a skill() that names an existing workspace skill', async () => {
    const root = await project({ 'agents/assistant.ts': SKILL_AGENT('triage') });
    const run = await aw(root, ['check'], withSkills('triage'));
    expect(run.code).toBe(EXIT_CODE.ok);
  });

  it("accepts builtinSkill('office-reader') in a fresh project, with no folder and no workspace skill", async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(", skills: [builtinSkill('office-reader')]").replace(
        'mcp }',
        'mcp, builtinSkill }',
      ),
    });
    const run = await aw(root, ['check'], server(emptyServer()));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).not.toContain('skill_not_found');
    expect(requests(run)).not.toContain('GET /api/skills');
  });

  it('refuses a missing skill by name, with the nearest name, and does not dry-run the agent', async () => {
    const root = await project({
      'agents/assistant.ts': SKILL_AGENT('refund-policy'),
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const run = await aw(root, ['check'], withSkills());
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe(
      "skills/refunds: ok (would be created)\nagents/assistant.ts: local skill_not_found [skill('refund-policy') is not in skills/ or the workspace (did you mean 'refunds'?)]\n",
    );
    expect(writes(run)).toEqual([]);
    expect(requests(run)).not.toContain('POST /api/agents');
  });

  it('refuses a folder without SKILL.md, a bad folder name and a SKILL.md that is not UTF-8', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'skills/empty/notes.txt': 'x',
      'skills/Bad Name/SKILL.md': SKILL_MD,
    });
    await tempFile(root, 'skills/binary/SKILL.md', Buffer.from([0xff, 0xfe, 0xfd]));
    await mkdir(path.join(root, 'skills/vacant'));
    const run = await aw(root, ['check'], withSkills());
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout.split('\n')).toEqual([
      'agents/assistant.ts: ok (would be version 1)',
      'skills/Bad Name: local invalid_skill [the folder name must be lower-case letters, digits and inner hyphens, at most 64]',
      'skills/binary: local invalid_skill [SKILL.md is not valid UTF-8]',
      'skills/empty: local invalid_skill [SKILL.md is missing]',
      'skills/vacant: local invalid_skill [skills/vacant holds no files]',
      '',
    ]);
  });

  it('refuses a SKILL.md without frontmatter, with invalid YAML, a wrong name or no description (BH061-021)', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'skills/bare/SKILL.md': 'Be kind.\n',
      'skills/broken/SKILL.md': '---\nname: broken\ndescription: [unclosed\n---\n',
      'skills/renamed/SKILL.md': '---\nname: other\ndescription: Refunds.\n---\n',
      'skills/silent/SKILL.md': '---\nname: silent\n---\n',
      'skills/blank/SKILL.md': "---\nname: blank\ndescription: ''\n---\n",
    });
    const run = await aw(root, ['check'], withSkills());
    expect(run.code).toBe(EXIT_CODE.problem);
    const lines = run.stdout.split('\n');
    expect(lines).toContain(
      '✗ skills/bare/SKILL.md:1:1  SKILL.md must start with frontmatter: ---, name: bare, description: <when to use it>, ---',
    );
    expect(lines.some((line) => line.startsWith('✗ skills/broken/SKILL.md:3:'))).toBe(true);
    expect(lines).toContain(
      "✗ skills/renamed/SKILL.md:2:1  name must be the folder's name, renamed",
    );
    expect(lines).toContain(
      '✗ skills/silent/SKILL.md:1:1  the frontmatter has no description: add description: <when to use it>',
    );
    expect(lines).toContain('✗ skills/blank/SKILL.md:3:1  description must be a non-empty string');
  });

  it('reports a failing skills list instead of a false skill_not_found', async () => {
    const root = await project({ 'agents/assistant.ts': SKILL_AGENT('triage') });
    const inner = server(emptyServer());
    const run = await aw(root, ['check'], (request) =>
      request.url.pathname === '/api/skills'
        ? json(500, { error: { code: 'internal_error', message: 'boom' } })
        : inner(request),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).not.toContain('skill_not_found');
    expect(run.stdout).toContain('agents/assistant.ts');
  });

  it('reports a failing skills list as a problem on skills/ when only a folder needs it', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const inner = server(emptyServer());
    const run = await aw(root, ['check', '--json'], (request) =>
      request.url.pathname === '/api/skills'
        ? json(500, { error: { code: 'internal_error', message: 'boom' } })
        : inner(request),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(stdoutJson(run)).toMatchObject({
      problems: [{ file: 'skills', code: 'internal_error' }],
      agents: [{ file: 'agents/assistant.ts' }],
    });
  });
}
