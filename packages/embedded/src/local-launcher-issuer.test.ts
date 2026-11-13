import { expect, it } from 'vitest';

import { ADMIN_ID, harness, projectDir } from './launcher.test-support.js';

const devIssuer = {
  issuer: 'http://127.0.0.1:3300',
  clientId: 'aw-local-console',
  clientSecret: 'k'.repeat(43),
  redirectUri: 'http://127.0.0.1:3100/api/auth/callback',
  ownerSubject: `local:${'o'.repeat(43)}`,
};
const startWith = (environment: Record<string, unknown>) => ({
  type: 'start',
  projectDir,
  environment: { port: 3100, bootstrapAdmin: 'dev@localhost.test', ...environment },
});

it('links the bootstrap Owner to (issuer, ownerSubject) after the membership check', async () => {
  const h = harness();
  await expect(h.runWith(startWith({ devIssuer }))).resolves.toBe(0);
  const link = `link:${devIssuer.issuer}:${devIssuer.ownerSubject}:${ADMIN_ID}:directory`;
  expect(h.events.filter((event) => event.startsWith('link:'))).toEqual([link]);
  expect(h.events.indexOf(link)).toBeGreaterThan(
    h.events.indexOf('resolveMembership:dev@localhost.test:default'),
  );
  expect(h.env['OIDC_ISSUER_URL']).toBe(devIssuer.issuer);
  // The client secret is never written to the terminal.
  expect([...h.stdout, ...h.stderr].join('')).not.toContain(devIssuer.clientSecret);
});

it('links nothing without devIssuer', async () => {
  const h = harness();
  await expect(h.run()).resolves.toBe(0);
  expect(h.events.some((event) => event.startsWith('link:'))).toBe(false);
});

it('refuses to start when an OIDC_* variable is set beside devIssuer, and links nothing', async () => {
  const h = harness();
  h.env['OIDC_CLIENT_ID'] = 'hand-set';
  await expect(h.runWith(startWith({ devIssuer }))).resolves.not.toBe(0);
  expect(h.events.some((event) => event.startsWith('link:'))).toBe(false);
  expect(JSON.stringify(h.sent)).toContain('OIDC_CLIENT_ID');
  expect(JSON.stringify(h.sent)).not.toContain('hand-set');
});
