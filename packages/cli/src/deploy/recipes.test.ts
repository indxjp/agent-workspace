import { PROJECT_DEPLOY_TARGETS } from '@indx-workspace/contracts/project-file';
import { describe, expect, it } from 'vitest';

import { ProfileError } from '../profile.ts';
import { DEPLOY_RECIPES } from './recipes.ts';
import { DESK, projectNamed, projectWithApps, refusalOf } from './recipes.test-support.ts';

describe('DEPLOY_RECIPES (#948)', () => {
  it('has exactly one recipe per deploy target, in the contracts order', () => {
    expect(Object.keys(DEPLOY_RECIPES)).toEqual([...PROJECT_DEPLOY_TARGETS]);
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
      const refusal = refusalOf(() => {
        check(projectNamed(58));
      });
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
      const refusal = refusalOf(() => {
        DEPLOY_RECIPES.vercel.checkProject(projectWithApps(DESK));
      });
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
      const refusal = refusalOf(() => {
        DEPLOY_RECIPES['gcp-cloudrun'].checkProject(named(26));
      });
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
