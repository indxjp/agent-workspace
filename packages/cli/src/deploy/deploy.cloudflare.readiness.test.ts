import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { runDeployCommand } from './command.js';
import { captured, capturedFailure, stubRunner } from './deploy.test-support.js';
import {
  cloudflareEnvironment,
  cloudflareProject,
  cloudflareResponder,
  token,
} from './deploy.cloudflare.test-support.js';

const readiness = { windowMs: 250, delayMs: 5, requestTimeoutMs: 1_000 };
const managerHealth = 'https://acme-ai-manager.acme.workers.dev/healthz';
const hrefOf = (url: string | URL | Request) =>
  typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
const answering = (manager: () => Response) =>
  vi.fn((url: string | URL | Request) =>
    Promise.resolve(
      hrefOf(url).endsWith('/healthz') ? manager() : new Response('', { status: 200 }),
    ),
  );

function pollsThroughServerErrorsCase(): void {
  it('polls /setup after the last upload, through 503s, then reports Applied', async () => {
    const target = await cloudflareProject();
    const { runner, calls } = stubRunner(cloudflareResponder(false).respond);
    const answers = [503, 503, 200];
    const requests: { url: string; redirect: string | undefined }[] = [];
    const fetchStub = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const href = hrefOf(url);
      // The runner manager is awaited after the control plane; this case is about /setup.
      if (href === managerHealth) return Promise.resolve(new Response('ok', { status: 200 }));
      requests.push({ url: href, redirect: init?.redirect });
      return Promise.resolve(
        new Response('The control plane is starting', { status: answers.shift() ?? 500 }),
      );
    });

    const { result, output } = await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: cloudflareEnvironment,
        fetch: fetchStub,
        readiness: { ...readiness, windowMs: 5_000 },
      }),
    );

    expect(result).toEqual({ changes: true, applied: true });
    expect(requests).toEqual([
      { url: 'https://app.example.com/setup', redirect: 'manual' },
      { url: 'https://app.example.com/setup', redirect: 'manual' },
      { url: 'https://app.example.com/setup', redirect: 'manual' },
    ]);
    expect(output).toContain('Waiting for the control plane at https://app.example.com/setup');
    expect(output).toContain('Applied.');
    expect(calls.at(-1)?.args.slice(0, 2)).toEqual(['secret', 'put']);
    expect(JSON.stringify(fetchStub.mock.calls)).not.toContain(token);
  });
}

function neverAnswersCase(): void {
  it('fails with the status, the Worker body and the Worker name when it never answers 200', async () => {
    const target = await cloudflareProject();
    const { runner, calls } = stubRunner(cloudflareResponder(false).respond);
    const fetchStub = vi.fn(() =>
      Promise.resolve(
        new Response('The control plane did not answer on port 3000 within 60 s', {
          status: 503,
        }),
      ),
    );

    const { message, output } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: cloudflareEnvironment,
        fetch: fetchStub,
        readiness,
      }),
    );

    expect(fetchStub.mock.calls.length).toBeGreaterThan(1);
    expect(message).toContain('acme-ai-control-plane did not answer https://app.example.com/setup');
    expect(message).toMatch(/in 0\.25 s \(\d+ requests\); last: HTTP 503/u);
    expect(message).toContain('were applied');
    expect(output).toContain('did not answer on port 3000 within 60 s');
    expect(output).not.toContain('Applied.');
    expect(calls.filter(({ args }) => args[0] === 'deploy')).toHaveLength(4);
    expect(`${message}${output}`).not.toContain(token);
  });
}

function errorPageCases(): void {
  it("names Cloudflare's error code, page title and ray instead of printing its HTML boilerplate", async () => {
    const target = await cloudflareProject();
    const page =
      '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n' +
      '<html><head><title>Worker threw exception | app.workers.dev | Cloudflare</title></head>' +
      '<body><span class="cf-error-code">1101</span><h1>Error 1101</h1></body></html>';
    const fetchStub = vi.fn(() =>
      Promise.resolve(
        new Response(page, { status: 500, headers: { 'cf-ray': '9a1b2c3d4e5f-NRT' } }),
      ),
    );

    const { message, output } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner: stubRunner(cloudflareResponder(false).respond).runner,
        environment: cloudflareEnvironment,
        fetch: fetchStub,
        readiness,
      }),
    );

    expect(message).toContain('last: HTTP 500');
    expect(output).toContain('title: Worker threw exception | app.workers.dev | Cloudflare');
    expect(output).toContain('code: Error 1101');
    expect(output).toContain('cf-ray: 9a1b2c3d4e5f-NRT');
    expect(output).not.toContain('<!DOCTYPE');
  });

  it('keeps the body of an HTML answer that has a cf-ray but no title and no error code', async () => {
    const target = await cloudflareProject();
    const page = '<html><body><h1>The app could not render this page</h1></body></html>';
    const fetchStub = vi.fn(() =>
      Promise.resolve(
        new Response(page, { status: 500, headers: { 'cf-ray': '9a1b2c3d4e5f-NRT' } }),
      ),
    );

    const { output } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner: stubRunner(cloudflareResponder(false).respond).runner,
        environment: cloudflareEnvironment,
        fetch: fetchStub,
        readiness: { ...readiness, windowMs: 0 },
      }),
    );

    expect(output).toContain('The app could not render this page');
  });
}

function otherFailureCases(): void {
  it("shows the step in the Worker's own JSON answer", async () => {
    const target = await cloudflareProject();
    const body = { error: { code: 'worker_exception', step: 'forward', message: 'Error: x' } };
    const { output } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner: stubRunner(cloudflareResponder(false).respond).runner,
        environment: cloudflareEnvironment,
        fetch: () => Promise.resolve(Response.json(body, { status: 502 })),
        readiness,
      }),
    );

    expect(output).toContain('HTTP 502');
    expect(output).toContain('\\"step\\":\\"forward\\"');
  });

  it('does not count a redirect as an answer, and names a network failure', async () => {
    const target = await cloudflareProject();
    const redirected = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner: stubRunner(cloudflareResponder(false).respond).runner,
        environment: cloudflareEnvironment,
        fetch: () =>
          Promise.resolve(new Response(null, { status: 307, headers: { location: '/signin' } })),
        readiness,
      }),
    );
    expect(redirected.message).toContain('last: HTTP 307');

    const unreachable = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner: stubRunner(cloudflareResponder(true).respond).runner,
        environment: cloudflareEnvironment,
        fetch: () =>
          Promise.reject(
            new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND app') }),
          ),
        readiness,
      }),
    );
    expect(unreachable.message).toContain('last: network error (TypeError)');
    expect(unreachable.output).toContain('getaddrinfo ENOTFOUND app');
  });
}

function spentWindowAndExitedContainerCases(): void {
  it('makes one request when the window is already spent', async () => {
    const target = await cloudflareProject();
    const fetchStub = vi.fn(() => Promise.resolve(new Response('starting', { status: 503 })));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner: stubRunner(cloudflareResponder(false).respond).runner,
        environment: cloudflareEnvironment,
        fetch: fetchStub,
        readiness: { ...readiness, windowMs: 0 },
      }),
    );

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(message).toContain('(1 requests); last: HTTP 503');
  });

  it('points at the container log when the answer says the container exited, and only then', async () => {
    const target = await cloudflareProject();
    const exited = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner: stubRunner(cloudflareResponder(false).respond).runner,
        environment: cloudflareEnvironment,
        fetch: () =>
          Promise.resolve(
            new Response(
              'The runner manager container exited (Container exited with unexpected exit code: 1)',
              { status: 503 },
            ),
          ),
        readiness: { ...readiness, windowMs: 0 },
      }),
    );
    expect(exited.message).toContain('The container exited: the reason it printed is in its log');
    expect(exited.message).toContain('acme-ai-control-plane');

    const starting = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner: stubRunner(cloudflareResponder(true).respond).runner,
        environment: cloudflareEnvironment,
        fetch: () => Promise.resolve(new Response('starting', { status: 503 })),
        readiness: { ...readiness, windowMs: 0 },
      }),
    );
    expect(starting.message).not.toContain('The container exited');
  });
}

function noRequestForPlanCase(): void {
  it('makes no request for a plan', async () => {
    const target = await cloudflareProject();
    const fetchStub = vi.fn(() => Promise.resolve(new Response('', { status: 200 })));

    await captured(() =>
      runDeployCommand([target], {
        runner: stubRunner(cloudflareResponder(true).respond).runner,
        environment: cloudflareEnvironment,
        fetch: fetchStub,
        readiness,
      }),
    );

    expect(fetchStub).not.toHaveBeenCalled();
  });
}

function managerPollingCase(): void {
  it('polls /healthz through 503s after the control plane answers, then reports Applied', async () => {
    const target = await cloudflareProject();
    const { runner } = stubRunner(cloudflareResponder(false).respond);
    const managerAnswers = [503, 503, 200];
    const seen: { url: string; redirect: string | undefined }[] = [];
    const fetchStub = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const href = hrefOf(url);
      seen.push({ url: href, redirect: init?.redirect });
      return Promise.resolve(
        href === managerHealth
          ? new Response('The runner manager is starting', {
              status: managerAnswers.shift() ?? 500,
            })
          : new Response('', { status: 200 }),
      );
    });

    const { result, output } = await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: cloudflareEnvironment,
        fetch: fetchStub,
        readiness: { ...readiness, windowMs: 5_000 },
      }),
    );

    expect(result).toEqual({ changes: true, applied: true });
    expect(seen.map(({ url }) => url)).toEqual([
      'https://app.example.com/setup',
      managerHealth,
      managerHealth,
      managerHealth,
    ]);
    expect(seen.every(({ redirect }) => redirect === 'manual')).toBe(true);
    expect(output).toContain(`Waiting for the runner manager at ${managerHealth}`);
    expect(output).toContain('Applied.');
    expect(JSON.stringify(fetchStub.mock.calls)).not.toContain(token);
  });
}

function managerFailureAndDomainCases(): void {
  it('fails with the Worker name, the URL and the last status when it never answers 200', async () => {
    const target = await cloudflareProject();
    const { runner, calls } = stubRunner(cloudflareResponder(false).respond);
    const fetchStub = answering(
      () => new Response('The runner manager is starting', { status: 503 }),
    );

    const { message, output } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: cloudflareEnvironment,
        fetch: fetchStub,
        readiness,
      }),
    );

    expect(message).toContain(
      `runner manager Worker acme-ai-manager did not answer ${managerHealth}`,
    );
    expect(message).toMatch(/in 0\.25 s \(\d+ requests\); last: HTTP 503/u);
    expect(message).toContain('were applied');
    expect(output).toContain('The runner manager is starting');
    expect(output).not.toContain('Applied.');
    expect(calls.filter(({ args }) => args[0] === 'deploy')).toHaveLength(4);
    expect(`${message}${output}`).not.toContain(token);
    expect(JSON.stringify(fetchStub.mock.calls)).not.toContain(token);
  });

  it('polls the RUNNER_MANAGER_URL custom domain from .env', async () => {
    const target = await cloudflareProject();
    const file = path.join(target, '.env');
    await writeFile(
      file,
      `${await readFile(file, 'utf8')}RUNNER_MANAGER_URL=https://manager.example.com/\n`,
    );
    const fetchStub = answering(() => new Response('ok', { status: 200 }));

    await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner: stubRunner(cloudflareResponder(false).respond).runner,
        environment: cloudflareEnvironment,
        fetch: fetchStub,
        readiness,
      }),
    );

    expect(fetchStub.mock.calls.map(([url]) => hrefOf(url))).toContain(
      'https://manager.example.com/healthz',
    );
    expect(fetchStub.mock.calls.map(([url]) => hrefOf(url))).not.toContain(managerHealth);
  });
}

describe('agent-workspace deploy to Cloudflare', () => {
  describe('waits for the control plane', () => {
    pollsThroughServerErrorsCase();
    neverAnswersCase();
    errorPageCases();
    otherFailureCases();
    spentWindowAndExitedContainerCases();
    describe('then the runner manager', () => {
      managerPollingCase();
      managerFailureAndDomainCases();
    });

    noRequestForPlanCase();
  });
});
