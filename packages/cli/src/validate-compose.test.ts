import { describe, expect, it } from 'vitest';

import { describeProbeResults, runProfileProbes } from './validate.js';

import {
  COMPOSE_DATABASE_URL,
  GCS_STORAGE,
  gcpProfile,
  localProfile,
  outcomes,
  recordingProbes,
} from './validate.test-support.ts';

const composeEnvironment = {
  DATABASE_URL: COMPOSE_DATABASE_URL,
  OBJECT_STORAGE_ACCESS_KEY_ID: 'agent_workspace',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'object-store-secret',
  AW_STORAGE_URL: 's3://agent-workspace?endpoint=http://seaweedfs:8333&pathStyle=true',
};
describe('Compose-internal stores', () => {
  /**
   * `templates/compose.yaml` puts `postgres` and `seaweedfs` on `control`, which is `internal: true`
   * and publishes no host port, so the host can never reach either hostname — started or not.
   * The skip therefore belongs to the store and not to the caller: gating it on the caller is
   * what made `agent-workspace validate <project>` unable to pass on a `--cloud local` project.
   */
  it('reports each store instead of probing it, whoever the caller is', async () => {
    const { calls, probes } = recordingProbes();
    const results = await runProfileProbes(localProfile, {
      probes,
      environment: composeEnvironment,
    });

    expect(calls).toEqual([]);
    expect(outcomes(results)).toEqual({
      relational: 'skipped',
      objects: 'skipped',
      identity: 'skipped',
    });
    expect(describeProbeResults(results)).toContain(
      "skipped  relational: postgres is on the Compose project's internal network, which " +
        'publishes no host port — check it from inside the project with `docker compose exec ' +
        'postgres pg_isready -U agent_workspace`',
    );
    expect(describeProbeResults(results)).toContain(
      "skipped  objects: seaweedfs is on the Compose project's internal network, which " +
        'publishes no host port — check it from inside the project with `docker compose exec ' +
        'seaweedfs wget -q -O /dev/null http://127.0.0.1:8333/healthz`',
    );
  });

  // A project generated before ADR-0067 keeps its own MinIO-era compose.yaml and `.env`, so its
  // object store is still the `minio` service on the same internal network.
  it('still reports the bundled store of a project generated before the SeaweedFS switch', async () => {
    const { calls, probes } = recordingProbes();
    const results = await runProfileProbes(localProfile, {
      probes,
      environment: {
        ...composeEnvironment,
        AW_STORAGE_URL: 's3://agent-workspace?endpoint=http://minio:9000&pathStyle=true',
      },
    });

    expect(calls).toEqual([]);
    expect(describeProbeResults(results)).toContain(
      "skipped  objects: minio is on the Compose project's internal network, which publishes " +
        'no host port — check it from inside the project with `docker compose exec minio curl ' +
        '-fsS http://127.0.0.1:9000/minio/health/live`',
    );
  });
});

it('still probes a store that is not one of those services', async () => {
  const managed = 'postgres://user:pw@10.0.0.2:5432/agent_workspace';
  const { calls, probes } = recordingProbes();
  await runProfileProbes(gcpProfile, {
    probes,
    environment: { DATABASE_URL: managed, ...GCS_STORAGE },
  });
  expect(calls).toEqual([`relational:${managed}`, 'objects:acme-ai-files']);
});
