import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { FIXTURES, json, tempFile } from '../testing.js';
import {
  ANTHROPIC_KEY,
  PROJECT_URL,
  DEFINE,
  READY,
  CREDENTIAL,
  sends,
  fakeRuntime,
  project,
  dev,
  type DevTty,
  synced,
} from './dev.test-support.js';
import { projectWithAgent, agentsRoute } from './dev.routes.test-support.js';

const tryUrl = `${PROJECT_URL}/p/s/main/try`;
async function withSurface(argv: readonly string[], tty?: DevTty) {
  const cwd = await projectWithAgent();
  await tempFile(
    cwd,
    'surfaces/main.ts',
    `${DEFINE}export default defineSurface({ name: 'main', agent: 'assistant' });
`,
  );
  return dev(cwd, {
    argv,
    env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
    route: agentsRoute,
    until: synced,
    ...(tty === undefined ? {} : { tty }),
  });
}

describe('aw dev opening the chat (UX-C): asking and declining', () => {
  it('on a terminal asks once and Enter opens the try page; the screen names the console first', async () => {
    const opened: string[] = [];
    const { run } = await withSurface([], { pasted: '', opened });
    expect(opened).toEqual([tryUrl]);
    expect(run.stdout).toContain('Agent Workspace');
    const screen = stripVTControlCharacters(run.stdout);
    expect(screen.indexOf(`try       ${tryUrl}`)).toBeLessThan(screen.indexOf('runtime   ready'));
    expect(screen).toContain(
      `console   ${PROJECT_URL}\n            sign in as admin@localhost.test\n            password in .agent-workspace/secrets/local-secrets.json\n`,
    );
    expect(screen).not.toContain('aw login');
  });

  it('n declines and opens nothing', async () => {
    const opened: string[] = [];
    await withSurface([], { pasted: '', open: 'n', opened });
    expect(opened).toEqual([]);
  });

  it('--open opens without asking, also with no terminal prompt; the link is said when no browser opens', async () => {
    const opened: string[] = [];
    await withSurface(['--open'], { pasted: '', noPrompt: true, opened });
    expect(opened).toEqual([tryUrl]);
    const { run } = await withSurface(['--open'], { pasted: '', browser: false });
    expect(run.stdout).toContain(`no browser could be opened here: open ${tryUrl} yourself`);
  }, 20_000);

  it('--no-open and --quiet never ask and never open', async () => {
    const opened: string[] = [];
    await withSurface(['--no-open'], { pasted: '', opened });
    await withSurface(['--quiet'], { pasted: '', opened });
    expect(opened).toEqual([]);
  }, 20_000);

  it('--open still opens under --quiet, an explicit request; with --no-open it is a usage error', async () => {
    const opened: string[] = [];
    await withSurface(['--quiet', '--open'], { pasted: '', opened });
    expect(opened).toEqual([tryUrl]);
    const cwd = await projectWithAgent();
    const both = await dev(cwd, { argv: ['--open', '--no-open'] });
    expect(both.run.code).toBe(EXIT_CODE.usage);
    expect(both.run.stderr).toContain('--open and --no-open cannot be used together');
  });
});

describe('aw dev opening the chat (UX-C): asking after the first sync', () => {
  it('asks only after the first sync has printed its lines', async () => {
    const cwd = await projectWithAgent();
    await tempFile(
      cwd,
      'surfaces/main.ts',
      `${DEFINE}export default defineSurface({ name: 'main', agent: 'assistant' });
`,
    );
    let stdout = '';
    const syncedAtAsk: boolean[] = [];
    await dev(cwd, {
      env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
      route: agentsRoute,
      until: (output) => {
        stdout = output.stdout;
        return synced(output);
      },
      tty: { pasted: '', onAsk: () => syncedAtAsk.push(stdout.includes('synced: ')) },
    });
    expect(syncedAtAsk).toEqual([true]);
  });

  it('a fatal first sync neither asks nor opens, even with --open', async () => {
    const cwd = await projectWithAgent();
    await tempFile(
      cwd,
      'surfaces/main.ts',
      `${DEFINE}export default defineSurface({ name: 'main', agent: 'assistant' });
`,
    );
    const opened: string[] = [];
    let thrown = false;
    await dev(cwd, {
      argv: ['--open'],
      env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
      route: agentsRoute,
      until: ({ stdout }) => {
        if (!thrown && stdout.includes('synced: ')) {
          thrown = true;
          throw new RangeError('the terminal went away');
        }
        return false;
      },
      tty: { pasted: '', opened },
    });
    expect(opened).toEqual([]);
  });
});

describe('aw dev opening the chat (UX-C): without a terminal or a key', () => {
  it('without a terminal it neither asks nor opens', async () => {
    const { run } = await withSurface([]);
    expect(run.stdout).toContain(`try       ${tryUrl}`);
    expect(run.stdout).not.toContain('Open the chat');
  });

  it('does not offer the chat when the provider rejected the key (BH061-051)', async () => {
    const cwd = await projectWithAgent();
    await tempFile(
      cwd,
      'surfaces/main.ts',
      `${DEFINE}export default defineSurface({ name: 'main', agent: 'assistant' });\n`,
    );
    const asked: string[] = [];
    const opened: string[] = [];
    const { run } = await dev(cwd, {
      env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
      route: (request) =>
        request.url.pathname === '/api/models'
          ? json(200, {
              models: [],
              unavailable: [
                {
                  connectionId: FIXTURES.modelConnection.id,
                  connectionName: 'default',
                  reason: 'The provider rejected the API key (HTTP 401).',
                  kind: 'credential-rejected',
                  status: 401,
                },
              ],
            })
          : agentsRoute(request),
      until: synced,
      tty: { pasted: '', asked, opened },
    });
    expect(run.stdout).toContain('the key was rejected (401)');
    expect(asked).toEqual([]);
    expect(opened).toEqual([]);
  });
});

describe('aw dev opening the chat (UX-C): a crashing runtime', () => {
  it('a runtime that crashes while the question is pending ends aw dev with its log tail', async () => {
    const cwd = await project({
      script: fakeRuntime(
        // Crash once the question is pending (the prompt below writes `asked`), not after a fixed
        // sleep: on a loaded runner the sleep ran out before the first sync had asked.
        `${sends(READY, CREDENTIAL)}
const { existsSync } = await import('node:fs');
await new Promise((resolve) => {
  const poll = setInterval(() => {
    if (existsSync('asked')) resolve(clearInterval(poll));
  }, 20);
});
process.exit(3);`,
      ),
    });
    await tempFile(
      cwd,
      'surfaces/main.ts',
      `${DEFINE}export default defineSurface({ name: 'main', agent: 'assistant' });
`,
    );
    await tempFile(
      cwd,
      'agents/assistant.ts',
      `${DEFINE}export default defineAgent({ name: 'assistant', instructions: 'Help people.' });
`,
    );
    const asked: string[] = [];
    const { run } = await dev(cwd, {
      env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
      route: agentsRoute,
      tty: {
        pasted: '',
        pending: true,
        asked,
        onAsk: () => {
          writeFileSync(path.join(cwd, 'asked'), '');
        },
      },
    });
    expect(asked).toEqual(['  Open the chat in your browser? (Y/n) ']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('full log: ');
  });
});

describe('aw dev opening the chat (UX-C): the console password and Ctrl-C', () => {
  it('says where the console password is: the environment, then .env, then the secrets file', async () => {
    const row = async (env: Record<string, string>, dotEnv?: string): Promise<string> => {
      const cwd = await projectWithAgent();
      if (dotEnv !== undefined) await tempFile(cwd, '.env', dotEnv);
      const { run } = await dev(cwd, { env, route: agentsRoute, until: synced });
      expect(run.stdout + run.stderr).not.toContain('Hunter2-Hunter2');
      return /password in (.*)$/mu.exec(run.stdout)?.[1] ?? '';
    };
    expect(await row({})).toBe('.agent-workspace/secrets/local-secrets.json');
    expect(await row({}, 'BOOTSTRAP_ADMIN_PASSWORD=Hunter2-Hunter2\n')).toBe(
      '.env (BOOTSTRAP_ADMIN_PASSWORD)',
    );
    expect(await row({ BOOTSTRAP_ADMIN_PASSWORD: 'Hunter2-Hunter2' })).toBe(
      'your environment (BOOTSTRAP_ADMIN_PASSWORD)',
    );
  }, 60_000);

  it('Ctrl-C at the question is an interrupt', async () => {
    const opened: string[] = [];
    const { run } = await withSurface([], { pasted: '', interrupt: true, opened });
    expect(run.code).toBe(EXIT_CODE.interrupted);
    expect(opened).toEqual([]);
  });
});
