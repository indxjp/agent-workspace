/**
 * `GET /api/readyz` — issue #1562, owner decision D9: a set-but-malformed `MASTER_ENCRYPTION_KEY`
 * fails readiness (boot continues), an unset one does not.
 */
import { createInMemoryStorageConnectionRepositoryProvider } from '@agent-workspace/core/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from '../app/api/readyz/route';
import { installTestDomains } from './application-context-fixtures';
import { clearApplicationContext } from './application-context';
import { installSecretsApi } from './composition/services';
import { captureLog } from './telemetry/capture-log';

afterEach(() => {
  clearApplicationContext();
  vi.unstubAllEnvs();
});

describe('GET /api/readyz', () => {
  it('is ready before anything is wired, and while secrets are merely not configured', async () => {
    expect(GET().status).toBe(200);
    installTestDomains({ secrets: { kind: 'unavailable' } });
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ready' });
  });

  it('is not ready for a malformed MASTER_ENCRYPTION_KEY, names it, and never returns or logs the value', async () => {
    const malformed = 'zz-not-a-hex-key-zz';
    vi.stubEnv('MASTER_KEY_PROVIDER', '');
    vi.stubEnv('MASTER_ENCRYPTION_KEY', malformed);
    const capture = captureLog();
    try {
      const { secrets } = await installSecretsApi(
        () => Promise.resolve({ kind: 'workspace', workspaceId: 'ws-a' }),
        {
          forWorkspaceId: () => Promise.resolve(null),
          forWorkspaceSlug: () => Promise.resolve(null),
        },
        createInMemoryStorageConnectionRepositoryProvider(),
      );
      installTestDomains({ secrets });
      const response = GET();
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        error: {
          code: 'service_unavailable',
          message: expect.stringMatching(/MASTER_ENCRYPTION_KEY.*64 hex characters/u) as string,
          details: ['malformed_master_key'],
        },
      });
      expect(text).not.toContain(malformed);
      expect(capture.text()).not.toContain(malformed);
    } finally {
      capture.restore();
    }
  });
});
