import { describe, expect, it } from 'vitest';

import { pushProject } from '../project/index.js';

import { json, tempFile } from '../testing.js';

import {
  count,
  DEFINE,
  EDITED_SUMMARY,
  editInUi,
  exportReads,
  HINT,
  named,
  start,
  synced,
  until,
  writes,
} from './sync.fixture.test-support.js';

import { seedUiAgent, server } from './sync-server.test-support.js';
describe('startDevSync over an agent edited in the UI (issue #546)', () => {
  it('refuses the edited agent, writes nothing for it, and still syncs the others', async () => {
    const harness = await start({
      'agents/a.ts': `${DEFINE}export default defineAgent({ name: 'a', instructions: 'A.' });\n`,
      'agents/b.ts': `${DEFINE}export default defineAgent({ name: 'b', instructions: 'B.' });\n`,
    });
    await until(harness, () => synced(harness) === 1);
    const a = editInUi(harness, 'a');
    const b = named(harness, 'b');
    const before = writes(harness).length;

    await tempFile(
      harness.root,
      'agents/b.ts',
      `${DEFINE}export default defineAgent({ name: 'b', instructions: 'B again.' });\n`,
    );
    await until(harness, () => synced(harness) === 2);
    const { stdout, stderr } = harness.output();
    expect(stdout).toContain('synced: "b" version 2 (1 change)\n');
    expect(stdout).toContain(
      `agents/a.ts: local edited_in_ui ["a" edited ${a.agent.updatedAt}, ` +
        `local 1 set ${a.local?.updatedAt ?? ''}]; ${HINT}\n`,
    );
    expect(stderr).toBe(`sync: 1 problem; ${EDITED_SUMMARY}\n`);
    expect(writes(harness).slice(before)).toEqual([
      `POST /api/agents/${b.agent.id}/versions`,
      `PUT /api/agents/${b.agent.id}/pointers`,
    ]);
    expect(a.versions).toHaveLength(1);
    expect(harness.fatal).toEqual([]);
  });

  it('refuses an agent made in the UI, until aw push --yes overwrites it', async () => {
    const harness = await start(
      {
        'agents/helper.ts': `${DEFINE}export default defineAgent({ name: 'helper', instructions: 'H.' });\n`,
      },
      (state) => {
        seedUiAgent(state, 'helper');
      },
    );
    const line = `agents/helper.ts: local edited_in_ui ["helper" has no local pointer]; ${HINT}\n`;
    await until(harness, () => harness.output().stderr.includes('sync: '));
    expect(harness.output()).toEqual({
      stdout: line,
      stderr: `sync: 1 problem; ${EDITED_SUMMARY}\n`,
    });
    expect(writes(harness)).toEqual([]);
    // Refused before `agents.export`: no read of the agent, its policy or its resources.
    expect(exportReads(harness)).toEqual([]);

    // `aw push --yes` (the default, overwrite) writes the file over the UI's agent.
    const pushed = await pushProject({
      client: harness.client,
      root: harness.root,
      io: harness.io,
      signal: harness.controller.signal,
      yes: true,
    });
    expect(pushed.problems).toEqual([]);
    expect(pushed.agents.map((agent) => agent.action)).toEqual(['version']);
    expect(named(harness, 'helper').local?.number).toBe(1);

    await tempFile(
      harness.root,
      'agents/helper.ts',
      `${DEFINE}export default defineAgent({ name: 'helper', instructions: 'H again.' });\n`,
    );
    await until(harness, () => synced(harness) === 1);
    const { stdout } = harness.output();
    expect(stdout).toBe(`${line}synced: "helper" version 2 (1 change)\n`);
    expect(count(stdout, 'edited_in_ui')).toBe(1);
    expect(harness.fatal).toEqual([]);
  });

  it('keeps advising a fix when another agent has a problem a save can clear', async () => {
    const harness = await start({
      'agents/a.ts': `${DEFINE}export default defineAgent({ name: 'a', instructions: 'A.' });\n`,
      'agents/b.ts': `${DEFINE}export default defineAgent({ name: 'b', instructions: 'B.' });\n`,
    });
    await until(harness, () => synced(harness) === 1);
    editInUi(harness, 'a');
    const b = named(harness, 'b');
    harness.outage = (request) =>
      request.method === 'GET' && request.path === `/api/agents/${b.agent.id}/versions`
        ? json(503, { error: { code: 'service_unavailable', message: 'starting', details: [] } })
        : server(harness.state, request);
    await tempFile(
      harness.root,
      'agents/b.ts',
      `${DEFINE}export default defineAgent({ name: 'b', instructions: 'B again.' });\n`,
    );
    await until(harness, () => harness.output().stderr.includes('sync: '));
    const { stdout, stderr } = harness.output();
    expect(stdout).toContain('agents/a.ts: local edited_in_ui');
    expect(stdout).toContain('agents/b.ts: 503 service_unavailable');
    expect(stderr).toBe(
      'sync: 2 problems; nothing was synced; fix the file and save to sync again\n',
    );
    expect(harness.fatal).toEqual([]);
  });
});
