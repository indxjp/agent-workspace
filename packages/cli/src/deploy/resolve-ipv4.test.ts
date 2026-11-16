import type { lookup } from 'node:dns/promises';

import { describe, expect, it, vi } from 'vitest';

import { resolveIpv4 } from './project.js';

describe('resolveIpv4', () => {
  it('asks for every IPv4 answer, not the one the operating system lists first', async () => {
    const answers = [
      { address: '198.51.100.1', family: 4 },
      { address: '203.0.113.7', family: 4 },
    ];
    const fake = vi.fn().mockResolvedValue(answers);

    await expect(resolveIpv4('app.example.com', fake as unknown as typeof lookup)).resolves.toBe(
      answers,
    );
    expect(fake).toHaveBeenCalledWith('app.example.com', { all: true, family: 4 });
  });
});
