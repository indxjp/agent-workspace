import path from 'node:path';

import { expect, it } from 'vitest';

import { harness, projectDir, TOKEN } from './launcher.test-support.js';
import { HAND_SET_POLICY_WARNING } from './local-environment.js';

it('revokes the key before closing the database when a step after issuing it fails', async () => {
  const h = harness();
  const send = h.deps.channel.send.bind(h.deps.channel);
  h.deps.channel.send = (message) => {
    if (typeof message === 'object' && message !== null && 'type' in message) {
      if (message.type === 'credential') return Promise.reject(new Error('channel closed'));
    }
    return send(message);
  };
  await expect(h.run()).resolves.toBe(1);
  expect(h.events.slice(-3)).toStrictEqual(['revoke', 'root.close', 'workspace.close']);
  for (const output of [...h.stdout, ...h.stderr]) expect(output).not.toContain(TOKEN);
});

it('refuses a relative or missing project directory before touching anything', async () => {
  for (const dir of ['relative/project', path.join(projectDir, 'missing')]) {
    const h = harness();
    await expect(h.run(dir)).resolves.toBe(1);
    expect(h.sent).toStrictEqual([
      {
        type: 'failed',
        message: 'the project directory must be an existing absolute directory',
      },
    ]);
    expect(h.events).toStrictEqual(['send:failed']);
  }
});

it('prints the hand-set policy warning before starting anything when start sends no policy (#534)', async () => {
  let order: string[] = [];
  const h = harness({ stderr: (chunk) => void order.push(`stderr:${chunk}`) });
  order = h.events;
  const handSet = '{ "limits": { "maxTurns": 5 } }';
  h.env['AW_DEPLOYMENT_POLICY'] = handSet;
  await expect(h.run()).resolves.toBe(0);
  const warning = `stderr:${HAND_SET_POLICY_WARNING}\n`;
  expect(h.events.filter((event) => event.startsWith('stderr:'))).toStrictEqual([warning]);
  const started = h.events.findIndex((event) => event.startsWith('startWorkspace'));
  expect(started).toBeGreaterThan(h.events.indexOf(warning));
  expect(h.env['AW_DEPLOYMENT_POLICY']).toBe(handSet);
});

// ADR-0109 slice-2 amendment: the withheld check runs after `.env` is loaded, so a secret kept
// only in `.env` is refused rather than reaching the runtime.
it('refuses a withheld name that .env sets, after loading it and before starting anything (#534)', async () => {
  const value = 'ghp_from-dotenv-only';
  const h = harness({
    loadDotEnv: () => {
      h.events.push('loadDotEnv');
      h.env['github_token'] = value;
    },
  });
  const result = h.runWith({
    type: 'start',
    projectDir,
    environment: {
      port: 3100,
      bootstrapAdmin: 'Dev@Localhost.test',
      withheld: ['GITHUB_TOKEN'],
    },
  });
  await expect(result).resolves.toBe(1);
  expect(h.events).toContain('loadDotEnv');
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toMatchObject({ type: 'failed' });
  const failed = JSON.stringify(h.sent[0]);
  expect(failed).toContain('GITHUB_TOKEN is named by secret()');
  expect(failed).toContain('remove it from .env');
  expect(failed).not.toContain(value);
  expect(h.events.some((event) => event.startsWith('startWorkspace'))).toBe(false);
});

it('refuses a conflicting environment before starting anything', async () => {
  const h = harness();
  h.env['HOST'] = '0.0.0.0';
  await expect(h.run()).resolves.toBe(1);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toMatchObject({ type: 'failed' });
  expect(JSON.stringify(h.sent[0])).toContain('local posture needs a loopback HOST');
  expect(h.events.some((event) => event.startsWith('startWorkspace'))).toBe(false);
});

it('never passes the token to a writer, even on failure', async () => {
  const ok = harness();
  await ok.run();
  ok.signal('SIGINT');
  await ok.exitCode;
  const failing = harness({ issueLocalCredential: () => Promise.reject(new Error(TOKEN)) });
  failing.deps.channel.send = () => Promise.reject(new Error('channel closed'));
  await failing.run();
  for (const output of [...ok.stdout, ...ok.stderr, ...failing.stdout, ...failing.stderr]) {
    expect(output).not.toContain(TOKEN);
  }
  expect(failing.stderr.join('')).toContain('the local runtime failed to start (Error)');
});

it('never prints the generated password, only where it is kept (BH061-011)', async () => {
  // The first start generates the password, the second reads it back.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const start = harness();
    await start.run();
    const line = start.stdout.join('');
    expect(line).toContain('dev@localhost.test');
    expect(line).not.toContain(String(start.env['BOOTSTRAP_ADMIN_PASSWORD']));
    expect(line).toContain(
      `the password is in ${path.join(projectDir, '.agent-workspace', 'secrets', 'local-secrets.json')}`,
    );
  }
});
