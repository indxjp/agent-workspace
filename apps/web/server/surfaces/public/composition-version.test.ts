/** Local and production pointer selection for public and try surfaces. */

import { describe, expect, it } from 'vitest';
import { pickSurfaceVersion } from './composition';
import { EXPIRES_AT } from './composition.test-support';

describe('pickSurfaceVersion (issue #612)', () => {
  const AGENT = '77777777-7777-4777-8777-777777777777';
  const surfaceIn = (environment: 'local' | 'production') => ({
    agentId: AGENT,
    versionId: `${environment}-version`,
    number: environment === 'local' ? 2 : 1,
    surface: { name: 'main', agent: 'Front desk' },
  });
  function versions(carries: readonly ('local' | 'production')[], promoted: boolean) {
    return {
      findPointedSurface: (environment: 'local' | 'production') =>
        Promise.resolve(carries.includes(environment) ? surfaceIn(environment) : null),
      list: () =>
        Promise.resolve({
          versions: [],
          materialisedVersionId: null,
          pointers: (promoted ? (['local', 'production'] as const) : (['local'] as const)).map(
            (environment) => ({
              agentId: AGENT,
              environment,
              versionId: `${environment}-version`,
              number: 1,
              updatedAt: EXPIRES_AT,
            }),
          ),
        }),
    };
  }

  it('serves the public production when a production version carries the surface', async () => {
    await expect(
      pickSurfaceVersion(versions(['local', 'production'], true), 'main', 'public'),
    ).resolves.toMatchObject({ environment: 'production', promoted: true });
  });

  it('serves the public local before any promotion, and notes it is not promoted', async () => {
    await expect(
      pickSurfaceVersion(versions(['local'], false), 'main', 'public'),
    ).resolves.toMatchObject({
      environment: 'local',
      promoted: false,
      pointed: { versionId: 'local-version' },
    });
  });

  it('serves the public nothing when the promoted version lacks the surface', async () => {
    await expect(
      pickSurfaceVersion(versions(['local'], true), 'main', 'public'),
    ).resolves.toBeNull();
  });

  it('always serves the try page local, promoted or not', async () => {
    await expect(
      pickSurfaceVersion(versions(['local', 'production'], true), 'main', 'try'),
    ).resolves.toMatchObject({ environment: 'local', promoted: true });
    await expect(
      pickSurfaceVersion(versions(['production'], true), 'main', 'try'),
    ).resolves.toBeNull();
  });
});
