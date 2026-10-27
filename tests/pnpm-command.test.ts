import { describe, expect, it } from 'vitest';

import { pnpmCommand } from '../scripts/test-services/pnpm-command.mjs';

describe('pnpmCommand', () => {
  it('runs a JavaScript pnpm entry point through node', () => {
    const run = pnpmCommand('/pnpm/bin/pnpm.cjs', ['exec', 'vitest']);
    expect(run.command).toBe(process.execPath);
    expect(run.args).toEqual(['/pnpm/bin/pnpm.cjs', 'exec', 'vitest']);
  });

  it('runs a native pnpm executable directly', () => {
    expect(pnpmCommand('C:/pnpm/pnpm.exe', ['exec', 'vitest'])).toEqual({
      command: 'C:/pnpm/pnpm.exe',
      args: ['exec', 'vitest'],
    });
    expect(pnpmCommand('/usr/local/bin/pnpm', ['build'])).toEqual({
      command: '/usr/local/bin/pnpm',
      args: ['build'],
    });
  });
});
