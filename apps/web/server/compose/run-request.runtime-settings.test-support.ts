import { describe, expect, it } from 'vitest';

import { DEFAULT_WORKSPACE_ROOT, readRuntimeSettings } from './run-request';

export function registerRuntimeSettingsTests() {
  describe('readRuntimeSettings', () => {
    it('refuses a deployment with no RUNNER_URL, and names the variable', () => {
      const result = readRuntimeSettings({});
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toContain('RUNNER_URL');
      // No default. The reason a missing runtime must not become a guessed one is in the function.
      expect(result.reason).toContain('503');
    });

    it('refuses a RUNNER_URL that is not an http(s) URL', () => {
      expect(readRuntimeSettings({ RUNNER_URL: 'runner:8080' }).ok).toBe(false);
      expect(readRuntimeSettings({ RUNNER_URL: 'ftp://runner:8080' }).ok).toBe(false);
      expect(readRuntimeSettings({ RUNNER_URL: '   ' }).ok).toBe(false);
    });

    it('accepts a URL, strips its trailing slash, and defaults the workspace root', () => {
      const result = readRuntimeSettings({ RUNNER_URL: 'http://runner:8080/' });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      expect(result.settings.runnerUrl).toBe('http://runner:8080');
      expect(result.settings.workspaceRoot).toBe(DEFAULT_WORKSPACE_ROOT);
    });

    it('takes RUNNER_WORKSPACE_ROOT when it is set', () => {
      const result = readRuntimeSettings({
        RUNNER_URL: 'https://runtime.internal',
        RUNNER_WORKSPACE_ROOT: '/srv/sandboxes/',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      expect(result.settings.workspaceRoot).toBe('/srv/sandboxes');
    });
  });
}
