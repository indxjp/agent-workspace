import { afterEach, describe, vi } from 'vitest';
import { clearApplicationContext } from '../application-context';
import { registerAcceptanceTests } from './invitation-routes.acceptance.test-support';
import { registerIdentityTests } from './invitation-routes.identity.test-support';
import { registerManagementTests } from './invitation-routes.management.test-support';
import { registerValidationTests } from './invitation-routes.validation.test-support';

afterEach(() => {
  for (const name of [
    'SESSION_SECRET',
    'OIDC_ISSUER_URL',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'OIDC_REDIRECT_URI',
  ]) {
    delete process.env[name];
  }
  clearApplicationContext();
  vi.restoreAllMocks();
});
describe('/api/invitations route wiring', () => {
  registerManagementTests();
  registerValidationTests(process.env);
  registerAcceptanceTests(process.env);
  registerIdentityTests(process.env);
});
