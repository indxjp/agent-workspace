import { CreateAgentFromVersionRequestSchema } from '@indx-workspace/contracts/agent-versions';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { EXIT_CODE } from '../output.js';
import { FIXTURES, json, stdoutJson, type CliRun, type Route } from '../testing.js';
import {
  agentFile,
  aw,
  emptyServer,
  missingReferences,
  project,
  type RecordedRequest,
  server,
  SKILL_AGENT,
  writes,
} from './project.fixture.test-support.js';

export function describeProjectPushSkills(): void {
  const SKILL_MD = '---\nname: refunds\ndescription: Refund policy.\n---\n\nBe kind.\n';

  const b64 = (text: string): string => Buffer.from(text).toString('base64');

  function workspace(files: readonly { path: string; contentBase64: string }[] | null): Route {
    const inner = server(emptyServer());
    return (request: RecordedRequest) => {
      const { pathname } = request.url;
      if (pathname === '/api/skills' && request.method === 'GET') {
        return json(200, {
          skills: files === null ? [] : [{ ...FIXTURES.skill, name: 'refunds' }],
        });
      }
      if (pathname === '/api/skills') return json(201, { skill: FIXTURES.skill });
      if (request.method === 'POST' && pathname === '/api/agents') {
        // Like the server: a version naming a skill the workspace lacks is refused.
        const named = CreateAgentFromVersionRequestSchema.parse(request.json).version.body
          .definition.resources.skills;
        const missing = named.filter((name) => name !== 'refunds' || files === null);
        if (missing.length > 0) return missingReferences(missing.map((name) => `skill:${name}`));
      }
      if (pathname === '/api/skills/refunds') {
        return request.method === 'GET'
          ? json(200, { skill: { name: 'refunds', files: files ?? [] } })
          : json(200, { skill: FIXTURES.skill });
      }
      return inner(request);
    };
  }

  const writtenSkills = (run: CliRun): readonly string[] =>
    writes(run).filter((write) => write.includes('/api/skills'));

  it('previews a new folder and an agent naming it without a write or a missing-reference problem', async () => {
    const root = await project({
      'agents/assistant.ts': SKILL_AGENT('refunds'),
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const run = await aw(root, ['push'], workspace(null));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(writes(run)).toEqual([]);
  });

  it('writes no skill when an agent names one that is neither a folder nor in the workspace', async () => {
    const root = await project({
      'agents/assistant.ts': SKILL_AGENT('refund-policy'),
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const run = await aw(root, ['push', '--yes'], workspace(null));
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toContain('skill_not_found');
    expect(writes(run)).toEqual([]);
  });

  it('creates a new folder as a skill before the agent is saved', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'skills/refunds/SKILL.md': SKILL_MD,
      'skills/refunds/policy.txt': 'ok',
    });
    const run = await aw(root, ['push', '--yes'], workspace(null));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(writes(run)[0]).toBe('POST /api/skills');
    expect(run.stdout).toContain('skills/refunds: create (2 files)\n');
  });

  it('updates a changed folder with one patch that also removes files the folder dropped', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const run = await aw(
      root,
      ['push', '--yes'],
      workspace([
        { path: 'SKILL.md', contentBase64: b64('old') },
        { path: 'gone.txt', contentBase64: b64('x') },
      ]),
    );
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(writtenSkills(run)).toEqual(['PATCH /api/skills/refunds']);
    const patch = run.calls.find((call) => call.method === 'PATCH');
    expect(patch?.json).toEqual({
      files: [{ path: 'SKILL.md', contentBase64: b64(SKILL_MD) }],
      removeFiles: ['gone.txt'],
    });
  });

  it('writes nothing for an unchanged folder, and never deletes a workspace skill', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const run = await aw(
      root,
      ['push', '--yes'],
      workspace([{ path: 'SKILL.md', contentBase64: b64(SKILL_MD) }]),
    );
    expect(writtenSkills(run)).toEqual([]);
    const gone = await project({
      'agents/assistant.ts': agentFile(),
      'skills/x/SKILL.md': SKILL_MD,
    });
    await rm(path.join(gone, 'skills/x'), { recursive: true });
    const after = await aw(
      gone,
      ['push', '--yes'],
      workspace([{ path: 'SKILL.md', contentBase64: b64('a') }]),
    );
    expect(after.calls.map((call) => call.method)).not.toContain('DELETE');
  });

  it('reports a refused skill upload as a problem on its folder and saves nothing', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const inner = workspace([{ path: 'SKILL.md', contentBase64: b64('old') }]);
    const run = await aw(root, ['push', '--yes', '--json'], (request) =>
      request.method === 'PATCH'
        ? json(409, { error: { code: 'colliding_paths', message: 'paths collide' } })
        : inner(request),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(stdoutJson(run)).toMatchObject({
      saved: false,
      problems: [{ file: 'skills/refunds', code: 'colliding_paths' }],
    });
  });

  it('writes no skill when an agent file does not load', async () => {
    const root = await project({
      'agents/assistant.ts': 'export default 1;\n',
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const run = await aw(root, ['push', '--yes'], workspace(null));
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(writtenSkills(run)).toEqual([]);
  });
}
