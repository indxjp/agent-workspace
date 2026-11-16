import { expect, it, vi } from 'vitest';
import { fixture, gcpProject, PASSWORD, WEB_URL } from './gcp-fixtures.test-support.ts';
import { commandLine } from './gcp-runner.test-support.ts';
import { captured, granted, scenario } from './gcp-scenario.test-support.ts';

const SETUP_URL = `${WEB_URL}/api/setup`;

/** The plan fixture plus a web service the apply creates (or only updates). */
async function planWith(action: 'create' | 'update' | null): Promise<string> {
  const parsed = JSON.parse(await fixture('plan.json')) as {
    resource_changes: Record<string, unknown>[];
  };
  const plan = {
    ...parsed,
    resource_changes: parsed.resource_changes.filter(
      (change) => change['address'] !== 'google_cloud_run_v2_service.web',
    ),
  };
  if (action !== null) {
    plan.resource_changes.push({
      address: 'google_cloud_run_v2_service.web',
      type: 'google_cloud_run_v2_service',
      name: 'web',
      change: { actions: [action], before: null, after: {} },
    });
  }
  return JSON.stringify(plan);
}

interface Setup {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A refusal that names its own code; a bare status answers `setup_unavailable`. */
interface Refusal {
  readonly status: number;
  readonly code: string;
}

/** A fetch that answers setup with `answers` in turn (the last one repeats). */
function fetchSetup(answers: readonly (number | Error | Refusal)[]) {
  const setups: Setup[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith('/api/setup')) return granted(input, init);
    setups.push({ url, init });
    const answer = answers[Math.min(setups.length, answers.length) - 1] ?? 201;
    if (answer instanceof Error) return Promise.reject(answer);
    const { status, code } =
      typeof answer === 'number' ? { status: answer, code: 'setup_unavailable' } : answer;
    return Promise.resolve(
      status < 300
        ? Response.json({ agentId: 'a' }, { status })
        : Response.json({ error: { code, message: PASSWORD } }, { status }),
    );
  };
  return { fetchStub, setups };
}

const noWait = () => Promise.resolve();

it('creates the web service, then connects Claude through POST /api/setup with the Owner password', async () => {
  const { fetchStub, setups } = fetchSetup([201]);
  const { run, calls } = await scenario(
    { fetch: fetchStub, sleep: noWait },
    { planJson: await planWith('create') },
  );

  const outcome = await run();

  expect(setups).toHaveLength(1);
  expect(setups[0]?.url).toBe(SETUP_URL);
  expect(setups[0]?.init?.method).toBe('POST');
  expect(setups[0]?.init?.headers).toEqual({
    'content-type': 'application/json',
    origin: WEB_URL,
  });
  expect(JSON.parse(String(setups[0]?.init?.body as string))).toEqual({
    provider: 'vertex',
    providerApiKey: '',
    runtime: 'cloud-run-service',
    adminEmail: 'owner@acme.example',
    adminPassword: PASSWORD,
    agentName: 'Assistant',
    agentInstructions: 'You are a helpful assistant.',
  });
  const lines = calls.map(commandLine);
  expect(lines.lastIndexOf('terraform output -raw web_url')).toBeLessThan(
    lines.indexOf('terraform output -raw bootstrap_admin_password'),
  );
  expect(captured.output).toMatch(/Connect Claude on Vertex AI \.\.\.\n/u);
  expect(captured.output).toContain(
    "model: Claude on Vertex AI (global), using this install's Google Cloud identity",
  );
  expect(outcome.nextSteps).toContain(
    "model: Claude on Vertex AI (global), using this install's Google Cloud identity",
  );
  expect(outcome.nextSteps).not.toContain(
    'model: connect one on the Models screen if you have not yet',
  );
  expect(captured.output).not.toContain(PASSWORD);
});

it('names the project location in the summary', async () => {
  const { fetchStub } = fetchSetup([201]);
  const { run } = await scenario(
    {
      fetch: fetchStub,
      sleep: noWait,
      project: await gcpProject('acme-ai', { modelLocation: 'eu' }),
    },
    { planJson: await planWith('create') },
  );

  const outcome = await run();

  expect(outcome.nextSteps).toContain(
    "model: Claude on Vertex AI (eu), using this install's Google Cloud identity",
  );
});

it.each([
  ['an update of web', 'update'],
  ['no change to web', null],
] as const)('does not call setup after %s', async (_name, action) => {
  const { fetchStub, setups } = fetchSetup([201]);
  const { run, calls } = await scenario(
    { fetch: fetchStub, sleep: noWait },
    { planJson: await planWith(action) },
  );

  const outcome = await run();

  expect(setups).toHaveLength(0);
  expect(calls.map(commandLine)).not.toContain('terraform output -raw bootstrap_admin_password');
  expect(captured.output).not.toContain('Connect Claude on Vertex AI');
  expect(outcome.nextSteps).toContain(
    'model: connect one on the Models screen if you have not yet',
  );
});

it('does not call setup when nothing was applied', async () => {
  const { fetchStub, setups } = fetchSetup([201]);
  const { run } = await scenario(
    { fetch: fetchStub, sleep: noWait, apply: false },
    { planJson: await planWith('create') },
  );

  await run();

  expect(setups).toHaveLength(0);
});

it('waits for the new revision on 503 and on a refused connection, then succeeds', async () => {
  const { fetchStub, setups } = fetchSetup([503, new TypeError('fetch failed'), 503, 201]);
  const sleep = vi.fn(noWait);
  const { run } = await scenario(
    { fetch: fetchStub, sleep },
    { planJson: await planWith('create') },
  );

  const outcome = await run();

  expect(setups).toHaveLength(4);
  expect(sleep).toHaveBeenCalledTimes(3);
  expect(sleep).toHaveBeenCalledWith(5000);
  expect(outcome.nextSteps).toContain(
    "model: Claude on Vertex AI (global), using this install's Google Cloud identity",
  );
});

it('gives up after about two minutes of 503 with a visible warning, and the deploy succeeds', async () => {
  const { fetchStub, setups } = fetchSetup([503]);
  const sleep = vi.fn(noWait);
  const { run } = await scenario(
    { fetch: fetchStub, sleep },
    { planJson: await planWith('create') },
  );

  const outcome = await run();

  expect(setups).toHaveLength(24);
  expect(sleep.mock.calls.length * 5000).toBeLessThanOrEqual(120_000);
  expect(outcome).toMatchObject({ applied: true });
  expect(captured.output).toContain(
    'warning: Claude on Vertex AI was not connected (HTTP 503 setup_unavailable)',
  );
  expect(captured.output).toContain(
    `next: open ${WEB_URL} and choose Claude on Google Cloud (Vertex AI) in setup`,
  );
  expect(outcome.nextSteps).toContain(
    'model: connect one on the Models screen if you have not yet',
  );
});

it('does not retry a refusal, and prints the status and code, never the body', async () => {
  const { fetchStub, setups } = fetchSetup([409]);
  const { run } = await scenario(
    { fetch: fetchStub, sleep: noWait },
    { planJson: await planWith('create') },
  );

  const outcome = await run();

  expect(setups).toHaveLength(1);
  expect(captured.output).toContain('(HTTP 409 setup_unavailable)');
  expect(captured.output).not.toContain(PASSWORD);
  expect(outcome.nextSteps).toContain(
    'model: connect one on the Models screen if you have not yet',
  );
});

const FORBIDDEN: Refusal = { status: 500, code: 'runtime_manager_forbidden' };

const WAITING = 'Waiting for the new permission to reach Cloud Run...\n';

it('retries a front-end 403 with a growing delay, says so once, and succeeds once setup passes', async () => {
  const { fetchStub, setups } = fetchSetup([FORBIDDEN, FORBIDDEN, 201]);
  const sleep = vi.fn<(milliseconds: number) => Promise<void>>(noWait);
  const { run } = await scenario(
    { fetch: fetchStub, sleep },
    { planJson: await planWith('create') },
  );

  const outcome = await run();

  expect(setups).toHaveLength(3);
  expect(sleep.mock.calls).toEqual([[5000], [10_000]]);
  expect(captured.output.split(WAITING)).toHaveLength(2);
  expect(outcome.nextSteps).toContain(
    "model: Claude on Vertex AI (global), using this install's Google Cloud identity",
  );
});

it('gives up after three minutes of waiting with the same warning, and the deploy succeeds', async () => {
  const { fetchStub, setups } = fetchSetup([FORBIDDEN]);
  const sleep = vi.fn<(milliseconds: number) => Promise<void>>(noWait);
  const { run } = await scenario(
    { fetch: fetchStub, sleep },
    { planJson: await planWith('create') },
  );

  const outcome = await run();

  const waited = sleep.mock.calls.reduce((total, [ms]) => total + ms, 0);
  expect(waited).toBe(180_000);
  expect(sleep.mock.calls.every(([ms]) => ms <= 30_000)).toBe(true);
  expect(setups).toHaveLength(sleep.mock.calls.length + 1);
  expect(outcome).toMatchObject({ applied: true });
  expect(captured.output).toContain(
    'warning: Claude on Vertex AI was not connected (HTTP 500 runtime_manager_forbidden)',
  );
  expect(captured.output).not.toContain(PASSWORD);
});

it.each([
  ['setup_failed', { status: 500, code: 'setup_failed' }],
  ['a 403 with another code', { status: 403, code: 'forbidden' }],
] as const)('does not retry %s', async (_name, refusal) => {
  const { fetchStub, setups } = fetchSetup([refusal, 201]);
  const sleep = vi.fn<(milliseconds: number) => Promise<void>>(noWait);
  const { run } = await scenario(
    { fetch: fetchStub, sleep },
    { planJson: await planWith('create') },
  );

  await run();

  expect(setups).toHaveLength(1);
  expect(sleep).not.toHaveBeenCalled();
  expect(captured.output).not.toContain(WAITING);
  expect(captured.output).toContain(`(HTTP ${String(refusal.status)} ${refusal.code})`);
});

it('masks the Owner password in anything the step prints', async () => {
  const { fetchStub } = fetchSetup([new Error(`connect failed for ${PASSWORD}`)]);
  const { run } = await scenario(
    { fetch: fetchStub, sleep: noWait },
    { planJson: await planWith('create') },
  );

  await run();

  expect(captured.output).toContain('Claude on Vertex AI was not connected (no connection)');
  expect(captured.output).not.toContain(PASSWORD);
});
