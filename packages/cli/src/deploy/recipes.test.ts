import path from 'node:path';

import {
  PROJECT_DEPLOY_TARGETS,
  type ProjectDocument,
} from '@indx-workspace/contracts/project-file';
import { describe, expect, it } from 'vitest';

import { ProfileError } from '../profile.ts';
import { composeProjectName } from '../render/env.ts';
import { DEPLOY_RECIPES } from './recipes.ts';

const FACTS = {
  projectName: 'acme-ai',
  url: 'https://agents.acme.example',
  adminEmail: 'admin@localhost.test',
  envFile: '/home/owner/.config/agent-workspace/deployments/acme-ai/production/.env',
  moduleDirectory: null,
  frontend: false,
} as const;

/** Only `name` is read by the recipes' project checks. */
function projectNamed(length: number): ProjectDocument {
  return { name: 'a'.repeat(length) } as ProjectDocument;
}

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

    it.each([
      ['the module beneath --infra', path.join('/x/infra', 'terraform', 'gcp-cloudrun')],
      [
        'the module the CLI shipped (#794)',
        '/home/owner/.config/agent-workspace/deployments/acme-ai/production.infra/terraform/gcp-cloudrun',
      ],
    ])('gcp-cloudrun names %s and no caddy or .env', (_label, moduleDirectory) => {
      const steps = DEPLOY_RECIPES['gcp-cloudrun'].nextSteps({ ...FACTS, moduleDirectory });

      expect(steps).toEqual([
        `next: map agents.acme.example to the web service: terraform -chdir=${moduleDirectory} output web_url`,
        'next: aw login --url https://agents.acme.example',
        `the Owner is admin@localhost.test; the password is: terraform -chdir=${moduleDirectory} output -raw bootstrap_admin_password`,
      ]);
      const text = steps.join('\n');
      expect(text).not.toContain('caddy');
      expect(text).not.toContain('.env');
      expect(text).not.toContain('-chdir= ');
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
