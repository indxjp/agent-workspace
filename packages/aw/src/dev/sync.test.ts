import { rename, rm, writeFile } from 'node:fs/promises';

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { IDS, json, tempFile } from '../testing.js';

import {
  AGENT,
  count,
  DEBOUNCE_MS,
  DEFINE,
  first,
  named,
  ORIGIN,
  PROJECT,
  SETTLE_MS,
  start,
  surface,
  synced,
  until,
  WIDGET,
  writes,
} from './sync.fixture.test-support.js';
describe('startDevSync (issue #453)', () => {
  it('syncs once on start with one write per agent, then prints the surface lines once', async () => {
    const harness = await start(PROJECT);
    await until(harness, () => synced(harness) === 1);
    expect(writes(harness)).toEqual(['POST /api/agents']);
    const { stdout, stderr } = harness.output();
    expect(stderr).toBe('');
    expect(stdout).toBe(
      [
        'synced: "assistant" created at version 1',
        `page: ${ORIGIN}/p/s/main`,
        `try: ${ORIGIN}/p/s/main/try`,
        WIDGET,
        '',
      ].join('\n'),
    );
  });

  it('uploads a skills/ folder created after start before the agent that names it, and syncs any file in it', async () => {
    const SKILL_MD = [
      '---',
      'name: refunds',
      'description: Refund policy.',
      '---',
      '',
      'Be kind.',
      '',
    ].join('\n');
    const harness = await start(PROJECT);
    await until(harness, () => synced(harness) === 1);
    await tempFile(harness.root, 'skills/refunds/SKILL.md', SKILL_MD);
    await writeFile(
      path.join(harness.root, 'agents/assistant.ts'),
      AGENT.replace('{ defineAgent,', '{ defineAgent, skill,').replace(
        "instructions: 'Help people.'",
        "instructions: 'Help people.', skills: [skill('refunds')]",
      ),
    );
    await until(harness, () => synced(harness) >= 2);
    const written = writes(harness);
    expect(written.indexOf('POST /api/skills')).toBeGreaterThan(-1);
    expect(written.indexOf('POST /api/skills')).toBeLessThan(
      written.findLastIndex((write) => write.includes('/api/agents')),
    );
    const saved = harness.state.agents[0]?.versions.at(-1);
    expect(JSON.stringify(saved?.body)).toContain('refunds');
    // Not a .md or .ts file: a skill folder holds any file.
    await tempFile(harness.root, 'skills/refunds/policy.txt', 'ok');
    await until(harness, () => writes(harness).includes('PATCH /api/skills/refunds'));
  });

  it('syncs a project of two agents on start with one write per agent and one synced part each', async () => {
    const harness = await start({
      'agents/a.ts': `${DEFINE}export default defineAgent({ name: 'a', instructions: 'A.' });\n`,
      'agents/b.ts': `${DEFINE}export default defineAgent({ name: 'b', instructions: 'B.' });\n`,
    });
    await until(harness, () => synced(harness) === 1);
    expect(writes(harness)).toEqual(['POST /api/agents', 'POST /api/agents']);
    expect(harness.state.agents.map((stored) => stored.agent.name)).toEqual(['a', 'b']);
    const { stdout, stderr } = harness.output();
    expect(stderr).toBe('');
    expect(stdout).toBe('synced: "a" created at version 1, "b" created at version 1\n');
  });

  it('runs one sync on start of a settled project, not a second one its own load triggers', async () => {
    const harness = await start(PROJECT);
    await until(harness, () => synced(harness) === 1);
    // Long enough for the debounce and another loader run had the load scheduled one.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(synced(harness)).toBe(1);
    expect(
      harness.calls.filter((call) => `${call.method} ${call.path}` === 'GET /api/agents'),
    ).toHaveLength(1);
    expect(harness.output().stdout).not.toContain('unchanged');
  });

  it('syncs an edit to an instructions file in a folder beside its agent', async () => {
    const harness = await start({
      'agents/assistant.ts': `${DEFINE}export default defineAgent({ name: 'assistant', instructions: { file: './prompts/en.md' } });\n`,
      'agents/prompts/en.md': 'Help people.\n',
    });
    await until(harness, () => synced(harness) === 1);

    await tempFile(harness.root, 'agents/prompts/en.md', 'Help people kindly.\n');
    await until(harness, () => synced(harness) === 2);
    expect(harness.output().stdout).toContain('synced: "assistant" version 2 (1 change)\n');
    expect(first(harness).versions).toHaveLength(2);
  });

  it('pushes a saved surface again, once per burst, and prints its lines only once', async () => {
    const harness = await start(PROJECT);
    await until(harness, () => synced(harness) === 1);

    await tempFile(harness.root, 'surfaces/main.ts', surface('#112233'));
    await until(harness, () => synced(harness) === 2);
    expect(writes(harness)).toEqual([
      'POST /api/agents',
      `POST /api/agents/${IDS.agent}/versions`,
      `PUT /api/agents/${IDS.agent}/pointers`,
    ]);
    expect(harness.output().stdout).toContain('synced: "assistant" version 2 (1 change)\n');

    for (const colour of ['#000001', '#000002', '#000003']) {
      await tempFile(harness.root, 'surfaces/main.ts', surface(colour));
    }
    await until(harness, () => synced(harness) >= 3);
    // Settle: a second sync for the same burst would land within the debounce and one loader run.
    await until(harness, () => first(harness).versions.length >= 3);
    const after = writes(harness).length;
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 5));
    expect(writes(harness).length).toBe(after);
    expect(first(harness).versions).toHaveLength(3);
    expect(first(harness).local?.number).toBe(3);
    const { stdout } = harness.output();
    expect(count(stdout, WIDGET)).toBe(1);
    expect(stdout.indexOf(WIDGET)).toBeGreaterThan(stdout.indexOf('synced: '));
  });

  it('prints a refused surface like aw push, writes nothing, and syncs the next valid save', async () => {
    const harness = await start(PROJECT);
    await until(harness, () => synced(harness) === 1);

    await tempFile(harness.root, 'surfaces/main.ts', surface('blue'));
    await until(harness, () => harness.output().stderr.includes('sync: 1 problem'));
    const { stdout, stderr } = harness.output();
    expect(stdout).toMatch(/^✗ surfaces\/main\.ts:\d+:\d+ {2}theme\.colour: /mu);
    expect(stderr).toBe(
      'sync: 1 problem; nothing was synced; fix the file and save to sync again\n',
    );
    expect(writes(harness)).toEqual(['POST /api/agents']);

    await tempFile(harness.root, 'surfaces/main.ts', surface('#445566'));
    await until(harness, () => synced(harness) === 2);
    expect(writes(harness)).toHaveLength(3);
    expect(harness.fatal).toEqual([]);
  });

  it('says once that an agent renamed in its file stays in the workspace (BH061-047)', async () => {
    const harness = await start({
      'agents/a.ts': `${DEFINE}export default defineAgent({ name: 'a', instructions: 'A.' });\n`,
    });
    await until(harness, () => synced(harness) === 1);
    const old = named(harness, 'a');

    await tempFile(
      harness.root,
      'agents/a.ts',
      `${DEFINE}export default defineAgent({ name: 'b', instructions: 'A.' });\n`,
    );
    await until(harness, () => synced(harness) === 2);
    expect(harness.output().stderr).toBe(
      `notice: agents/a.ts no longer defines "a", which stays in the local workspace (aw chat then asks which agent); remove it with aw agents remove ${old.agent.id}\n`,
    );

    await tempFile(
      harness.root,
      'agents/a.ts',
      `${DEFINE}export default defineAgent({ name: 'b', instructions: 'B.' });\n`,
    );
    await until(harness, () => synced(harness) === 3);
    expect(count(harness.output().stderr, 'notice: ')).toBe(1);
    expect(harness.fatal).toEqual([]);
  });

  it('syncs the save that fixes a syntax error, written the way an editor does (#662)', async () => {
    const harness = await start(PROJECT);
    await until(harness, () => synced(harness) === 1);

    // A save is a write to a temporary file and a rename over the original: a new inode each time.
    const save = async (source: string): Promise<void> => {
      const target = path.join(harness.root, 'surfaces', 'main.ts');
      await writeFile(`${target}.tmp`, source);
      await rename(`${target}.tmp`, target);
    };
    await save('export default {\n  name: "main"\n  agent: "assistant",\n};\n');
    await until(harness, () => harness.output().stdout.includes('✗ surfaces/main.ts:3:'));
    expect(synced(harness)).toBe(1);

    await save(surface('#778899'));
    await until(harness, () => synced(harness) === 2);
    expect(harness.fatal).toEqual([]);
  });

  it('says a 503 and a transport failure, and keeps watching', async () => {
    const harness = await start(PROJECT);
    await until(harness, () => synced(harness) === 1);

    harness.outage = () =>
      json(503, { error: { code: 'service_unavailable', message: 'starting', details: [] } });
    await tempFile(harness.root, 'surfaces/main.ts', surface('#101010'));
    await until(harness, () => harness.output().stderr.includes('sync: '));
    expect(harness.output().stdout).toContain('agents/assistant.ts: 503 service_unavailable');

    harness.outage = () => Promise.reject(new TypeError('fetch failed'));
    const before = harness.output().stderr.length;
    await tempFile(harness.root, 'surfaces/main.ts', surface('#202020'));
    await until(harness, () => harness.output().stderr.slice(before).startsWith('sync: '));

    harness.outage = null;
    await tempFile(harness.root, 'surfaces/main.ts', surface('#303030'));
    await until(harness, () => synced(harness) === 2);
    expect(harness.fatal).toEqual([]);
  });

  it('says a directory with no agents and syncs once one appears', async () => {
    const harness = await start({});
    await until(harness, () => harness.output().stderr.includes('sync: '));
    expect(harness.output().stderr).toBe(
      'sync: no agents/*.ts or agents/*.agent.md in this directory\n',
    );

    await tempFile(harness.root, 'agents/assistant.ts', AGENT);
    await until(harness, () => synced(harness) === 1);
    expect(writes(harness)).toEqual(['POST /api/agents']);
  });

  it('releases the watchers on abort, and no sync runs after it', async () => {
    const harness = await start(PROJECT);
    await until(harness, () => synced(harness) === 1);
    harness.controller.abort();
    await harness.sync.closed;
    const calls = harness.calls.length;
    await tempFile(harness.root, 'surfaces/main.ts', surface('#404040'));
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 5));
    expect(harness.calls).toHaveLength(calls);
    // The watchers no longer hold the directory: it can be removed at once.
    await rm(harness.root, { recursive: true });
  });

  it('stops on an error no refusal describes and reports it as fatal', async () => {
    const harness = await start(PROJECT);
    harness.brokenStdout = true;
    await until(harness, () => harness.fatal.length === 1);
    await harness.sync.closed;
    expect(harness.fatal[0]?.message).toBe('stdout is gone');
    // Stopped: a later save starts nothing.
    const calls = harness.calls.length;
    await tempFile(harness.root, 'surfaces/main.ts', surface('#505050'));
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 5));
    expect(harness.calls).toHaveLength(calls);
  });
});
