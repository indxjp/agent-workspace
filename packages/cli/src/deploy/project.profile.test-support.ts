import { PROJECT_DEPLOY_TARGETS } from '@indx-workspace/contracts/project-file';
import { describe, expect, it } from 'vitest';
import { parseProfileDocument, ProfileError, renderProfileDocument } from '../profile.js';
import { projectToDeploymentProfile } from './project.js';
import { fixture, projectFixture } from './project.fixture.test-support.js';
export function defineProfileCases(): void {
  describe('projectToDeploymentProfile (#621)', () => {
    it('has no v1 profile for the kubernetes target, which installs the chart (#796)', async () => {
      const project = await projectFixture('production-kubernetes.project.yaml');
      expect(() => projectToDeploymentProfile(project, 'production')).toThrow(
        new ProfileError(
          'environments.production.target',
          'kubernetes has no v1 deployment profile; it installs the Helm chart',
        ),
      );
    });

    it.each(PROJECT_DEPLOY_TARGETS.filter((target) => target !== 'kubernetes'))(
      'turns the %s project into its golden v1 profile, byte for byte',
      async (target) => {
        const project = await projectFixture(`production-${target}.project.yaml`);
        const golden = await fixture(`production-${target}.profile.yaml`);

        const profile = projectToDeploymentProfile(project, 'production');

        expect(renderProfileDocument(profile)).toBe(golden);
        expect(parseProfileDocument(golden)).toEqual(profile);
      },
    );

    it('carries the local identity, since production names none', async () => {
      const project = await projectFixture('production-single-vm.project.yaml');
      expect(projectToDeploymentProfile(project, 'production').identity).toEqual(
        project.environments.local.identity,
      );
    });

    it('refuses a project with no production environment, naming the path', async () => {
      const project = await projectFixture('production-single-vm.project.yaml');
      const withoutProduction = {
        ...project,
        environments: { local: project.environments.local },
      };
      expect(() => projectToDeploymentProfile(withoutProduction, 'production')).toThrow(
        new ProfileError('environments.production', 'is not defined; add target and url'),
      );
    });

    it('refuses a gcp-cloudrun project whose name cannot produce a bucket, naming name', async () => {
      const project = await projectFixture('production-gcp-cloudrun.project.yaml');
      const longName = { ...project, name: `a${'-b'.repeat(28)}c` };
      expect(longName.name).toHaveLength(58);
      expect(() => projectToDeploymentProfile(longName, 'production')).toThrow(
        new ProfileError(
          'name',
          'must be at most 57 characters for the gcp-cloudrun target (its bucket is <name>-files)',
        ),
      );
    });
  });
}
