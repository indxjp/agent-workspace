/**
 * Issue #1168: the deployment workspace is `WORKSPACE_SLUG` alone, so a deployment that signs in
 * only through OIDC (no bootstrap credential) still resolves it. `readBootstrapAdmin` keeps its
 * own checks, in the same order, and reuses the slug rule.
 */
import { describe, expect, it } from 'vitest';

import { readBootstrapAdmin, readDeploymentWorkspaceSlug } from './session';

const BAD_SLUG = 'WORKSPACE_SLUG is not a usable lower-case URL-safe slug.';
const CREDENTIALS = {
  BOOTSTRAP_ADMIN: 'Owner@Example.com',
  BOOTSTRAP_ADMIN_PASSWORD: 'x'.repeat(12),
};

describe('readDeploymentWorkspaceSlug', () => {
  it('defaults to `default` when WORKSPACE_SLUG is unset or blank, with no bootstrap variables', () => {
    expect(readDeploymentWorkspaceSlug({})).toEqual({ ok: true, slug: 'default' });
    expect(readDeploymentWorkspaceSlug({ WORKSPACE_SLUG: '   ' })).toEqual({
      ok: true,
      slug: 'default',
    });
  });

  it('trims the configured slug', () => {
    expect(readDeploymentWorkspaceSlug({ WORKSPACE_SLUG: '  acme ' })).toEqual({
      ok: true,
      slug: 'acme',
    });
  });

  it('rejects a slug that is not lower-case and URL-safe', () => {
    expect(readDeploymentWorkspaceSlug({ WORKSPACE_SLUG: 'Bad Slug' })).toEqual({
      ok: false,
      reason: BAD_SLUG,
    });
  });
});

describe('readBootstrapAdmin', () => {
  it('still names the missing or unusable email first', () => {
    expect(readBootstrapAdmin({})).toMatchObject({
      ok: false,
      reason: expect.stringContaining('BOOTSTRAP_ADMIN is not set.') as string,
    });
    expect(readBootstrapAdmin({ BOOTSTRAP_ADMIN: 'not-an-email' })).toEqual({
      ok: false,
      reason: 'BOOTSTRAP_ADMIN is not a usable email address.',
    });
  });

  it('still names the missing or short password before the slug', () => {
    expect(
      readBootstrapAdmin({ BOOTSTRAP_ADMIN: 'a@b.co', WORKSPACE_SLUG: 'Bad Slug' }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('BOOTSTRAP_ADMIN_PASSWORD is not set.') as string,
    });
    expect(
      readBootstrapAdmin({ BOOTSTRAP_ADMIN: 'a@b.co', BOOTSTRAP_ADMIN_PASSWORD: 'short' }),
    ).toEqual({
      ok: false,
      reason: 'BOOTSTRAP_ADMIN_PASSWORD is 5 characters; the minimum is 12.',
    });
  });

  it('returns the lower-cased email and the default workspace when WORKSPACE_SLUG is unset', () => {
    expect(readBootstrapAdmin(CREDENTIALS)).toEqual({
      ok: true,
      admin: { email: 'owner@example.com', password: 'x'.repeat(12), workspaceSlug: 'default' },
    });
  });

  it('returns the configured workspace and rejects an unusable one with the slug reason', () => {
    expect(readBootstrapAdmin({ ...CREDENTIALS, WORKSPACE_SLUG: ' acme ' })).toMatchObject({
      ok: true,
      admin: { workspaceSlug: 'acme' },
    });
    expect(readBootstrapAdmin({ ...CREDENTIALS, WORKSPACE_SLUG: 'Bad Slug' })).toEqual({
      ok: false,
      reason: BAD_SLUG,
    });
  });
});
