import { afterEach, expect, it, vi } from 'vitest';

import { createRuntimeManagerClient } from './runtime-manager-client';

afterEach(() => vi.restoreAllMocks());

it.each(['closeToolSandbox', 'releaseRunToolSandboxes'] as const)(
  '%s bounds its inline cleanup request to ten seconds',
  async (operation) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = createRuntimeManagerClient('https://manager.example', 'a'.repeat(32), fetch);

    await client[operation]('workspace', 'subject');

    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  },
);
