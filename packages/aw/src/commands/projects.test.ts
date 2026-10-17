import {
  ProjectResourceSchema,
  ProjectSessionMoveResponseSchema,
  ProjectSessionResponseSchema,
} from '@indx-workspace/contracts/projects';
import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { FIXTURES, IDS, json, runCli, stdoutJson } from '../testing.js';

describe('aw projects', () => {
  it('list honours --archived and round-trips through the contract', async () => {
    const list = await runCli(['projects', 'list', '--archived', 'all', '--json'], {
      route: () => json(200, { projects: [FIXTURES.project] }),
    });
    expect(list.calls[0]?.url.search).toBe('?archived=all');
    expect(ProjectResourceSchema.array().parse(stdoutJson(list))).toEqual([FIXTURES.project]);
    const bad = await runCli(['projects', 'list', '--archived', 'sometimes']);
    expect(bad.code).toBe(EXIT_CODE.usage);
  });

  it('get, create, update, archive and restore', async () => {
    const get = await runCli(['projects', 'get', IDS.project], {
      route: () => json(200, FIXTURES.project),
    });
    expect(get.stdout).toContain('visibility                workspace');
    const create = await runCli(['projects', 'create', '--file', '-', '--name', 'Launch'], {
      stdin: '{"visibility":"workspace","fileIds":[],"mcpServerIds":[]}',
      route: () => json(201, FIXTURES.project),
    });
    expect(create.calls[0]?.json).toEqual({
      visibility: 'workspace',
      fileIds: [],
      mcpServerIds: [],
      name: 'Launch',
    });
    const update = await runCli(['projects', 'update', IDS.project, '--file', '-'], {
      stdin: '{"instructions":null,"defaultAgentId":null}',
      route: () => json(200, FIXTURES.project),
    });
    expect(update.calls[0]?.json).toEqual({ instructions: null, defaultAgentId: null });
    for (const action of ['archive', 'restore'] as const) {
      const run = await runCli(['projects', action, IDS.project, '--json'], {
        route: () => json(200, FIXTURES.project),
      });
      expect(run.calls[0]?.url.pathname).toBe(`/api/projects/${IDS.project}/${action}`);
      expect(ProjectResourceSchema.parse(stdoutJson(run))).toEqual(FIXTURES.project);
    }
  });

  it('start-session with an optional agent, and adopt-session', async () => {
    const started = { id: IDS.session, projectId: IDS.project, agentId: IDS.agent };
    const start = await runCli(['projects', 'start-session', IDS.project, IDS.agent, '--json'], {
      route: () => json(201, started),
    });
    expect(start.calls[0]?.json).toEqual({ agentId: IDS.agent });
    expect(ProjectSessionResponseSchema.parse(stdoutJson(start))).toEqual(started);
    const defaulted = await runCli(['projects', 'start-session', IDS.project], {
      route: () => json(201, started),
    });
    expect(defaulted.calls[0]?.json).toEqual({});
    const moved = { projectId: IDS.project, sessionId: IDS.session };
    const adopt = await runCli(['projects', 'adopt-session', IDS.project, IDS.session, '--json'], {
      route: () => json(200, moved),
    });
    expect(adopt.calls[0]?.json).toEqual({ sessionId: IDS.session });
    expect(ProjectSessionMoveResponseSchema.parse(stdoutJson(adopt))).toEqual(moved);
  });
});
