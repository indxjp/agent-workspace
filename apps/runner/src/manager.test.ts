import { expect, it } from 'vitest';
import type { RuntimeHandle } from '@agent-workspace/runtime/driver';
import {
  TOKEN,
  withManager,
  allocationBody,
  authenticated,
  allocate,
} from './manager.fixture.test-support.js';

it('runner manager Docker lifecycle > requires its private bearer and reuses live session/profile affinity', async () => {
  await withManager(async (base, fixture) => {
    expect(
      (
        await fetch(`${base}/runtimes`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(allocationBody),
        })
      ).status,
    ).toBe(401);

    const first = await allocate(base);
    expect(first.status).toBe(201);
    const firstValue = (await first.json()) as { handle: RuntimeHandle; runnerUrl: string };
    expect(firstValue.runnerUrl).toBe(`${base}/runtimes/${firstValue.handle.id}`);
    const createdConfig = fixture.create.mock.calls[0]?.[0];
    expect(createdConfig?.sessionId).toBe('session-one');
    expect(createdConfig?.workspacePath).toMatch(
      /srv[\\/]runtimes[\\/]workspace-one[\\/]session-one/u,
    );

    const reused = await allocate(base);
    expect(reused.status).toBe(200);
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });
});

it('runner manager Docker lifecycle > creates one runtime for two concurrent requests of the same session', async () => {
  await withManager(async (base, fixture) => {
    // A container takes time to start; both requests must arrive inside that window.
    const create = fixture.create.getMockImplementation();
    if (create === undefined) throw new Error('the fixture has no create');
    fixture.create.mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      return create(...args);
    });
    const allocateRuntime = (): Promise<Response> => allocate(base);
    const answers = await Promise.all([allocateRuntime(), allocateRuntime()]);
    expect(answers.map((answer) => answer.status).toSorted()).toEqual([200, 201]);
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });
});

it("runner manager Docker lifecycle > echoes the caller's scheme in runnerUrl instead of always http, per X-Forwarded-Proto", async () => {
  // A reverse proxy — Cloud Run's own edge included — terminates TLS and forwards plain HTTP to
  // this server, so trusting the literal connection scheme here would bake `http:` into
  // `runnerUrl` even when every real caller used `https:`. A caller that then POSTs to that
  // `http:` URL hits Cloud Run's http→https redirect, which drops `Authorization` across the
  // scheme change — turning the caller's next `/run` into a 401 this manager issued against
  // itself. `X-Forwarded-Proto` is what a caller's own request actually arrived as.
  await withManager(async (base) => {
    const created = await fetch(`${base}/runtimes`, {
      method: 'POST',
      headers: { ...authenticated, 'x-forwarded-proto': 'https' },
      body: JSON.stringify(allocationBody),
    });
    expect(created.status).toBe(201);
    const value = (await created.json()) as { runnerUrl: string };
    expect(value.runnerUrl.startsWith('https://')).toBe(true);
  });
});

it('runner manager Docker lifecycle > proxies the runtime contract by handle and destroys only that allocation', async () => {
  await withManager(async (base, fixture, proxy) => {
    const created = await allocate(base);
    const value = (await created.json()) as { handle: RuntimeHandle; runnerUrl: string };
    const run = await fetch(`${value.runnerUrl}/run`, {
      method: 'POST',
      headers: authenticated,
      body: JSON.stringify({ runId: 'run-one' }),
    });
    expect(await run.text()).toContain('run-done');
    expect(proxy).toHaveBeenCalledWith(
      `http://${value.handle.externalId}:8080/run`,
      expect.objectContaining({ method: 'POST' }),
    );

    const removed = await fetch(`${value.runnerUrl}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(removed.status).toBe(204);
    expect(fixture.destroy).toHaveBeenCalledOnce();
    expect(
      (
        await fetch(`${value.runnerUrl}`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(404);
  });
});
