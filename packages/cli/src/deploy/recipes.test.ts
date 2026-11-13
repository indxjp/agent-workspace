import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  PROJECT_DEPLOY_TARGETS,
  type ProductionEnvironment,
  type ProjectDocument,
} from '@indx-workspace/contracts/project-file';
import { describe, expect, it } from 'vitest';

import { ProfileError } from '../profile.ts';
import { composeProjectName } from '../render/env.ts';
import { DEPLOY_RECIPES } from './recipes.ts';
import { createRedactor } from './redact.ts';

const FACTS = {
  projectName: 'acme-ai',
  url: 'https://agents.acme.example',
  adminEmail: 'admin@localhost.test',
  envFile: '/home/owner/.config/agent-workspace/deployments/acme-ai/production/.env',
  moduleDirectory: null,
  managedStack: false,
  webUrl: null,
  oidcIssuer: null,
  domain: null,
  loadBalancerIp: null,
  frontend: false,
  apps: {},
} as const;

/** The redactor `aw deploy` prints through, over an `.env` holding the generated Owner password. */
function redactor(): (text: string) => string {
  return createRedactor({ BOOTSTRAP_ADMIN_PASSWORD: 'generated-password-0123456789' });
}

/** Only `name` and `environments.production.apps` are read by the recipes' project checks. */
function projectNamed(length: number): ProjectDocument {
  return { name: 'a'.repeat(length), environments: {} } as ProjectDocument;
}

function projectWithApps(apps: ProductionEnvironment['apps']): ProjectDocument {
  return {
    name: 'acme-ai',
    environments: { production: { target: 'single-vm', url: FACTS.url, apps } },
  } as unknown as ProjectDocument;
}

const DESK = {
  desk: { image: `ghcr.io/acme/desk@sha256:${'a1'.repeat(32)}`, url: 'https://desk.acme.example' },
};

describe('DEPLOY_RECIPES (#948)', () => {
  it('has exactly one recipe per deploy target, in the contracts order', () => {
    expect(Object.keys(DEPLOY_RECIPES)).toEqual([...PROJECT_DEPLOY_TARGETS]);
  });

  describe('nextSteps, byte for byte what aw deploy printed', () => {
    it('single-vm', () => {
      expect(DEPLOY_RECIPES['single-vm'].nextSteps(FACTS)).toEqual([
        'next: caddy reverse-proxy --from agents.acme.example --to 127.0.0.1:3000',
        'next: aw login --url https://agents.acme.example',
        `the Owner is admin@localhost.test; the password is BOOTSTRAP_ADMIN_PASSWORD in ${FACTS.envFile}`,
      ]);
    });

    it('single-vm adds, per app in name order, its Caddy site, its .env lines and its connector (#1512)', () => {
      const steps = DEPLOY_RECIPES['single-vm'].nextSteps({
        ...FACTS,
        apps: { ...DESK, crm: { ...DESK.desk, url: 'https://crm.acme.example' } },
      });

      expect(steps.slice(3)).toEqual([
        'next: caddy reverse-proxy --from crm.acme.example --to 127.0.0.1:3100',
        `next: set AW_APP_CRM_API_KEY (an Admin API key), AW_APP_CRM_WORKSPACE_ID and, after registering the connector, AW_APP_CRM_CONNECTOR_ID in ${FACTS.envFile}, then aw deploy production --yes`,
        "next: store AW_APP_CRM_IDENTITY_SECRET's value as the workspace secret APP_CRM_IDENTITY (aw secrets create --name APP_CRM_IDENTITY --value-stdin), then register connector crm → https://crm.acme.example/api/mcp with identity: { secret: APP_CRM_IDENTITY } (aw connectors create --file …; docs/deploy/single-vm.md#apps)",
        'next: caddy reverse-proxy --from desk.acme.example --to 127.0.0.1:3101',
        `next: set AW_APP_DESK_API_KEY (an Admin API key), AW_APP_DESK_WORKSPACE_ID and, after registering the connector, AW_APP_DESK_CONNECTOR_ID in ${FACTS.envFile}, then aw deploy production --yes`,
        "next: store AW_APP_DESK_IDENTITY_SECRET's value as the workspace secret APP_DESK_IDENTITY (aw secrets create --name APP_DESK_IDENTITY --value-stdin), then register connector desk → https://desk.acme.example/api/mcp with identity: { secret: APP_DESK_IDENTITY } (aw connectors create --file …; docs/deploy/single-vm.md#apps)",
      ]);
    });

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
        'gap: AW_WORKSPACE_ID, AW_APP_API_KEY and AW_APP_CONNECTOR_ID are not set on Cloud Run yet, so an app answers app_misconfigured past /api/health';
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
        expect(steps.slice(-3)).toEqual([
          'app desk: https://aw-app-desk-abc123-an.a.run.app',
          'app desk: internal only; set gcp.domain to serve its pages at https://desk.acme.example',
          GAP,
        ]);
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

    it('kubernetes names the Secrets and the ingress, and no caddy, terraform or overlay', () => {
      const overlay = '/state/deploy/helm/values.yaml';
      const steps = DEPLOY_RECIPES.kubernetes.nextSteps({ ...FACTS, envFile: overlay });

      expect(steps).toEqual([
        'the chart reads three Secrets you create in the agent-workspace namespace: agent-workspace-database, agent-workspace-object-store, agent-workspace-secrets',
        'next: point agents.acme.example at the ingress controller: kubectl -n agent-workspace get ingress',
        'next: aw login --url https://agents.acme.example',
        'the Owner and password are BOOTSTRAP_ADMIN and BOOTSTRAP_ADMIN_PASSWORD in agent-workspace-secrets',
      ]);
      const text = steps.join('\n');
      expect(text).not.toContain('caddy');
      expect(text).not.toContain('terraform');
      expect(text).not.toContain(overlay);
    });

    it('vercel without a frontend', () => {
      expect(DEPLOY_RECIPES.vercel.nextSteps(FACTS)).toEqual([
        'next: attach agents.acme.example to the control-plane Vercel project (Settings, Domains) if it is not a *.vercel.app address',
        'next: aw login --url https://agents.acme.example',
        `the Owner is admin@localhost.test; the password is BOOTSTRAP_ADMIN_PASSWORD in ${FACTS.envFile}`,
      ]);
    });

    it('vercel with a frontend names the allowed origin after the slugged project name (#830)', () => {
      const [first, ...rest] = DEPLOY_RECIPES.vercel.nextSteps({ ...FACTS, frontend: true });

      expect(first).toBe(
        'next: aw push and aw promote the agent; unless deploy said otherwise above, the control plane allows https://acme-ai-web.vercel.app; list a custom domain in allowedOrigins of the surface web/ calls',
      );
      expect(rest).toEqual(DEPLOY_RECIPES.vercel.nextSteps(FACTS));

      const [slugged] = DEPLOY_RECIPES.vercel.nextSteps({
        ...FACTS,
        projectName: 'agent-workspace',
        frontend: true,
      });
      expect(slugged).toContain(
        `the control plane allows https://${composeProjectName('agent-workspace')}-web.vercel.app;`,
      );
      expect(slugged).not.toContain('https://agent-workspace-web.vercel.app');
    });
  });

  describe('hardenEnv', () => {
    const harden = DEPLOY_RECIPES['single-vm'].hardenEnv;
    const env = 'A=1\nPORT=3000\nAW_TRUSTED_PROXY_HOPS=0\nB=2\n';

    it('puts single-vm behind the TLS proxy, idempotently, keeping other lines', () => {
      const once = harden(env);

      expect(once).toContain('\nPORT=127.0.0.1:3000\nAW_TRUSTED_PROXY_HOPS=1\n');
      expect(once).not.toContain('PORT=3000');
      expect(once).toContain('A=1');
      expect(once).toContain('B=2');
      expect(harden(once)).toBe(once);
    });

    it.each(['gcp-cloudrun', 'kubernetes', 'vercel'] as const)('leaves %s untouched', (target) => {
      expect(DEPLOY_RECIPES[target].hardenEnv(env)).toBe(env);
    });
  });

  describe('checkProject', () => {
    it('refuses a gcp-cloudrun name over 57 characters at `name`, and accepts 57', () => {
      const check = DEPLOY_RECIPES['gcp-cloudrun'].checkProject;

      expect(() => {
        check(projectNamed(57));
      }).not.toThrow();
      let refusal: unknown;
      try {
        check(projectNamed(58));
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(ProfileError);
      expect(refusal).toMatchObject({ path: 'name' });
    });

    it.each(['single-vm', 'kubernetes', 'vercel'] as const)(
      'accepts 58 characters for %s',
      (target) => {
        expect(() => {
          DEPLOY_RECIPES[target].checkProject(projectNamed(58));
        }).not.toThrow();
      },
    );

    it('vercel still refuses environments.production.apps (#1512)', () => {
      let refusal: unknown;
      try {
        DEPLOY_RECIPES.vercel.checkProject(projectWithApps(DESK));
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(ProfileError);
      expect(refusal).toMatchObject({ path: 'environments.production.apps' });
      expect((refusal as Error).message).toContain(
        'is deployed by the single-vm, kubernetes and gcp-cloudrun targets only; the vercel recipe has no app service yet',
      );
    });

    it('gcp-cloudrun names an app at most 25 characters, so <module name>-app-<name> fits a 49-character Cloud Run service name', () => {
      const named = (length: number) =>
        projectWithApps({ [`a${'b'.repeat(length - 1)}`]: DESK.desk });
      expect(() => {
        DEPLOY_RECIPES['gcp-cloudrun'].checkProject(named(25));
      }).not.toThrow();
      let refusal: unknown;
      try {
        DEPLOY_RECIPES['gcp-cloudrun'].checkProject(named(26));
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(ProfileError);
      expect(refusal).toMatchObject({ path: `environments.production.apps.a${'b'.repeat(25)}` });
      expect((refusal as Error).message).toContain('at most 25 characters for the gcp-cloudrun');
    });

    it.each(['gcp-cloudrun', 'vercel'] as const)(
      '%s accepts an empty or absent apps map (#1512)',
      (target) => {
        expect(() => {
          DEPLOY_RECIPES[target].checkProject(projectWithApps({}));
          DEPLOY_RECIPES[target].checkProject(projectWithApps(undefined));
        }).not.toThrow();
      },
    );

    it.each(['single-vm', 'kubernetes', 'gcp-cloudrun'] as const)(
      '%s accepts environments.production.apps (#1512)',
      (target) => {
        expect(() => {
          DEPLOY_RECIPES[target].checkProject(projectWithApps(DESK));
        }).not.toThrow();
      },
    );
  });

  it('refuses --infra exactly for the targets that take none', () => {
    expect(
      PROJECT_DEPLOY_TARGETS.filter((target) => DEPLOY_RECIPES[target].infraRefusal !== null),
    ).toEqual(['single-vm', 'vercel']);
  });

  it('has no v1 profile for kubernetes, which installs the Helm chart', () => {
    expect(() => DEPLOY_RECIPES.kubernetes.profile('acme-ai')).toThrow(
      'kubernetes has no v1 deployment profile; it installs the Helm chart',
    );
  });
});
