import { TestServicesError } from './errors.mjs';

const FORCEABLE_MODES = ['docker', 'native'];

/**
 * Decide, per service, where `pnpm test` gets PostgreSQL and S3 from:
 *
 * 1. `TEST_DATABASE_URL` / `TEST_S3_ENDPOINT`, when set, name a server the caller runs (`external`);
 * 2. otherwise `AW_TEST_SERVICES=docker|native` forces the mode of every remaining service;
 * 3. otherwise Docker when `docker info` succeeds, and the native fallback when it does not.
 *
 * `dockerAvailable` is called at most once, and only when the answer matters. A forced `docker`
 * without a daemon and an unknown `AW_TEST_SERVICES` both fail; neither falls back silently.
 *
 * @param {{ env: Record<string, string | undefined>; dockerAvailable: () => boolean }} input
 * @returns {{ postgres: 'external' | 'docker' | 'native'; s3: 'external' | 'docker' | 'native' }}
 */
export function selectServices({ env, dockerAvailable }) {
  const forced = env['AW_TEST_SERVICES']?.trim() ?? '';
  if (forced !== '' && !FORCEABLE_MODES.includes(forced)) {
    throw new TestServicesError(
      'test_services_mode_invalid',
      `AW_TEST_SERVICES must be one of ${FORCEABLE_MODES.join(', ')} (or unset); got ${JSON.stringify(forced)}.`,
    );
  }
  const postgresExternal = Boolean(env['TEST_DATABASE_URL']);
  const s3External = Boolean(env['TEST_S3_ENDPOINT']);
  /** @type {'docker' | 'native'} */
  let provided = 'native';
  if (!postgresExternal || !s3External) {
    if (forced === 'native') {
      provided = 'native';
    } else if (forced === 'docker') {
      if (!dockerAvailable()) {
        throw new TestServicesError(
          'docker_unavailable',
          'AW_TEST_SERVICES=docker, but `docker info` failed. Start the Docker daemon, or unset AW_TEST_SERVICES to use the native test services.',
        );
      }
      provided = 'docker';
    } else {
      provided = dockerAvailable() ? 'docker' : 'native';
    }
  }
  return {
    postgres: postgresExternal ? 'external' : provided,
    s3: s3External ? 'external' : provided,
  };
}
