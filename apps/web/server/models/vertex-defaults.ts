/**
 * The install's defaults for a `vertex` connection: `AW_VERTEX_PROJECT_ID` and `AW_VERTEX_LOCATION`,
 * set by the Google Cloud Run module on the web service. A create or first-run setup that omits
 * `projectId` or `location` takes them from here.
 *
 * An invalid value is logged without echoing it and treated as absent, like
 * `deployment-default.ts`: a connection is then refused rather than given a guessed project.
 */
import {
  GCP_PROJECT_ID_PATTERN,
  VERTEX_LOCATIONS,
  type VertexLocation,
} from '@indx-workspace/contracts/models';

import { log } from '../telemetry/logger';

export const VERTEX_PROJECT_ID_ENV = 'AW_VERTEX_PROJECT_ID';
export const VERTEX_LOCATION_ENV = 'AW_VERTEX_LOCATION';

export type VertexDefaults = {
  readonly projectId?: string;
  readonly location?: VertexLocation;
};

export function readVertexDefaults(
  env: Readonly<Record<string, string | undefined>>,
): VertexDefaults {
  const projectId = env[VERTEX_PROJECT_ID_ENV]?.trim();
  const location = env[VERTEX_LOCATION_ENV]?.trim();
  const defaults: { projectId?: string; location?: VertexLocation } = {};
  if (projectId !== undefined && projectId !== '') {
    if (GCP_PROJECT_ID_PATTERN.test(projectId)) defaults.projectId = projectId;
    else
      log.error(`[models] ${VERTEX_PROJECT_ID_ENV} ignored: it is not a Google Cloud project id`);
  }
  if (location !== undefined && location !== '') {
    const match = VERTEX_LOCATIONS.find((candidate) => candidate === location);
    if (match !== undefined) defaults.location = match;
    else {
      log.error(
        `[models] ${VERTEX_LOCATION_ENV} ignored: it is not one of ${VERTEX_LOCATIONS.join(', ')}`,
      );
    }
  }
  return defaults;
}

/**
 * The config a `vertex` connection starts from: what the caller sent, with the install's project
 * and location filling what it omitted. Without either, the location is `global`. Values the
 * caller did send are kept as they are, so the contract's own validation still judges them.
 */
export function vertexConfigWithDefaults(
  config: Readonly<Record<string, unknown>>,
  defaults: VertexDefaults,
): Record<string, unknown> {
  return {
    ...config,
    ...(config['projectId'] === undefined && defaults.projectId !== undefined
      ? { projectId: defaults.projectId }
      : {}),
    ...(config['location'] === undefined ? { location: defaults.location ?? 'global' } : {}),
  };
}
