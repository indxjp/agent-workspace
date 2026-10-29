import { ApiProblemSchema } from '@indx-workspace/contracts';
import { FEATURE_IDS, type FeatureId } from '@indx-workspace/contracts/features';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEPLOYMENT_FEATURES_ENV, readDeploymentFeatures } from './deployment';
import { featureRefusal, refuseIfFeatureDisabled } from './guard';
import { routeFeatureOf } from './route-feature';
import { clearFeatureSwitches, configureFeatureSwitches, enabledFeaturesFor } from './runtime';

describe('routeFeatureOf', () => {
  it.each([
    ['GET', '/api/agents', 'core'],
    ['GET', '/api/files', 'files'],
    ['GET', '/api/skills', 'skills'],
    ['GET', '/api/connectors', 'connectors'],
    ['GET', '/api/projects', 'projects'],
    ['GET', '/api/runs', 'runs'],
    ['GET', '/api/sharing-policies', 'sharing'],
    ['GET', '/api/triggers', 'triggers'],
    ['POST', '/api/builder/mcp', 'builder'],
    ['GET', '/.well-known/oauth-protected-resource/mcp/builder', 'builder'],
    ['GET', '/p/s/some-surface', 'surfaces'],
  ] as const)('tags %s %s as %s', (method, pathname, feature) => {
    expect(routeFeatureOf(method, pathname)).toBe(feature);
  });

  it('matches HEAD as the GET it shadows', () => {
    expect(routeFeatureOf('HEAD', '/api/files')).toBe('files');
  });

  it('keeps the collection and the member of one family apart', () => {
    expect(routeFeatureOf('GET', '/api/runs')).toBe('runs');
    expect(routeFeatureOf('GET', '/api/runs/run-1')).toBe('core');
  });

  it('answers null for a path or method no route serves', () => {
    expect(routeFeatureOf('GET', '/api/no-such-route')).toBeNull();
    expect(routeFeatureOf('DELETE', '/api/me')).toBeNull();
  });
});

describe('readDeploymentFeatures', () => {
  it.each([[{}], [{ [DEPLOYMENT_FEATURES_ENV]: '' }], [{ [DEPLOYMENT_FEATURES_ENV]: '  \t ' }]])(
    'installs every feature when the variable is unset or blank (%j)',
    (env) => {
      expect(readDeploymentFeatures(env)).toEqual(FEATURE_IDS);
    },
  );

  it('reads a comma-separated list, trimming each id', () => {
    expect(readDeploymentFeatures({ [DEPLOYMENT_FEATURES_ENV]: ' chat , runs ' })).toEqual([
      'chat',
      'runs',
    ]);
  });

  it('refuses an unknown id without echoing it', () => {
    const attempt = () =>
      readDeploymentFeatures({ [DEPLOYMENT_FEATURES_ENV]: 'chat,secret-value' });
    expect(attempt).toThrow(`${DEPLOYMENT_FEATURES_ENV} is invalid:`);
    expect(attempt).not.toThrow(/secret-value/u);
  });

  it('refuses a feature whose dependency is missing, a repeat and an empty entry', () => {
    for (const value of ['triggers', 'chat,chat', 'chat,,runs', ',']) {
      expect(() => readDeploymentFeatures({ [DEPLOYMENT_FEATURES_ENV]: value })).toThrow(
        `${DEPLOYMENT_FEATURES_ENV} is invalid:`,
      );
    }
  });
});

describe('featureRefusal', () => {
  const allBut = (off: FeatureId): readonly FeatureId[] => FEATURE_IDS.filter((id) => id !== off);

  it('answers 404 feature_disabled naming the feature, in the ADR-0078 envelope', () => {
    const refusal = featureRefusal('GET', '/api/files', allBut('files'));
    expect(refusal?.status).toBe(404);
    const parsed = ApiProblemSchema.parse(refusal?.body);
    expect(parsed.error.code).toBe('feature_disabled');
    expect(parsed.error.details).toEqual(['files']);
    expect(refusal?.body).toMatchObject({
      error: { detail: parsed.error.message },
    });
  });

  it('answers null for an enabled feature, a core route and an unknown path', () => {
    expect(featureRefusal('GET', '/api/files', FEATURE_IDS)).toBeNull();
    expect(featureRefusal('GET', '/api/agents', [])).toBeNull();
    expect(featureRefusal('GET', '/api/no-such-route', [])).toBeNull();
  });
});

describe('refuseIfFeatureDisabled', () => {
  afterEach(() => {
    clearFeatureSwitches();
  });

  it('treats an unwired deployment as everything on (ADR-0160 D9)', async () => {
    await expect(enabledFeaturesFor('ws-1')).resolves.toEqual(FEATURE_IDS);
    await expect(
      refuseIfFeatureDisabled(new Request('https://aw.test/api/files'), 'ws-1'),
    ).resolves.toBeNull();
  });

  it('refuses a switched-off feature for the workspace it is given', async () => {
    const enabledFor = vi.fn((workspaceId: string) =>
      Promise.resolve(
        workspaceId === 'ws-off' ? FEATURE_IDS.filter((id) => id !== 'files') : FEATURE_IDS,
      ),
    );
    configureFeatureSwitches({ enabledFor });
    const request = new Request('https://aw.test/api/files');
    expect((await refuseIfFeatureDisabled(request, 'ws-off'))?.status).toBe(404);
    expect(await refuseIfFeatureDisabled(request, 'ws-on')).toBeNull();
  });

  it('reads no switch for a core route or an unknown path', async () => {
    const enabledFor = vi.fn(() => Promise.resolve([]));
    configureFeatureSwitches({ enabledFor });
    expect(
      await refuseIfFeatureDisabled(new Request('https://aw.test/api/agents'), 'w'),
    ).toBeNull();
    expect(await refuseIfFeatureDisabled(new Request('https://aw.test/api/nope'), 'w')).toBeNull();
    expect(enabledFor).not.toHaveBeenCalled();
  });
});
