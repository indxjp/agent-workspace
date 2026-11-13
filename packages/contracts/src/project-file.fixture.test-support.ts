import { expect } from 'vitest';
import { z } from 'zod';

import {
  DEFAULT_BOOTSTRAP_ADMIN,
  DEPLOYMENT_V1_API_VERSION,
  PROJECT_API_VERSION,
  PROJECT_CLOUDS,
} from './project-file.js';

export const identity = { bootstrapAdmin: DEFAULT_BOOTSTRAP_ADMIN };

export const storage = {
  relational: 'compose-postgres',
  objects: 'local-filesystem',
  secrets: 'local-key',
};

export const minimal = {
  apiVersion: PROJECT_API_VERSION,
  kind: 'Project',
  name: 'demo',
  environments: { local: { cloud: 'local', identity } },
};

export function v1(cloud: (typeof PROJECT_CLOUDS)[number]): Record<string, unknown> {
  return {
    apiVersion: DEPLOYMENT_V1_API_VERSION,
    kind: 'Deployment',
    cloud,
    storage,
    runtime: { default: 'docker' },
    identity: { bootstrapAdmin: 'owner@example.com', oidc: 'https://issuer.example.com' },
  };
}

export function without(
  record: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

export function refusedPaths(result: {
  readonly success: boolean;
  readonly error?: z.ZodError;
}): (string | number | symbol)[][] {
  expect(result.success).toBe(false);
  return (result.error?.issues ?? []).flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => [...issue.path, key])
      : [[...issue.path]],
  );
}
