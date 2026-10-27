import { afterEach, expect, it, vi } from 'vitest';
import { log } from './logger';

afterEach(() => {
  vi.restoreAllMocks();
});

it('writes one JSON line tagged service=web and redacts the error it is given', () => {
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  log.error('[test] failed', {
    error: new Error(
      'upstream said Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
    ),
  });

  const line = String(write.mock.calls[0]?.[0]);
  const parsed = JSON.parse(line) as Record<string, unknown>;
  expect(parsed).toMatchObject({ level: 'error', service: 'web', msg: '[test] failed' });
  expect(line).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
});
