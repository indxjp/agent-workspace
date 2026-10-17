import { stripVTControlCharacters } from 'node:util';

import { describe, expect, it } from 'vitest';

import type { PushedAgent } from '../project/index.js';
import { readyScreen, surfaceLines, syncSummary, type DevStatus } from './format.js';

function pushed(overrides: Partial<PushedAgent>): PushedAgent {
  return {
    file: 'agents/assistant.ts',
    name: 'assistant',
    surfaces: [],
    agentId: 'agent-1',
    action: 'none',
    version: 1,
    local: { from: 1, to: 1 },
    changes: [],
    saved: false,
    ...overrides,
  };
}

describe('syncSummary', () => {
  it('puts a changed skill folder before the agents, and leaves an unchanged one out', () => {
    const skills = {
      skills: [
        { name: 'refunds', action: 'create' as const, files: 2 },
        { name: 'same', action: 'unchanged' as const, files: 1 },
      ],
      workspaceOnly: [],
    };
    expect(syncSummary([pushed({ name: 'a', action: 'none', version: 1 })], skills)).toBe(
      'synced: skill refunds (new, 2 files) · "a" unchanged at version 1',
    );
  });

  it('names each agent and what its sync did, in order', () => {
    expect(
      syncSummary([
        pushed({ name: 'a', action: 'create', local: { from: null, to: 1 }, saved: true }),
        pushed({
          name: 'b',
          action: 'version',
          version: 3,
          local: { from: 2, to: 3 },
          changes: [{ op: '~', path: 'definition.agent.instructions' }],
          saved: true,
        }),
        pushed({
          name: 'c',
          action: 'version',
          version: 2,
          local: { from: 1, to: 2 },
          changes: [
            { op: '~', path: 'surfaces' },
            { op: '+', path: 'definition.agent.description' },
          ],
          saved: true,
        }),
        pushed({ name: 'd', action: 'point', version: 2, local: { from: 4, to: 2 }, saved: true }),
        pushed({ name: 'f', action: 'none', version: 7, local: { from: 7, to: 7 } }),
      ]),
    ).toBe(
      'synced: "a" created at version 1, "b" version 3 (1 change), "c" version 2 (2 changes), ' +
        '"d" back on version 2, "f" unchanged at version 7',
    );
  });
});

describe('surfaceLines', () => {
  it("prints C5's page, try and one-tag widget lines on the runtime's origin", () => {
    expect(surfaceLines('http://127.0.0.1:3000', 'main')).toEqual([
      'page: http://127.0.0.1:3000/p/s/main',
      'try: http://127.0.0.1:3000/p/s/main/try',
      'widget: <script src="http://127.0.0.1:3000/p/s/main/widget.js" async></script>',
    ]);
  });

  it('encodes the name as one path segment', () => {
    expect(surfaceLines('http://127.0.0.1:3000', 'help desk/"x"')).toEqual([
      'page: http://127.0.0.1:3000/p/s/help%20desk%2F%22x%22',
      'try: http://127.0.0.1:3000/p/s/help%20desk%2F%22x%22/try',
      'widget: <script src="http://127.0.0.1:3000/p/s/help%20desk%2F%22x%22/widget.js" async></script>',
    ]);
  });
});

const ESCAPE = String.fromCharCode(27);

const STATUS: DevStatus = {
  project: 'my-agent',
  environment: 'local',
  runtime: { seconds: 6.14, logPath: '.aw/logs/runtime.log' },
  identity: 'admin@localhost.test (workspace local)',
  model: 'anthropic · claude-sonnet-4-5 · key set',
  agents: [{ name: 'assistant', file: 'agents/assistant.ts' }],
  surfaces: ['main'],
  origin: 'http://127.0.0.1:3000',
  console: { email: 'admin@localhost.test', password: '.agent-workspace/local-secrets.json' },
  watching: ['agents/', 'surfaces/', 'tools/', 'skills/'],
};

describe('readyScreen', () => {
  it('prints one calm screen: what is up, where to go, what is watched', () => {
    expect(readyScreen(STATUS, { plain: true })).toMatchInlineSnapshot(`
      "
        Agent Workspace · my-agent · local

        try       http://127.0.0.1:3000/p/s/main/try
        console   http://127.0.0.1:3000
                  sign in as admin@localhost.test
                  password in .agent-workspace/local-secrets.json
        chat      npx aw chat

          runtime   ready in 6.1 s   logs: .aw/logs/runtime.log
          model     anthropic · claude-sonnet-4-5 · key set
          signed in as admin@localhost.test (workspace local)
          agent     assistant  (agents/assistant.ts)
          surface   main

        embed     <script src="http://127.0.0.1:3000/p/s/main/widget.js" async></script>
        react     https://docs.agentworkspace.indx.jp/building/react

        watching agents/ surfaces/ tools/ skills/ · edit a file and save
      "
    `);
  });

  it('shows the evals row only when there are eval cases, singular for one', () => {
    expect(readyScreen(STATUS, { plain: true })).not.toContain('evals');
    const row = (evalCases: number): string =>
      readyScreen({ ...STATUS, evalCases }, { plain: true });
    expect(row(1)).toContain('\n  evals     1 case · npx aw eval\n');
    expect(row(5)).toContain('\n  evals     5 cases · npx aw eval\n');
    expect(row(1)).not.toContain('1 cases');
  });

  it('says when the web port moved, and drops the surface rows for a project with none', () => {
    const screen = readyScreen(
      { ...STATUS, surfaces: [], moved: { port: 3001, wanted: 3000 } },
      { plain: true },
    );
    expect(screen).toContain('web       on :3001 (3000 was busy)');
    expect(screen).not.toContain('try ');
    expect(screen).toContain(
      'console   http://127.0.0.1:3000\n            sign in as admin@localhost.test\n',
    );
  });

  it('adds colour and a tick only for a terminal', () => {
    const plain = readyScreen(STATUS, { plain: true });
    const styled = readyScreen(STATUS, { plain: false });
    expect(plain).not.toContain(ESCAPE);
    expect(plain).not.toContain('✓');
    expect(styled).toContain(ESCAPE);
    expect(styled).toContain('✓');
    expect(stripVTControlCharacters(styled).replaceAll('✓', ' ')).toBe(plain);
  });

  it('says a model that cannot be used on one cross row, with the fix under it', () => {
    const modelProblem = ['the key was rejected (401)', 'Set ANTHROPIC_API_KEY to a valid key.'];
    const plain = readyScreen({ ...STATUS, modelProblem }, { plain: true });
    expect(plain).toContain(
      `  x model     the key was rejected (401)\n` +
        `              Set ANTHROPIC_API_KEY to a valid key.\n`,
    );
    expect(plain).not.toContain('key set');
    const styled = readyScreen({ ...STATUS, modelProblem }, { plain: false });
    expect(stripVTControlCharacters(styled)).toContain('✗ model     the key was rejected');
  });
});
