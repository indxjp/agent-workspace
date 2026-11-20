import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { DEPLOY_RECIPES } from './recipes.ts';
import { DESK, FACTS, redactor } from './recipes.test-support.ts';

describe('DEPLOY_RECIPES gcp-cloudrun nextSteps (#948)', () => {
  it('gcp-cloudrun names the terraform output command for a legacy or --infra stack', () => {
    const moduleDirectory = path.join('/x/infra', 'terraform', 'gcp-cloudrun');
    const steps = DEPLOY_RECIPES['gcp-cloudrun'].nextSteps({ ...FACTS, moduleDirectory });

    expect(steps.at(-1)).toBe(
      `owner password: terraform -chdir=${moduleDirectory} output -raw bootstrap_admin_password`,
    );
    expect(steps.join('\n')).not.toContain('--show-owner-password');
  });

  it('gcp-cloudrun names the managed password command and no caddy or .env', () => {
    const moduleDirectory =
      '/home/owner/.config/agent-workspace/deployments/acme-ai/production.infra/terraform/gcp-cloudrun';
    const steps = DEPLOY_RECIPES['gcp-cloudrun'].nextSteps({
      ...FACTS,
      moduleDirectory,
      managedStack: true,
    });

    expect(steps).toEqual([
      'web: not up yet; run aw deploy production to bring it up',
      'sign-in: Owner password (set gcp.oidc for single sign-on)',
      'model: connect one on the Models screen if you have not yet',
      'owner: admin@localhost.test',
      'owner password: aw deploy production --show-owner-password',
    ]);
    const text = steps.join('\n');
    expect(text).not.toContain('caddy');
    expect(text).not.toContain('.env');
    expect(text).not.toContain('terraform');
  });

  it('gcp-cloudrun prints the web address, and never the Owner password (golden)', async () => {
    const steps = DEPLOY_RECIPES['gcp-cloudrun'].nextSteps({
      ...FACTS,
      moduleDirectory: '/state/production.infra/terraform/gcp-cloudrun',
      managedStack: true,
      webUrl: 'https://aw-web-123456789012.asia-northeast1.run.app',
      seededLocation: 'global',
    });

    const printed = redactor()(`${steps.join('\n')}\n`);
    expect(printed).toBe(
      await readFile(
        new URL('./fixtures/gcp-lifecycle/success-summary.txt', import.meta.url),
        'utf8',
      ),
    );
    expect(printed).not.toMatch(/bootstrap_admin_password|BOOTSTRAP_ADMIN_PASSWORD/u);
  });

  it('gcp-cloudrun says which sign-in is active, and where a domain must point', () => {
    const recipe = DEPLOY_RECIPES['gcp-cloudrun'];
    const steps = recipe.nextSteps({
      ...FACTS,
      managedStack: true,
      webUrl: 'https://aw-web-123456789012.asia-northeast1.run.app',
      oidcIssuer: 'https://accounts.example.com',
      domain: 'agents.example.com',
      loadBalancerIp: '203.0.113.7',
    });
    expect(steps.slice(0, 4)).toEqual([
      'web: https://agents.example.com',
      'next: point agents.example.com at 203.0.113.7',
      'sign-in: single sign-on through https://accounts.example.com; the Owner password stays as a break-glass sign-in',
      'next: register https://agents.example.com/api/auth/callback as the redirect URI at https://accounts.example.com',
    ]);
    const noAddress = recipe.nextSteps({
      ...FACTS,
      managedStack: true,
      domain: 'agents.example.com',
    });
    expect(noAddress.join('\n')).not.toContain('next: point');
    expect(recipe.nextSteps({ ...FACTS, managedStack: true })).toContain(
      'sign-in: Owner password (set gcp.oidc for single sign-on)',
    );
  });

  // Run 42674364781: web sends <web_url>/api/auth/callback as its redirect URI, so the line names
  // exactly the web line's origin, and nothing before the stack reports one.
  it('gcp-cloudrun names the redirect URI to register on the web line origin', () => {
    const recipe = DEPLOY_RECIPES['gcp-cloudrun'];
    const webUrl = 'https://aw-web-123456789012.asia-northeast1.run.app';
    const oidc = { ...FACTS, managedStack: true, oidcIssuer: 'https://accounts.example.com' };
    const steps = recipe.nextSteps({ ...oidc, webUrl });
    expect(steps.slice(0, 3)).toEqual([
      `web: ${webUrl}`,
      'sign-in: single sign-on through https://accounts.example.com; the Owner password stays as a break-glass sign-in',
      `next: register ${webUrl}/api/auth/callback as the redirect URI at https://accounts.example.com`,
    ]);
    expect(recipe.nextSteps(oidc).join('\n')).not.toContain('redirect URI');
    expect(recipe.nextSteps({ ...FACTS, managedStack: true, webUrl }).join('\n')).not.toContain(
      'redirect URI',
    );
  });

  describe('gcp-cloudrun apps', () => {
    const recipe = DEPLOY_RECIPES['gcp-cloudrun'];
    const GAP =
      'gap: app desk has no workspaceId, connectorId, apiKeySecret (environments.production.apps.desk)';
    const NEXT =
      "next: create the app's workspace and Admin API key after the Owner signs in, store the key in Secret Manager, set environments.production.apps.<name>.workspaceId / apiKeySecret / connectorId, and run aw deploy production --yes again (docs/40-operate/deploy/gcp-cloudrun.md#connecting-an-app-to-its-workspace)";
    const SIGN_IN_GAP =
      'gap: app desk answers sign_in_not_configured until gcp.oidc and its signIn are set (environments.production.apps.desk.signIn; docs/40-operate/deploy/gcp-cloudrun.md#signing-people-in-to-an-app)';
    const withDesk = { ...FACTS, managedStack: true, apps: DESK };

    it('prints nothing for a project without apps', () => {
      expect(recipe.nextSteps(FACTS).join('\n')).not.toContain('app ');
      expect(recipe.nextSteps(FACTS)).not.toContain(GAP);
    });

    it('says an app is internal only without a domain, and names its run.app URL', () => {
      const steps = recipe.nextSteps({
        ...withDesk,
        appUrls: { desk: 'https://aw-app-desk-abc123-an.a.run.app' },
      });
      expect(steps.slice(-5)).toEqual([
        'app desk: https://aw-app-desk-abc123-an.a.run.app',
        'app desk: internal only; set gcp.domain to serve its pages at https://desk.acme.example',
        GAP,
        NEXT,
        SIGN_IN_GAP,
      ]);
    });

    it('names only the keys an app still lacks, and prints no gap for an app that has all three', () => {
      const partial = recipe.nextSteps({
        ...withDesk,
        apps: {
          desk: { ...DESK.desk, workspaceId: '7b0e1a52-3f5d-4c3e-9a55-0d6a3e7f2b11' },
        },
      });
      expect(partial).toContain(
        'gap: app desk has no connectorId, apiKeySecret (environments.production.apps.desk)',
      );
      const complete = recipe.nextSteps({
        ...withDesk,
        oidcIssuer: 'https://accounts.example.com',
        apps: {
          desk: {
            ...DESK.desk,
            workspaceId: '7b0e1a52-3f5d-4c3e-9a55-0d6a3e7f2b11',
            connectorId: 'desk',
            apiKeySecret: 'desk-api-key',
            signIn: {
              oidcClientId: 'desk-client',
              oidcClientSecret: 'desk-oidc-client-secret',
              appClientId: 'b6e5f0c2-7d4e-4f1b-9a0c-3e2d1c0b9a87',
              appClientSecret: 'desk-app-client-secret',
            },
          },
        },
      });
      expect(complete.join('\n')).not.toMatch(/gap:|next: create the app's workspace/u);
      expect(complete).toContain(
        'next: register https://desk.acme.example/api/sign-in/callback as a redirect URI of client desk-client at https://accounts.example.com',
      );
    });

    it('names only the app sign-in as missing once the deployment has an issuer', () => {
      const steps = recipe.nextSteps({ ...withDesk, oidcIssuer: 'https://accounts.example.com' });
      expect(steps).toContain(
        'gap: app desk answers sign_in_not_configured until its signIn is set (environments.production.apps.desk.signIn; docs/40-operate/deploy/gcp-cloudrun.md#signing-people-in-to-an-app)',
      );
      expect(steps).not.toContain(SIGN_IN_GAP);
    });

    it('says an app is not up yet before the apps output exists', () => {
      expect(recipe.nextSteps(withDesk)).toContain('app desk: not up yet');
    });

    it('points the app host at the load balancer with a domain', () => {
      const steps = recipe.nextSteps({
        ...withDesk,
        domain: 'agents.example.com',
        loadBalancerIp: '203.0.113.7',
      });
      expect(steps).toContain('next: point desk.acme.example at 203.0.113.7');
      expect(steps.join('\n')).not.toContain('internal only');
    });
  });
});
