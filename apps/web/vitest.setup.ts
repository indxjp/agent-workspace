/**
 * Every `apps/web` test reads the sign-in settings from its own environment on each call, as the
 * auth modules did before refactoring part 03, step 3: a test sets `SESSION_SECRET` or
 * `AW_INSTANCE_ID` and the routes see it at once. In a real process the composition root installs
 * them once, at start-up (`register()`), and `close()` clears them, so they are reinstalled before
 * each test.
 */
import { beforeEach } from 'vitest';

beforeEach(async () => {
  // Imported here, not at the top: a static import would load `auth/oidc.ts`, and with it
  // `openid-client`, before a test file's `vi.mock('openid-client')` is registered.
  const { authSettingsFromEnvironment, installAuthSettingsReader } =
    await import('./server/auth-settings');
  installAuthSettingsReader(() => authSettingsFromEnvironment(process.env));
});
