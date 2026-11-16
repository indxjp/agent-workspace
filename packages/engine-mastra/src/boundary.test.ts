/**
 * Real Mastra (`@mastra/core` 1.71.0) against a scripted gateway (ENG-10, #309).
 *
 * The model is reached through the process's global `fetch`, which this file replaces with the
 * gateway, so every request Mastra, its providers or its telemetry could make is seen here: the
 * egress assertions are over **all** of them, not over the ones the adapter chose to route. The
 * gateway answers in each protocol's own streaming dialect, recorded from the providers' wire
 * format, and each scenario drives the adapter end to end — compile, the boundary, Mastra's agent
 * loop and workspace tools, and the frame mapper.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import { mastraProcessEnvironmentHolds } from './boundary.js';
import {
  GATEWAY,
  TOKEN,
  drain,
  neutral,
  request,
  scriptedGateway,
  text,
  tool,
  workspace,
} from './boundary.test-support.js';
import { createMastraEngine } from './engine.js';

it('uses a skill, reads and edits a file, runs a command, and reaches only the gateway', async () => {
  const cwd = workspace();
  scriptedGateway.script = [
    tool('t1', 'skill', { name: 'greeter' }),
    tool('t2', 'mastra_workspace_read_file', { path: 'a.md' }),
    tool('t3', 'mastra_workspace_edit_file', {
      path: 'a.md',
      old_string: 'hello',
      new_string: 'Ahoy',
    }),
    tool('t4', 'mastra_workspace_execute_command', { command: 'cat a.md' }),
    text('Ahoy, done.'),
  ];
  const frames = await drain(createMastraEngine().start(request(cwd)).frames);

  const calls = frames.filter((frame) => frame.frame === 'agent.tool.call');
  expect(calls.map((frame) => [frame.name, frame.kind])).toEqual([
    ['skill', 'read'],
    ['mastra_workspace_read_file', 'read'],
    ['mastra_workspace_edit_file', 'edit'],
    ['mastra_workspace_execute_command', 'execute'],
  ]);
  const results = frames.filter((frame) => frame.frame === 'agent.tool.result');
  expect(results.map((frame) => frame.isError)).toEqual([false, false, false, false]);
  expect(results[0]?.output).toContain('Ahoy');
  expect(results[3]?.output).toContain('Ahoy doc');
  expect(readFileSync(path.join(cwd, 'a.md'), 'utf8')).toBe('Ahoy doc\n');
  expect(frames.at(-1)).toMatchObject({
    frame: 'agent.result',
    stopReason: 'end_turn',
    turns: 5,
  });
  expect(frames.filter((frame) => frame.frame === 'agent.message').at(-1)).toMatchObject({
    blocks: [{ type: 'text', text: 'Ahoy, done.' }],
  });
  expect(neutral(frames).slice(-2)).toEqual(['agent.usage', 'agent.result']);

  // Egress: five model calls, every one to the gateway's Messages route with the run token as
  // the bearer, and not a single other request — no telemetry, no catalogue, no exporter.
  expect(scriptedGateway.seen.map((request) => request.url)).toEqual(
    Array(5).fill(`${GATEWAY}/v1/messages`),
  );
  for (const request of scriptedGateway.seen) {
    expect(request.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request.apiKey).toBeNull();
  }
  expect(mastraProcessEnvironmentHolds()).toBe(true);
  const offered = (scriptedGateway.seen[0]?.body as { tools: { name: string }[] }).tools.map(
    (entry) => entry.name,
  );
  expect(offered).toEqual(
    expect.arrayContaining([
      'skill',
      'mastra_workspace_read_file',
      'mastra_workspace_execute_command',
    ]),
  );
  expect(offered).not.toContain('mastra_workspace_ast_edit');
});

it('offers only the plan: no command tools without runCommands, no write tools without writeFiles', async () => {
  const cwd = workspace();
  scriptedGateway.script = [text('ok')];
  const base = request(cwd);
  await drain(
    createMastraEngine().start(
      request(cwd, {
        portable: {
          ...base.portable,
          permissions: {
            readFiles: true,
            writeFiles: false,
            runCommands: false,
            unrestrictedNetwork: false,
          },
          skills: { mode: 'allowlist', names: [] },
        },
        resources: { files: [], skills: [] },
      }),
    ).frames,
  );
  const offered = (scriptedGateway.seen[0]?.body as { tools: { name: string }[] }).tools
    .map((entry) => entry.name)
    .sort();
  expect(offered).toEqual([
    'mastra_workspace_file_stat',
    'mastra_workspace_grep',
    'mastra_workspace_list_files',
    'mastra_workspace_read_file',
  ]);
});

it('runs a skill script without a shell: offered beside the withheld command tool, read-only under the grant', async () => {
  const cwd = workspace();
  mkdirSync(path.join(cwd, '.mastra/skills/greeter/scripts'));
  writeFileSync(
    path.join(cwd, '.mastra/skills/greeter/scripts/hello.mjs'),
    `import fs from 'node:fs';
let write;
try { fs.writeFileSync('contracts/signed.pdf', 'forged'); write = 'OK'; } catch (error) { write = error.code; }
console.log(process.argv[2], fs.readFileSync('contracts/signed.pdf', 'utf8'), write);
`,
  );
  scriptedGateway.script = [
    tool('t1', 'run_skill_script', { skill: 'greeter', script: 'hello.mjs', args: ['Ahoy'] }),
    tool('t2', 'run_skill_script', { skill: 'greeter', script: '../SKILL.md' }),
    text('done'),
  ];
  const frames = await drain(
    createMastraEngine().start(
      request(cwd, {
        resources: {
          files: [{ kind: 'file', path: 'contracts/signed.pdf', access: 'read' }],
          skills: [
            {
              name: 'greeter',
              files: [{ path: 'scripts/hello.mjs', contentBase64: 'Y29uc29sZS5sb2coMSk=' }],
            },
          ],
        },
      }),
    ).frames,
  );

  const offered = (scriptedGateway.seen[0]?.body as { tools: { name: string }[] }).tools.map(
    (entry) => entry.name,
  );
  expect(offered).toContain('run_skill_script');
  expect(offered).not.toContain('mastra_workspace_execute_command');
  const calls = frames.filter((frame) => frame.frame === 'agent.tool.call');
  expect(calls.map((frame) => [frame.name, frame.kind])).toEqual([
    ['run_skill_script', 'execute'],
    ['run_skill_script', 'execute'],
  ]);
  const results = frames.filter((frame) => frame.frame === 'agent.tool.result');
  expect(results[0]).toMatchObject({ isError: false });
  expect(results[0]?.output).toContain('Ahoy signed ERR_ACCESS_DENIED');
  expect(results[1]).toMatchObject({ isError: true });
  expect(results[1]?.output).toContain('outside_skill_directory');
  expect(readFileSync(path.join(cwd, 'contracts/signed.pdf'), 'utf8')).toBe('signed');
});

it('offers no skill script tool without runCommands', async () => {
  const cwd = workspace();
  scriptedGateway.script = [text('ok')];
  const base = request(cwd);
  await drain(
    createMastraEngine().start(
      request(cwd, {
        portable: {
          ...base.portable,
          permissions: { ...base.portable.permissions, runCommands: false },
        },
        resources: {
          files: [],
          skills: [
            {
              name: 'greeter',
              files: [{ path: 'scripts/hello.mjs', contentBase64: 'Y29uc29sZS5sb2coMSk=' }],
            },
          ],
        },
      }),
    ).frames,
  );
  const offered = (scriptedGateway.seen[0]?.body as { tools: { name: string }[] }).tools.map(
    (entry) => entry.name,
  );
  expect(offered).not.toContain('run_skill_script');
});
