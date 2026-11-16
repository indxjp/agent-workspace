import { describe, expect, it } from 'vitest';

import {
  DEPLOYMENT_POSTURE_ENV,
  DeploymentPostureError,
  deploymentPostures,
  checkDeploymentPosture,
  isLoopbackHost,
  readDeploymentPosture,
  type DeploymentPosture,
} from './posture.js';

const nodeEnvs = [undefined, 'development', 'production'] as const;
const postures = [undefined, 'local', 'production', 'prod'] as const;
const hosts = [
  undefined,
  '',
  '   ',
  ' 127.0.0.1',
  '127.0.0.1',
  '127.1.2.3',
  '::1',
  'localhost',
  '0.0.0.0',
  '10.0.0.1',
];
// An unset, empty, blank or padded HOST is not loopback: the gateway and the runner bind an unset
// HOST to 0.0.0.0, and Node listens on every interface for an empty one.
const loopbackHosts = new Set<string | undefined>(['127.0.0.1', '127.1.2.3', '::1', 'localhost']);

type Expected =
  | { readonly posture: DeploymentPosture }
  | { readonly error: 'invalid_deployment_posture' | 'local_posture_needs_loopback_host' };

function expected(
  nodeEnv: string | undefined,
  posture: string | undefined,
  host: string | undefined,
): Expected {
  if (posture === undefined) return { posture: nodeEnv === 'production' ? 'production' : 'local' };
  if (posture === 'production') return { posture: 'production' };
  if (posture === 'local') {
    return loopbackHosts.has(host)
      ? { posture: 'local' }
      : { error: 'local_posture_needs_loopback_host' };
  }
  return { error: 'invalid_deployment_posture' };
}

function environment(
  nodeEnv: string | undefined,
  posture: string | undefined,
  host: string | undefined,
): Record<string, string | undefined> {
  return { NODE_ENV: nodeEnv, [DEPLOYMENT_POSTURE_ENV]: posture, HOST: host };
}

function readError(env: Record<string, string | undefined>): DeploymentPostureError {
  try {
    readDeploymentPosture(env);
  } catch (error) {
    if (error instanceof DeploymentPostureError) return error;
    throw error;
  }
  throw new Error('expected readDeploymentPosture to throw');
}

describe('readDeploymentPosture', () => {
  const matrix = nodeEnvs.flatMap((nodeEnv) =>
    postures.flatMap((posture) => hosts.map((host) => [nodeEnv, posture, host] as const)),
  );

  it.each(matrix)('NODE_ENV=%s posture=%s HOST=%s', (nodeEnv, posture, host) => {
    const env = environment(nodeEnv, posture, host);
    const want = expected(nodeEnv, posture, host);
    if ('posture' in want) {
      expect(readDeploymentPosture(env)).toBe(want.posture);
    } else {
      expect(readError(env).code).toBe(want.error);
    }
  });

  it('treats a blank posture as unset and never checks HOST then', () => {
    expect(readDeploymentPosture({ NODE_ENV: 'production', [DEPLOYMENT_POSTURE_ENV]: '  ' })).toBe(
      'production',
    );
    expect(readDeploymentPosture({ [DEPLOYMENT_POSTURE_ENV]: '', HOST: '0.0.0.0' })).toBe('local');
  });

  it.each([undefined, '', '   ', ' 127.0.0.1'])(
    'refuses a local posture when HOST is %j, which no listener binds as loopback',
    (host) => {
      expect(readError({ [DEPLOYMENT_POSTURE_ENV]: 'local', HOST: host }).code).toBe(
        'local_posture_needs_loopback_host',
      );
    },
  );

  it('names the variable and the accepted values for an invalid posture', () => {
    const error = readError({ [DEPLOYMENT_POSTURE_ENV]: 'prod' });
    expect(error.code).toBe('invalid_deployment_posture');
    expect(error.message).toContain('AW_DEPLOYMENT_POSTURE');
    for (const posture of deploymentPostures) expect(error.message).toContain(posture);
  });

  it('says a local posture needs a loopback HOST', () => {
    const error = readError({ [DEPLOYMENT_POSTURE_ENV]: 'local', HOST: '0.0.0.0' });
    expect(error.message).toContain('local posture needs a loopback HOST');
    expect(error).toBeInstanceOf(Error);
  });
});

describe('checkDeploymentPosture', () => {
  const local = { [DEPLOYMENT_POSTURE_ENV]: 'local', HOST: '127.0.0.1' };

  it('checks an explicit local posture against the host actually bound, not env HOST', () => {
    expect(checkDeploymentPosture(local, '127.0.0.1')).toBe('local');
    expect(() => checkDeploymentPosture(local, '0.0.0.0')).toThrow(
      'local posture needs a loopback HOST',
    );
    expect(() => checkDeploymentPosture(local, undefined)).toThrow(DeploymentPostureError);
  });

  it('never checks the bound host for a derived or production posture', () => {
    expect(checkDeploymentPosture({}, '0.0.0.0')).toBe('local');
    expect(checkDeploymentPosture({ [DEPLOYMENT_POSTURE_ENV]: 'production' }, '0.0.0.0')).toBe(
      'production',
    );
  });
});

describe('isLoopbackHost', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.255.255.255', '::1', '[::1]'])(
    'accepts %s',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '128.0.0.1',
    '127.0.0.256',
    '127.0.0',
    '::',
    'example.com',
    '',
    ' 127.0.0.1 ',
  ])('refuses %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('production refuses the dev issuer (ADR-0161 amendment DI9, issue #2075)', () => {
  const devIssuer = 'http://127.0.0.1:3200';

  it('refuses an http OIDC issuer under the production posture, a loopback one included', () => {
    for (const env of [
      { [DEPLOYMENT_POSTURE_ENV]: 'production', OIDC_ISSUER_URL: devIssuer },
      { NODE_ENV: 'production', OIDC_ISSUER_URL: devIssuer },
      { NODE_ENV: 'production', OIDC_ISSUER_URL: 'http://idp.example.test' },
      { NODE_ENV: 'production', OIDC_ISSUER_URL: 'not a url' },
    ]) {
      const error = readError(env);
      expect(error.code).toBe('oidc_issuer_not_https');
      expect(error.message).not.toContain(env.OIDC_ISSUER_URL);
      expect(() => checkDeploymentPosture(env, '0.0.0.0')).toThrow(DeploymentPostureError);
    }
  });

  it('accepts an https issuer, and no issuer, under the production posture', () => {
    const https = { NODE_ENV: 'production', OIDC_ISSUER_URL: 'https://idp.example.test' };
    expect(readDeploymentPosture(https)).toBe('production');
    expect(readDeploymentPosture({ NODE_ENV: 'production', OIDC_ISSUER_URL: '  ' })).toBe(
      'production',
    );
    expect(readDeploymentPosture({ NODE_ENV: 'production' })).toBe('production');
  });

  it('leaves the dev issuer to the local posture', () => {
    const local = {
      [DEPLOYMENT_POSTURE_ENV]: 'local',
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      OIDC_ISSUER_URL: devIssuer,
    };
    expect(readDeploymentPosture(local)).toBe('local');
  });
});
