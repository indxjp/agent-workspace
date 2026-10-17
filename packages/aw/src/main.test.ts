import { PassThrough } from 'node:stream';

import { SETUP_QUESTIONS } from '@indx-workspace/contracts/setup';
import { describe, expect, it } from 'vitest';

import { supportedFlags } from './command.js';
import { COMMANDS } from './commands/index.js';
import { readStreamWithIdleTimeout } from './io.js';
import { EXIT_CODE } from './output.js';
import { FIXTURES, json, runCli } from './testing.js';

describe('aw (entry behaviour)', () => {
  it('prints the whole tree for --help and exits 0; a bare aw prints it on stderr and exits 2', async () => {
    const help = await runCli(['--help']);
    expect(help.code).toBe(EXIT_CODE.ok);
    for (const command of COMMANDS) expect(help.stdout).toContain(`aw ${command.path.join(' ')}`);
    expect(help.stdout).toContain('--api-key-stdin');
    const bare = await runCli([]);
    expect(bare.code).toBe(EXIT_CODE.usage);
    expect(bare.stderr).toContain('Usage: aw');
    expect(bare.stdout).toBe('');
  });

  it('scopes --help to a family and refuses an unknown one', async () => {
    const runs = await runCli(['runs', '--help']);
    expect(runs.code).toBe(EXIT_CODE.ok);
    expect(runs.stdout).toContain('aw runs start');
    expect(runs.stdout).not.toContain('aw agents');
    const unknown = await runCli(['nope', '--help']);
    expect(unknown.code).toBe(EXIT_CODE.usage);
  });

  it("prints one command's own usage line and summary for its --help (BH061-041)", async () => {
    for (const argv of [
      ['runs', 'list', '--help'],
      ['help', 'runs', 'list'],
    ]) {
      const leaf = await runCli(argv);
      expect(leaf.code, argv.join(' ')).toBe(EXIT_CODE.ok);
      expect(leaf.stdout).toContain('Usage: aw runs list [--status <status>]');
      expect(leaf.stdout).toContain('One page of run history');
      expect(leaf.stdout).not.toContain('<command>');
    }
    const withArgument = await runCli(['runs', 'get', 'run_1', '--help']);
    expect(withArgument.stdout).toContain('Usage: aw runs get <id>');
    const tree = await runCli(['help']);
    expect(tree.code).toBe(EXIT_CODE.ok);
    expect(tree.stdout).toContain('Usage: aw <family>');
    const family = await runCli(['agents']);
    expect(family.code).toBe(EXIT_CODE.usage);
    expect(family.stderr).toContain('"aw agents" needs a command');
    expect(family.stderr).not.toContain('unknown command');
  });

  it('has no command for a row that waits on a server change or refuses an API key', async () => {
    for (const absent of [
      // `me` used to head this list; issue #233 landed `GET /api/me`, so it is a command now and
      // `commands/me.test.ts` drives it. `agents policy get/set` left the same way — issue #234
      // landed `GET`/`PUT /api/agents/:id/policy`, so both are commands now and
      // `commands/agents.test.ts` drives them. `runs interrupt` left the same way — issue #235
      // landed `POST /api/runs/:id/interrupt`, so it is a command now and `commands/runs.test.ts`
      // drives it. `secrets remove`, `skills remove` and `connectors update` left the same way —
      // issue #240 landed their routes, and `commands/{secrets,skills,connectors}.test.ts` drive
      // them. `workspaces list|create` and `team invitations list` left the same way — issue #242
      // signed the CLI in as a person, and `commands/{workspaces,team,auth}.test.ts` drive them.
      // The rest still wait on a server change.
      ['runtimes', 'detect'],
      ['runtimes', 'test', 'local'],
      ['agents', 'archive', 'x'],
      ['shares', 'publish'],
      ['team', 'invitations', 'accept', 'x'],
    ]) {
      const run = await runCli(absent);
      expect(run.code, absent.join(' ')).toBe(EXIT_CODE.usage);
      expect(run.stderr, absent.join(' ')).toContain('unknown command');
      expect(run.calls).toHaveLength(0);
    }
  });

  // Issue #416: `aw runs start ""` used to send `POST /api/agents//runs`.
  it('refuses an empty or blank id before any request, naming the argument', async () => {
    for (const [argv, message] of [
      [['runs', 'start', '', '--prompt', 'hi'], '<agent> must not be empty'],
      [['agents', 'get', ''], '<id> must not be empty'],
      [['runs', 'get', '   '], '<id> must not be empty'],
      [['runs', 'list', '--agent', ''], '--agent must not be empty'],
      [['runs', 'list', '--agent', 'a', '--agent', 'b'], '--agent was given more than once'],
    ] as const) {
      const run = await runCli([...argv]);
      expect(run.code, argv.join(' ')).toBe(EXIT_CODE.usage);
      expect(run.stderr, argv.join(' ')).toContain(message);
      expect(run.calls, argv.join(' ')).toHaveLength(0);
    }
  });

  it('refuses a flag the command does not declare instead of accepting and ignoring it', async () => {
    // The parser's flag tables are global, so `--all` parses everywhere; `runs list` has no
    // `--all`, and printing one page as if it were every page would be a silent lie.
    for (const argv of [
      ['runs', 'list', '--all'],
      ['agents', 'list', '--limit', '5'],
      ['shares', 'list', '--cursor', 'c'],
      ['me', '--all'],
    ]) {
      const run = await runCli(argv);
      expect(run.code, argv.join(' ')).toBe(EXIT_CODE.usage);
      expect(run.stderr, argv.join(' ')).toContain(`aw ${argv[0]}`);
      expect(run.stderr, argv.join(' ')).toContain('does not take --');
      expect(run.calls, argv.join(' ')).toHaveLength(0);
    }
    const runsList = await runCli(['runs', 'list', '--all']);
    expect(runsList.stderr).toContain('aw runs list does not take --all');
    expect(runsList.stderr).toContain('Usage: aw runs list [--status <status>]');
  });

  it('accepts the global flags and every flag a command declares in its usage line', () => {
    // A local command (issue #451) takes no configuration or output flag; see the case below.
    for (const command of COMMANDS.filter((candidate) => candidate.controlPlane !== 'none')) {
      const declared = supportedFlags(command);
      for (const global of [
        'url',
        'profile',
        'timeout',
        'json',
        'jsonl',
        'raw',
        'quiet',
        'version',
      ]) {
        expect(declared.has(global), `${command.path.join(' ')} --${global}`).toBe(true);
      }
    }
    const sessions = COMMANDS.find((command) => command.path.join(' ') === 'sessions list');
    expect(sessions === undefined ? [] : [...supportedFlags(sessions)]).toEqual(
      expect.arrayContaining(['status', 'limit', 'cursor', 'all']),
    );
  });

  it('lists the local commands, which take only --help, --version and their own flags (issue #451)', async () => {
    const help = await runCli(['--help']);
    expect(help.stdout).toContain('  aw init [--yes] [--theme <theme>]');
    expect(help.stdout).toContain(
      '  aw dev [--quiet] [--verbose] [--open | --no-open] [--sandbox <local|docker>] [--port <n>]\n',
    );
    const local = COMMANDS.filter((command) => command.controlPlane === 'none');
    expect(local.map((command) => command.path.join(' '))).toEqual([
      'init',
      'dev',
      'dev status',
      'dev stop',
      'tool call',
      'eval add',
      'deploy',
      'platforms list',
      'platforms export',
      'platforms publish',
      'platforms import',
      'platforms doctor',
    ]);
    const init = local.find((command) => command.path.join(' ') === 'init');
    expect(init === undefined ? [] : [...supportedFlags(init)].sort()).toEqual(
      [
        'help',
        'version',
        'yes',
        'answers',
        ...SETUP_QUESTIONS.map((question) => question.flag),
      ].sort(),
    );
    for (const argv of [
      ['dev', '--json'],
      ['init', '--open'],
      ['dev', '--url', 'https://aw.example.com'],
      ['init', '--jsonl'],
      ['init', '--profile', 'staging'],
      ['deploy', '--url', 'https://aw.example.com'],
    ]) {
      const run = await runCli(argv, { env: {} });
      expect(run.code, argv.join(' ')).toBe(EXIT_CODE.usage);
      expect(run.stderr).toContain(`aw ${argv[0] ?? ''} does not take ${argv[1] ?? ''}`);
      expect(run.calls).toEqual([]);
    }
  });

  it('exits 2 for --api-key before touching the network or the configuration', async () => {
    const run = await runCli(['agents', 'list', '--api-key', 'ak_live_x'], { env: {} });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--api-key is not accepted');
    expect(run.calls).toHaveLength(0);
  });

  it('exits 2 when no URL or key can be resolved, without a request', async () => {
    const run = await runCli(['agents', 'list'], { env: {} });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('no control plane URL');
    expect(run.calls).toHaveLength(0);
  });

  it('sends the resolved key as a bearer and renders a listing as a table', async () => {
    const run = await runCli(['agents', 'list'], {
      route: () => json(200, { agents: [FIXTURES.agent] }),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls[0]?.headers.get('authorization')).toBe('Bearer ak_live_test');
    expect(run.calls[0]?.url.href).toBe('https://aw.example.com/api/agents');
    expect(run.stdout.split('\n')[0]).toMatch(
      /^id\s+name\s+model\s+modelConnectionId\s+runtimeProfileId\s+updatedAt$/u,
    );
    expect(run.stdout).toContain('Summariser  claude-x');
  });

  it('exits 1 with "error: <code>: <message>" when the server refuses', async () => {
    const run = await runCli(['agents', 'get', 'x'], {
      route: () => json(404, { error: { code: 'agent_not_found', message: 'No such agent.' } }),
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toBe('error: agent_not_found: No such agent.\n');
    expect(run.stdout).toBe('');
  });

  it('exits 2 with a plain message when the SDK refuses an id before any request (issue #496)', async () => {
    const agent = await runCli(['agents', 'get', '..']);
    expect(agent.code).toBe(EXIT_CODE.usage);
    expect(agent.stderr).toContain('error: ');
    expect(agent.stderr).toContain('(got "..")');
    expect(agent.stderr).toContain('aw --help');
    expect(agent.stderr).not.toContain('unexpected');
    expect(agent.stdout).toBe('');
    expect(agent.calls).toHaveLength(0);

    const run = await runCli(['runs', 'get', '.']);
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('(got ".")');
    expect(run.stderr).toContain('aw --help');
    expect(run.stderr).not.toContain('unexpected');
    expect(run.calls).toHaveLength(0);
  });

  it('exits 3 when a successful response breaks the contract', async () => {
    const run = await runCli(['agents', 'list'], {
      route: () => json(200, { agents: [{ id: 1 }] }),
    });
    expect(run.code).toBe(EXIT_CODE.contract);
    expect(run.stderr).toContain('error: contract_violation: agents.list');
  });

  it('exits 4 when no response arrives', async () => {
    const run = await runCli(['agents', 'list'], {
      route: () => Promise.reject(new TypeError('fetch failed')),
    });
    expect(run.code).toBe(EXIT_CODE.transport);
    expect(run.stderr).toBe(
      'error: transport: agents.list: the request could not be completed (fetch failed)\n',
    );
  });

  it('exits 130 when interrupted', async () => {
    const controller = new AbortController();
    const run = await runCli(['agents', 'list'], {
      signal: controller.signal,
      route: () => {
        controller.abort();
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      },
    });
    expect(run.code).toBe(EXIT_CODE.interrupted);
    expect(run.stderr).toBe('interrupted\n');
  });

  it('reads stdin once: --api-key-stdin and --file - cannot both have it', async () => {
    const run = await runCli(['agents', 'create', '--api-key-stdin', '--file', '-'], {
      env: { AGENT_WORKSPACE_URL: 'https://aw.example.com' },
      stdin: 'ak_live_k',
    });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('standard input can be read only once');
    expect(run.calls).toHaveLength(0);
  });

  // Issue #879: every stdin reader, per command, refuses a terminal and gives up on a silent pipe.
  const STDIN_READERS = [
    [['agents', 'list', '--api-key-stdin'], '--api-key-stdin'],
    [['secrets', 'replace', 'API_TOKEN', '--value-stdin'], '--value-stdin'],
    [['models', 'connections', 'rotate-credential', 'mc_1', '--value-stdin'], '--value-stdin'],
    [['agents', 'create', '--file', '-'], '--file -'],
    [['runs', 'start', 'agent_1', '--prompt-file', '-'], '--prompt-file -'],
  ] as const;

  it('exits 2 naming the flag when a stdin reader finds a terminal, without a request', async () => {
    for (const [argv, flag] of STDIN_READERS) {
      const run = await runCli([...argv], {
        env: {
          AGENT_WORKSPACE_URL: 'https://aw.example.com',
          AGENT_WORKSPACE_API_KEY: 'ak_live_k',
        },
        stdinIsTty: true,
      });
      expect(run.code, argv.join(' ')).toBe(EXIT_CODE.usage);
      expect(run.stderr, argv.join(' ')).toContain(`fix: ${flag} reads standard input`);
      expect(run.calls, argv.join(' ')).toHaveLength(0);
    }
  });

  it('exits 2 when a stdin reader is given a pipe that stays open and silent', async () => {
    for (const [argv] of STDIN_READERS) {
      const run = await runCli([...argv], {
        env: {
          AGENT_WORKSPACE_URL: 'https://aw.example.com',
          AGENT_WORKSPACE_API_KEY: 'ak_live_k',
        },
        stdin: () => readStreamWithIdleTimeout(new PassThrough(), 20),
      });
      expect(run.code, argv.join(' ')).toBe(EXIT_CODE.usage);
      expect(run.stderr, argv.join(' ')).toContain('standard input stayed open with no data');
      expect(run.calls, argv.join(' ')).toHaveLength(0);
    }
  });

  it('applies --timeout to the client, and a timeout is a transport failure, not an interrupt', async () => {
    const run = await runCli(['agents', 'list', '--timeout', '1'], {
      route: (request) =>
        new Promise((_, reject) => {
          request.signal?.addEventListener('abort', () => {
            reject(new DOMException('timed out', 'TimeoutError'));
          });
        }),
    });
    expect(run.code).toBe(EXIT_CODE.transport);
    expect(run.stderr).toContain('the request was aborted');
  });
});
